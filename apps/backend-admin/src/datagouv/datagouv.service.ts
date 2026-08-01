import { HttpService } from '@nestjs/axios';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
// CommonJS import keeps the callable export intact in both Jest and the Nest build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import archiver = require('archiver');
import { AxiosError } from 'axios';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { json2csv } from 'json-2-csv';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import JSZip = require('jszip');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import moment = require('moment');
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { catchError, firstValueFrom, lastValueFrom } from 'rxjs';
import { PassThrough, Readable, Transform } from 'stream';
import { DataSource, QueryRunner } from 'typeorm';
import { ArreteCadreService } from '../arrete_cadre/arrete_cadre.service';
import { ArreteRestrictionService } from '../arrete_restriction/arrete_restriction.service';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { S3Service } from '../shared/services/s3.service';
import { StatisticCommuneService } from '../statistic_commune/statistic_commune.service';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';
import {
  ExternalPublicationRegistryService,
  PublicationRunIdentity,
} from './external-publication-registry.service';

export interface DatagouvPublicationContext extends PublicationRunIdentity {
  verifyCurrent: () => Promise<void>;
}

interface LocalArtifact {
  byteSize: number;
  checksum: string;
  recordCount?: number;
  sourceDate?: string;
}

const DEFAULT_ARRETES_ARCHIVE_YEARS = [
  2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
];
const MAP_ARCHIVE_LOCK_RETRY_MS = 1_000;

@Injectable()
export class DatagouvService {
  private readonly logger = new RegleauLogger('DataGouvService');
  private path: string;
  private datagouvApiUrl: string;
  private datagouvApiKey: string;
  private datagouvResources = {
    arretes: 'f425cfa6-ccd1-438e-bb03-9d90ab527851',
    arretes_2012: 'c4e90996-fbdd-4496-9c56-af253900c7bf',
    arretes_2013: '6ac72ce0-8508-40db-b4bb-91464ae86937',
    arretes_2014: 'b1a43321-4218-400a-b795-61f956c536a7',
    arretes_2015: 'a24fc145-bebe-471f-ab01-660c160a19f6',
    arretes_2016: 'db90caca-ec1c-4b34-8e17-fd7693bd1d35',
    arretes_2017: 'c1de03e2-f948-4a8b-8d76-cfbaca9d071f',
    arretes_2018: '2b35ce5f-1539-4909-9473-2b6901447be9',
    arretes_2019: '1740aa06-2b91-4630-a05b-a46b611dfcbd',
    arretes_2020: 'a55dda0c-2088-41e2-96a0-2fda3875b7ec',
    arretes_2021: 'c88b5dcb-7975-4509-865a-5e5d6b3cde97',
    arretes_2022: '4489197f-63ce-4c8c-aff1-d2e1b02d2943',
    arretes_2023: '9091f47f-b5b9-4569-b3c9-252f2eae185e',
    arretes_2024: 'dcfdafd4-5f42-4445-9ee7-f4589e05c641',
    pmtiles: 'a101ef59-0999-4b9a-a682-6f9b79d53c7e',
    geojson: 'bfba7898-aed3-40ec-aa74-abb73b92a363',
    restrictions: 'e403a885-5eaf-411d-a03e-751a9c22930d',
    arretes_cadre: '0732e970-c12c-4e6a-adca-5ac9dbc3fdfa',
  };
  private readonly deadlineContext = new AsyncLocalStorage<AbortSignal>();
  private readonly httpTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly mapArchivesEnabled: boolean;

