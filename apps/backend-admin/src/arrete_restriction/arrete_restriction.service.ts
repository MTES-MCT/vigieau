import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
import { Departement } from '@shared/entities/departement.entity';
import { User } from '@shared/entities/user.entity';
import { StatutArreteCadre } from '@shared/types/arrete_cadre.type';
import moment, { Moment } from 'moment';
import { paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import {
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { AbonnementMailService } from '../abonnement_mail/abonnement_mail.service';
import { ArreteCadreService } from '../arrete_cadre/arrete_cadre.service';
import { ConfigService } from '../config/config.service';
import { DepartementService } from '../departement/departement.service';
import { FichierService } from '../fichier/fichier.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { RestrictionService } from '../restriction/restriction.service';
import { MailService } from '../shared/services/mail.service';
import { StatisticDepartementService } from '../statistic_departement/statistic_departement.service';
import { UserService } from '../user/user.service';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';
import { arreteRestrictionPaginateConfig } from './dto/arrete_restriction.dto';
import { CreateUpdateArreteRestrictionDto } from './dto/create_update_arrete_restriction.dto';
import { PublishArreteRestrictionDto } from './dto/publish_arrete_restriction.dto';
import { RepealArreteRestrictionDto } from './dto/repeal_arrete_restriction.dto';

@Injectable()
export class ArreteRestrictionService {
  private readonly logger = new RegleauLogger('ArreteRestrictionService');

  constructor(
    @InjectRepository(ArreteRestriction)
    private readonly arreteRestrictionRepository: Repository<ArreteRestriction>,
    private readonly departementService: DepartementService,
    @Inject(forwardRef(() => ArreteCadreService))
    private readonly arreteCadreService: ArreteCadreService,
    private readonly restrictionService: RestrictionService,
    private readonly fichierService: FichierService,
    private readonly userService: UserService,
    private readonly mailService: MailService,
    @Inject(forwardRef(() => ZoneAlerteComputedService))
    private readonly zoneAlerteComputedService: ZoneAlerteComputedService,
    private readonly statisticDepartementService: StatisticDepartementService,
    private readonly abonnementMailService: AbonnementMailService,
    private readonly configService: ConfigService,
    private readonly nestConfigService: NestConfigService,
  ) {}

  async findAll(query: PaginateQuery): Promise<Paginated<ArreteRestriction>> {
    const paginateConfig = arreteRestrictionPaginateConfig;
    const paginateToReturn = await paginate(
      query,
      this.arreteRestrictionRepository,
      paginateConfig,
    );

    // Récupérer tous les départements, car on filtre sur les départements
    await Promise.all(
      paginateToReturn.data.map(async (ar) => {
        await Promise.all(
          ar.arretesCadre.map(async (ac) => {
            ac.departements = await this.departementService.findByArreteCadreId(
              ac.id,
            );
            return ac;
          }),
        );
        return ar;
      }),
    );

    return paginateToReturn;
  }

  async find(
    currentUser?: User,
    depCode?: string,
  ): Promise<ArreteRestriction[]> {
    const whereClause: FindOptionsWhere<ArreteRestriction> = {
      statut: In(['a_venir', 'publie']),
      departement: {
        code:
          !currentUser || currentUser.role === 'mte'
            ? depCode
            : In(currentUser.role_departements),
      },
    };
    return this.arreteRestrictionRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        dateDebut: true,
        dateFin: true,
        dateSignature: true,
        statut: true,
        arretesCadre: {
          id: true,
          numero: true,
          statut: true,
          zonesAlerte: {
            id: true,
            code: true,
            nom: true,
            type: true,
            disabled: true,
            departement: {
              id: true,
              code: true,
              nom: true,
            },
          },
        },
      },
      relations: [
        'arretesCadre',
        'arretesCadre.zonesAlerte',
        'arretesCadre.zonesAlerte.departement',
      ],
      where: whereClause,
    });
  }

  async findDatagouv(): Promise<ArreteRestriction[]> {
    return this.arreteRestrictionRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        dateDebut: true,
        dateFin: true,
        dateSignature: true,
        statut: true,
        niveauGraviteSpecifiqueEap: true,
        ressourceEapCommunique: true,
        fichier: {
          url: true,
        },
        departement: {
          code: true,
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
          nomGroupementAep: true,
          niveauGravite: true,
          zoneAlerte: {
            id: true,
            idSandre: true,
            nom: true,
            code: true,
            type: true,
          },
          communes: {
            code: true,
          },
        },
      },
      relations: [
        'fichier',
        'departement',
        'arretesCadre',
        'arretesCadre.fichier',
        'restrictions',
        'restrictions.zoneAlerte',
        'restrictions.communes',
      ],
      where: {
        statut: In(['a_venir', 'publie', 'abroge']),
      },
      order: {
        dateDebut: 'ASC',
      },
    });
  }

  async findOne(id: number, currentUser?: User) {
    const whereClause: FindOptionsWhere<ArreteRestriction> | null =
      !currentUser || currentUser.role === 'mte'
        ? { id }
        : {
            id,
            departement: {
              code: In(currentUser.role_departements),
            },
          };
    const [ar, acs] = await Promise.all(<any>[
      this.arreteRestrictionRepository.findOne(<FindOneOptions>{
        select: {
          id: true,
          numero: true,
          dateDebut: true,
          dateFin: true,
          dateSignature: true,
          statut: true,
          niveauGraviteSpecifiqueEap: true,
          ressourceEapCommunique: true,
          fichier: {
            id: true,
            nom: true,
            url: true,
            size: true,
          },
          restrictions: {
            id: true,
            nomGroupementAep: true,
            zoneAlerte: {
              id: true,
              code: true,
              nom: true,
              type: true,
              ressourceInfluencee: true,
              disabled: true,
            },
            arreteCadre: {
              id: true,
            },
            communes: {
              id: true,
              nom: true,
              code: true,
            },
            niveauGravite: true,
            usages: {
              id: true,
              nom: true,
              thematique: {
                id: true,
                nom: true,
              },
              concerneParticulier: true,
              concerneEntreprise: true,
              concerneCollectivite: true,
              concerneExploitation: true,
              concerneEso: true,
              concerneEsu: true,
              concerneAep: true,
              descriptionVigilance: true,
              descriptionAlerte: true,
              descriptionAlerteRenforcee: true,
              descriptionCrise: true,
            },
          },
          departement: {
            id: true,
            code: true,
          },
          arreteRestrictionAbroge: {
            id: true,
            numero: true,
            dateDebut: true,
            dateFin: true,
          },
        },
        relations: [
          'fichier',
          'restrictions',
          'restrictions.zoneAlerte',
          'restrictions.arreteCadre',
          'restrictions.communes',
          'restrictions.usages',
          'restrictions.usages.thematique',
          'departement',
          'arreteRestrictionAbroge',
        ],
        where: whereClause,
        order: {
          restrictions: {
            zoneAlerte: {
              code: 'ASC',
            },
            nomGroupementAep: 'ASC',
            usages: {
              nom: 'ASC',
            },
            communes: {
              code: 'ASC',
            },
          },
        },
      }),
      this.arreteCadreService.findByArreteRestrictionId(id),
    ]);
    ar.arretesCadre = acs;
    return ar;
  }

  async findByArreteCadreAndDepartement(
    acId: number,
    depCode: string,
  ): Promise<ArreteRestriction[]> {
    return this.arreteRestrictionRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        statut: true,
        restrictions: {
          id: true,
          nomGroupementAep: true,
          zoneAlerte: {
            id: true,
            code: true,
            nom: true,
            type: true,
            disabled: true,
          },
          arreteCadre: {
            id: true,
          },
          communes: {
            id: true,
            nom: true,
            code: true,
          },
        },
      },
      relations: [
        'restrictions',
        'restrictions.zoneAlerte',
        'restrictions.arreteCadre',
        'restrictions.communes',
        'departement',
      ],
      where: {
        arretesCadre: {
          id: acId,
        },
        departement: {
          code: depCode,
        },
        statut: In(['a_venir', 'publie']),
      },
    });
  }

  async findByDepartement(depCode: string): Promise<ArreteRestriction[]> {
    return this.arreteRestrictionRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        statut: true,
        niveauGraviteSpecifiqueEap: true,
        ressourceEapCommunique: true,
        restrictions: {
          id: true,
          nomGroupementAep: true,
          niveauGravite: true,
          zoneAlerte: {
            id: true,
            code: true,
            nom: true,
            type: true,
            disabled: true,
          },
          arreteCadre: {
            id: true,
          },
          communes: {
            id: true,
            nom: true,
            code: true,
          },
        },
        departement: {
          id: true,
          code: true,
          nom: true,
        },
      },
      relations: [
        'restrictions',
        'restrictions.zoneAlerte',
        'restrictions.zonesAlerteComputed',
        'restrictions.arreteCadre',
        'restrictions.communes',
        'departement',
      ],
      where: {
        departement: {
          code: depCode,
        },
        statut: In(['publie']),
      },
    });
  }

  async findByDepartementAndDate(
    depCode: string,
    date: Moment,
  ): Promise<ArreteRestriction[]> {
    return this.arreteRestrictionRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        statut: true,
        niveauGraviteSpecifiqueEap: true,
        ressourceEapCommunique: true,
        restrictions: {
          id: true,
          nomGroupementAep: true,
          niveauGravite: true,
          zoneAlerte: {
            id: true,
            code: true,
            nom: true,
            type: true,
            disabled: true,
          },
          arreteCadre: {
            id: true,
          },
          communes: {
            id: true,
            nom: true,
            code: true,
          },
        },
        departement: {
          id: true,
          code: true,
          nom: true,
        },
      },
      relations: [
        'restrictions',
        'restrictions.zoneAlerte',
        'restrictions.zonesAlerteComputed',
        'restrictions.arreteCadre',
        'restrictions.communes',
        'departement',
      ],
      where: [
        {
          departement: {
            code: depCode,
          },
          statut: In(['publie', 'abroge']),
          dateDebut: LessThanOrEqual(date.format('YYYY-MM-DD')),
          dateFin: MoreThanOrEqual(date.format('YYYY-MM-DD')),
        },
        {
          departement: {
            code: depCode,
          },
          statut: In(['publie', 'abroge']),
          dateDebut: LessThanOrEqual(date.format('YYYY-MM-DD')),
          dateFin: IsNull(),
        },
      ],
    });
  }

  async findByDate(date: Moment) {
    return this.arreteRestrictionRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        dateDebut: true,
        dateFin: true,
        dateSignature: true,
        statut: true,
        fichier: {
          id: true,
          nom: true,
          url: true,
        },
        departement: {
          code: true,
        },
        arretesCadre: {
          id: true,
          numero: true,
          fichier: {
            url: true,
          },
        },
      },
      relations: [
        'fichier',
        'departement',
        'arretesCadre',
        'arretesCadre.fichier',
      ],
      where: [
        {
          statut: In(['publie', 'abroge']),
          dateDebut: LessThanOrEqual(date.format('YYYY-MM-DD')),
          dateFin: MoreThanOrEqual(date.format('YYYY-MM-DD')),
        },
        {
          statut: In(['publie', 'abroge']),
          dateDebut: LessThanOrEqual(date.format('YYYY-MM-DD')),
          dateFin: IsNull(),
        },
      ],
    });
  }

  async create(
    createArreteRestrictionDto: CreateUpdateArreteRestrictionDto,
    currentUser?: User,
  ): Promise<ArreteRestriction> {
    const arreteRestriction: ArreteRestriction =
      await this.arreteRestrictionRepository.save(createArreteRestrictionDto);
    arreteRestriction.restrictions = await this.restrictionService.updateAll(
      createArreteRestrictionDto,
      arreteRestriction.id,
    );
    return arreteRestriction;
  }

  async update(
    id: number,
    updateArreteRestrictionDto: CreateUpdateArreteRestrictionDto,
    currentUser: User,
  ): Promise<ArreteRestriction> {
    const oldAr = await this.findOne(id, currentUser);
    if (!(await this.canUpdateArreteRestriction(oldAr, currentUser))) {
      throw new HttpException(
        `Vous ne pouvez éditer un arrêté de restriction que si il est sur votre département et n'est pas abrogé.`,
        HttpStatus.FORBIDDEN,
      );
    }
    if (oldAr.statut !== 'a_valider') {
      const arBis: ArreteRestriction = {
        ...oldAr,
        ...{
          restrictions: updateArreteRestrictionDto.restrictions,
          arreteRestrictionAbroge:
            updateArreteRestrictionDto.arreteRestrictionAbroge,
        },
      };
      const checkReturn = await this.checkBeforePublish(arBis);
      if (checkReturn.errors.length > 0) {
        throw new HttpException(
          `Impossible de modifier l'arrête de restriction.\n${checkReturn.errors.join('\n')}`,
          HttpStatus.FORBIDDEN,
        );
      }
    }
    // await this.checkAci(updateArreteRestrictionDto, true, currentUser);
    const arreteRestriction: ArreteRestriction =
      await this.arreteRestrictionRepository.save({
        id,
        updatedByHuman: new Date(),
        ...updateArreteRestrictionDto,
      });
    arreteRestriction.restrictions = await this.restrictionService.updateAll(
      updateArreteRestrictionDto,
      arreteRestriction.id,
    );
    this.checkModifications(oldAr, arreteRestriction, currentUser);
    return arreteRestriction;
  }

  async publish(
    id: number,
    arreteRestrictionPdf: Express.Multer.File,
    publishArreteRestrictionDto: PublishArreteRestrictionDto,
    currentUser: User,
  ): Promise<ArreteRestriction> {
    if (
      publishArreteRestrictionDto.dateFin &&
      moment(publishArreteRestrictionDto.dateFin).isBefore(
        publishArreteRestrictionDto.dateDebut,
        'day',
      )
    ) {
      throw new HttpException(
        `La date de fin doit être postérieure à la date de début.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    // CHECKER URL / FILE
    const ar: ArreteRestriction = await this.findOne(id, currentUser);
    // @ts-expect-error type
    const arBis: ArreteRestriction = {
      ...ar,
      ...{
        dateDebut: publishArreteRestrictionDto.dateDebut,
        dateFin: publishArreteRestrictionDto.dateFin,
      },
    };
    if (
      !(await this.canUpdateArreteRestriction(
        ar,
        currentUser,
        !arreteRestrictionPdf,
      ))
    ) {
      throw new HttpException(
        `Impossible de publier l'arrête de restriction.`,
        HttpStatus.FORBIDDEN,
      );
    }
    const checkReturn = await this.checkBeforePublish(arBis);
    if (checkReturn.errors.length > 0) {
      throw new HttpException(
        `Impossible de publier l'arrête de restriction.\n${checkReturn.errors.join('\n')}`,
        HttpStatus.FORBIDDEN,
      );
    }
    if (!arreteRestrictionPdf && !ar.fichier) {
      throw new HttpException(
        `Le PDF de l'arrêté de restriction est obligatoire.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    let toSave: any = {
      id,
      ...publishArreteRestrictionDto,
    };
    // Upload du PDF de l'arrêté cadre
    if (arreteRestrictionPdf) {
      if (ar.fichier) {
        await this.arreteRestrictionRepository.update(
          { id: id },
          { fichier: null },
        );
        await this.fichierService.deleteById(ar.fichier.id);
      }
      const newFile = await this.fichierService.create(
        arreteRestrictionPdf,
        `arrete-restriction/${ar.id}/`,
      );
      toSave.fichier = { id: newFile.id, nom: newFile.nom };
    }
    toSave = moment(publishArreteRestrictionDto.dateDebut).isSameOrBefore(
      moment(),
      'day',
    )
      ? publishArreteRestrictionDto.dateFin &&
        moment(publishArreteRestrictionDto.dateFin).isBefore(moment(), 'day')
        ? { ...toSave, ...{ statut: <StatutArreteCadre>'abroge' } }
        : { ...toSave, ...{ statut: <StatutArreteCadre>'publie' } }
      : { ...toSave, ...{ statut: <StatutArreteCadre>'a_venir' } };
    const toReturn: any = await this.arreteRestrictionRepository.save(toSave);
    if (!arreteRestrictionPdf) {
      toReturn.fichier = ar.fichier;
    }

    // Gestion des abrogations associées
    if (ar.arreteRestrictionAbroge) {
      const dateDebutAr = new Date(publishArreteRestrictionDto.dateDebut);
      const dateFinArAbroge = ar.arreteRestrictionAbroge.dateFin
        ? new Date(ar.arreteRestrictionAbroge.dateFin)
        : null;
      if (
        !dateFinArAbroge ||
        moment(dateFinArAbroge).isSameOrAfter(moment(dateDebutAr), 'day')
      ) {
        const dateToSave = dateDebutAr;
        dateToSave.setDate(dateToSave.getDate() - 1);
        await this.arreteRestrictionRepository.update(
          {
            id: ar.arreteRestrictionAbroge.id,
          },
          {
            dateFin: dateToSave.toDateString(),
          },
        );
      }
    }
    if (
      ar.dateDebut !== publishArreteRestrictionDto.dateDebut ||
      ar.dateFin !== publishArreteRestrictionDto.dateFin
    ) {
      const minDate = moment(ar.dateDebut).isBefore(
        moment(publishArreteRestrictionDto.dateDebut),
      )
        ? ar.dateDebut
        : publishArreteRestrictionDto.dateDebut;
      await this.configService.setConfig(minDate, minDate);
    }
    this.updateArreteRestrictionStatut([ar.departement]);
    this.checkModifications(ar, toReturn, currentUser, true);
    return toReturn;
  }

  async repeal(
    id: number,
    repealArreteRestrictionDto: RepealArreteRestrictionDto,
    currentUser: User,
  ): Promise<ArreteRestriction> {
    const ar = await this.findOne(id, currentUser);
    if (
      !(await this.canRepealArreteRestriction(
        ar,
        repealArreteRestrictionDto,
        currentUser,
      ))
    ) {
      throw new HttpException(
        `Abrogation impossible.`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    let toSave = {
      id,
      ...repealArreteRestrictionDto,
    };
    if (moment(repealArreteRestrictionDto.dateFin).isBefore(moment(), 'day')) {
      toSave = { ...toSave, ...{ statut: <StatutArreteCadre>'abroge' } };
    }
    const toReturn = await this.arreteRestrictionRepository.save(toSave);
    await this.updateArreteRestrictionStatut([ar.departement]);
    return toReturn;
  }

  async checkBeforePublish(ar: ArreteRestriction) {
    const errors = [];
    const warnings = [];
    /**
     * Check des arrêtés cadre, si un des ACs n'est pas publié, on ne peut pas publier l'AR
     */
    const maxDateDebut = new Date(
      Math.max.apply(
        null,
        ar.arretesCadre
          .filter((ac) => ac.dateDebut)
          .map((ac) =>
            ac.dateDebut ? new Date(ac.dateDebut).getTime() : null,
          ),
      ),
    );
    const minDateFin = ar.arretesCadre.some((ac) => ac.dateFin)
      ? new Date(
          Math.min.apply(
            null,
            ar.arretesCadre
              .filter((ac) => ac.dateFin)
              .map((ac) =>
                ac.dateFin ? new Date(ac.dateFin).getTime() : null,
              ),
          ),
        )
      : null;
    ar.arretesCadre.forEach((ac) => {
      switch (ac.statut) {
        case 'a_valider':
          errors.push(
            `L'arrête cadre ${ac.numero} est en brouillon, il n'est pas possible de publier un AR dessus.`,
          );
          break;
        case 'abroge':
          errors.push(
            `L'arrête cadre ${ac.numero} est abrogé, il n'est pas possible de publier un AR dessus.`,
          );
          break;
      }
      if (ac.zonesAlerte.some((za) => za.disabled)) {
        errors.push(
          `L'arrête cadre ${ac.numero} est gelé, il contient des zones qui ne sont plus à jour.`,
        );
      }
    });
    const acFreeze = ar.arretesCadre.find((ac) =>
      ac.zonesAlerte.some((z) => z.disabled),
    );
    if (acFreeze) {
      errors.push(
        `L'arrête cadre ${acFreeze.numero} est gelé, il n'est pas possible de publier un AR dessus.`,
      );
    }
    if (
      ar.arretesCadre.some((ac) => ['a_venir', 'publie'].includes(ac.statut))
    ) {
      // Check des dates (un AR doit avoir ses dates incluses dans celle de l'AC)
      warnings.push(
        `Pour respecter les dates des arrêtés cadre associés, l'arrêté de restriction doit commencer à partir du ${maxDateDebut.toLocaleDateString('fr')}${minDateFin ? 'et terminer avant le ' + minDateFin.toLocaleDateString('fr') + '.' : '.'}`,
      );
      if (
        new Date(ar.dateDebut).getTime() < maxDateDebut.getTime() ||
        (minDateFin && new Date(ar.dateDebut).getTime() > minDateFin.getTime())
      ) {
        if (minDateFin) {
          errors.push(
            `Pour respecter les dates des arrêtés cadre associés, la date de début de l'arrêté de restriction doit être comprise entre le ${maxDateDebut.toLocaleDateString('fr')} et le ${minDateFin.toLocaleDateString('fr')}.`,
          );
        } else {
          errors.push(
            `Pour respecter les dates des arrêtés cadre associés, l'arrêté de restriction doit commencer à partir du ${maxDateDebut.toLocaleDateString('fr')}.`,
          );
        }
      }
      // Check date AR abrogé
      if (ar.arreteRestrictionAbroge) {
        const dateDebutAr = new Date(ar.dateDebut);
        const dateDebutArAbroge = new Date(
          ar.arreteRestrictionAbroge.dateDebut,
        );
        if (dateDebutAr.getTime() <= dateDebutArAbroge.getTime()) {
          errors.push(
            `La date de début de l'arrêté de restriction doit être supérieur à celle de l'arrêté de restriction abrogé.`,
          );
        }
      }
      if (
        ar.dateFin &&
        minDateFin &&
        new Date(ar.dateFin).getTime() > minDateFin.getTime()
      ) {
        errors.push(
          `Pour respecter les dates des arrêtés cadre associés, la date de fin de l'arrêté de restriction doit être antérieur au ${minDateFin.toLocaleDateString('fr')}.`,
        );
      }
    }
    if (ar.restrictions.length < 1) {
      errors.push(
        `L'arrête de restriction doit contenir au minimum une zone (ESO / ESU ou AEP).`,
      );
    }
    const zonesId = ar.restrictions
      .filter((r) => !!r.zoneAlerte)
      .map((r) => r.zoneAlerte.id);
    const communesId = ar.restrictions
      .filter((r) => !r.zoneAlerte)
      .map((r) => r.communes)
      .flat()
      .map((c) => c.id);
    const idsExcluded = [ar.id];
    if (ar.arreteRestrictionAbroge) {
      idsExcluded.push(ar.arreteRestrictionAbroge.id);
    }
    const arsWithSameZonesOrCommunes =
      await this.arreteRestrictionRepository.find(<FindManyOptions>{
        select: {
          id: true,
          numero: true,
          dateDebut: true,
          dateFin: true,
          statut: true,
        },
        where: {
          restrictions: [
            { zoneAlerte: { id: In(zonesId) } },
            { communes: { id: In(communesId) } },
          ],
          statut: In(['a_venir', 'publie']),
          id: Not(In(idsExcluded)),
        },
        relations: [],
      });
    const minDateDebut = arsWithSameZonesOrCommunes.some((ar) => ar.dateDebut)
      ? new Date(
          Math.min.apply(
            null,
            arsWithSameZonesOrCommunes.map((ar) =>
              new Date(ar.dateDebut).getTime(),
            ),
          ),
        )
      : null;
    const maxDateFin = arsWithSameZonesOrCommunes.some((ar) => ar.dateFin)
      ? new Date(
          Math.max.apply(
            null,
            arsWithSameZonesOrCommunes.map((ar) =>
              new Date(ar.dateFin).getTime(),
            ),
          ),
        )
      : null;
    if (arsWithSameZonesOrCommunes.length > 0) {
      let message = `D'autres arrêtés de restrictions sont à venir ou en vigueur sur des zones ou communes similaires (${arsWithSameZonesOrCommunes.map((ar) => ar.numero).join(', ')}).`;
      if (minDateDebut) {
        message += ` Votre arrêté de restriction doit terminer avant le ${minDateDebut.toLocaleDateString('fr')}`;
      }
      if (maxDateFin) {
        message += ` ou commencer après le ${maxDateFin.toLocaleDateString('fr')}`;
      }
      if (minDateDebut) {
        message += ` afin de ne pas chevaucher les autres arrêtés de restrictions.`;
      }
      warnings.push(message);
      if (
        (ar.dateDebut &&
          new Date(ar.dateDebut).getTime() >= minDateDebut.getTime() &&
          (!maxDateFin ||
            new Date(ar.dateDebut).getTime() <= maxDateFin.getTime())) ||
        (ar.dateFin &&
          new Date(ar.dateFin).getTime() >= minDateDebut.getTime() &&
          (!maxDateFin ||
            new Date(ar.dateFin).getTime() <= maxDateFin.getTime())) ||
        (ar.dateDebut &&
          ar.dateFin &&
          new Date(ar.dateDebut).getTime() < minDateDebut.getTime() &&
          new Date(ar.dateFin).getTime() > maxDateFin.getTime())
      ) {
        errors.push(message);
      }
    }
    return {
      errors,
      warnings,
    };
  }

  async remove(id: number, curentUser: User) {
    const arrete = await this.findOne(id, curentUser);
    if (!(await this.canRemoveArreteRestriction(arrete, curentUser))) {
      throw new HttpException(
        `Vous ne pouvez supprimer un arrêté de restriction que si il est sur votre département.`,
        HttpStatus.FORBIDDEN,
      );
    }

    await this.arreteRestrictionRepository.update(
      {
        arreteRestrictionAbroge: { id: id },
      },
      {
        arreteRestrictionAbroge: null,
      },
    );
    await this.arreteRestrictionRepository.delete(id);
    if (arrete.statut === 'publie') {
      this.zoneAlerteComputedService.askCompute([arrete.departement.id], false);
      this.statisticDepartementService.computeDepartementStatistics();
    }
    return;
  }

  async deleteByArreteCadreId(acId: number) {
    const arIds = await this.arreteRestrictionRepository
      .createQueryBuilder('arreteRestriction')
      .select('arreteRestriction.id')
      .leftJoin('arreteRestriction.arretesCadre', 'arretesCadre')
      .where('arretesCadre.id = :acId', { acId: acId })
      .getMany();
    return this.arreteRestrictionRepository.delete({
      id: In(arIds.map((ar) => ar.id)),
    });
  }

  async canUpdateArreteRestriction(
    arreteRestriction: ArreteRestriction,
    user: User,
    containUrl: boolean = false,
  ): Promise<boolean> {
    return (
      arreteRestriction &&
      (!containUrl || !!arreteRestriction.fichier) &&
      (user.role === 'mte' ||
        (arreteRestriction.statut !== 'abroge' &&
          user.role_departements.includes(arreteRestriction.departement.code) &&
          !arreteRestriction.restrictions.some((r) => r.zoneAlerte?.disabled)))
    );
  }

  async canRemoveArreteRestriction(
    arrete: ArreteRestriction,
    user: User,
  ): Promise<boolean> {
    /**
     * On peut supprimer un AR s'il est sur le département de l'utilisateur
     * ou que l'utilisateur a un rôle MTE
     */
    return (
      arrete &&
      (user.role === 'mte' ||
        (user.role_departements.includes(arrete.departement.code) &&
          ['a_valider'].includes(arrete.statut)))
    );
  }

  async canRepealArreteRestriction(
    arrete: ArreteRestriction,
    repealArreteRestriction: RepealArreteRestrictionDto,
    user: User,
  ): Promise<boolean> {
    if (
      repealArreteRestriction.dateFin &&
      moment(repealArreteRestriction.dateFin).isBefore(
        moment(arrete.dateDebut),
        'day',
      )
    ) {
      throw new HttpException(
        `La date de fin doit être postérieure à la date de début.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return (
      arrete &&
      ['a_venir', 'publie'].includes(arrete.statut) &&
      (user.role === 'mte' ||
        user.role_departements.includes(arrete.departement.code))
    );
  }

  /**
   * Mis à jour des statuts des AR en fonction de ceux des ACs
   * On reprend tout pour éviter que certains AR soient passés entre les mailles du filet (notamment l'historique ou autre)
   */
  async updateArreteRestrictionStatut(
    departements?: Departement[],
    computeHistoric?: boolean,
  ) {
    const arAVenir = await this.arreteRestrictionRepository.find(<
      FindManyOptions
    >{
      where: {
        statut: 'a_venir',
        dateDebut: LessThanOrEqual(new Date()),
        arretesCadre: {
          statut: 'publie',
        },
      },
    });
    await this.arreteRestrictionRepository.update(
      { id: In(arAVenir.map((ar) => ar.id)) },
      { statut: 'publie' },
    );
    this.logger.log(`${arAVenir.length} Arrêtés Restriction publiés`);

    const minDateDebut =
      arAVenir.length > 0
        ? arAVenir
            .map((ar) => ar.dateDebut)
            .reduce((min, date) => {
              return moment(date).isBefore(moment(min)) ? date : min;
            })
        : moment().format();
    // Si un AR commence avant aujourd'hui
    if (moment(minDateDebut).isBefore(moment(), 'day')) {
      await this.configService.setConfig(minDateDebut, minDateDebut);
    }

    const arPerime: ArreteRestriction[] =
      await this.arreteRestrictionRepository.find(<FindManyOptions>{
        select: {
          id: true,
          dateDebut: true,
          dateFin: true,
          arretesCadre: {
            id: true,
            statut: true,
            dateFin: true,
          },
        },
        relations: ['arretesCadre'],
        where: [
          {
            statut: In(['a_venir', 'publie']),
            dateFin: LessThan(moment().startOf('day')),
          },
          {
            statut: In(['a_venir', 'publie']),
            arretesCadre: {
              statut: 'abroge',
            },
          },
        ],
      });
    const promises = [];
    arPerime.forEach((ar) => {
      const arDateFin = moment(ar.dateFin);
      const arDateDebut = moment(ar.dateDebut);
      const acDateFin = moment(
        Math.min.apply(
          null,
          ar.arretesCadre
            .filter((ac) => ac.statut === 'abroge')
            .map((ac) => new Date(ac.dateFin)),
        ),
      );
      if (
        (!ar.dateFin && acDateFin) ||
        (ar.dateFin && acDateFin && arDateFin.isAfter(acDateFin))
      ) {
        promises.push(
          this.arreteRestrictionRepository.update(
            { id: ar.id },
            // @ts-ignore
            { dateFin: acDateFin.format('YYYY-MM-DD') },
          ),
        );
        if (acDateFin.isBefore(arDateDebut)) {
          promises.push(
            this.arreteRestrictionRepository.update(
              { id: ar.id },
              // @ts-ignore
              { dateDebut: acDateFin.format('YYYY-MM-DD') },
            ),
          );
          ar.dateDebut = acDateFin.format('YYYY-MM-DD');
        }
        ar.dateFin = acDateFin.format('YYYY-MM-DD');
      }
    });
    promises.push(
      this.arreteRestrictionRepository.update(
        { id: In(arPerime.map((ar) => ar.id)) },
        { statut: 'abroge' },
      ),
    );
    await Promise.all(promises);
    this.logger.log(`${arPerime.length} Arrêtés Restriction abrogés`);

    // ARs qui se sont terminés avant hier
    const arsFiltered = arPerime.filter((ar) =>
      moment(ar.dateFin).isBefore(moment().subtract(1, 'day').startOf('day')),
    );
    // Si un AR commence avant aujourd'hui
    if (arsFiltered.length > 0) {
      const minDate = arsFiltered
        .map((ar) => ar.dateDebut)
        .reduce((min, date) => {
          return moment(date).isBefore(moment(min)) ? date : min;
        });
      await this.configService.setConfig(minDate, minDate);
    }

    try {
      await this.statisticDepartementService.computeDepartementStatistics();
    } catch (e) {
      this.logger.error('ERREUR COMPUTE DEPARTEMENTS STATISTICS', e);
    }
    this.zoneAlerteComputedService.askCompute(
      departements ? departements.map((d) => d.id) : [],
      false,
      computeHistoric,
    );
  }

  /**
   * Vérification s'il faut envoyer des mails de relance tous les jours à 8h du matin
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendArreteRestrictionEmails() {
    const [ar15ARelancer, ar2ARelancer] = await Promise.all([
      this.getArAtXDays(15),
      this.getArAtXDays(2),
    ]);
    for (const ar of ar15ARelancer.concat(ar2ARelancer)) {
      const [usersToSendMail, subscritpions] = await Promise.all([
        this.userService.findByDepartementsId([ar.departement.id]),
        this.abonnementMailService.getCountByDepartement(ar.departement.code),
      ]);
      const nbJoursFin = ar15ARelancer.some((a) => a.id === ar.id) ? 15 : 2;
      await this.mailService.sendEmails(
        usersToSendMail.map((u) => u.email),
        `L'arrêté ${ar.numero} se termine dans ${nbJoursFin} jours`,
        'relance_arrete',
        {
          arreteNumero: ar.numero,
          arreteDateFin: ar.dateFin,
          joursFin: nbJoursFin,
          isAc: false,
          isAr: true,
          arreteLien: `https://${this.nestConfigService.get('DOMAIN_NAME')}/arrete-restriction/${ar.id}/edition`,
          subscritpions: subscritpions,
        },
      );
    }

    const arARelancer = await this.getArByMonth();
    for (const ar of arARelancer) {
      const usersToSendMail = await this.userService.findByDepartementsId([
        ar.departement.id,
      ]);
      const nbMonths =
        new Date().getMonth() -
        new Date(ar.dateDebut).getMonth() +
        12 * (new Date().getFullYear() - new Date(ar.dateDebut).getFullYear());
      await this.mailService.sendEmails(
        usersToSendMail.map((u) => u.email),
        `L'arrêté ${ar.numero} est actif depuis ${nbMonths} mois`,
        'relance_arrete_mois',
        {
          arreteNumero: ar.numero,
          arreteDateDebut: ar.dateDebut,
          arreteDateFin: ar.dateFin,
          nbMonths: nbMonths,
          arreteLien: `https://${this.nestConfigService.get('DOMAIN_NAME')}/arrete-restriction/${ar.id}/edition`,
        },
      );
    }
  }

  private getArAtXDays(days: number) {
    return this.arreteRestrictionRepository
      .createQueryBuilder('arrete_restriction')
      .leftJoinAndSelect('arrete_restriction.departement', 'departement')
      .where('arrete_restriction.statut IN (:...statuts)', {
        statuts: ['a_venir', 'publie'],
      })
      .having(
        `DATE_PART('day', "dateFin"::timestamp - CURRENT_DATE::timestamp) = ${days}`,
      )
      .groupBy('arrete_restriction.id')
      .addGroupBy('departement.id')
      .getMany();
  }

  private getArByMonth() {
    return this.arreteRestrictionRepository
      .createQueryBuilder('arrete_restriction')
      .leftJoinAndSelect('arrete_restriction.departement', 'departement')
      .where('arrete_restriction.statut IN (:...statuts)', {
        statuts: ['publie'],
      })
      .andWhere(
        `DATE_PART('day', "dateDebut"::timestamp) = DATE_PART('day', current_date)`,
      )
      .having(
        `DATE_PART('day', CURRENT_DATE::timestamp - "dateDebut"::timestamp) > 27`,
      )
      .groupBy('arrete_restriction.id')
      .addGroupBy('departement.id')
      .getMany();
  }

  private async checkModifications(
    oldAr: ArreteRestriction,
    newAr: ArreteRestriction,
    currentUser: User,
    publish = false,
  ) {
    if (oldAr.statut !== 'publie') {
      return;
    }
    const model = publish
      ? {
          dateDebut: true,
          fichier: {
            nom: true,
          },
        }
      : {
          numero: true,
          niveauGraviteSpecifiqueEap: true,
          ressourceEapCommunique: true,
          arreteRestrictionAbroge: {
            id: true,
            numero: true,
          },
          arretesCadre: [
            {
              id: true,
              numero: true,
            },
          ],
          restrictions: [
            {
              id: true,
              zoneAlerte: {
                id: true,
                code: true,
                nom: true,
              },
              niveauGravite: true,
              communes: [
                {
                  id: true,
                },
              ],
              usages: [
                {
                  nom: true,
                },
              ],
            },
          ],
        };
    const oldArLight = this.filterObjectByModel(oldAr, model);
    const newArLight = this.filterObjectByModel(newAr, model);
    const diff = this.compare(
      structuredClone(oldArLight),
      structuredClone(newArLight),
    );
    if (Object.keys(diff).length > 0) {
      await this.mailService.sendEmail(
        this.nestConfigService.get('MAIL_MTE'),
        `Des modifications importantes ont été apportées à l’arrêté ${oldAr.numero}`,
        'maj_ar',
        {
          date: new Date().toLocaleDateString(),
          userEmail: currentUser.email,
          userDepartement: currentUser.role_departements?.join(', '),
          arreteNumero: oldAr.numero,
          oldAr: oldArLight,
          newAr: newArLight,
          diffAr: diff,
          arreteLien: `https://${this.nestConfigService.get('DOMAIN_NAME')}/arrete-restriction/${oldAr.id}/edition`,
        },
      );
      if (!publish) {
        if (diff.restrictions && diff.restrictions.some((r) => r.id)) {
          await this.configService.setConfig(oldAr.dateDebut, oldAr.dateDebut);
        } else {
          await this.configService.setConfig(oldAr.dateDebut, null);
        }
      }
    }
  }

  private compare(original: any, copy: any) {
    for (let [k, v] of Object.entries(original)) {
      if (typeof v === 'object' && v !== null) {
        if (!copy.hasOwnProperty(k)) {
          copy[k] = v;
        } else {
          this.compare(v, copy?.[k]);
        }
      } else {
        if (Object.is(v, copy?.[k])) {
          delete copy?.[k];
        }
      }
    }
    return this.removeEmpty(copy);
  }

  private filterObjectByModel(obj: any, model: any): any {
    const filteredObj: any = {};

    for (const key in model) {
      if (obj && key in obj) {
        if (
          typeof obj[key] === 'object' &&
          !Array.isArray(obj[key]) &&
          typeof model[key] === 'object' &&
          !Array.isArray(model[key])
        ) {
          filteredObj[key] = this.filterObjectByModel(obj[key], model[key]);
        } else if (
          Array.isArray(obj[key]) &&
          Array.isArray(model[key]) &&
          model[key].length > 0
        ) {
          filteredObj[key] = obj[key].map((item: any) => {
            if (typeof item === 'object' && !Array.isArray(item)) {
              return this.filterObjectByModel(item, model[key][0]);
            }
            return item;
          });
        } else {
          filteredObj[key] = obj[key];
        }
      }
    }

    return this.removeEmpty(filteredObj);
  }

  private removeEmpty(object) {
    Object.entries(object).forEach(([k, v]) => {
      if (v && typeof v === 'object') {
        this.removeEmpty(v);
      }
      if (
        (v && typeof v === 'object' && !Object.keys(v).length) ||
        v === null ||
        v === undefined
      ) {
        if (Array.isArray(object)) {
          // @ts-ignore
          object.splice(k, 1);
          this.removeEmpty(object);
        } else {
          delete object[k];
        }
      }
    });
    return object;
  }
}
