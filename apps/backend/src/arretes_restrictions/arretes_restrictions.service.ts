import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
import { Restriction } from '@shared/entities/restriction.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import {
  FindManyOptions,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { VigieauLogger } from '../logger/vigieau.logger';

@Injectable()
export class ArretesRestrictionsService {
  private readonly logger = new VigieauLogger('ArretesRestrictionsService');

  constructor(
    @InjectRepository(ArreteRestriction)
    private readonly arreteRestrictionRepository: Repository<ArreteRestriction>,
  ) {}

  /**
   * Récupère les arrêtés de restriction en fonction de la date et des filtres optionnels.
   *
   * @param date Date limite de recherche pour les arrêtés (format YYYY-MM-DD). Si non spécifiée, tous les arrêtés sont considérés.
   * @param bassinVersant Identifiant du bassin versant pour filtrer les arrêtés (facultatif).
   * @param region Identifiant de la région pour filtrer les arrêtés (facultatif).
   * @param departement Identifiant du département pour filtrer les arrêtés (facultatif).
   * @returns Une liste des arrêtés de restriction enrichie avec des informations calculées (`niveauGraviteMax`, `types`).
   */
  async getByDate(
    date?: string,
    bassinVersant?: string,
    region?: string,
    departement?: string,
  ) {
    const whereClause: any = {
      statut: In(['publie', 'abroge']),
      dateDebut: LessThanOrEqual(date),
    };
    if (bassinVersant) {
      whereClause.departement = { bassinsVersants: { id: bassinVersant } };
    }
    if (region) {
      whereClause.departement = { region: { id: region } };
    }
    if (departement) {
      whereClause.departement = { id: departement };
    }
    const findOptions: FindManyOptions<ArreteRestriction> = <
      FindManyOptions<ArreteRestriction>
    >{
      select: {
        id: true,
        numero: true,
        dateDebut: true,
        dateFin: true,
        dateSignature: true,
        statut: true,
        departement: {
          code: true,
          nom: true,
        },
        fichier: {
          nom: true,
          url: true,
          size: true,
        },
        arretesCadre: {
          id: true,
          numero: true,
          dateDebut: true,
          dateFin: true,
          fichier: {
            url: true,
          },
        },
        restrictions: {
          niveauGravite: true,
          zonesAlerteComputed: {
            type: true,
          },
          zoneAlerte: {
            type: true,
          },
        },
      },
      relations: [
        'departement',
        'fichier',
        'restrictions',
        'restrictions.zonesAlerteComputed',
        'arretesCadre',
        'arretesCadre.fichier',
      ],
      where: [
        { ...whereClause, dateFin: MoreThanOrEqual(date) },
        { ...whereClause, dateFin: IsNull() },
      ],
      order: {
        dateDebut: 'DESC',
      },
    };

    const ars = await this.arreteRestrictionRepository.find(findOptions);
    return this.formatArretesRestrictions(ars);
  }

  /**
   * Transforme les résultats pour enrichir chaque arrêté avec des informations calculées.
   *
   * - Ajoute `niveauGraviteMax` pour représenter le niveau de gravité maximal des restrictions.
   * - Déduit les `types` uniques des zones d'alerte des restrictions.
   *
   * @param ars Liste des arrêtés de restriction récupérés depuis la base de données.
   * @returns Une liste transformée et enrichie des arrêtés de restriction.
   */
  private formatArretesRestrictions(ars: any[]): any[] {
    const niveauGravitePriority = {
      vigilance: 1,
      alerte: 2,
      alerte_renforcee: 3,
      crise: 4,
    };

    return ars.map((ar) => {
      ar.niveauGraviteMax = null;

      // Calcul de `niveauGraviteMax`
      ar.restrictions?.forEach((r: Restriction) => {
        if (
          !ar.niveauGraviteMax ||
          niveauGravitePriority[r.niveauGravite] >
            niveauGravitePriority[ar.niveauGraviteMax]
        ) {
          ar.niveauGraviteMax = r.niveauGravite;
        }
      });

      // Déduplication et tri des `types`
      ar.types = [
        ...new Set(
          ar.restrictions
            ?.map((r: Restriction) =>
              r.zonesAlerteComputed.map((z: ZoneAlerteComputed) => z.type),
            )
            .flat()
            .concat(
              ar.restrictions
                .filter((r: Restriction) => r.zoneAlerte)
                ?.map((r: Restriction) => r.zoneAlerte.type)
                .flat(),
            ),
        ),
      ].sort();

      return ar;
    });
  }
}
