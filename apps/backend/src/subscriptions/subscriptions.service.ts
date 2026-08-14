import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { CreateSubscriptionDto } from './dto/create_subscription.dto';
import { CommunesService } from '../communes/communes.service';
import { HttpService } from '@nestjs/axios';
import { pick } from 'lodash';
import { ZonesService } from '../zones/zones.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AbonnementMail } from '@shared/entities/abonnement_mail.entity';
import { firstValueFrom } from 'rxjs';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VigieauLogger } from '../logger/vigieau.logger';
import { BrevoService } from '../brevo/brevo.service';
import { MattermostService } from '../mattermost/mattermost.service';
import { CronService } from '../cron/cron.service';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new VigieauLogger('SubscriptionsService');

  constructor(
    @InjectRepository(AbonnementMail)
    private readonly abonnementMailRepository: Repository<AbonnementMail>,
    private readonly communesService: CommunesService,
    private readonly httpService: HttpService,
    private readonly zonesService: ZonesService,
    private readonly brevoService: BrevoService,
    private readonly mattermostService: MattermostService,
    private readonly cronService: CronService,
  ) {}

  /**
   * Récupère tous les abonnements dans une version légère.
   * Renvoie uniquement l'id, l'email et la date de création.
   */
  getAllLight() {
    return this.abonnementMailRepository.find({
      select: ['id', 'email', 'createdAt'],
    });
  }

  /**
   * Crée un nouvel abonnement ou met à jour un abonnement existant.
   * @param createSubscriptionDto - Les données pour créer un abonnement.
   * @param ip - L'adresse IP de l'utilisateur à l'origine de la requête.
   * @returns L'abonnement nouvellement créé ou mis à jour.
   */
  async create(
    createSubscriptionDto: CreateSubscriptionDto,
    ip: string,
  ): Promise<AbonnementMail> {
    const subscription: any = { ...createSubscriptionDto, ip };
    let communeNom: string | undefined;

    if (subscription.commune) {
      const commune = this.communesService.getCommune(subscription.commune);

      if (!commune) {
        throw new HttpException(
          `Code commune inconnu.`,
          HttpStatus.BAD_REQUEST,
        );
      }

      communeNom = commune.nom;
      subscription.libelleLocalisation = communeNom;
    }

    if (subscription.idAdresse) {
      if (!subscription.lon || !subscription.lat) {
        throw new HttpException(
          `lon/lat requis dans le cas d’une inscription à l’adresse.`,
          HttpStatus.BAD_REQUEST,
        );
      }

      const {
        libelle,
        commune,
        communeNom: adresseCommuneNom,
      } = await this.resolveIdAdresse(subscription.idAdresse);

      subscription.commune = commune;
      subscription.libelleLocalisation = libelle;
      communeNom =
        this.getCommuneNom(subscription.commune) ||
        adresseCommuneNom ||
        communeNom;
    }

    subscription.typesEau = [...new Set(subscription.typesEau)].sort();

    try {
      subscription.situation = this.computeNiveauxAlerte(subscription);
    } catch {
      subscription.situation = {};
    }

    const whereClause = subscription.commune
      ? {
          email: subscription.email,
          commune: subscription.commune,
          idAdresse: subscription.idAdresse,
        }
      : {
          lon: subscription.lon,
          lat: subscription.lat,
        };
    const subscriptionExists = await this.abonnementMailRepository.exists({
      where: whereClause,
    });
    if (subscriptionExists) {
      await this.abonnementMailRepository.update(
        whereClause,
        pick(subscription, 'profil', 'typesEau'),
      );
    } else {
      await this.abonnementMailRepository.save(subscription);

      await this.brevoService.sendMail(29, subscription.email, {
        city:
          communeNom ||
          this.getCommuneNom(subscription.commune) ||
          subscription.libelleLocalisation ||
          '',
        address: subscription.libelleLocalisation,
        unsubscribeUrl: this.brevoService.computeUnsubscribeUrl(
          subscription.email,
        ),
      });
    }

    return subscription;
  }

  /**
   * Résout un ID d'adresse en récupérant les informations associées via un service externe.
   * @param idAdresse - L'identifiant unique de l'adresse.
   * @returns Un objet contenant le libellé et la commune associée.
   */
  async resolveIdAdresse(idAdresse) {
    try {
      const result = await firstValueFrom(
        this.httpService.get(
          `https://plateforme.adresse.data.gouv.fr/lookup/${idAdresse}`,
        ),
      );

      return {
        libelle: this.buildLibelle(result.data),
        commune: result.data.commune.code,
        communeNom: result.data.commune.nom,
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new HttpException(
          `L’adresse renseignée n’existe pas`,
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        `Une erreur inattendue est survenue`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Construit un libellé d'adresse lisible à partir des données d'une adresse.
   * @param adresse - Les données brutes de l'adresse.
   * @returns Une chaîne lisible représentant l'adresse.
   */
  buildLibelle(adresse: any): string {
    if (adresse.type === 'voie' || adresse.type === 'lieu-dit') {
      return `${adresse.nomVoie}, ${adresse.commune.nom}`;
    }

    if (adresse.type === 'numero') {
      return `${adresse.numero}${adresse.suffixe || ''}, ${adresse.voie.nomVoie}, ${adresse.commune.nom}`;
    }

    throw new HttpException(
      `Une erreur inattendue est survenue`,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  private getCommuneNom(codeCommune?: string): string | undefined {
    if (!codeCommune) {
      return undefined;
    }

    return this.communesService.getCommune(codeCommune)?.nom;
  }

  /**
   * Calcule les niveaux d'alerte pour un abonnement.
   * Utilise les coordonnées géographiques ou la commune pour rechercher les zones d'alerte.
   * @param param - Objet contenant les coordonnées géographiques ou le code commune.
   * @returns Un objet contenant les niveaux d'alerte pour AEP, SOU, et SUP.
   */
  computeNiveauxAlerte({
    lon,
    lat,
    commune,
  }: {
    lon: number;
    lat: number;
    commune: string;
  }) {
    const zones =
      lon || lat
        ? this.zonesService.searchZonesByLonLat({ lon, lat })
        : this.zonesService.searchZonesByCommune(commune);

    return {
      SUP:
        zones.find((z) => z.type === 'SUP')?.niveauGravite || 'pas_restriction',
      SOU:
        zones.find((z) => z.type === 'SOU')?.niveauGravite || 'pas_restriction',
      AEP:
        zones.find((z) => z.type === 'AEP')?.niveauGravite || 'pas_restriction',
      zones: zones.map((z) => z.idZone),
    };
  }

  /**
   * Récupère les abonnements liés à une adresse email donnée.
   * @param email - L'adresse email de l'utilisateur.
   * @returns Une liste des abonnements associés.
   */
  getSubscriptionsByEmail(email: string) {
    return this.abonnementMailRepository.find({
      select: {
        id: true,
        email: true,
        profil: true,
        typesEau: true,
        libelleLocalisation: true,
        // @ts-ignore
        situation: true,
      },
      where: { email },
    });
  }

  /**
   * Supprime un abonnement spécifique basé sur son ID et l'email de l'utilisateur.
   * @param id - L'ID de l'abonnement.
   * @param email - L'email de l'utilisateur.
   * @returns Le résultat de la suppression.
   */
  deleteSubscriptionById(id: string, email: string) {
    return this.abonnementMailRepository.delete({ id: +id, email: email });
  }

  /**
   * Supprime tous les abonnements associés à un email donné.
   * @param email - L'adresse email.
   * @returns Le résultat de la suppression.
   */
  deleteSubscriptionByEmail(email: string) {
    return this.abonnementMailRepository.delete({ email: email });
  }

  /**
   * Tâche CRON exécutée tous les jours à 16h pour mettre à jour les situations d'alerte.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4PM)
  async tryUpdateSituations() {
    // On force la mise à jour des zones d'alertes avant
    await this.zonesService.loadAllZones();
    const canRun = await this.cronService.askForLock('emails');
    if (!canRun) return;

    try {
      await this.updateSituations();
    } finally {
      await this.cronService.unlock('emails');
    }
  }

  /**
   * Met à jour les situations des abonnements en vérifiant les niveaux d'alerte
   * actuels par rapport aux abonnements enregistrés. Si un changement est détecté,
   * un email est envoyé à l'utilisateur.
   */
  async updateSituations() {
    const stats = {
      pas_restriction: 0,
      vigilance: 0,
      alerte: 0,
      alerte_renforcee: 0,
      crise: 0,
      pas_changement: 0,
      erreur: 0,
      nouveau: 0,
      mail_envoye: 0,
      departements: [],
    };

    const subscriptions = await this.abonnementMailRepository.find({
      select: [
        'id',
        'email',
        'commune',
        'lon',
        'lat',
        'typesEau',
        'profil',
        'libelleLocalisation',
        'situation',
        'createdAt',
      ],
    });
    for (const subscription of subscriptions) {
      let situationUpdated = false;

      if (
        subscription.createdAt &&
        new Date(subscription.createdAt).getTime() >
          Date.now() - 24 * 60 * 60 * 1000
      ) {
        stats.nouveau++;
      }

      try {
        // @ts-ignore
        const { AEP, SOU, SUP } = this.computeNiveauxAlerte(subscription);

        // Vérifie les changements pour chaque type d'eau (AEP, SOU, SUP)
        situationUpdated = this.checkAndUpdateSituation(
          stats,
          subscription,
          AEP,
          'AEP',
        );
        situationUpdated =
          this.checkAndUpdateSituation(stats, subscription, SOU, 'SOU') ||
          situationUpdated;
        situationUpdated =
          this.checkAndUpdateSituation(stats, subscription, SUP, 'SUP') ||
          situationUpdated;

        if (situationUpdated) {
          // TMP
          this.logger.log(
            `CHECK SUBSCRIPTION - ${AEP} - ${SOU} - ${SUP} - ${JSON.stringify(subscription)}`,
          );

          await this.brevoService.sendSituationUpdate(
            subscription.email,
            AEP,
            Boolean(
              subscription.situation?.AEP && subscription.situation.AEP !== AEP,
            ),
            SUP,
            Boolean(
              subscription.situation?.SUP && subscription.situation.SUP !== SUP,
            ),
            SOU,
            Boolean(
              subscription.situation?.SOU && subscription.situation.SOU !== SOU,
            ),
            subscription.commune,
            subscription.libelleLocalisation,
            subscription.profil,
          );

          stats.mail_envoye++;

          await this.abonnementMailRepository.update(
            { id: subscription.id },
            { situation: { AEP, SOU, SUP } },
          );
        } else {
          stats.pas_changement++;
        }
      } catch (error) {
        stats.erreur++;
        this.logger.error(
          `MISE A JOUR SITUATION - ${JSON.stringify(subscription)} - `,
          error,
        );
      }
    }
    await this.sendMattermostNotification(stats);
  }

  /**
   * Vérifie si le niveau d'alerte d'un type d'eau a changé pour l'abonnement
   * et met à jour les statistiques et les départements concernés.
   *
   * @param stats - Objet contenant les statistiques.
   * @param subscription - L'abonnement en cours de vérification.
   * @param newLevel - Le nouveau niveau d'alerte pour le type d'eau.
   * @param waterType - Le type d'eau (AEP, SOU, SUP).
   * @returns True si la situation a changé, sinon False.
   */
  private checkAndUpdateSituation(
    stats: any,
    subscription: any,
    newLevel: string,
    waterType: string,
  ): boolean {
    if (
      subscription.typesEau.includes(waterType) &&
      newLevel &&
      subscription.situation?.[waterType] !== newLevel
    ) {
      stats[newLevel]++;
      this.addStatDepartement(stats.departements, subscription.commune);
      return true; // La situation a changé
    }
    return false; // Pas de changement
  }

  /**
   * Ajoute un département aux statistiques s'il n'est pas déjà présent.
   *
   * @param departements - Liste des départements déjà ajoutés.
   * @param commune - Code de la commune pour déduire le département.
   */
  addStatDepartement(departements: string[], commune: string) {
    const depCode = commune >= '97' ? commune.slice(0, 3) : commune.slice(0, 2);
    if (!departements.includes(depCode)) {
      departements.push(depCode);
    }
  }

  /**
   * Envoie un message à Mattermost avec un résumé des statistiques
   * après la mise à jour des situations.
   *
   * @param stats - Objet contenant les statistiques de la mise à jour.
   */
  async sendMattermostNotification(stats) {
    const sentences = [];

    // Construction des messages pour Mattermost en fonction des statistiques
    if (stats.mail_envoye)
      sentences.push(`- **${stats.mail_envoye}** emails envoyés 📧`);
    if (stats.nouveau)
      sentences.push(
        `- **${stats.nouveau}** usagers se sont inscrits au cours des dernières 24h 🎊`,
      );
    if (stats.pas_restriction)
      sentences.push(
        `- **${stats.pas_restriction}** usagers n’ont plus de restrictions 🚰`,
      );
    if (stats.vigilance)
      sentences.push(
        `- **${stats.vigilance}** usagers sont passés en **Vigilance** 💧`,
      );
    if (stats.alerte)
      sentences.push(
        `- **${stats.alerte}** usagers sont passés en **Alerte** 😬`,
      );
    if (stats.alerte_renforcee)
      sentences.push(
        `- **${stats.alerte_renforcee}** usagers sont passés en **Alerte renforcée** 🥵`,
      );
    if (stats.crise)
      sentences.push(
        `- **${stats.crise}** usagers sont passés en **Crise** 🔥`,
      );
    if (stats.pas_changement)
      sentences.push(
        `- **${stats.pas_changement}** usagers n’ont pas de changement 👻`,
      );
    if (stats.erreur)
      sentences.push(`- **${stats.erreur}** usagers sont en erreur 🧨`);
    if (stats.departements?.length > 0) {
      sentences.push(
        `- **${stats.departements.join(', ')}** départements concernés 🗺️`,
      );
    }

    const message = sentences.join('\n');
    await this.mattermostService.sendMessage(message);
  }
}