  constructor(
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => ArreteRestrictionService))
    private readonly arreteRestrictionService: ArreteRestrictionService,
    @Inject(forwardRef(() => ArreteCadreService))
    private readonly arreteCadreService: ArreteCadreService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => ZoneAlerteComputedService))
    private readonly zoneAlerteComputedService: ZoneAlerteComputedService,
    private readonly s3Service: S3Service,
    private readonly departementService: DepartementService,
    private readonly statisticCommuneService: StatisticCommuneService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly publicationRegistry: ExternalPublicationRegistryService,
  ) {
    this.path = this.configService.get('PATH_TO_WRITE_FILE');
    this.datagouvApiKey = this.configService.get('API_DATAGOUV_KEY');
    const apiUrl = this.configService.get<string>('API_DATAGOUV') || '';
    this.datagouvApiUrl = `${apiUrl.replace(/\/+$/, '')}/datasets/${this.configService.get('API_DATAGOUV_DATASET')}`;
    this.httpTimeoutMs = this.readPositiveInteger(
      'DATAGOUV_HTTP_TIMEOUT_MS',
      60_000,
    );
    this.runTimeoutMs = this.readPositiveInteger(
      'DATAGOUV_RUN_TIMEOUT_MS',
      30 * 60_000,
    );
    this.mapArchivesEnabled =
      this.configService.get<string>('DATAGOUV_MAP_ARCHIVES_ENABLED') ===
      'true';
  }

  /**
   * Vérifie si toutes les configurations nécessaires pour l'upload vers Datagouv sont présentes.
   * @returns {boolean} - `true` si toutes les configurations sont présentes, sinon `false`.
   */
  canUploadToDataGouv(): boolean {
    return (
      !!this.configService.get('API_DATAGOUV') &&
      !!this.configService.get('API_DATAGOUV_DATASET') &&
      !!this.datagouvApiKey
    );
  }

  async updateDatagouvData(
    scheduledFor = this.getParisDate(),
    publicationContext?: DatagouvPublicationContext,
  ): Promise<void> {
    return this.runWithDeadline(() =>
      this.updateDatagouvDataWithinDeadline(scheduledFor, publicationContext),
    );
  }

  private async updateDatagouvDataWithinDeadline(
    scheduledFor: string,
    publicationContext?: DatagouvPublicationContext,
  ): Promise<void> {
    if (!this.canUploadToDataGouv()) {
      throw new Error("Configuration manquante pour l'upload vers Datagouv");
    }

    this.logger.log('MISE A JOUR DATAGOUV - DEBUT');
    const failures: Array<{ name: string; error: unknown }> = [];
    await publicationContext?.verifyCurrent();

    let arretes: ArreteRestriction[] | undefined;
    try {
      arretes = await this.arreteRestrictionService.findDatagouv();
    } catch (error) {
      this.logDataGouvError('RECUPERATION DES ARRETES', error);
      failures.push({ name: 'RECUPERATION DES ARRETES', error });
    }

    if (arretes) {
      await this.runDataGouvUpdate(
        'arretes',
        'ARRETES',
        scheduledFor,
        () => this.updateArretes(arretes),
        failures,
        publicationContext,
      );
      await this.runDataGouvUpdate(
        'historique-arretes',
        'HISTORIQUE ARRETES',
        scheduledFor,
        () => this.updateHistoriqueArretes(arretes),
        failures,
        publicationContext,
      );
    }

    await this.runDataGouvUpdate(
      'arretes-cadre',
      'ARRETES CADRE',
      scheduledFor,
      () => this.updateArretesCadre(),
      failures,
      publicationContext,
    );
    await this.runDataGouvUpdate(
      'restrictions',
      'RESTRICTIONS',
      scheduledFor,
      () => this.updateRestrictions(),
      failures,
      publicationContext,
    );
    await this.runDataGouvUpdate(
      `communes-${new Date(scheduledFor).getUTCFullYear()}`,
      'COMMUNES',
      scheduledFor,
      () =>
        this.updateCommunes(
          new Date(scheduledFor).getUTCFullYear(),
          scheduledFor,
        ),
      failures,
      publicationContext,
    );
    if (this.mapArchivesEnabled) {
      await this.runDataGouvUpdate(
        'maps-geojson',
        'ARCHIVE CARTES GEOJSON',
        scheduledFor,
        () => this.updateDailyMapArchive(scheduledFor, true),
        failures,
      );
      await this.runDataGouvUpdate(
        'maps-pmtiles',
        'ARCHIVE CARTES PMTILES',
        scheduledFor,
        () => this.updateDailyMapArchive(scheduledFor, false),
        failures,
      );
    }
    await this.runDataGouvUpdate(
      'historique-communes',
      'HISTORIQUE COMMUNES',
      scheduledFor,
      () => this.updateHistoriqueCommunes(scheduledFor),
      failures,
      publicationContext,
    );

    this.logger.log('MISE A JOUR DATAGOUV - FIN');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Échec de ${failures.length} publication(s) Datagouv: ${failures.map(({ name }) => name).join(', ')}`,
      );
    }
  }

  private async runDataGouvUpdate(
    key: string,
    name: string,
    scheduledFor: string,
    update: () => Promise<void>,
    failures: Array<{ name: string; error: unknown }>,
    publicationContext?: DatagouvPublicationContext,
  ): Promise<void> {
    try {
      this.throwIfDeadlineExceeded();
      const result = await this.publicationRegistry.executeDailyRun(
        `datagouv:${key}`,
        scheduledFor,
        async () => {
          await publicationContext?.verifyCurrent();
          await update();
          await publicationContext?.verifyCurrent();
          return publicationContext
            ? {
                publicationId: publicationContext.publicationId,
                sourceRevision: publicationContext.sourceRevision,
              }
            : undefined;
        },
        new Date(),
        publicationContext
          ? {
              identity: {
                publicationId: publicationContext.publicationId,
                sourceRevision: publicationContext.sourceRevision,
              },
            }
          : undefined,
      );
      if (!['succeeded', 'already_succeeded'].includes(result)) {
        throw new Error(`Publication ${name} non terminée (${result})`);
      }
    } catch (error) {
      this.logDataGouvError(name, error);
      failures.push({ name, error });
    }
  }

  private logDataGouvError(name: string, error: unknown): void {
    this.logger.error(
      `Erreur lors de la mise à jour Datagouv - ${name}`,
      this.formatDataGouvError(error),
    );
  }

  private formatDataGouvError(error: unknown): string {
    const axiosError = error as AxiosError;
    return JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      code: axiosError?.code,
      status: axiosError?.response?.status,
      statusText: axiosError?.response?.statusText,
    });
  }

  /**
   * Met à jour les arrêtés sur Datagouv.
   * @param arretes - Liste des arrêtés à traiter.
   */
  async updateArretes(arretes: ArreteRestriction[]): Promise<void> {
    this.logger.log('MISE A JOUR DATAGOUV - ARRETES - DEBUT');

    const departements = await this.departementService.findAllLight();
    const formattedArretes = this.formatArretesData(arretes, departements);
    await this.writeCsv('arretes.csv', formattedArretes);
    await this.uploadToDatagouv('arretes', 'arretes.csv', 'Arrêtés');

    this.logger.log('MISE A JOUR DATAGOUV - ARRETES - FIN');
  }

  /**
   * Formate les données des arrêtés.
   * @param arretes - Liste des arrêtés à formater.
   * @param departements - Liste des départements pour enrichir les données.
   * @returns Tableau formaté pour l'export.
   */
  private formatArretesData(
    arretes: ArreteRestriction[],
    departements: any[],
  ): any[] {
    return arretes.map((arrete) => ({
      id: arrete.id,
      numero: arrete.numero,
      date_debut: arrete.dateDebut,
      date_signature: arrete.dateSignature,
      date_fin: arrete.dateFin,
      statut: arrete.statut,
      departement: arrete.departement.code,
      chemin_fichier: arrete.fichier?.url || '',
      niveau_gravite_specifique_aep: arrete.niveauGraviteSpecifiqueEap,
      ressource_aep_communique: arrete.ressourceEapCommunique,
      arrete_cadre: arrete.arretesCadre.map((cadre) => ({
        id: cadre.id,
        numero: cadre.numero,
        date_debut: cadre.dateDebut,
        date_fin: cadre.dateFin,
        chemin_fichier: cadre.fichier?.url || '',
      })),
      zones_alerte: arrete.restrictions.map((restriction) => ({
        id: restriction.zoneAlerte?.id,
        type:
          restriction.communes.length > 0 ? 'AEP' : restriction.zoneAlerte.type,
        code: restriction.zoneAlerte?.code,
        nom:
          restriction.communes.length > 0
            ? restriction.nomGroupementAep
            : restriction.zoneAlerte.nom,
        niveau_gravite: restriction.niveauGravite,
        id_sandre: restriction.zoneAlerte?.idSandre,
        communes: restriction.communes.map((c) => c.code),
      })),
      regle_gestion: departements
        .find((d) => d.code === arrete.departement.code)
        .parametres.find(
          (p) =>
            moment(arrete.dateDebut).isSameOrAfter(moment(p.dateDebut)) &&
            (!p.dateFin ||
              moment(arrete.dateDebut).isSameOrBefore(moment(p.dateFin))),
        )?.superpositionCommune,
    }));
  }

  /**
   * Écrit un tableau de données dans un fichier CSV.
   * @param fileName - Nom du fichier CSV.
   * @param data - Données à écrire.
   */
  private async writeCsv(fileName: string, data: any[]): Promise<void> {
    const csv = await json2csv(data, { expandArrayObjects: true });
    await writeFile(`${this.path}/${fileName}`, csv, 'utf8');
  }

  async updateHistoriqueArretes(arretes: ArreteRestriction[]) {
    this.logger.log('MISE A JOUR DATAGOUV - HISTORIQUE ARRETES - DEBUT');
    const archiveYears = this.getArretesArchiveYears();

    const missingResourceYears: number[] = [];
    for (const year of archiveYears) {
      if (!(await this.getDataGouvResourceId(`arretes_${year}`))) {
        missingResourceYears.push(year);
      }
    }
    if (missingResourceYears.length > 0) {
      throw new Error(
        `Ressources Datagouv manquantes pour les archives d'arrêtés: ${missingResourceYears.join(', ')}`,
      );
    }

    const departements = await this.departementService.findAllLight();

    for (const year of archiveYears) {
      let formatArretes = arretes.filter((arrete) => {
        const startDate = moment(`01/01/${year}`, 'DD/MM/YYYY');
        const endDate = moment(`31/12/${year}`, 'DD/MM/YYYY');
        return (
          moment(arrete.dateDebut).isBetween(
            startDate,
            endDate,
            'days',
            '[]',
          ) ||
          (arrete.dateFin &&
            moment(arrete.dateFin).isBetween(startDate, endDate, 'days', '[]'))
        );
      });
      formatArretes = this.formatArretesData(formatArretes, departements);
      await this.writeCsv(`arretes_${year}.csv`, formatArretes);
      await this.uploadToDatagouv(
        `arretes_${year}`,
        `arretes_${year}.csv`,
        `Arrêtés ${year}`,
      );
    }

    this.logger.log('MISE A JOUR DATAGOUV - HISTORIQUE ARRETES - FIN');
  }

  private getArretesArchiveYears(): number[] {
    const configuredYears = this.configService
      .get<string>('API_DATAGOUV_ARRETES_ARCHIVE_YEARS')
      ?.trim();
    const rawYears = configuredYears
      ? configuredYears.split(',').map((year) => year.trim())
      : DEFAULT_ARRETES_ARCHIVE_YEARS.map(String);
    const years = rawYears.map(Number);
    const currentYear = new Date().getFullYear();

    if (
      years.length === 0 ||
      years.some(
        (year) => !Number.isInteger(year) || year < 2012 || year >= currentYear,
      )
    ) {
      throw new Error(
        'API_DATAGOUV_ARRETES_ARCHIVE_YEARS doit contenir des années antérieures à l’année courante, séparées par des virgules',
      );
    }

    return [...new Set(years)].sort((left, right) => left - right);
  }

  /**
   * Met à jour les arrêtés cadres sur Datagouv.
   */
  async updateArretesCadre() {
    this.logger.log('MISE A JOUR DATAGOUV - ARRETES CADRE - DEBUT');

    const arretes = await this.arreteCadreService.findDatagouv();
    const formatArretes = arretes.map((arrete) => {
      return {
        id: arrete.id,
        numero: arrete.numero,
        date_debut: arrete.dateDebut,
        date_fin: arrete.dateFin,
        statut: arrete.statut,
        departement_pilote: arrete.departementPilote
          ? arrete.departementPilote.code
          : '',
        departements: arrete.departements.map((d) => d.code),
        chemin_fichier: arrete.fichier ? arrete.fichier?.url : '',
        zones_alerte: arrete.zonesAlerte.map((zone) => {
          return {
            id: zone.id,
            type: zone.type,
            code: zone.code,
            nom: zone.nom,
            id_sandre: zone.idSandre,
          };
        }),
      };
    });

    await this.writeCsv('arretes_cadre.csv', formatArretes);
    await this.uploadToDatagouv(
      'arretes_cadre',
      'arretes_cadre.csv',
      'Arrêtés Cadre',
    );

    this.logger.log('MISE A JOUR DATAGOUV - ARRETES CADRE - FIN');
  }

  /**
   * Met à jour les restrictions sur Datagouv.
   */
  async updateRestrictions() {
    this.logger.log('MISE A JOUR DATAGOUV - RESTRICTIONS - DEBUT');

    const zonesAlertesComputed =
      await this.zoneAlerteComputedService.findDatagouv();
    const formatRestrictions = [];
    zonesAlertesComputed.forEach((zoneAlerte) => {
      const restriction = {
        zone: {
          nom: zoneAlerte.nom,
          type: zoneAlerte.type,
          departement: zoneAlerte.departement.code,
        },
        niveau_gravite: zoneAlerte.niveauGravite,
        arrete: {
          id: zoneAlerte.restriction.arreteRestriction?.id,
          numero: zoneAlerte.restriction.arreteRestriction?.numero,
        },
      };
      const usages = zoneAlerte.restriction.usages
        .filter((usage) => {
          if (zoneAlerte.type === 'SUP') {
            return usage.concerneEsu;
          } else if (zoneAlerte.type === 'SOU') {
            return usage.concerneEso;
          } else if (zoneAlerte.type === 'AEP') {
            return usage.concerneAep;
          }
          return false;
        })
        .map((usage) => {
          let description = '';
          switch (zoneAlerte.niveauGravite) {
            case 'vigilance':
              description = usage.descriptionVigilance;
              break;
            case 'alerte':
              description = usage.descriptionAlerte;
              break;
            case 'alerte_renforcee':
              description = usage.descriptionAlerteRenforcee;
              break;
            case 'crise':
              description = usage.descriptionCrise;
              break;
          }
          return {
            nom: usage.nom,
            thematique: usage.thematique.nom,
            concerne_particulier: usage.concerneParticulier,
            concerne_entreprise: usage.concerneEntreprise,
            concerne_collectivite: usage.concerneCollectivite,
            concerne_exploitation: usage.concerneExploitation,
            description: description,
          };
        });
      usages.forEach((u) => {
        formatRestrictions.push({
          ...restriction,
          usage: {
            u,
          },
        });
      });
    });
    const csv = json2csv(formatRestrictions, {
      arrayIndexesAsKeys: true,
      expandArrayObjects: true,
    });

    await writeFile(`${this.path}/restrictions.csv`, csv, 'utf8');
    await this.uploadToDatagouv(
      'restrictions',
      'restrictions.csv',
      'Restrictions',
    );

    this.logger.log('MISE A JOUR DATAGOUV - RESTRICTIONS - FIN');
  }

  async updateMaps(date?: moment.Moment) {
    if (!this.canUploadToDataGouv()) {
      throw new Error("Configuration manquante pour l'upload vers Datagouv");
    }

    const dateDebut = date ? date.clone() : moment();
    const dateFin = moment();

    for (let y = dateDebut.year(); y <= dateFin.year(); y++) {
      const yearStart =
        y === dateDebut.year()
          ? dateDebut.clone()
          : moment(`${y}-01-01`, 'YYYY-MM-DD', true);
      await this.generateMapsArchive(yearStart, y, true, dateFin);
      await this.generateMapsArchive(yearStart, y, false, dateFin);
    }
  }

  async updateDailyMapArchive(
    scheduledFor: string,
    geojson: boolean,
  ): Promise<void> {
    const date = moment(scheduledFor, 'YYYY-MM-DD', true);
    if (!date.isValid()) {
      throw new Error(
        `Date de publication cartographique invalide: ${scheduledFor}`,
      );
    }
    await this.generateMapsArchive(date, date.year(), geojson, date);
  }

  async generateMapsArchive(
    dateDebut: moment.Moment,
    year: number,
    geojson = false,
    dateFin = moment(),
  ): Promise<void> {
    const kind = geojson ? 'geojson' : 'pmtiles';
    const lockKey = `vigieau:datagouv-map-archive:${kind}:${year}`;
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let locked = false;
    let operationFailed = false;
    try {
      await queryRunner.connect();
      connected = true;
      await this.acquireMapArchiveLock(queryRunner, lockKey);
      locked = true;
      await this.generateMapsArchiveLocked(dateDebut, year, geojson, dateFin);
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      let cleanupError: unknown;
      if (locked) {
        try {
          const [unlock] = await queryRunner.query(
            'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
            [lockKey],
          );
          if (unlock?.unlocked !== true) {
            throw new Error(
              `Impossible de libérer le verrou de l'archive ${kind} ${year}`,
            );
          }
        } catch (error) {
          this.logger.error(
            `ERREUR LORS DE LA LIBERATION DU VERROU DE L'ARCHIVE ${kind.toUpperCase()} ${year}`,
            error,
          );
          if (!operationFailed) {
            cleanupError = error;
          }
        }
      }
      if (connected) {
        try {
          await queryRunner.release();
        } catch (error) {
          this.logger.error(
            `ERREUR LORS DE LA LIBERATION DE LA CONNEXION DE L'ARCHIVE ${kind.toUpperCase()} ${year}`,
            error,
          );
          if (!operationFailed && cleanupError === undefined) {
            cleanupError = error;
          }
        }
      }
      if (cleanupError !== undefined) {
        throw cleanupError;
      }
    }
  }

  private async acquireMapArchiveLock(
    queryRunner: QueryRunner,
    lockKey: string,
  ): Promise<void> {
    while (true) {
      this.throwIfDeadlineExceeded();
      const [lock] = await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [lockKey],
      );
      if (lock?.locked === true) {
        return;
      }
      await this.waitForMapArchiveLockRetry();
    }
  }

  private async waitForMapArchiveLockRetry(): Promise<void> {
    const signal = this.deadlineContext.getStore();
    if (!signal) {
      await new Promise((resolve) =>
        setTimeout(resolve, MAP_ARCHIVE_LOCK_RETRY_MS),
      );
      return;
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          signal.reason ||
            new Error("Attente du verrou de l'archive cartographique annulée"),
        );
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, MAP_ARCHIVE_LOCK_RETRY_MS);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    signal.throwIfAborted();
  }

  private async generateMapsArchiveLocked(
    dateDebut: moment.Moment,
    year: number,
    geojson: boolean,
    dateFin: moment.Moment,
  ): Promise<void> {
    const path = this.configService.get('PATH_TO_WRITE_FILE');
    const geojsonOrPmtiles = geojson ? 'geojson' : 'pmtiles';
    const archiveResource = geojson ? 'geojson_archive' : 'pmtiles_archive';
    if (!(await this.getDataGouvResourceId(archiveResource))) {
      throw new Error(`Ressource non configurée : ${archiveResource}`);
    }

    this.logger.log(
      `GENERATION DE L'ARCHIVE ${geojsonOrPmtiles} DE L'ANNEE ${year}`,
    );
    const existingArchiveUrl = this.s3Service.getPublicFileUrl(
      `zones_${geojsonOrPmtiles}_${year}.zip`,
      `${geojsonOrPmtiles}/`,
    );
    // On récupère le zip existant, si il n'existe pas on le crée
    let dataZip;
    try {
      const { data } = await firstValueFrom(
        this.httpService.get(existingArchiveUrl, {
          responseType: 'arraybuffer',
          timeout: this.httpTimeoutMs,
          signal: this.deadlineContext.getStore(),
        }),
      );
      dataZip = data;
    } catch (e) {
      this.logger.error(`ARCHIVE ${existingArchiveUrl} non accessible`, e);
      if ((e as AxiosError)?.response?.status !== 404) {
        throw e;
      }
    }
    const zip = dataZip ? await JSZip.loadAsync(dataZip) : new JSZip();
    let addedFileCount = 0;
    let latestAddedDate: string | undefined;

    for (
      let m = dateDebut.clone();
      m.isSameOrBefore(dateFin, 'day') && m.year() === year;
      m.add(1, 'days')
    ) {
      const fileName = `zones_arretes_en_vigueur_${m.format('YYYY-MM-DD')}.${geojsonOrPmtiles}`;
      try {
        const isCurrentDay = m.isSame(moment(), 'day');
        const sourceFileName = isCurrentDay
          ? `zones_arretes_en_vigueur.${geojsonOrPmtiles}`
          : fileName;
        const filePath = `${path}/${sourceFileName}`;
        this.logger.log(`ADDING ${filePath} to ZIP`);
        const fileData = await this.readMapArtifact(
          filePath,
          fileName,
          geojsonOrPmtiles,
        );
        if (fileData.length === 0) {
          throw new Error(`Le fichier ${fileName} est vide`);
        }
        zip.remove(fileName);
        zip.file(fileName, fileData);
        addedFileCount += 1;
        latestAddedDate = m.format('YYYY-MM-DD');
      } catch (e) {
        this.logger.error(`ARCHIVE FICHIER ${fileName} non accessible`, e);
      }
    }

    if (addedFileCount === 0) {
      throw new Error(
        `Aucun fichier ${geojsonOrPmtiles} valide à ajouter à l'archive ${year}`,
      );
    }
    const archiveEntryCount = Object.values(zip.files).filter(
      (entry) => !entry.dir,
    ).length;
    if (archiveEntryCount === 0) {
      throw new Error(`L'archive ${geojsonOrPmtiles} ${year} serait vide`);
    }

    const newZipData = await zip.generateAsync({ type: 'nodebuffer' });
    if (newZipData.length <= 22) {
      throw new Error(`L'archive ${geojsonOrPmtiles} ${year} est invalide`);
    }
    const fileToTransfer: Express.Multer.File = {
      fieldname: 'file',
      originalname: `zones_${geojsonOrPmtiles}_${year}.zip`,
      encoding: '7bit',
      mimetype: 'application/zip',
      size: newZipData.length,
      destination: '',
      filename: `zones_${geojsonOrPmtiles}_${year}.zip`,
      path: '',
      stream: Readable.from(newZipData),
      buffer: newZipData,
    };
    const s3Response = await this.s3Service.uploadFile(
      fileToTransfer,
      `${geojsonOrPmtiles}/`,
      {
        cacheControl: 'public, max-age=0, must-revalidate',
        abortSignal: this.deadlineContext.getStore(),
      },
    );
    const remoteObject = await this.s3Service.headFile(
      fileToTransfer.originalname,
      `${geojsonOrPmtiles}/`,
      { abortSignal: this.deadlineContext.getStore() },
    );
    if (Number(remoteObject.ContentLength) !== newZipData.length) {
      throw new Error(
        `Validation S3 impossible pour ${fileToTransfer.originalname}: taille distante inattendue`,
      );
    }
    const archiveUrl =
      s3Response.Location ||
      this.s3Service.getPublicFileUrl(
        fileToTransfer.originalname,
        `${geojsonOrPmtiles}/`,
      );
    await this.uploadToDatagouv(
      archiveResource,
      archiveUrl,
      `Cartes des zones et arrêtés en vigueur - ${geojson ? 'GEOJSON' : 'PMTILES'} - Année en cours`,
      true,
      { sourceDate: latestAddedDate },
    );
    this.logger.log(
      `FIN GENERATION DE L'ARCHIVE ${geojsonOrPmtiles} DE L'ANNEE ${year}`,
    );
  }

  private async readMapArtifact(
    localPath: string,
    fileName: string,
    kind: 'geojson' | 'pmtiles',
  ): Promise<Buffer> {
    try {
      return fs.readFileSync(localPath);
    } catch (localError) {
      try {
        const { data } = await firstValueFrom(
          this.httpService.get(
            this.s3Service.getPublicFileUrl(fileName, `${kind}/`),
            {
              responseType: 'arraybuffer',
              timeout: this.httpTimeoutMs,
              signal: this.deadlineContext.getStore(),
            },
          ),
        );
        return Buffer.isBuffer(data) ? data : Buffer.from(data);
      } catch (remoteError) {
        throw new AggregateError(
          [localError, remoteError],
          `Artefact ${kind} ${fileName} inaccessible localement et sur S3`,
        );
      }
    }
  }

  /**
   * Upload un fichier ou des métadonnées vers Datagouv.
   * @param resource - Nom de la ressource Datagouv.
   * @param fileName - Nom du fichier ou URL.
   * @param title - Titre de la ressource.
   * @param isUrl - Indique si le fichier est une URL.
   */
  async uploadToDatagouv(
    resource: string,
    fileName: string,
    title: string,
    isUrl = false,
    options?: { timeoutMs?: number; sourceDate?: string },
  ): Promise<void> {
    this.logger.log(`ENVOI VERS DATAGOUV - ${resource}`);

    const resourceId = await this.getDataGouvResourceId(resource);
    if (!resourceId) {
      const error = new Error(`Ressource non configurée : ${resource}`);
      await this.publicationRegistry.recordResourceFailure(
        resource,
        'data.gouv.fr',
        error,
      );
      throw error;
    }

    const url = `${this.datagouvApiUrl}/resources/${resourceId}/`;
    let artifact: LocalArtifact | undefined;
    try {
      if (!isUrl) {
        artifact = await this.inspectLocalArtifact(fileName);
        await this.uploadDataGouvFile(
          `${url}upload/`,
          fileName,
          options?.timeoutMs,
        );
      }

      const body: any = { title };
      if (isUrl) body.url = fileName;

      await this.updateDataGouvResource(resourceId, body, options?.timeoutMs);
      const remoteResource = await this.verifyDataGouvResourceWithRetry(
        resourceId,
        title,
        isUrl ? fileName : undefined,
        artifact?.byteSize,
        options?.timeoutMs,
      );
      await this.publicationRegistry.recordResourceSuccess(
        resource,
        'data.gouv.fr',
        {
          remoteResourceId: resourceId,
          sourceDate: options?.sourceDate,
          checksum: artifact?.checksum,
          byteSize: artifact?.byteSize,
          metadata: {
            title,
            url: remoteResource.url,
          },
        },
      );
    } catch (error) {
      await this.publicationRegistry.recordResourceFailure(
        resource,
        'data.gouv.fr',
        error,
      );
      throw error;
    }
  }

  private async getDataGouvResourceId(
    resource: string,
  ): Promise<string | undefined> {
    let configuredResourceId: string | undefined;
    if (resource === 'historique_communes') {
      configuredResourceId = this.configService.get(
        'API_DATAGOUV_HISTORIQUE_COMMUNES_RESOURCE_ID',
      );
    } else {
      const communesMatch = /^communes_(\d{4})$/.exec(resource);
      if (communesMatch) {
        configuredResourceId = this.configService.get(
          `API_DATAGOUV_COMMUNES_${communesMatch[1]}_RESOURCE_ID`,
        );
      } else {
        configuredResourceId =
          this.configService.get(
            `API_DATAGOUV_${resource.toUpperCase()}_RESOURCE_ID`,
          ) || this.datagouvResources[resource];
      }
    }
    return this.publicationRegistry.resolveResourceId(
      resource,
      'data.gouv.fr',
      configuredResourceId,
    );
  }

  private async uploadDataGouvFile(
    url: string,
    fileName: string,
    timeoutMs?: number,
  ): Promise<any> {
    const data = await fs.openAsBlob(`${this.path}/${fileName}`);
    const formData = new FormData();
    formData.append('file', data, fileName);

    const response = await lastValueFrom(
      this.httpService
        .post(url, formData, {
          headers: {
            Accept: 'application/json',
            'X-Api-Key': this.datagouvApiKey,
          },
          timeout: this.resolveHttpTimeout(timeoutMs),
          signal: this.deadlineContext.getStore(),
        })
        .pipe(
          catchError((error: AxiosError) => {
            this.logger.error(
              "ERREUR DANS L'ENVOI VERS DATAGOUV",
              this.formatDataGouvError(error),
            );
            throw error;
          }),
        ),
    );
    return response.data;
  }

  private async updateDataGouvResource(
    resourceId: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<void> {
    const url = `${this.datagouvApiUrl}/resources/${resourceId}/`;
    await lastValueFrom(
      this.httpService
        .put(url, body, {
          headers: {
            Accept: 'application/json',
            'X-Api-Key': this.datagouvApiKey,
          },
          timeout: this.resolveHttpTimeout(timeoutMs),
          signal: this.deadlineContext.getStore(),
        })
        .pipe(
          catchError((error: AxiosError) => {
            this.logger.error(
              'ERREUR DANS LA MISE A JOUR DES METADONNEES DATAGOUV',
              this.formatDataGouvError(error),
            );
            throw error;
          }),
        ),
    );
  }

  private async verifyDataGouvResourceWithRetry(
    resourceId: string,
    expectedTitle: string,
    expectedUrl?: string,
    expectedByteSize?: number,
    timeoutMs?: number,
  ): Promise<{ id: string; title: string; url?: string; filesize?: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.verifyDataGouvResource(
          resourceId,
          expectedTitle,
          expectedUrl,
          expectedByteSize,
          timeoutMs,
        );
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    }
    throw lastError;
  }

  private async verifyDataGouvResource(
    resourceId: string,
    expectedTitle: string,
    expectedUrl?: string,
    expectedByteSize?: number,
    timeoutMs?: number,
  ): Promise<{ id: string; title: string; url?: string; filesize?: number }> {
    const response = await firstValueFrom(
      this.httpService.get(`${this.datagouvApiUrl}/`, {
        headers: { Accept: 'application/json' },
        timeout: this.resolveHttpTimeout(timeoutMs),
        signal: this.deadlineContext.getStore(),
      }),
    );
    const resource = (response.data?.resources || []).find(
      (candidate) => candidate.id === resourceId,
    );
    if (!resource) {
      throw new Error(
        `La ressource Datagouv ${resourceId} est absente après publication`,
      );
    }
    if (resource.title !== expectedTitle) {
      throw new Error(
        `La ressource Datagouv ${resourceId} a un titre inattendu`,
      );
    }
    if (expectedUrl && resource.url !== expectedUrl) {
      throw new Error(
        `La ressource Datagouv ${resourceId} ne pointe pas vers l'URL publiée`,
      );
    }
    if (expectedByteSize !== undefined) {
      if (resource.filesize === undefined || resource.filesize === null) {
        throw new Error(
          `La ressource Datagouv ${resourceId} n'expose aucune taille de fichier`,
        );
      }
      if (Number(resource.filesize) !== expectedByteSize) {
        throw new Error(
          `La ressource Datagouv ${resourceId} a une taille inattendue`,
        );
      }
    }
    return resource;
  }

  private async inspectLocalArtifact(fileName: string): Promise<LocalArtifact> {
    const filePath = `${this.path}/${fileName}`;
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new Error(`Le fichier ${fileName} est absent ou vide`);
    }
    const hash = createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash, {
      signal: this.deadlineContext.getStore(),
    });
    return {
      byteSize: fileStat.size,
      checksum: hash.digest('hex'),
    };
  }

  async updateCommunes(
    year = new Date().getFullYear(),
    expectedSourceDate?: string,
  ): Promise<void> {
    const definition = this.getCommunesResourceDefinition(year);
    if (!(await this.getDataGouvResourceId(definition.resource))) {
      await this.createOrUpdateCommunesResource(year, expectedSourceDate);
      return;
    }

    const artifact = await this.generateCommunesArchive(
      year,
      definition.jsonFileName,
      expectedSourceDate,
    );
    this.assertExpectedSourceDate(
      definition.zipFileName,
      artifact,
      expectedSourceDate,
    );
    await this.uploadToDatagouv(
      definition.resource,
      definition.zipFileName,
      definition.title,
      false,
      { sourceDate: artifact.sourceDate },
    );
  }

  async updateHistoriqueCommunes(expectedSourceDate?: string): Promise<void> {
    if (!this.canUploadToDataGouv()) {
      throw new Error("Configuration manquante pour l'upload vers Datagouv");
    }
    if (!(await this.getDataGouvResourceId('historique_communes'))) {
      const error = new Error('Ressource non configurée : historique_communes');
      await this.publicationRegistry.recordResourceFailure(
        'historique_communes',
        'data.gouv.fr',
        error,
      );
      throw error;
    }

    this.logger.log('MISE A JOUR DATAGOUV - HISTORIQUE COMMUNES - DEBUT');

    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let locked = false;
    try {
      await queryRunner.connect();
      connected = true;
      const [lock] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau:datagouv-historique-communes')) AS locked",
      );
      locked = lock?.locked === true;
      if (!locked) {
        throw new Error(
          "Une publication de l'historique des communes est déjà en cours",
        );
      }

      const stream =
        await this.statisticCommuneService.getStatisticCommuneStream();
      const artifact = await this.writeCommunesArchive(
        stream,
        'historique_communes.json',
        'historique_communes.zip',
      );
      this.assertExpectedSourceDate(
        'historique_communes.zip',
        artifact,
        expectedSourceDate,
      );
      await this.uploadToDatagouv(
        'historique_communes',
        'historique_communes.zip',
        'Historique Communes',
        false,
        { sourceDate: artifact.sourceDate },
      );
    } finally {
      try {
        if (locked) {
          await queryRunner.query(
            "SELECT pg_advisory_unlock(hashtext('vigieau:datagouv-historique-communes')) AS unlocked",
          );
        }
      } finally {
        if (connected) {
          await queryRunner.release();
        }
      }
    }

    this.logger.log('MISE A JOUR DATAGOUV - HISTORIQUE COMMUNES - FIN');
  }

  async createOrUpdateCommunesResource(
    year: number,
    expectedSourceDate?: string,
  ): Promise<string> {
    if (!this.canUploadToDataGouv()) {
      throw new Error("Configuration manquante pour l'upload vers Datagouv");
    }

    const definition = this.getCommunesResourceDefinition(year);
    const configuredResourceId = await this.getDataGouvResourceId(
      definition.resource,
    );
    const matchingResources = configuredResourceId
      ? [{ id: configuredResourceId }]
      : await this.findDataGouvCommuneResources(
          definition.title,
          definition.zipFileName,
        );

    if (matchingResources.length > 1) {
      throw new Error(
        `Plusieurs ressources Datagouv correspondent à « ${definition.title} »`,
      );
    }

    const artifact = await this.generateCommunesArchive(
      year,
      definition.jsonFileName,
      expectedSourceDate,
    );
    this.assertExpectedSourceDate(
      definition.zipFileName,
      artifact,
      expectedSourceDate,
    );

    let resourceId = matchingResources[0]?.id;
    if (resourceId) {
      await this.uploadDataGouvFile(
        `${this.datagouvApiUrl}/resources/${resourceId}/upload/`,
        definition.zipFileName,
      );
    } else {
      const resource = await this.uploadDataGouvFile(
        `${this.datagouvApiUrl}/upload/`,
        definition.zipFileName,
      );
      resourceId = resource?.id;
      if (!resourceId) {
        throw new Error(
          "Datagouv n'a pas retourné l'identifiant de la ressource",
        );
      }
    }

    await this.updateDataGouvResource(resourceId, {
      title: definition.title,
      description: definition.description,
      type: 'update',
    });
    const remoteResource = await this.verifyDataGouvResourceWithRetry(
      resourceId,
      definition.title,
      undefined,
      artifact.byteSize,
    );
    await this.publicationRegistry.recordResourceSuccess(
      definition.resource,
      'data.gouv.fr',
      {
        remoteResourceId: resourceId,
        sourceDate: artifact.sourceDate,
        checksum: artifact.checksum,
        byteSize: artifact.byteSize,
        metadata: { title: definition.title, url: remoteResource.url },
      },
    );
    return resourceId;
  }

  private async findDataGouvCommuneResources(
    title: string,
    fileName: string,
  ): Promise<Array<{ id: string }>> {
    const response = await firstValueFrom(
      this.httpService.get(`${this.datagouvApiUrl}/`, {
        headers: { Accept: 'application/json' },
        timeout: this.httpTimeoutMs,
        signal: this.deadlineContext.getStore(),
      }),
    );
    const possibleFileNames = [fileName, fileName.replaceAll('_', '-')];
    return (response.data?.resources || []).filter((resource) => {
      const resourceUrl = resource.url || '';
      return (
        resource.title === title ||
        possibleFileNames.some((candidate) =>
          resourceUrl.endsWith(`/${candidate}`),
        )
      );
    });
  }

  private getCommunesResourceDefinition(year: number) {
    if (!Number.isInteger(year) || year < 2013 || year > 9999) {
      throw new Error(`Année de statistiques communales invalide : ${year}`);
    }

    return {
      resource: `communes_${year}`,
      jsonFileName: `restrictions_communes_${year}.json`,
      zipFileName: `restrictions_communes_${year}.zip`,
      title: `Communes en restrictions - ${year}`,
      description:
        `Historique quotidien des niveaux de gravité applicables à chaque commune pour l'année ${year}. ` +
        `Le ZIP contient le fichier restrictions_communes_${year}.json.`,
    };
  }

  private async generateCommunesArchive(
    year: number,
    jsonFileName: string,
    expectedSourceDate?: string,
  ): Promise<LocalArtifact> {
    this.logger.log(`MISE A JOUR DATAGOUV - COMMUNES ${year} - DEBUT`);
    const stream =
      await this.statisticCommuneService.getStatisticCommuneStreamForYear(year);
    const artifact = await this.writeCommunesArchive(
      stream,
      jsonFileName,
      `restrictions_communes_${year}.zip`,
      expectedSourceDate
        ? {
            startDate: `${year}-01-01`,
            endDate: expectedSourceDate,
          }
        : undefined,
    );
    this.logger.log(`MISE A JOUR DATAGOUV - COMMUNES ${year} - FIN`);
    return artifact;
  }

  private async writeCommunesArchive(
    source: Readable,
    jsonFileName: string,
    zipFileName: string,
    expectedCoverage?: { startDate: string; endDate: string },
  ): Promise<LocalArtifact> {
    const zipFilePath = `${this.path}/${zipFileName}`;
    const temporaryZipFilePath = `${zipFilePath}.tmp`;
    await rm(temporaryZipFilePath, { force: true });

    const jsonStream = new PassThrough();
    const zipStream = fs.createWriteStream(temporaryZipFilePath, {
      flags: 'wx',
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    const archiveCompleted = new Promise<void>((resolve, reject) => {
      zipStream.once('close', resolve);
      zipStream.once('error', reject);
      archive.once('error', reject);
    });

    archive.pipe(zipStream);
    archive.append(jsonStream, { name: jsonFileName });

    const contentStats: { recordCount: number; sourceDate?: string } = {
      recordCount: 0,
    };

    const contentCompleted = pipeline(
      source,
      this.createCommunesJsonTransform(contentStats, expectedCoverage),
      jsonStream,
      { signal: this.deadlineContext.getStore() },
    );
    const finalizationCompleted = archive.finalize();

    try {
      await Promise.all([
        contentCompleted,
        finalizationCompleted,
        archiveCompleted,
      ]);
      if (contentStats.recordCount === 0) {
        throw new Error(`L'archive ${zipFileName} ne contient aucune commune`);
      }
      await rename(temporaryZipFilePath, zipFilePath);
    } catch (error) {
      archive.abort();
      jsonStream.destroy();
      zipStream.destroy();
      await rm(temporaryZipFilePath, { force: true });
      throw error;
    }

    this.logger.log(`Fichier ZIP disponible : ${zipFilePath}`);
    return {
      ...(await this.inspectLocalArtifact(zipFileName)),
      recordCount: contentStats.recordCount,
      sourceDate: contentStats.sourceDate,
    };
  }

  private createCommunesJsonTransform(
    stats: {
      recordCount: number;
      sourceDate?: string;
    },
    expectedCoverage?: { startDate: string; endDate: string },
  ): Transform {
    let first = true;
    const expectedDayCount = expectedCoverage
      ? Math.floor(
          (Date.parse(`${expectedCoverage.endDate}T00:00:00Z`) -
            Date.parse(`${expectedCoverage.startDate}T00:00:00Z`)) /
            86_400_000,
        ) + 1
      : undefined;
    if (
      expectedDayCount !== undefined &&
      (!Number.isInteger(expectedDayCount) || expectedDayCount <= 0)
    ) {
      throw new Error(
        `Plage de dates communales invalide: ${expectedCoverage?.startDate} à ${expectedCoverage?.endDate}`,
      );
    }
    return new Transform({
      writableObjectMode: true,
      transform(chunk: any, _encoding, callback) {
        stats.recordCount += 1;
        const restrictions = chunk.sc_restrictions || [];
        const restrictionDates = new Set<string>();
        let hasOutOfRangeDate = false;
        for (const restriction of restrictions) {
          if (
            typeof restriction.date === 'string' &&
            (!stats.sourceDate || restriction.date > stats.sourceDate)
          ) {
            stats.sourceDate = restriction.date;
          }
          if (typeof restriction.date === 'string') {
            restrictionDates.add(restriction.date);
            if (
              expectedCoverage &&
              (restriction.date < expectedCoverage.startDate ||
                restriction.date > expectedCoverage.endDate)
            ) {
              hasOutOfRangeDate = true;
            }
          }
        }
        if (
          expectedCoverage &&
          (restrictions.length !== expectedDayCount ||
            restrictionDates.size !== expectedDayCount ||
            hasOutOfRangeDate ||
            !restrictionDates.has(expectedCoverage.startDate) ||
            !restrictionDates.has(expectedCoverage.endDate))
        ) {
          callback(
            new Error(
              `Historique incomplet pour la commune ${chunk.commune_code}: ${restrictionDates.size}/${expectedDayCount} jours entre ${expectedCoverage.startDate} et ${expectedCoverage.endDate}`,
            ),
          );
          return;
        }
        const formattedData = JSON.stringify({
          commune: {
            code: chunk.commune_code,
            nom: chunk.commune_nom,
          },
          restrictions: chunk.sc_restrictions,
        });
        const prefix = first ? '[' : ',';
        first = false;
        callback(null, prefix + formattedData);
      },
      flush(callback) {
        callback(null, first ? '[]' : ']');
      },
    });
  }

  private async runWithDeadline<T>(operation: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new Error(
      `Datagouv publication exceeded ${this.runTimeoutMs}ms`,
    );
    timeoutError.name = 'TimeoutError';
    let forceExitTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      controller.abort(timeoutError);
      forceExitTimer = setTimeout(() => process.exit(1), 30_000);
      forceExitTimer.unref();
    }, this.runTimeoutMs);
    timer.unref();

    return this.deadlineContext.run(controller.signal, async () => {
      const execution = operation();
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason || timeoutError),
          { once: true },
        );
      });
      try {
        return await Promise.race([execution, aborted]);
      } catch (error) {
        if (controller.signal.aborted) {
          await execution.catch(() => undefined);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (forceExitTimer) {
          clearTimeout(forceExitTimer);
        }
      }
    });
  }

  private throwIfDeadlineExceeded(): void {
    this.deadlineContext.getStore()?.throwIfAborted();
  }

  private resolveHttpTimeout(timeoutMs?: number): number {
    return Number.isInteger(timeoutMs) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : this.httpTimeoutMs;
  }

  private readPositiveInteger(name: string, fallback: number): number {
    const value = Number(this.configService.get<string>(name));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private getParisDate(now = new Date()): string {
    const parts = new Intl.DateTimeFormat('fr-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value || '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  private assertExpectedSourceDate(
    fileName: string,
    artifact: LocalArtifact,
    expectedSourceDate?: string,
  ): void {
    if (expectedSourceDate && artifact.sourceDate !== expectedSourceDate) {
      throw new Error(
        `${fileName} est incomplet: dernière date ${artifact.sourceDate || 'absente'}, date attendue ${expectedSourceDate}`,
      );
    }
  }
}
