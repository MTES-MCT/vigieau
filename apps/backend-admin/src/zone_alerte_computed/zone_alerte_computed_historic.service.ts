import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { ZoneAlerte } from '@shared/entities/zone_alerte.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { ZoneAlerteComputedHistoric } from '@shared/entities/zone_alerte_computed_historic.entity';
import { exec } from 'child_process';
import fs from 'fs';
import moment, { Moment } from 'moment';
import { writeFile } from 'node:fs/promises';
import { DataSource, FindManyOptions, IsNull, Repository } from 'typeorm';
import util from 'util';
import { ArreteRestrictionService } from '../arrete_restriction/arrete_restriction.service';
import { CommuneService } from '../commune/commune.service';
import { ConfigService } from '../config/config.service';
import { Utils } from '../core/utils';
import { DatagouvService } from '../datagouv/datagouv.service';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { RestrictionService } from '../restriction/restriction.service';
import { S3Service } from '../shared/services/s3.service';
import { StatisticService } from '../statistic/statistic.service';
import { StatisticCommuneService } from '../statistic_commune/statistic_commune.service';
import { StatisticDepartementService } from '../statistic_departement/statistic_departement.service';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';

@Injectable()
export class ZoneAlerteComputedHistoricService {
  private readonly logger = new RegleauLogger(
    'ZoneAlerteComputedHistoricService',
  );
  // Promisifier exec
  private execPromise = util.promisify(exec);

  constructor(
    @Inject(forwardRef(() => ArreteRestrictionService))
    private readonly arreteResrictionService: ArreteRestrictionService,
    private readonly zoneAlerteService: ZoneAlerteService,
    private readonly nestConfigService: NestConfigService,
    private readonly s3Service: S3Service,
    private readonly statisticService: StatisticService,
    private readonly departementService: DepartementService,
    private readonly communeService: CommuneService,
    @InjectRepository(ZoneAlerteComputedHistoric)
    private readonly zoneAlerteComputedHistoricRepository: Repository<ZoneAlerteComputedHistoric>,
    private readonly restrictionService: RestrictionService,
    @Inject(forwardRef(() => StatisticDepartementService))
    private readonly statisticDepartementService: StatisticDepartementService,
    @Inject(forwardRef(() => StatisticCommuneService))
    private readonly statisticCommuneService: StatisticCommuneService,
    @Inject(forwardRef(() => DatagouvService))
    private readonly dataGouvService: DatagouvService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    setTimeout(() => {
      // this.computeHistoricMapsComputed(moment('2024-04-29'));
      // this.computeHistoricMaps(moment('2023-01-01'));
    }, 5000);
  }

