import { HttpService } from '@nestjs/axios';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
// CommonJS import keeps the callable export intact in both Jest and the Nest build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import archiver = require('archiver');
import { AxiosError } from 'axios';
import * as fs from 'node:fs';
import { json2csv } from 'json-2-csv';
import JSZip from 'jszip';
import moment from 'moment';
import { rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { catchError, firstValueFrom, lastValueFrom } from 'rxjs';
import { PassThrough, Readable, Transform } from 'stream';
import { DataSource } from 'typeorm';
import { ArreteCadreService } from '../arrete_cadre/arrete_cadre.service';
import { ArreteRestrictionService } from '../arrete_restriction/arrete_restriction.service';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { S3Service } from '../shared/services/s3.service';
import { StatisticCommuneService } from '../statistic_commune/statistic_commune.service';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';

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
    pmtiles_archive: '9b5a883c-1b44-493e-9b4a-472b47f63e8f',
    geojson_archive: 'f386e124-3dcc-435a-a368-427ac51fbe97',
    arretes_cadre: '0732e970-c12c-4e6a-adca-5ac9dbc3fdfa',
  };

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
  ) {
    this.path = this.configService.get('PATH_TO_WRITE_FILE');
    this.datagouvApiKey = this.configService.get('API_DATAGOUV_KEY');
    const apiUrl = this.configService.get<string>('API_DATAGOUV') || '';
    this.datagouvApiUrl = `${apiUrl.replace(/\/+$/, '')}/datasets/${this.configService.get('API_DATAGOUV_DATASET')}`;
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

  /**
   * Tâche planifiée pour mettre à jour les données sur Datagouv chaque jour à 6 heures du matin.
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async updateDatagouvData() {
    if (!this.canUploadToDataGouv()) {
      this.logger.warn(`Configuration manquante pour l'upload vers Datagouv.`);
      return;
    }

    this.logger.log('MISE A JOUR DATAGOUV - DEBUT');

    let arretes: ArreteRestriction[] | undefined;
    try {
      arretes = await this.arreteRestrictionService.findDatagouv();
    } catch (error) {
      this.logDataGouvError('RECUPERATION DES ARRETES', error);
    }

    if (arretes) {
      await this.runDataGouvUpdate('ARRETES', () =>
        this.updateArretes(arretes),
      );
      await this.runDataGouvUpdate('HISTORIQUE ARRETES', () =>
        this.updateHistoriqueArretes(arretes),
      );
    }

    await this.runDataGouvUpdate('ARRETES CADRE', () =>
      this.updateArretesCadre(),
    );
    await this.runDataGouvUpdate('RESTRICTIONS', () =>
      this.updateRestrictions(),
    );
    await this.runDataGouvUpdate('COMMUNES', () => this.updateCommunes());
    await this.runDataGouvUpdate('CARTES', () => this.updateMaps());
    await this.runDataGouvUpdate('HISTORIQUE COMMUNES', () =>
      this.updateHistoriqueCommunes(),
    );

    this.logger.log('MISE A JOUR DATAGOUV - FIN');
  }

  private async runDataGouvUpdate(
    name: string,
    update: () => Promise<void>,
  ): Promise<void> {
    try {
      await update();
    } catch (error) {
      this.logDataGouvError(name, error);
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
    const yearBegin = 2012;
    const currentYear = new Date().getFullYear();

    const departements = await this.departementService.findAllLight();

    for (let year = yearBegin; year < currentYear; year++) {
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
      return;
    }

    const dateDebut = date ? date : moment();

    for (let y = dateDebut.year(); y <= moment().year(); y++) {
      await this.generateMapsArchive(dateDebut.clone(), y, true);
      await this.generateMapsArchive(dateDebut.clone(), y, false);
    }
  }

  async generateMapsArchive(
    dateDebut: moment.Moment,
    year: number,
    geojson?: boolean,
  ) {
    const path = this.configService.get('PATH_TO_WRITE_FILE');
    const geojsonOrPmtiles = geojson ? 'geojson' : 'pmtiles';

    this.logger.log(
      `GENERATION DE L'ARCHIVE ${geojsonOrPmtiles} DE L'ANNEE ${year}`,
    );
    // On récupère le zip existant, si il n'existe pas on le crée
    let dataZip;
    try {
      const { data } = await firstValueFrom(
        this.httpService.get(
          `${this.configService.get('S3_VHOST')}${this.configService.get('S3_PREFIX') ? this.configService.get('S3_PREFIX') : ''}${geojsonOrPmtiles}/zones_${geojsonOrPmtiles}_${year}.zip`,
          { responseType: 'arraybuffer' },
        ),
      );
      dataZip = data;
    } catch (e) {
      this.logger.error(
        `ARCHIVE ${this.configService.get('S3_VHOST')}${this.configService.get('S3_PREFIX') ? this.configService.get('S3_PREFIX') : ''}${geojsonOrPmtiles}/zones_${geojsonOrPmtiles}_${year}.zip non accessible`,
        e,
      );
    }
    const zip = dataZip ? await JSZip.loadAsync(dataZip) : new JSZip();

    for (
      let m = dateDebut;
      m.diff(moment(), 'days', true) <= 0 && m.year() === year;
      m.add(1, 'days')
    ) {
      const fileName = `zones_arretes_en_vigueur_${m.format('YYYY-MM-DD')}.${geojsonOrPmtiles}`;
      try {
        const filePath =
          m.diff(moment(), 'days', true) === 0
            ? `${path}/zones_arretes_en_vigueur.${geojsonOrPmtiles}`
            : `${path}/${fileName}`;
        this.logger.log(`ADDING ${filePath} to ZIP`);
        const fileData = fs.readFileSync(filePath);
        zip.remove(fileName);
        zip.file(fileName, fileData);
      } catch (e) {
        this.logger.error(`ARCHIVE FICHIER ${fileName} non accessible`, e);
      }
    }

    const newZipData = await zip.generateAsync({ type: 'nodebuffer' });
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
    );
    await this.uploadToDatagouv(
      geojson ? 'geojson_archive' : 'pmtiles_archive',
      s3Response.Location,
      `Cartes des zones et arrêtés en vigueur - ${geojson ? 'GEOJSON' : 'PMTILES'} - Année en cours`,
      true,
    );
    this.logger.log(
      `FIN GENERATION DE L'ARCHIVE ${geojsonOrPmtiles} DE L'ANNEE ${year}`,
    );
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
  ): Promise<void> {
    this.logger.log(`ENVOI VERS DATAGOUV - ${resource}`);

    const resourceId = this.getDataGouvResourceId(resource);
    if (!resourceId) {
      this.logger.warn(`Ressource non configurée : ${resource}`);
      return;
    }

    const url = `${this.datagouvApiUrl}/resources/${resourceId}/`;
    if (!isUrl) {
      await this.uploadDataGouvFile(`${url}upload/`, fileName);
    }

    const body: any = { title };
    if (isUrl) body.url = fileName;

    await this.updateDataGouvResource(resourceId, body);
  }

  private getDataGouvResourceId(resource: string): string | undefined {
    if (resource === 'historique_communes') {
      return this.configService.get(
        'API_DATAGOUV_HISTORIQUE_COMMUNES_RESOURCE_ID',
      );
    }
    const communesMatch = /^communes_(\d{4})$/.exec(resource);
    if (communesMatch) {
      return this.configService.get(
        `API_DATAGOUV_COMMUNES_${communesMatch[1]}_RESOURCE_ID`,
      );
    }
    return this.datagouvResources[resource];
  }

  private async uploadDataGouvFile(
    url: string,
    fileName: string,
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
  ): Promise<void> {
    const url = `${this.datagouvApiUrl}/resources/${resourceId}/`;
    await lastValueFrom(
      this.httpService
        .put(url, body, {
          headers: {
            Accept: 'application/json',
            'X-Api-Key': this.datagouvApiKey,
          },
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

  async updateCommunes(year = new Date().getFullYear()): Promise<void> {
    const definition = this.getCommunesResourceDefinition(year);
    if (!this.getDataGouvResourceId(definition.resource)) {
      this.logger.warn(`Ressource non configurée : ${definition.resource}`);
      return;
    }

    await this.generateCommunesArchive(year, definition.jsonFileName);
    await this.uploadToDatagouv(
      definition.resource,
      definition.zipFileName,
      definition.title,
    );
  }

  async updateHistoriqueCommunes(): Promise<void> {
    if (!this.canUploadToDataGouv()) {
      throw new Error("Configuration manquante pour l'upload vers Datagouv");
    }
    if (!this.getDataGouvResourceId('historique_communes')) {
      throw new Error('Ressource non configurée : historique_communes');
    }

    this.logger.log('MISE A JOUR DATAGOUV - HISTORIQUE COMMUNES - DEBUT');

    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let transactionStarted = false;
    try {
      await queryRunner.connect();
      connected = true;
      await queryRunner.startTransaction();
      transactionStarted = true;
      const [lock] = await queryRunner.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('vigieau:datagouv-historique-communes')) AS locked",
      );
      if (lock?.locked !== true) {
        throw new Error(
          "Une publication de l'historique des communes est déjà en cours",
        );
      }

      const stream =
        await this.statisticCommuneService.getStatisticCommuneStream();
      await this.writeCommunesArchive(
        stream,
        'historique_communes.json',
        'historique_communes.zip',
      );
      await this.uploadToDatagouv(
        'historique_communes',
        'historique_communes.zip',
        'Historique Communes',
      );
    } finally {
      try {
        if (transactionStarted && queryRunner.isTransactionActive) {
          await queryRunner.rollbackTransaction();
        }
      } finally {
        if (connected) {
          await queryRunner.release();
        }
      }
    }

    this.logger.log('MISE A JOUR DATAGOUV - HISTORIQUE COMMUNES - FIN');
  }

  async createOrUpdateCommunesResource(year: number): Promise<string> {
    if (!this.canUploadToDataGouv()) {
      throw new Error("Configuration manquante pour l'upload vers Datagouv");
    }

    const definition = this.getCommunesResourceDefinition(year);
    const configuredResourceId = this.getDataGouvResourceId(
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

    await this.generateCommunesArchive(year, definition.jsonFileName);

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
    return resourceId;
  }

  private async findDataGouvCommuneResources(
    title: string,
    fileName: string,
  ): Promise<Array<{ id: string }>> {
    const response = await firstValueFrom(
      this.httpService.get(`${this.datagouvApiUrl}/`, {
        headers: { Accept: 'application/json' },
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
  ): Promise<void> {
    this.logger.log(`MISE A JOUR DATAGOUV - COMMUNES ${year} - DEBUT`);
    const stream =
      await this.statisticCommuneService.getStatisticCommuneStreamForYear(year);
    await this.writeCommunesArchive(
      stream,
      jsonFileName,
      `restrictions_communes_${year}.zip`,
    );
    this.logger.log(`MISE A JOUR DATAGOUV - COMMUNES ${year} - FIN`);
  }

  private async writeCommunesArchive(
    source: Readable,
    jsonFileName: string,
    zipFileName: string,
  ): Promise<void> {
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

    const contentCompleted = pipeline(
      source,
      this.createCommunesJsonTransform(),
      jsonStream,
    );
    const finalizationCompleted = archive.finalize();

    try {
      await Promise.all([
        contentCompleted,
        finalizationCompleted,
        archiveCompleted,
      ]);
      await rename(temporaryZipFilePath, zipFilePath);
    } catch (error) {
      archive.abort();
      jsonStream.destroy();
      zipStream.destroy();
      await rm(temporaryZipFilePath, { force: true });
      throw error;
    }

    this.logger.log(`Fichier ZIP disponible : ${zipFilePath}`);
  }

  private createCommunesJsonTransform(): Transform {
    let first = true;
    return new Transform({
      writableObjectMode: true,
      transform(chunk: any, _encoding, callback) {
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
}
