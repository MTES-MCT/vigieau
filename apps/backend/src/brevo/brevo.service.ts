import { Injectable } from '@nestjs/common';
import { BrevoClient } from '@getbrevo/brevo';
import { JwtService } from '@nestjs/jwt';
import { CommunesService } from '../communes/communes.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BrevoService {
  private readonly brevoClient?: BrevoClient;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly communesService: CommunesService,
  ) {
    const apiKey = this.configService.get<string>('BREVO_API_KEY');

    if (apiKey) {
      this.brevoClient = new BrevoClient({
        apiKey,
        maxRetries: 0,
      });
    }
  }

  /**
   * Envoie une mise à jour de situation par email via Brevo.
   * Si les notifications sont désactivées, la méthode retourne immédiatement.
   *
   * @param email Adresse email du destinataire.
   * @param niveauGraviteAep Niveau de gravité pour l'eau potable.
   * @param changementAep Indique si le niveau AEP a changé.
   * @param niveauGraviteSup Niveau de gravité pour les eaux superficielles.
   * @param changementSup Indique si le niveau des eaux superficielles a changé.
   * @param niveauGraviteSou Niveau de gravité pour les eaux souterraines.
   * @param changementSou Indique si le niveau des eaux souterraines a changé.
   * @param codeCommune Code INSEE de la commune.
   * @param libelleLocalisation Libellé de localisation pour l'adresse.
   * @param profil Profil utilisateur pour personnaliser l'URL de restriction.
   */
  sendSituationUpdate(
    email: string,
    niveauGraviteAep: string,
    changementAep: boolean,
    niveauGraviteSup: string,
    changementSup: boolean,
    niveauGraviteSou: string,
    changementSou: boolean,
    codeCommune: string,
    libelleLocalisation: string,
    profil: string,
    coordinates?: { lon: number | string; lat: number | string },
  ) {
    const isEmailEnabled =
      this.configService.get<string>('EMAIL_NOTIFICATIONS_ENABLED') === '1';
    if (!isEmailEnabled) {
      return;
    }

    const recipient =
      this.configService.get<string>('EMAIL_NOTIFICATIONS_DEV_RECIPIENT') ||
      email;

    const restrictionUrl = new URL(
      '/situation',
      this.configService.get<string>('WEBSITE_URL'),
    );
    restrictionUrl.searchParams.set('profil', profil);
    restrictionUrl.searchParams.set('adresse', libelleLocalisation);
    if (coordinates?.lon != null && coordinates?.lat != null) {
      const lon = Number(coordinates.lon);
      const lat = Number(coordinates.lat);
      if (
        !Number.isFinite(lon) ||
        !Number.isFinite(lat) ||
        lon < -180 ||
        lon > 180 ||
        lat < -90 ||
        lat > 90
      ) {
        throw new Error('Invalid subscription coordinates');
      }
      restrictionUrl.searchParams.set('lon', String(lon));
      restrictionUrl.searchParams.set('lat', String(lat));
      if (codeCommune) restrictionUrl.searchParams.set('commune', codeCommune);
    }

    const params = {
      address: libelleLocalisation,
      city:
        this.communesService.getCommune(codeCommune)?.nom ||
        libelleLocalisation,
      unsubscribeUrl: this.computeUnsubscribeUrl(email),
      niveauGraviteAep: this.getniveauGraviteFr(niveauGraviteAep),
      changementAep,
      niveauGraviteSup: this.getniveauGraviteFr(niveauGraviteSup),
      changementSup,
      niveauGraviteSou: this.getniveauGraviteFr(niveauGraviteSou),
      changementSou,
      restrictionUrl: restrictionUrl.toString(),
    };

    return this.sendMail(
      this.getTemplateId(niveauGraviteAep, niveauGraviteSup, niveauGraviteSou),
      recipient,
      params,
    );
  }

  /**
   * Détermine l'ID du template à utiliser pour l'email en fonction des niveaux de gravité.
   *
   * @param niveauGraviteAep Niveau de gravité pour l'eau potable.
   * @param niveauGraviteSup Niveau de gravité pour les eaux superficielles.
   * @param niveauGraviteSou Niveau de gravité pour les eaux souterraines.
   * @returns ID du template à utiliser (32 pour "pas de restrictions", 65 sinon).
   */
  getTemplateId(niveauGraviteAep, niveauGraviteSup, niveauGraviteSou) {
    if (
      niveauGraviteAep === 'pas_restriction' &&
      niveauGraviteSup === 'pas_restriction' &&
      niveauGraviteSou === 'pas_restriction'
    ) {
      return 32;
    }

    return 65;
  }

  /**
   * Traduit un niveau de gravité en une description lisible en français.
   *
   * @param niveauGravite Niveau de gravité (ex: "vigilance", "alerte").
   * @returns Traduction française du niveau de gravité.
   */
  getniveauGraviteFr(niveauGravite: string): string {
    const graviteMapping = {
      pas_restriction: 'pas de restrictions',
      vigilance: 'vigilance',
      alerte: 'alerte',
      alerte_renforcee: 'alerte renforcée',
      crise: 'crise',
    };

    return graviteMapping[niveauGravite] || '';
  }

  /**
   * Génère un lien de désinscription contenant un token JWT sécurisé.
   *
   * @param email Adresse email pour laquelle le lien de désinscription est généré.
   * @returns URL de désinscription avec le token JWT.
   */
  computeUnsubscribeUrl(email: string): string {
    const token = this.jwtService.sign(
      { email },
      {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: '7d',
      },
    );
    return `${this.configService.get<string>('WEBSITE_URL')}/abonnements?token=${token}`;
  }

  /** Sends a fresh management link without creating or changing subscriptions. */
  async sendManagementLink(email: string) {
    if (!this.brevoClient) {
      if (this.configService.get<string>('NODE_ENV') === 'production') {
        throw new Error('BREVO_API_KEY is required');
      }
      return;
    }

    // Reuse the verified sender of the subscription confirmation template.
    const template = await this.brevoClient.transactionalEmails.getSmtpTemplate(
      {
        templateId: 29,
      },
    );
    if (!template.sender?.email) {
      throw new Error('Subscription email sender is unavailable');
    }
    const url = this.computeUnsubscribeUrl(email);
    const escapedUrl = url.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character],
    );

    return this.brevoClient.transactionalEmails.sendTransacEmail({
      sender: { email: template.sender.email, name: template.sender.name },
      ...(template.replyTo ? { replyTo: { email: template.replyTo } } : {}),
      to: [{ email }],
      subject: 'Gérer vos abonnements aux alertes VigiEau',
      htmlContent: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Vos abonnements VigiEau</title></head><body>
<h1>Gérer vos abonnements aux alertes VigiEau</h1>
<p>Vous avez demandé un nouveau lien pour consulter vos abonnements ou vous désabonner.</p>
<p><a href="${escapedUrl}">Gérer mes abonnements</a></p>
<p>Ce lien personnel est valable 7 jours. Ne le partagez pas.</p>
<p>Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer ce message. Vos abonnements restent inchangés.</p>
</body></html>`,
      textContent: `Vous avez demandé un nouveau lien pour gérer vos abonnements aux alertes VigiEau.\n\nGérer mes abonnements : ${url}\n\nCe lien personnel est valable 7 jours. Ne le partagez pas.\n\nSi vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer ce message. Vos abonnements restent inchangés.`,
    });
  }

  /**
   * Envoie un email transactionnel via Brevo.
   *
   * @param templateId ID du template à utiliser.
   * @param to Adresse email du destinataire.
   * @param params Paramètres dynamiques à injecter dans le template.
   */
  sendMail(templateId: number, to: string, params: Record<string, unknown>) {
    if (!this.brevoClient) {
      if (this.configService.get<string>('NODE_ENV') === 'production') {
        throw new Error('BREVO_API_KEY is required');
      } else {
        return;
      }
    }

    return this.brevoClient.transactionalEmails.sendTransacEmail({
      templateId,
      to: [{ email: to }],
      params,
    });
  }
}