  findOne(id: number): Promise<any> {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select('zone_alerte_computed_historic.id', 'id')
      .addSelect('zone_alerte_computed_historic.code', 'code')
      .addSelect('zone_alerte_computed_historic.nom', 'nom')
      .addSelect('zone_alerte_computed_historic.type', 'type')
      .addSelect(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte_computed_historic.geom, 4326))',
        'geom',
      )
      .where('zone_alerte_computed_historic.id = :id', { id })
      .getRawOne();
  }

  async computeHistoricMaps(date?: Moment, dateStats?: Moment) {
    const dateDebut = date ? date : moment();
    // const dateFin = moment('2024-04-28');
    const dateFin = moment('2023-12-31');

    for (
      let m = moment(dateDebut);
      m.diff(dateFin, 'days') <= 0;
      m.add(1, 'days')
    ) {
      const ars = await this.arreteResrictionService.findByDate(m);
      let zas: ZoneAlerte[] = <ZoneAlerte[]>(
        await this.zoneAlerteService.findByArreteRestriction(
          ars.map((ar) => ar.id),
        )
      );

      const zasFormated = await Promise.all(
        zas.map(async (z) => {
          z.geom = JSON.parse(
            (await this.zoneAlerteService.findOne(z.id)).geom,
          );
          return {
            type: 'Feature',
            geometry: z.geom,
            properties: {
              id: z.id,
              idSandre: z.idSandre,
              nom: z.nom,
              code: z.code,
              type: z.type,
              niveauGravite: z.restrictions[0].niveauGravite,
              departement: z.departement,
              arreteRestriction: {
                id: z.restrictions[0].arreteRestriction.id,
                numero: z.restrictions[0].arreteRestriction.numero,
                dateDebut: z.restrictions[0].arreteRestriction.dateDebut,
                dateFin: z.restrictions[0].arreteRestriction.dateFin,
                dateSignature:
                  z.restrictions[0].arreteRestriction.dateSignature,
                fichier: z.restrictions[0].arreteRestriction.fichier?.url,
              },
              restrictions: z.restrictions[0].usages.map((u) => {
                let d;
                switch (z.restrictions[0].niveauGravite) {
                  case 'vigilance':
                    d = u.descriptionVigilance;
                    break;
                  case 'alerte':
                    d = u.descriptionAlerte;
                    break;
                  case 'alerte_renforcee':
                    d = u.descriptionAlerteRenforcee;
                    break;
                  case 'crise':
                    d = u.descriptionCrise;
                    break;
                }
                return {
                  nom: u.nom,
                  thematique: u.thematique.nom,
                  concerneParticulier: u.concerneParticulier,
                  concerneEntreprise: u.concerneEntreprise,
                  concerneCollectivite: u.concerneCollectivite,
                  concerneExploitation: u.concerneExploitation,
                  concerneEso: u.concerneEso,
                  concerneEsu: u.concerneEsu,
                  concerneAep: u.concerneAep,
                  description: d,
                };
              }),
            },
          };
        }),
      );

      const geojson = {
        type: 'FeatureCollection',
        features: zasFormated,
      };

      const path = this.nestConfigService.get('PATH_TO_WRITE_FILE');

      const fileNameToSave = `zones_arretes_en_vigueur_${m.format('YYYY-MM-DD')}`;
      await writeFile(
        `${path}/${fileNameToSave}.geojson`,
        JSON.stringify(geojson),
      );
      try {
        await this.execPromise(
          `${path}/tippecanoe_program/bin/tippecanoe -Z4 -zg -pg -ai -pn -f --drop-densest-as-needed -l zones_arretes_en_vigueur --read-parallel --detect-shared-borders --simplification=10 --output=${path}/${fileNameToSave}.pmtiles ${path}/${fileNameToSave}.geojson`,
        );
        const dataPmtiles = fs.readFileSync(
          `${path}/${fileNameToSave}.pmtiles`,
        );
        const fileToTransferPmtiles = {
          originalname: `${fileNameToSave}.pmtiles`,
          buffer: dataPmtiles,
        };
        const dataGeojson = fs.readFileSync(
          `${path}/${fileNameToSave}.geojson`,
        );
        const fileToTransferGeojson = {
          originalname: `${fileNameToSave}.geojson`,
          buffer: dataGeojson,
        };
        // @ts-ignore
        await this.s3Service.uploadFile(fileToTransferPmtiles, 'pmtiles/');
        // @ts-ignore
        await this.s3Service.uploadFile(fileToTransferGeojson, 'geojson/');
      } catch (e) {
        this.logger.error('ERROR GENERATING PMTILES', e);
      }
      if (dateStats && dateStats.isSameOrAfter(m, 'day')) {
        // @ts-ignore
        await this.statisticDepartementService.computeDepartementStatisticsRestrictions(
          zas.map((z) => {
            // @ts-ignore
            z.restriction = z.restrictions[0];
            // @ts-ignore
            return z as ZoneAlerteComputed;
          }),
          new Date(m.format('YYYY-MM-DD')),
          true,
          true,
        );
        // @ts-ignore
        await this.statisticCommuneService.computeCommuneStatisticsRestrictions(
          zas.map((z) => {
            // @ts-ignore
            z.restriction = z.restrictions[0];
            // @ts-ignore
            return z as ZoneAlerteComputed;
          }),
          new Date(m.format('YYYY-MM-DD')),
          true,
          true,
        );
        await this.statisticService.computeDepartementsSituationHistoric(
          zas,
          m.format('YYYY-MM-DD'),
        );
        await this.configService.setConfig(null, m.format('YYYY-MM-DD'));
      }
      await this.configService.setConfig(m.format('YYYY-MM-DD'));
    }
  }

  async computeHistoricMapsComputed(date?: Moment, dateStats?: Moment) {
    const dateDebut = date ? date : moment();
    const dateFin = moment().subtract(1, 'days');
    // const dateFin = moment('23/06/2024', 'DD/MM/YYYY');

    for (
      let m = moment(dateDebut);
      m.diff(dateFin, 'days', true) <= 0;
      m.add(1, 'days')
    ) {
      this.logger.log(
        `COMPUTING ZONES D'ALERTES ${m.format('DD/MM/YYYY')} - BEGIN`,
      );
      let departements = await this.departementService.findAllLight();

      for (const departement of departements) {
        const param = departement.parametres.find(
          (p) =>
            m.isSameOrAfter(moment(p.dateDebut)) &&
            (!p.dateFin || m.isSameOrBefore(moment(p.dateFin))),
        )?.superpositionCommune;
        const zonesSaved = await this.computeRegleAr(departement, m);
        if (zonesSaved.length > 0) {
          switch (param) {
            case 'no':
            case 'no_all':
              break;
            case 'yes_all':
              await this.computeYesDistinct(departement, false);
              await this.computeYesAll(departement, false);
              break;
            case 'yes_only_aep':
              await this.computeYesDistinct(departement, true);
              break;
            case 'yes_except_aep':
              await this.computeYesDistinct(departement, false);
              await this.computeYesAll(departement, true);
              break;
            case 'yes_distinct':
              await this.computeYesDistinct(departement, false);
              break;
            default:
              this.logger.error(
                `COMPUTING ${departement.code} - ${departement.nom} - ${param} not implemented`,
                '',
              );
          }
        }
        await this.computeCommunesIntersected(departement);
      }
      // On récupère toutes les restrictions en cours
      this.logger.log(
        `COMPUTING ZONES D'ALERTES ${m.format('DD/MM/YYYY')} - END`,
      );

      const allZonesComputed = await this.computeGeoJson(m);
      if (dateStats && dateStats.isSameOrAfter(m, 'day')) {
        await this.statisticDepartementService.computeDepartementStatisticsRestrictions(
          allZonesComputed,
          new Date(m.format('YYYY-MM-DD')),
          true,
        );
        await this.statisticCommuneService.computeCommuneStatisticsRestrictions(
          allZonesComputed,
          new Date(m.format('YYYY-MM-DD')),
          true,
        );
        await this.statisticService.computeDepartementsSituation(
          allZonesComputed,
          m.format('YYYY-MM-DD'),
        );
        await this.configService.setConfig(
          null,
          m.format('YYYY-MM-DD'),
          null,
          true,
        );
      }
      await this.zoneAlerteComputedHistoricRepository.update(
        {},
        { enabled: true },
      );
      await this.configService.setConfig(
        m.format('YYYY-MM-DD'),
        null,
        null,
        true,
      );
    }
    await this.statisticCommuneService.sortStatCommune();
    await this.statisticDepartementService.sortStatDepartement();
    await this.dataGouvService.updateMaps(dateDebut);
  }

  async computeRegleAr(departement: Departement, date: Moment) {
    const arretesRestrictions =
      await this.arreteResrictionService.findByDepartementAndDate(
        departement.code,
        date,
      );
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${arretesRestrictions.length} arrêtés de restriction`,
    );
    let zonesToSave = [];
    for (const ar of arretesRestrictions) {
      await Promise.all(
        ar.restrictions.map(async (restriction) => {
          if (restriction.zoneAlerte) {
            const za = await this.zoneAlerteService.findOne(
              restriction.zoneAlerte.id,
              [restriction.arreteCadre.id],
            );
            za.restriction = {
              id: restriction.id,
              niveauGravite: restriction.niveauGravite,
            };
            za.departement = { id: departement.id };

            if (
              za.arreteCadreZoneAlerteCommunes &&
              za.arreteCadreZoneAlerteCommunes[0] &&
              za.arreteCadreZoneAlerteCommunes[0].communes?.length > 0
            ) {
              za.geom =
                await this.zoneAlerteService.getUnionGeomOfZoneAndCommunes(
                  za.id,
                  za.arreteCadreZoneAlerteCommunes[0].communes.map((c) => c.id),
                );
            }
            // SAUVEGARDE ZONE ESU ou ESO
            zonesToSave.push(za);
          } else if (restriction.communes?.length > 0) {
            const za = {
              nom: restriction.nomGroupementAep,
              type: 'AEP',
              geom: null,
              departement: { id: departement.id },
              bassinVersant: null,
              restriction: {
                id: restriction.id,
                niveauGravite: restriction.niveauGravite,
              },
            };
            za.geom = (
              await this.communeService.getUnionGeomOfCommunes(
                restriction.communes,
              )
            ).geom;
            // SAUVEGARDE ZONE AEP
            zonesToSave.push(za);
          }
        }),
      );
    }

    zonesToSave = zonesToSave
      .filter((z) => z.geom)
      .map((z) => {
        z.id = null;
        z.geom = JSON.parse(z.geom);
        z.niveauGravite = z.restriction.niveauGravite;
        return z;
      })
      .filter((z) => z.geom.coordinates.length > 0);
    await Promise.all([
      this.zoneAlerteComputedHistoricRepository.delete({
        departement: IsNull(),
      }),
      this.zoneAlerteComputedHistoricRepository.delete({
        departement: departement,
      }),
    ]);
    const toReturn =
      await this.zoneAlerteComputedHistoricRepository.save(zonesToSave);
    if (toReturn.length > 0) {
      await this.cleanZones(departement);
    }
    const param = departement.parametres.find(
      (p) =>
        date.isSameOrAfter(moment(p.dateDebut)) &&
        (!p.dateFin || date.isSameOrBefore(moment(p.dateFin))),
    )?.superpositionCommune;
    if (!param || param !== 'yes_all') {
      await this.computeRegleAepNotSpecific(departement, date);
    }
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${zonesToSave.length} zones ajoutées`,
    );
    return toReturn;
  }

  async computeRegleAepNotSpecific(departement: Departement, date: Moment) {
    const arretesRestrictions =
      await this.arreteResrictionService.findByDepartementAndDate(
        departement.code,
        date,
      );
    const zonesDepartement =
      await this.getZonesAlerteComputedByDepartement(departement);
    let zonesToSave = [];
    for (const ar of arretesRestrictions) {
      let zonesAr = zonesDepartement.filter(
        (z) => z.restriction?.arreteRestriction.id === ar.id,
      );
      if (
        ar.niveauGraviteSpecifiqueEap === false &&
        ar.ressourceEapCommunique &&
        zonesAr.length > 0
      ) {
        let allZones;

        if (
          ar.ressourceEapCommunique === 'eso' ||
          ar.ressourceEapCommunique === 'esu'
        ) {
          allZones = zonesAr.filter(
            (z) =>
              z.type ===
                (ar.ressourceEapCommunique === 'eso' ? 'SOU' : 'SUP') &&
              ar.restrictions.some((r) => r.id === z.restriction.id),
          );
          allZones = structuredClone(allZones);
        } else {
          const zonesEsu: any = structuredClone(
            zonesAr.filter((z) => z?.type === 'SUP'),
          );
          const zonesEso: any = structuredClone(
            zonesAr.filter((z) => z?.type === 'SOU'),
          );
          allZones = [...zonesEsu, ...zonesEso];
        }

        // On boucle sur toutes les zones et on stock un tableau intersect avec les autres zones
        if (allZones.length > 1) {
          for (const zone of allZones) {
            zone.intersect = await this.getIntersect(
              zone.id,
              allZones.filter((z) => z.id !== zone.id).map((z) => z.id),
            );
          }
        }

        // Pour les zones de l'AR qui ne s'intersectent pas, on peut les copier et les enregistrer sous AEP
        const zonesWithoutIntersection = allZones
          .filter((z) => !z.intersect || z.intersect.length < 1)
          .map((z) => {
            z.type = 'AEP';
            return z;
          });
        zonesToSave = zonesToSave.concat(zonesWithoutIntersection);
        // Pour chaque couple de zone qui s'intersectent, vérifier celle qui a le niveau de gravité max et qui doit être prioritaire
        let zonesWithIntersection = allZones
          .filter((z) => z.intersect && z.intersect.length > 0)
          .map((z) => {
            z.add = [];
            z.remove = [];
            return z;
          });
        for (const z of allZones.filter(
          (z) => z.intersect && z.intersect.length > 0,
        )) {
          for (const zIntersected of z.intersect) {
            // On décide ici quelle portion de quelle zone on ajoute ou on enlève à l'autre
            // Si même niveau de gravité, on prend la zone au pif
            // Si ressource naturelle && ressource influencée, la ressource naturelle à l'aval pour l'AEP
            if (
              (z.type === zIntersected.type &&
                !z.ressourceInfluencee &&
                zIntersected.ressourceInfluencee) ||
              (!(
                z.type === zIntersected.type &&
                z.ressourceInfluencee &&
                !zIntersected.ressourceInfluencee
              ) &&
                this.getNiveauGravite(z.id, ar.restrictions) >=
                  this.getNiveauGravite(zIntersected.id, ar.restrictions))
            ) {
              zonesWithIntersection
                .find((zwi) => zwi.id === z.id)
                .add.push(zIntersected.id);
              zonesWithIntersection
                .find((zwi) => zwi.id === zIntersected.id)
                .remove.push(z.id);
            } else {
              zonesWithIntersection
                .find((zwi) => zwi.id === z.id)
                .remove.push(zIntersected.id);
              zonesWithIntersection
                .find((zwi) => zwi.id === zIntersected.id)
                .add.push(z.id);
            }

            // On supprime la zone en question de zIntersected afin de ne pas faire le calcul en double
            const zi = allZones.find((az) => az.id === zIntersected.id);
            zi.intersect = zi.intersect.filter((iz) => iz.id !== z.id);
          }
        }
        for (const z of zonesWithIntersection) {
          // On construit les nouvelles géométries de zones
          z.geom = (await this.computeNewZone(z)).geom;
        }
        zonesWithIntersection = zonesWithIntersection.map((z) => {
          z.type = 'AEP';
          return z;
        });
        zonesToSave = zonesToSave.concat(zonesWithIntersection);
      }
    }
    zonesToSave = zonesToSave
      .map((z) => {
        z.id = null;
        z.geom = JSON.parse(z.geom);
        return z;
      })
      .filter((z) => z.geom.coordinates?.length > 0);
    const toReturn =
      await this.zoneAlerteComputedHistoricRepository.save(zonesToSave);
    if (toReturn.length > 0) {
      await this.cleanZones(departement);
    }
  }

  // Chaque type de zone doit être harmonisé indépendamment à la commune
  async computeYesDistinct(departement, onlyAep: boolean) {
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${onlyAep ? 'YES_ONLY_AEP' : 'YES_DISTINCT'} BEGIN`,
    );
    // On récupères les communes avec des ZA qui ne couvrent pas totalement la zone
    const communes =
      await this.communeService.getZoneAlerteComputedHistoricForHarmonisation(
        departement.id,
      );
    const zoneTypes = onlyAep ? ['AEP'] : ['SUP', 'SOU', 'AEP'];
    const queries = [];
    for (const commune of communes) {
      for (const zoneType of zoneTypes) {
        let zonesSameType = commune.zones.filter((z) => z.type === zoneType);
        // Gestion des zones influencées
        // Si il y a des ressources influencées ET des ressources naturelles, on exclut les ressources influencées des calculs
        if (
          zonesSameType.length > 1 &&
          zonesSameType.some(
            (z) => z.ressourceInfluencee && z.areaCommunePercentage >= 5,
          ) &&
          zonesSameType.some(
            (z) => !z.ressourceInfluencee && z.areaCommunePercentage >= 5,
          )
        ) {
          zonesSameType = zonesSameType.filter((z) => !z.ressourceInfluencee);
        }

        // Quand une seule zone, on l'agrandie à la geometrie de la commune
        if (
          zonesSameType.length === 1 &&
          zonesSameType[0].areaCommunePercentage >= 5
        ) {
          queries.push(
            this.getQueryToExtendZone(zonesSameType[0].id, commune.id),
          );
        } else if (zonesSameType.length > 1) {
          // Si plusieurs zones, soit elles sont toutes au même niveau de gravité et on prend celle qui couvre le plus le territoire
          // Soit on prend celle qui a le niveau de gravité le plus élevé
          const zonesSameTypeExploitables = zonesSameType.filter(
            (z) => z.areaCommunePercentage >= 5,
          );
          if (zonesSameTypeExploitables.length >= 1) {
            const maxNiveauGravite = zonesSameTypeExploitables.reduce(
              (prev, current) => {
                return Utils.getNiveau(prev.niveauGravite) >
                  Utils.getNiveau(current.niveauGravite)
                  ? prev
                  : current;
              },
            );
            const zonesSameTypeMaxNiveau = zonesSameTypeExploitables.filter(
              (z) => z.niveauGravite === maxNiveauGravite.niveauGravite,
            );
            const zoneToExtend =
              zonesSameTypeMaxNiveau.length === 1
                ? zonesSameTypeMaxNiveau[0]
                : zonesSameTypeMaxNiveau.reduce((prev, current) => {
                    return prev.areaCommune > current.areaCommune
                      ? prev
                      : current;
                  });
            const zonesToReduce = zonesSameType.filter(
              (z) => z.id !== zoneToExtend.id,
            );
            queries.push(
              this.getQueryToExtendZone(zoneToExtend.id, commune.id),
            );
            zonesToReduce.forEach((z) => {
              queries.push(this.getQueryToReduceZone(z.id, commune.id));
            });
          }
        }
      }
    }
    await Promise.all(queries.map((q) => q.execute()));
    await this.cleanZones(departement);
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${onlyAep ? 'YES_ONLY_AEP' : 'YES_DISTINCT'} END`,
    );
  }

  async computeYesAll(departement, exceptAep: boolean) {
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${exceptAep ? 'YES_EXCEPT_AEP' : 'YES_ALL'} BEGIN`,
    );
    // On récupères les communes avec des ZA (même celles qui couvrent totalement la commune)
    const communes =
      await this.communeService.getZoneAlerteComputedHistoricForHarmonisation(
        departement.id,
      );
    const zoneTypes = exceptAep ? ['SUP', 'SOU'] : ['SUP', 'SOU', 'AEP'];
    const queries = [];
    let zonesToSave = [];
    for (const commune of communes) {
      // On filtre sur les aires des zones / communes pour éviter les zones résiduelles
      const zones = commune.zones.filter(
        (z) =>
          zoneTypes.includes(z.type) &&
          commune.area.toFixed(10) === z.areaCommune.toFixed(10),
      );
      if (!zones || zones.length <= 0) {
        continue;
      }
      const maxNiveauGravite = zones.reduce((prev, current) => {
        return Utils.getNiveau(prev.niveauGravite) >
          Utils.getNiveau(current.niveauGravite)
          ? prev
          : current;
      }).niveauGravite;
      for (const zoneType of zoneTypes) {
        // Normalement il y a au maximum une zone par type mais si ils ont fait plusieurs AR avec des règles de gestions différentes il se peut que plusieurs zones AEP se superposent
        let zonesSameType = zones.filter((z) => z.type === zoneType);

        // Gestion des ressources influencées
        if (
          zonesSameType.some((z) => z.ressourceInfluencee) &&
          zonesSameType.some((z) => !z.ressourceInfluencee)
        ) {
          zonesSameType = zonesSameType.filter((z) => !z.ressourceInfluencee);
        }

        if (
          zonesSameType.length === 1 &&
          zonesSameType[0].niveauGravite !== maxNiveauGravite
        ) {
          // Si il n'y a qu'une zone et que ce n'est pas son niveau de gravité de base, on la duplique pour avoir la zone au niveau de la commune avec le bon niveau de gravité
          let zoneToDuplicate = await this.findOneWithCommuneZone(
            zonesSameType[0].id,
            commune.id,
          );
          zoneToDuplicate.niveauGravite = maxNiveauGravite;
          zonesToSave.push(zoneToDuplicate);
          queries.push(
            this.getQueryToReduceZone(zonesSameType[0].id, commune.id),
          );
        } else if (zonesSameType.length > 1) {
          // Si plusieurs zones du même type, on prend celle qui a le niveau de gravité le plus élevé, ou une au pif
          const maxNiveauGraviteZonesSameType = zonesSameType.reduce(
            (prev, current) => {
              return Utils.getNiveau(prev.niveauGravite) >
                Utils.getNiveau(current.niveauGravite)
                ? prev
                : current;
            },
          ).niveauGravite;
          let zoneToKeep = zonesSameType.filter(
            (z) => z.niveauGravite === maxNiveauGraviteZonesSameType,
          );
          if (zoneToKeep.length > 1) {
            zoneToKeep = zoneToKeep.reduce((prev, current) => {
              return prev.areaCommune > current.areaCommune ? prev : current;
            });
          } else {
            zoneToKeep = zoneToKeep[0];
          }
          if (zoneToKeep.niveauGravite !== maxNiveauGravite) {
            let zoneToDuplicate = await this.findOneWithCommuneZone(
              zoneToKeep.id,
              commune.id,
            );
            zoneToDuplicate.niveauGravite = maxNiveauGravite;
            zonesToSave.push(zoneToDuplicate);
            queries.push(this.getQueryToReduceZone(zoneToKeep.id, commune.id));
          } else {
            queries.push(this.getQueryToExtendZone(zoneToKeep.id, commune.id));
          }
          zonesSameType
            .filter((z) => z.id !== zoneToKeep.id && !z.ressourceInfluencee)
            .forEach((z) => {
              queries.push(this.getQueryToReduceZone(z.id, commune.id));
            });
        } else if (zonesSameType.length <= 0) {
          // Si il n'y a pas de zone, on en crée une
          let zoneToDuplicate = zones
            .filter((z) => z.niveauGravite === maxNiveauGravite)
            .reduce((prev, current) => {
              return prev.areaCommune > current.areaCommune ? prev : current;
            });
          zoneToDuplicate = await this.findOneWithCommuneZone(
            zoneToDuplicate.id,
            commune.id,
          );
          zoneToDuplicate.type = zoneType;
          zonesToSave.push(zoneToDuplicate);
        }
      }
    }
    await Promise.all(queries.map((q) => q.execute()));
    zonesToSave = zonesToSave.map((z) => {
      z.id = null;
      z.geom = JSON.parse(z.geom);
      return z;
    });
    await this.zoneAlerteComputedHistoricRepository.save(zonesToSave);
    await this.fusionSameZones(departement);
    await this.cleanZones(departement);
    this.logger.log(
      `COMPUTING ${departement.code} - ${departement.nom} - ${exceptAep ? 'YES_EXCEPT_AEP' : 'YES_ALL'} END`,
    );
  }

  getNiveauGravite(zoneId, restrictions) {
    const r = restrictions.find((r) =>
      r.zonesAlerteComputed?.some((z) => z.id === zoneId),
    );
    return Utils.getNiveau(r?.niveauGravite);
  }

  getQueryToExtendZone(zoneId, communeId) {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .update()
      .set({
        geom: () =>
          `ST_UNION(zone_alerte_computed_historic.geom, (select c.geom from commune as c where c.id = ${communeId}))`,
      })
      .where('zone_alerte_computed_historic.id = :id', { id: zoneId });
  }

  getQueryToReduceZone(zoneId, communeId) {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .update()
      .set({
        geom: () =>
          `ST_DIFFERENCE(zone_alerte_computed_historic.geom, (select c.geom from commune as c where c.id = ${communeId}))`,
      })
      .where('zone_alerte_computed_historic.id = :id', { id: zoneId });
  }

  async cleanZones(departement: Departement) {
    await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .update()
      .set({
        geom: () =>
          `st_makevalid(geom, 'method=structure keepcollapsed=false')`,
      })
      .where('not st_isvalid(geom)')
      .andWhere('"departementId" = :id', { id: departement.id })
      .execute();
    await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .update()
      .set({ geom: () => 'ST_CollectionExtract(geom, 3)' })
      .where('"departementId" = :id', { id: departement.id })
      .execute();
    // Clean des résidus de moins de 100m²
    await this.dataSource.query(
      `
WITH cleaned_geometries AS (
      SELECT
          id,
          ST_Collect(geom) AS cleaned_geom
      FROM (
          SELECT
              id,
              (ST_Dump(geom)).geom AS geom
          FROM zone_alerte_computed_historic
      ) AS dumped
      WHERE ST_GeometryType(geom) = 'ST_Polygon' AND ST_Area(ST_Transform(geom, 2154)) > 100
      GROUP BY id
    )
    UPDATE zone_alerte_computed_historic
    SET geom = cleaned_geometries.cleaned_geom
    FROM cleaned_geometries
    WHERE zone_alerte_computed_historic.id = cleaned_geometries.id AND zone_alerte_computed_historic."departementId" = $1;
  `,
      [departement.id],
    );
    return;
  }

  async computeCommunesIntersected(departement: Departement) {
    const zones = await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select([
        'zone_alerte_computed_historic.id',
        'zone_alerte_computed_historic.idSandre',
        'zone_alerte_computed_historic.nom',
        'zone_alerte_computed_historic.code',
        'zone_alerte_computed_historic.type',
      ])
      .leftJoin('zone_alerte_computed_historic.departement', 'departement')
      // Au moins 1% de la surface en commun
      .leftJoinAndSelect(
        'commune',
        'commune',
        'commune.departement = departement.id AND ST_INTERSECTS(zone_alerte_computed_historic.geom, commune.geom) AND ST_Area(ST_Intersection(zone_alerte_computed_historic.geom, commune.geom)) / ST_AREA(commune.geom) > 0.01',
      )
      .where('departement.id = :id', { id: departement.id })
      .andWhere(
        `ST_GeometryType(zone_alerte_computed_historic.geom) IN ('ST_Polygon', 'ST_MultiPolygon')`,
      )
      .andWhere(
        'ST_IsValid(ST_TRANSFORM(zone_alerte_computed_historic.geom, 4326))',
      )
      .andWhere('ST_IsValid(ST_TRANSFORM(commune.geom, 4326))')
      .getRawMany();
    const toSave = [];
    zones.forEach((z) => {
      if (!toSave.some((s) => s.id === z.zone_alerte_computed_historic_id)) {
        toSave.push({
          id: z.zone_alerte_computed_historic_id,
          communes: [],
        });
      }
      const s = toSave.find((s) => s.id === z.zone_alerte_computed_historic_id);
      if (z.commune_id) {
        s.communes.push({
          id: z.commune_id,
        });
      }
    });
    await this.zoneAlerteComputedHistoricRepository.save(toSave);
  }

  async getZonesAlerteComputedByDepartement(
    departement: Departement,
  ): Promise<ZoneAlerteComputedHistoric[]> {
    const zonesDepartement = await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte_computed_historic.geom, 4326))',
        'geom',
      )
      .addSelect('zone_alerte_computed_historic.id', 'id')
      .addSelect('zone_alerte_computed_historic.idSandre', 'idSandre')
      .addSelect('zone_alerte_computed_historic.nom', 'nom')
      .addSelect('zone_alerte_computed_historic.code', 'code')
      .addSelect('zone_alerte_computed_historic.type', 'type')
      .addSelect(
        'zone_alerte_computed_historic.ressourceInfluencee',
        'ressourceInfluencee',
      )
      .addSelect('departement.id', 'departement_id')
      .addSelect('"niveauGravite"')
      .leftJoin('zone_alerte_computed_historic.departement', 'departement')
      .where('departement.id = :id', { id: departement.id })
      .getRawMany();
    // @ts-ignore
    await Promise.all(
      zonesDepartement.map(async (z) => {
        z.restriction =
          await this.restrictionService.findOneByZoneAlerteComputedHistoric(
            z.id,
          );
        z.departement = {
          id: z.departement_id,
        };
        return z;
      }),
    );
    return zonesDepartement;
  }

  computeNewZone(zone: any) {
    const qb = this.zoneAlerteComputedHistoricRepository.createQueryBuilder(
      'zone_alerte_computed_historic',
    );
    let sqlString = `ST_AsGeoJSON(ST_TRANSFORM(`;
    if (zone.remove && zone.remove.length > 0) {
      sqlString += `ST_DIFFERENCE(zone_alerte_computed_historic.geom, `;
      sqlString += `(SELECT ST_UNION(zaBis.geom) FROM zone_alerte_computed_historic as zaBis WHERE zaBis.id IN (${zone.remove.join(', ')}))`;
      sqlString += `)`;
    } else {
      sqlString += `zone_alerte_computed_historic.geom`;
    }
    sqlString += `, 4326))`;
    return qb
      .select(sqlString, 'geom')
      .where('zone_alerte_computed_historic.id = :id', { id: zone.id })
      .getRawOne();
  }

  getIntersect(zoneId: number, otherZonesId: number[]) {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select('zone_alerte_computed_historic.id', 'id')
      .addSelect('zone_alerte_computed_historic.code', 'code')
      .addSelect('zone_alerte_computed_historic.nom', 'nom')
      .addSelect('zone_alerte_computed_historic.type', 'type')
      .where('zone_alerte_computed_historic.id != :id', { id: zoneId })
      .andWhere('zone_alerte_computed_historic.id IN(:...ids)', {
        ids: otherZonesId,
      })
      .andWhere(
        'ST_INTERSECTS(zone_alerte_computed_historic.geom, (SELECT zaBis.geom FROM zone_alerte_computed_historic as zaBis WHERE zaBis.id = :id))',
        { id: zoneId },
      )
      .getRawMany();
  }

  getZonesIntersectedWithCommune(
    zones: ZoneAlerteComputedHistoric[],
    communeId: number,
  ) {
    return (
      this.zoneAlerteComputedHistoricRepository
        .createQueryBuilder('zone_alerte_computed_historic')
        .select('zone_alerte_computed_historic.id', 'id')
        .addSelect('zone_alerte_computed_historic.code', 'code')
        .addSelect('zone_alerte_computed_historic.nom', 'nom')
        .addSelect('zone_alerte_computed_historic.type', 'type')
        .where('zone_alerte_computed_historic.id IN(:...zonesId)', {
          zonesId: zones.map((z) => z.id),
        })
        .andWhere(
          `ST_GeometryType(zone_alerte_computed_historic.geom) IN ('ST_Polygon', 'ST_MultiPolygon')`,
        )
        .andWhere(
          'ST_INTERSECTS(zone_alerte_computed_historic.geom, (SELECT c.geom FROM commune as c WHERE c.id = :communeId))',
          { communeId },
        )
        // Au moins 1% de la surface en commun
        .andWhere(
          'ST_Area(ST_Intersection(zone_alerte_computed_historic.geom, (SELECT c.geom FROM commune as c WHERE c.id = :communeId))) / ST_Area((SELECT c.geom FROM commune as c WHERE c.id = :communeId)) > 0.01',
          { communeId },
        )
        .getRawMany()
    );
  }

  async findOneWithCommuneZone(id: number, communeId: number): Promise<any> {
    const zoneFull = await this.zoneAlerteComputedHistoricRepository.findOne({
      where: { id },
      relations: ['departement', 'bassinVersant', 'restriction'],
    });
    const zoneGeom = await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed')
      .select(
        `ST_AsGeoJSON(ST_TRANSFORM((select commune.geom from commune where commune.id = ${communeId}), 4326))`,
        'geom',
      )
      .where('zone_alerte_computed.id = :id', { id })
      .getRawOne();
    zoneFull.geom = zoneGeom.geom;
    return zoneFull;
  }

  async fusionSameZones(departement: Departement) {
    const groupedResults = await this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select('MIN(id)', 'id')
      .addSelect(['nom', 'type', '"niveauGravite"'])
      .addSelect('ST_Union(geom)', 'merged_geom')
      .groupBy('nom')
      .addGroupBy('type')
      .addGroupBy('"niveauGravite"')
      .where('"departementId" = :id', { id: departement.id })
      .having('COUNT(*) > 1')
      .getRawMany();

    await Promise.all(
      groupedResults.map(async (row) => {
        const { id, nom, type, niveauGravite, merged_geom } = row;
        return this.dataSource.query(
          `
UPDATE zone_alerte_computed_historic
    SET geom = $1
    WHERE id = $2
  `,
          [merged_geom, id],
        );
      }),
    );

    await Promise.all(
      groupedResults.map(async (row) => {
        const { nom, type, niveauGravite, id } = row;
        return this.dataSource.query(
          `
DELETE FROM zone_alerte_computed_historic 
    WHERE nom = $2 AND type = $3 AND "niveauGravite" = $4 AND "departementId" = $5 AND id != $1
  `,
          [id, nom, type, niveauGravite, departement.id],
        );
      }),
    );
  }

  async computeGeoJson(date: Moment) {
    let allZonesComputed: any =
      await this.zoneAlerteComputedHistoricRepository.find(<FindManyOptions>{
        select: {
          id: true,
          idSandre: true,
          code: true,
          nom: true,
          type: true,
          departement: {
            code: true,
            nom: true,
          },
          restriction: {
            niveauGravite: true,
            arreteRestriction: {
              id: true,
              numero: true,
              dateDebut: true,
              dateFin: true,
              dateSignature: true,
              fichier: {
                url: true,
              },
            },
            usages: {
              nom: true,
              concerneParticulier: true,
              concerneEntreprise: true,
              concerneExploitation: true,
              concerneCollectivite: true,
              concerneEso: true,
              concerneEsu: true,
              concerneAep: true,
              descriptionVigilance: true,
              descriptionAlerte: true,
              descriptionAlerteRenforcee: true,
              descriptionCrise: true,
              thematique: {
                nom: true,
              },
            },
          },
        },
        relations: [
          'departement',
          'restriction',
          'restriction.usages',
          'restriction.usages.thematique',
          'restriction.arreteRestriction',
          'restriction.arreteRestriction.fichier',
        ],
      });

    const allZones = await Promise.all(
      allZonesComputed.map(async (z) => {
        z.geom = JSON.parse((await this.findOne(z.id)).geom);
        return {
          type: 'Feature',
          geometry: z.geom,
          properties: {
            id: z.id,
            idSandre: z.idSandre,
            nom: z.nom,
            code: z.code,
            type: z.type,
            niveauGravite: z.restriction?.niveauGravite,
            departement: z.departement,
            arreteRestriction: {
              id: z.restriction?.arreteRestriction.id,
              numero: z.restriction?.arreteRestriction.numero,
              dateDebut: z.restriction?.arreteRestriction.dateDebut,
              dateFin: z.restriction?.arreteRestriction.dateFin,
              dateSignature: z.restriction?.arreteRestriction.dateSignature,
              fichier: z.restriction?.arreteRestriction.fichier?.url,
            },
            restrictions: z.restriction?.usages.map((u) => {
              let d;
              switch (z.restriction.niveauGravite) {
                case 'vigilance':
                  d = u.descriptionVigilance;
                  break;
                case 'alerte':
                  d = u.descriptionAlerte;
                  break;
                case 'alerte_renforcee':
                  d = u.descriptionAlerteRenforcee;
                  break;
                case 'crise':
                  d = u.descriptionCrise;
                  break;
              }
              return {
                nom: u.nom,
                thematique: u.thematique.nom,
                concerneParticulier: u.concerneParticulier,
                concerneEntreprise: u.concerneEntreprise,
                concerneCollectivite: u.concerneCollectivite,
                concerneExploitation: u.concerneExploitation,
                concerneEso: u.concerneEso,
                concerneEsu: u.concerneEsu,
                concerneAep: u.concerneAep,
                description: d,
              };
            }),
          },
        };
      }),
    );

    const geojson = {
      type: 'FeatureCollection',
      features: allZones,
    };

    const path = this.nestConfigService.get('PATH_TO_WRITE_FILE');

    await writeFile(
      `${path}/zones_arretes_en_vigueur_${date.format('YYYY-MM-DD')}.geojson`,
      JSON.stringify(geojson),
    );
    const dataGeojson = fs.readFileSync(
      `${path}/zones_arretes_en_vigueur_${date.format('YYYY-MM-DD')}.geojson`,
    );
    const fileToTransferGeojson = {
      originalname: `zones_arretes_en_vigueur_${date.format('YYYY-MM-DD')}.geojson`,
      buffer: dataGeojson,
    };
    try {
      // @ts-ignore
      const s3ResponseGeojson = await this.s3Service.uploadFile(
        fileToTransferGeojson,
        'geojson/',
      );
    } catch (e) {
      this.logger.error('ERROR UPLOADING GEOJSON', e);
    }
    try {
      await this.execPromise(
        `${path}/tippecanoe_program/bin/tippecanoe -zg -pg -ai -pn -f --drop-densest-as-needed -l zones_arretes_en_vigueur --read-parallel --detect-shared-borders --simplification=10 --output=${path}/zones_arretes_en_vigueur_${date.format('YYYY-MM-DD')}.pmtiles ${path}/zones_arretes_en_vigueur_${date.format('YYYY-MM-DD')}.geojson`,
      );
      const data = fs.readFileSync(
        `${path}/zones_arretes_en_vigueur_${date.format('YYYY-MM-DD')}.pmtiles`,
      );
      const fileToTransfer = {
        originalname: `zones_arretes_en_vigueur_${date.format('YYYY-MM-DD')}.pmtiles`,
        buffer: data,
      };
      // @ts-ignore
      const s3Response = await this.s3Service.uploadFile(
        fileToTransfer as Express.Multer.File,
        'pmtiles/',
      );
    } catch (e) {
      this.logger.error('ERROR UPLOADING / GENERATING PMTILES', e);
    }
    return allZonesComputed;
  }

  async getZonesArea(zones: ZoneAlerteComputed[]) {
    return this.zoneAlerteComputedHistoricRepository
      .createQueryBuilder('zone_alerte_computed_historic')
      .select(
        'SUM(ST_Area(zone_alerte_computed_historic.geom::geography)/1000000)',
        'area',
      )
      .where('zone_alerte_computed_historic.id IN(:...ids)', {
        ids: zones.map((z) => z.id),
      })
      .getRawOne();
  }
}
