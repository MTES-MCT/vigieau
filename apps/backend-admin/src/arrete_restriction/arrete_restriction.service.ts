import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { BusinessCron } from '../core/scheduling/business-cron';
import { shiftCivilDate } from '../core/scheduling/daily-job-schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { Departement } from '@shared/entities/departement.entity';
import { User } from '@shared/entities/user.entity';
import moment, { Moment } from 'moment';
import { paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import {
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  EntityManager,
  In,
  IsNull,
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
import {
  areCivilDatesEqual,
  getArreteLifecycleStatus,
  getCurrentParisCivilDate,
  getPredecessorEndDateConstraint,
  getPublicationEndDateProvenance,
  hasArreteComputationStateChanged,
  hasArreteMutationVersionChanged,
  normalizeCivilDate,
  resolveArreteEndDate,
  UnknownArreteEndDateProvenanceError,
} from '../shared/arrete-date-continuity';
import { StatisticDepartementService } from '../statistic_departement/statistic_departement.service';
import { UserService } from '../user/user.service';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';
import type { DailyZonePublicationReuseContext } from '../zone_publication/zone_publication.service';
import { isZonePublicationEnabled } from '../zone_publication/zone_publication.config';
import { arreteRestrictionPaginateConfig } from './dto/arrete_restriction.dto';
import { CreateUpdateArreteRestrictionDto } from './dto/create_update_arrete_restriction.dto';
import { PublishArreteRestrictionDto } from './dto/publish_arrete_restriction.dto';
import { RepealArreteRestrictionDto } from './dto/repeal_arrete_restriction.dto';

@Injectable()
export class ArreteRestrictionService {
  private readonly logger = new RegleauLogger('ArreteRestrictionService');
  private currentZoneRecomputeInFlight: Promise<void> | null = null;

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
          updated_at: true,
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
    void currentUser;
    return this.arreteRestrictionRepository.manager.transaction(
      'SERIALIZABLE',
      async (manager) => {
        await this.lockArreteCadresForMutation(
          manager,
          (createArreteRestrictionDto.arretesCadre ?? []).map(({ id }) => id),
        );
        const repository = manager.getRepository(ArreteRestriction);
        const arreteRestriction = (await repository.save(
          createArreteRestrictionDto,
        )) as ArreteRestriction;
        arreteRestriction.restrictions =
          await this.restrictionService.updateAll(
            createArreteRestrictionDto,
            arreteRestriction.id,
            manager,
          );
        return arreteRestriction;
      },
    );
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
    // await this.checkAci(updateArreteRestrictionDto, true, currentUser);
    let arreteRestriction: ArreteRestriction;
    if (oldAr.statut === 'a_valider') {
      const initialArreteCadreIds = oldAr.arretesCadre.map(({ id }) => id);
      const nextArreteCadreIds = (
        updateArreteRestrictionDto.arretesCadre ?? oldAr.arretesCadre
      ).map(({ id }) => id);
      arreteRestriction =
        await this.arreteRestrictionRepository.manager.transaction(
          'SERIALIZABLE',
          async (manager) => {
            await this.lockArreteCadresForMutation(manager, [
              ...initialArreteCadreIds,
              ...nextArreteCadreIds,
            ]);
            const repository = manager.getRepository(ArreteRestriction);
            await this.lockArreteRestrictionGraph(repository, [id]);
            const current = await this.findOneForContinuity(repository, id);
            const authorizationState =
              await this.findOneForMutationAuthorization(repository, id);
            if (
              current.statut !== 'a_valider' ||
              hasArreteMutationVersionChanged(oldAr, current) ||
              !(await this.canUpdateArreteRestriction(
                authorizationState,
                currentUser,
              ))
            ) {
              throw new HttpException(
                `L'arrêté a été modifié pendant son enregistrement. Veuillez recommencer.`,
                HttpStatus.CONFLICT,
              );
            }
            const saved = (await repository.save({
              id,
              updatedByHuman: new Date(),
              ...updateArreteRestrictionDto,
            })) as ArreteRestriction;
            saved.restrictions = await this.restrictionService.updateAll(
              updateArreteRestrictionDto,
              saved.id,
              manager,
            );
            return saved;
          },
        );
    } else {
      const initialPredecessorId = oldAr.arreteRestrictionAbroge?.id;
      const hasPredecessorUpdate = Object.prototype.hasOwnProperty.call(
        updateArreteRestrictionDto,
        'arreteRestrictionAbroge',
      );
      const nextPredecessorId = hasPredecessorUpdate
        ? updateArreteRestrictionDto.arreteRestrictionAbroge?.id
        : initialPredecessorId;
      const hasArreteCadreUpdate = Object.prototype.hasOwnProperty.call(
        updateArreteRestrictionDto,
        'arretesCadre',
      );
      const initialArreteCadreIds = oldAr.arretesCadre.map(({ id }) => id);
      const nextArreteCadreIds = hasArreteCadreUpdate
        ? (updateArreteRestrictionDto.arretesCadre ?? []).map(({ id }) => id)
        : initialArreteCadreIds;
      if (nextPredecessorId === id) {
        throw new HttpException(
          `Un arrêté ne peut pas s'abroger lui-même.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      const businessDate = getCurrentParisCivilDate();
      try {
        arreteRestriction =
          await this.arreteRestrictionRepository.manager.transaction(
            'SERIALIZABLE',
            async (manager) => {
              const repository = manager.getRepository(ArreteRestriction);
              const lockedArretesCadre = await this.lockArreteCadresForMutation(
                manager,
                [...initialArreteCadreIds, ...nextArreteCadreIds],
              );
              const affectedIds = [
                ...new Set(
                  [id, initialPredecessorId, nextPredecessorId].filter(
                    (arreteId): arreteId is number => arreteId !== undefined,
                  ),
                ),
              ].sort((left, right) => left - right);
              const before = await this.lockAndValidateArreteRestrictionChain(
                repository,
                id,
                initialPredecessorId,
                nextPredecessorId,
                updateArreteRestrictionDto.departement?.id ??
                  oldAr.departement.id,
              );
              const current = before.find((arrete) => arrete.id === id);
              if (
                !current ||
                current.arreteRestrictionAbroge?.id !== initialPredecessorId ||
                hasArreteComputationStateChanged(oldAr, current) ||
                hasArreteMutationVersionChanged(oldAr, current)
              ) {
                throw new HttpException(
                  `L'arrêté a été modifié pendant son enregistrement. Veuillez recommencer.`,
                  HttpStatus.CONFLICT,
                );
              }
              const authorizationState =
                await this.findOneForMutationAuthorization(repository, id);
              if (
                !(await this.canUpdateArreteRestriction(
                  authorizationState,
                  currentUser,
                ))
              ) {
                throw new HttpException(
                  `L'arrêté a été modifié pendant son enregistrement. Veuillez recommencer.`,
                  HttpStatus.CONFLICT,
                );
              }
              const proposedArretesCadre = nextArreteCadreIds.map(
                (arreteCadreId) => {
                  const arreteCadre = lockedArretesCadre.find(
                    ({ id: candidateId }) => candidateId === arreteCadreId,
                  );
                  if (!arreteCadre) {
                    throw new HttpException(
                      `Un arrêté cadre lié a été modifié. Veuillez recommencer.`,
                      HttpStatus.CONFLICT,
                    );
                  }
                  return arreteCadre;
                },
              );
              const transactionCheck = await this.checkBeforePublish(
                {
                  ...authorizationState,
                  restrictions: updateArreteRestrictionDto.restrictions,
                  arretesCadre: proposedArretesCadre,
                  arreteRestrictionAbroge: nextPredecessorId
                    ? before.find((arrete) => arrete.id === nextPredecessorId)
                    : null,
                } as unknown as ArreteRestriction,
                repository,
              );
              if (transactionCheck.errors.length > 0) {
                throw new HttpException(
                  `L'arrêté a été modifié pendant son enregistrement. Veuillez recommencer.`,
                  HttpStatus.CONFLICT,
                );
              }
              const saved = await repository.save({
                id,
                updatedByHuman: new Date(),
                ...updateArreteRestrictionDto,
              });
              const savedCurrent = await this.findOneForContinuity(
                repository,
                id,
              );
              if (
                savedCurrent.arreteRestrictionAbroge?.id !==
                  nextPredecessorId ||
                savedCurrent.departement?.id !==
                  (updateArreteRestrictionDto.departement?.id ??
                    current.departement.id) ||
                savedCurrent.arretesCadre.length !==
                  nextArreteCadreIds.length ||
                savedCurrent.arretesCadre.some(
                  ({ id: arreteCadreId }) =>
                    !nextArreteCadreIds.includes(arreteCadreId),
                )
              ) {
                throw new HttpException(
                  `Le lien entre les arrêtés n'a pas pu être enregistré. Veuillez recommencer.`,
                  HttpStatus.CONFLICT,
                );
              }
              for (const affectedId of affectedIds) {
                const synchronized =
                  await this.synchronizeArreteRestrictionEndDate(
                    repository,
                    affectedId,
                    businessDate,
                  );
                if (affectedId === id) {
                  Object.assign(saved, synchronized);
                }
              }
              Object.assign(saved, {
                restrictions: await this.restrictionService.updateAll(
                  updateArreteRestrictionDto,
                  saved.id,
                  manager,
                ),
              });
              await this.invalidateComputationsFromWithManager(
                manager,
                before
                  .map(({ dateDebut }) => normalizeCivilDate(dateDebut))
                  .sort()[0],
              );
              await this.enqueueCurrentZoneRecomputeWithManager(manager, [
                oldAr.departement.id,
                updateArreteRestrictionDto.departement?.id ??
                  oldAr.departement.id,
              ]);
              return saved;
            },
          );
      } catch (error) {
        if (error instanceof UnknownArreteEndDateProvenanceError) {
          throw new HttpException(error.message, HttpStatus.CONFLICT);
        }
        throw error;
      }
      const departements = [
        oldAr.departement,
        updateArreteRestrictionDto.departement,
      ].filter(
        (departement, index, all) =>
          !!departement &&
          all.findIndex(({ id }) => id === departement.id) === index,
      ) as Departement[];
      this.requestCurrentZoneRecompute(departements, 'MODIFICATION AR');
    }
    this.checkModifications(oldAr, arreteRestriction, currentUser);
    delete arreteRestriction.dateFinSaisie;
    delete arreteRestriction.dateFinCalculee;
    delete arreteRestriction.dateFinSaisieConnue;
    return arreteRestriction;
  }

  async publish(
    id: number,
    arreteRestrictionPdf: Express.Multer.File,
    publishArreteRestrictionDto: PublishArreteRestrictionDto,
    currentUser: User,
  ): Promise<ArreteRestriction> {
    let dateDebut: string;
    let dateFin: string | null;
    let dateSignature: string | null;
    try {
      dateDebut = normalizeCivilDate(publishArreteRestrictionDto.dateDebut);
      dateFin = publishArreteRestrictionDto.dateFin
        ? normalizeCivilDate(publishArreteRestrictionDto.dateFin)
        : null;
      dateSignature = publishArreteRestrictionDto.dateSignature
        ? normalizeCivilDate(publishArreteRestrictionDto.dateSignature)
        : null;
    } catch {
      throw new HttpException(
        `Les dates de l'arrêté de restriction sont invalides.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dateFin && dateFin < dateDebut) {
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
        dateDebut,
        dateFin,
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
      dateDebut,
      dateFin,
      dateSignature,
    };
    let newFile: { id: number; nom: string } | null = null;
    if (arreteRestrictionPdf) {
      newFile = await this.fichierService.createImmutable(
        arreteRestrictionPdf,
        `arrete-restriction/${ar.id}/`,
      );
      toSave.fichier = { id: newFile.id, nom: newFile.nom };
    }
    const businessDate = getCurrentParisCivilDate();
    toSave = {
      ...toSave,
      statut: getArreteLifecycleStatus(dateDebut, dateFin, businessDate),
    };
    let toReturn: ArreteRestriction;
    try {
      toReturn = await this.arreteRestrictionRepository.manager.transaction(
        'SERIALIZABLE',
        async (manager) => {
          const repository = manager.getRepository(ArreteRestriction);
          const initialPredecessorId = ar.arreteRestrictionAbroge?.id;
          await this.lockArreteCadresForMutation(
            manager,
            ar.arretesCadre.map(({ id: arreteCadreId }) => arreteCadreId),
          );
          const locked = await this.lockAndValidateArreteRestrictionChain(
            repository,
            id,
            initialPredecessorId,
            initialPredecessorId,
            ar.departement.id,
            dateDebut,
          );
          const current = locked.find((arrete) => arrete.id === id);
          if (
            !current ||
            current.arreteRestrictionAbroge?.id !== initialPredecessorId ||
            hasArreteComputationStateChanged(ar, current) ||
            hasArreteMutationVersionChanged(ar, current) ||
            !areCivilDatesEqual(ar.dateSignature, current.dateSignature)
          ) {
            throw new HttpException(
              `L'arrêté a été modifié pendant sa publication. Veuillez recommencer.`,
              HttpStatus.CONFLICT,
            );
          }
          const authorizationState = await this.findOneForMutationAuthorization(
            repository,
            id,
          );
          if (
            !(await this.canUpdateArreteRestriction(
              authorizationState,
              currentUser,
              !arreteRestrictionPdf,
            ))
          ) {
            throw new HttpException(
              `L'arrêté a été modifié pendant sa publication. Veuillez recommencer.`,
              HttpStatus.CONFLICT,
            );
          }
          const transactionCheck = await this.checkBeforePublish(
            {
              ...authorizationState,
              dateDebut,
              dateFin,
            } as ArreteRestriction,
            repository,
          );
          if (transactionCheck.errors.length > 0) {
            throw new HttpException(
              `L'arrêté a été modifié pendant sa publication. Veuillez recommencer.`,
              HttpStatus.CONFLICT,
            );
          }

          const saved = await repository.save({
            ...toSave,
            ...getPublicationEndDateProvenance(current, dateFin),
          });
          const synchronized = await this.synchronizeArreteRestrictionEndDate(
            repository,
            id,
            businessDate,
          );
          Object.assign(saved, synchronized);
          const dirtyDates: string[] = [];
          if (
            hasArreteComputationStateChanged(current, {
              dateDebut,
              dateFin: synchronized.dateFin,
              statut: synchronized.statut ?? toSave.statut,
            })
          ) {
            dirtyDates.push(
              ...[current.dateDebut, dateDebut]
                .filter((date): date is string => !!date)
                .map(normalizeCivilDate),
            );
          }
          if (
            newFile ||
            !areCivilDatesEqual(current.dateSignature, dateSignature)
          ) {
            dirtyDates.push(normalizeCivilDate(dateDebut));
          }
          if (initialPredecessorId) {
            const predecessor = await this.findOneForContinuity(
              repository,
              initialPredecessorId,
            );
            const synchronizedPredecessor =
              await this.synchronizeArreteRestrictionEndDate(
                repository,
                initialPredecessorId,
                businessDate,
              );
            if (
              hasArreteComputationStateChanged(predecessor, {
                dateDebut: predecessor.dateDebut,
                dateFin: synchronizedPredecessor.dateFin,
                statut: synchronizedPredecessor.statut ?? predecessor.statut,
              })
            ) {
              dirtyDates.push(normalizeCivilDate(predecessor.dateDebut));
            }
          }

          if (dirtyDates.length > 0) {
            await this.invalidateComputationsFromWithManager(
              manager,
              dirtyDates.sort()[0],
            );
          }
          await this.enqueueCurrentZoneRecomputeWithManager(manager, [
            ar.departement.id,
          ]);
          return saved;
        },
      );
    } catch (error) {
      if (newFile) {
        await this.fichierService
          .deleteById(newFile.id)
          .catch((cleanupError) =>
            this.logger.error(
              'ERREUR NETTOYAGE PDF APRES ECHEC PUBLICATION AR',
              cleanupError,
            ),
          );
      }
      if (error instanceof UnknownArreteEndDateProvenanceError) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      throw error;
    }
    if (!arreteRestrictionPdf) {
      toReturn.fichier = ar.fichier;
    }
    this.requestCurrentZoneRecompute([ar.departement], 'PUBLICATION AR');
    void this.checkModifications(ar, toReturn, currentUser, true).catch(
      (error) =>
        this.logger.error('ERREUR NOTIFICATION MODIFICATION AR', error),
    );
    delete toReturn.dateFinSaisie;
    delete toReturn.dateFinCalculee;
    delete toReturn.dateFinSaisieConnue;
    return toReturn;
  }

  private async lockArreteRestrictionGraph(
    repository: Repository<ArreteRestriction>,
    rootIds: Array<number | undefined>,
  ): Promise<void> {
    const definedRootIds = rootIds.filter(
      (arreteId): arreteId is number => arreteId !== undefined,
    );
    const related = await repository.find(<FindManyOptions>{
      select: { id: true },
      where: [
        { id: In(definedRootIds) },
        { arreteRestrictionAbroge: { id: In(definedRootIds) } },
      ],
    });
    const idsToLock = [
      ...new Set(related.map(({ id: arreteId }) => arreteId)),
    ].sort((left, right) => left - right);
    if (
      idsToLock.length === 0 ||
      !definedRootIds.every((arreteId) => idsToLock.includes(arreteId))
    ) {
      throw new HttpException(
        `Un arrêté lié a été modifié pendant la publication. Veuillez recommencer.`,
        HttpStatus.CONFLICT,
      );
    }
    const locked = await repository
      .createQueryBuilder('arreteRestriction')
      .select('arreteRestriction.id')
      .where('arreteRestriction.id IN (:...ids)', { ids: idsToLock })
      .orderBy('arreteRestriction.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    if (locked.length !== idsToLock.length) {
      throw new HttpException(
        `Un arrêté lié a été modifié pendant la publication. Veuillez recommencer.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async lockArreteCadresForMutation(
    manager: EntityManager,
    arreteCadreIds: number[],
  ): Promise<ArreteCadre[]> {
    const ids = [...new Set(arreteCadreIds)].sort(
      (left, right) => left - right,
    );
    if (ids.length === 0) {
      return [];
    }
    const repository = manager.getRepository(ArreteCadre);
    const existing = await repository.find(<FindManyOptions>{
      select: { id: true },
      where: { id: In(ids) },
    });
    if (existing.length !== ids.length) {
      throw new HttpException(
        `Un arrêté cadre lié a été modifié. Veuillez recommencer.`,
        HttpStatus.CONFLICT,
      );
    }
    const locked = await repository
      .createQueryBuilder('arreteCadre')
      .select('arreteCadre.id')
      .where('arreteCadre.id IN (:...ids)', { ids })
      .orderBy('arreteCadre.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    if (locked.length !== ids.length) {
      throw new HttpException(
        `Un arrêté cadre lié a été modifié. Veuillez recommencer.`,
        HttpStatus.CONFLICT,
      );
    }
    return repository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        dateDebut: true,
        dateFin: true,
        statut: true,
        zonesAlerte: { id: true, disabled: true },
      },
      relations: ['zonesAlerte'],
      where: { id: In(ids) },
    });
  }

  private async loadPredecessorChain(
    repository: Repository<ArreteRestriction>,
    currentId: number,
    predecessorId?: number,
  ): Promise<ArreteRestriction[]> {
    const chain: ArreteRestriction[] = [];
    const seen = new Set<number>([currentId]);
    let cursor = predecessorId;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        throw new HttpException(
          `La chaîne d'abrogation des arrêtés de restriction contient un cycle.`,
          HttpStatus.CONFLICT,
        );
      }
      seen.add(cursor);
      const arrete = await this.findOneForContinuity(repository, cursor);
      chain.push(arrete);
      cursor = arrete.arreteRestrictionAbroge?.id;
    }
    return chain;
  }

  private async lockAndValidateArreteRestrictionChain(
    repository: Repository<ArreteRestriction>,
    currentId: number,
    initialPredecessorId?: number,
    nextPredecessorId?: number,
    nextDepartementId?: number,
    nextDateDebut?: string,
  ): Promise<ArreteRestriction[]> {
    const preliminaryChain = await this.loadPredecessorChain(
      repository,
      currentId,
      nextPredecessorId,
    );
    const ids = [
      ...new Set(
        [
          currentId,
          initialPredecessorId,
          nextPredecessorId,
          ...preliminaryChain.map(({ id }) => id),
        ].filter((arreteId): arreteId is number => arreteId !== undefined),
      ),
    ].sort((left, right) => left - right);
    await this.lockArreteRestrictionGraph(repository, ids);
    const locked = await Promise.all(
      ids.map((arreteId) => this.findOneForContinuity(repository, arreteId)),
    );
    const byId = new Map(locked.map((arrete) => [arrete.id, arrete]));
    const current = byId.get(currentId);
    if (!current) {
      throw new HttpException(
        `Un arrêté lié a été modifié. Veuillez recommencer.`,
        HttpStatus.CONFLICT,
      );
    }

    const currentDateDebut = nextDateDebut ?? current.dateDebut;
    const currentDepartementId = nextDepartementId ?? current.departement?.id;
    const invalidDirectSuccessor = current.arretesRestriction.find(
      (successor) =>
        successor.statut !== 'a_valider' &&
        (successor.id === currentId ||
          !currentDateDebut ||
          !successor.dateDebut ||
          normalizeCivilDate(successor.dateDebut) <=
            normalizeCivilDate(currentDateDebut) ||
          successor.departement?.id !== currentDepartementId),
    );
    if (invalidDirectSuccessor) {
      throw new HttpException(
        `La chaîne d'abrogation des arrêtés de restriction est incohérente.`,
        HttpStatus.CONFLICT,
      );
    }

    const seen = new Set<number>([currentId]);
    let successor = current;
    let predecessorId = nextPredecessorId;
    while (predecessorId !== undefined) {
      if (seen.has(predecessorId)) {
        throw new HttpException(
          `La chaîne d'abrogation des arrêtés de restriction contient un cycle.`,
          HttpStatus.CONFLICT,
        );
      }
      seen.add(predecessorId);
      const predecessor = byId.get(predecessorId);
      const successorDateDebut =
        successor.id === currentId && nextDateDebut
          ? nextDateDebut
          : successor.dateDebut;
      if (
        !predecessor ||
        predecessor.statut === 'a_valider' ||
        !predecessor.dateDebut ||
        !successorDateDebut ||
        normalizeCivilDate(predecessor.dateDebut) >=
          normalizeCivilDate(successorDateDebut) ||
        predecessor.departement?.id !==
          (successor.id === currentId
            ? nextDepartementId
            : successor.departement?.id)
      ) {
        throw new HttpException(
          `La chaîne d'abrogation des arrêtés de restriction est incohérente.`,
          HttpStatus.CONFLICT,
        );
      }
      successor = predecessor;
      predecessorId = predecessor.arreteRestrictionAbroge?.id;
    }
    return locked;
  }

  private findOneForContinuity(
    repository: Repository<ArreteRestriction>,
    id: number,
  ): Promise<ArreteRestriction> {
    return repository.findOneOrFail(<FindOneOptions>{
      select: {
        id: true,
        numero: true,
        dateDebut: true,
        dateFin: true,
        dateSignature: true,
        dateFinSaisie: true,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
        statut: true,
        updated_at: true,
        departement: { id: true },
        arreteRestrictionAbroge: { id: true },
        arretesRestriction: {
          id: true,
          dateDebut: true,
          statut: true,
          departement: { id: true },
        },
        arretesCadre: {
          id: true,
          dateFin: true,
          statut: true,
        },
      },
      relations: [
        'arreteRestrictionAbroge',
        'arretesRestriction',
        'arretesRestriction.departement',
        'arretesCadre',
        'departement',
      ],
      where: { id },
    });
  }

  private findOneForMutationAuthorization(
    repository: Repository<ArreteRestriction>,
    id: number,
  ): Promise<ArreteRestriction> {
    return repository.findOneOrFail(<FindOneOptions>{
      select: {
        id: true,
        dateDebut: true,
        dateFin: true,
        statut: true,
        updated_at: true,
        fichier: { id: true },
        departement: { id: true, code: true },
        restrictions: {
          id: true,
          zoneAlerte: { id: true, disabled: true },
          communes: { id: true },
        },
        arretesCadre: {
          id: true,
          numero: true,
          dateDebut: true,
          dateFin: true,
          statut: true,
          zonesAlerte: { id: true, disabled: true },
        },
        arreteRestrictionAbroge: { id: true, dateDebut: true },
      },
      relations: [
        'fichier',
        'departement',
        'restrictions',
        'restrictions.zoneAlerte',
        'restrictions.communes',
        'arretesCadre',
        'arretesCadre.zonesAlerte',
        'arreteRestrictionAbroge',
      ],
      where: { id },
    });
  }

  private async synchronizeArreteRestrictionEndDate(
    repository: Repository<ArreteRestriction>,
    id: number,
    businessDate: string,
    rejectUnknownExtension = true,
    dirtyDates?: string[],
  ): Promise<Partial<ArreteRestriction>> {
    const arrete = await this.findOneForContinuity(repository, id);
    const validSuccessors = arrete.arretesRestriction.filter(
      (successor) =>
        successor.id !== arrete.id &&
        successor.statut !== 'a_valider' &&
        !!successor.dateDebut &&
        !!arrete.dateDebut &&
        normalizeCivilDate(successor.dateDebut) >
          normalizeCivilDate(arrete.dateDebut),
    );
    if (
      validSuccessors.length !==
      arrete.arretesRestriction.filter(
        (successor) => successor.statut !== 'a_valider',
      ).length
    ) {
      this.logger.error(
        `CHAINE ABROGATION AR INCOHERENTE IGNORÉE POUR ${arrete.id}`,
        '',
      );
    }
    const successorConstraint = getPredecessorEndDateConstraint(
      validSuccessors.map(({ dateDebut }) => dateDebut),
    );
    const invalidFrameworkEnds = arrete.arretesCadre.filter(
      (arreteCadre) =>
        arreteCadre.statut !== 'a_valider' &&
        !!arreteCadre.dateFin &&
        !!arrete.dateDebut &&
        normalizeCivilDate(arreteCadre.dateFin) <
          normalizeCivilDate(arrete.dateDebut),
    );
    if (invalidFrameworkEnds.length > 0) {
      this.logger.error(
        `BORNES AC ANTERIEURES AU DEBUT AR IGNOREES POUR ${arrete.id}`,
        '',
      );
    }
    const resolved = resolveArreteEndDate(
      arrete,
      [
        successorConstraint,
        ...arrete.arretesCadre
          .filter(
            (arreteCadre) =>
              arreteCadre.statut !== 'a_valider' &&
              !invalidFrameworkEnds.includes(arreteCadre),
          )
          .map((arreteCadre) => arreteCadre.dateFin),
      ],
      { rejectUnknownExtension },
    );
    let statut = arrete.statut;
    if (statut !== 'a_valider') {
      statut = getArreteLifecycleStatus(
        arrete.dateDebut,
        resolved.dateFin,
        businessDate,
      );
      if (arrete.arretesCadre.some((item) => item.statut === 'abroge')) {
        statut = 'abroge';
      } else if (
        statut === 'publie' &&
        !arrete.arretesCadre.some((item) => item.statut === 'publie')
      ) {
        statut = 'a_venir';
      }
    }
    const update = { ...resolved, statut };
    const effectiveEndChanged = !areCivilDatesEqual(
      arrete.dateFin,
      update.dateFin,
    );
    const missedStart =
      arrete.statut === 'a_venir' &&
      !!arrete.dateDebut &&
      normalizeCivilDate(arrete.dateDebut) < businessDate;
    const missedEnd =
      arrete.statut !== 'abroge' &&
      !!arrete.dateFin &&
      normalizeCivilDate(arrete.dateFin) < shiftCivilDate(businessDate, -1);
    const computationStateChanged = hasArreteComputationStateChanged(arrete, {
      dateDebut: arrete.dateDebut,
      dateFin: update.dateFin,
      statut: update.statut,
    });
    if (
      dirtyDates &&
      arrete.dateDebut &&
      (effectiveEndChanged ||
        (rejectUnknownExtension
          ? computationStateChanged
          : missedStart || missedEnd))
    ) {
      dirtyDates.push(normalizeCivilDate(arrete.dateDebut));
    }
    if (
      arrete.dateFin === update.dateFin &&
      arrete.dateFinSaisie === update.dateFinSaisie &&
      arrete.dateFinCalculee === update.dateFinCalculee &&
      arrete.dateFinSaisieConnue === update.dateFinSaisieConnue &&
      arrete.statut === update.statut
    ) {
      return update;
    }
    const result = await repository.update({ id }, update);
    if (result.affected !== 1) {
      throw new Error(`Unable to synchronize restriction order ${id}`);
    }
    return update;
  }

  async reconcileArreteRestrictionsForArreteCadres(
    manager: EntityManager,
    arreteCadreIds: number[],
    businessDate: string,
    rejectUnknownExtension = true,
  ): Promise<string[]> {
    if (arreteCadreIds.length === 0) {
      return [];
    }
    const ids = await this.lockArreteRestrictionsForArreteCadres(
      manager,
      arreteCadreIds,
    );
    if (ids.length === 0) {
      return [];
    }
    const repository = manager.getRepository(ArreteRestriction);
    const dirtyDates: string[] = [];
    for (const id of ids.sort((left, right) => left - right)) {
      await this.synchronizeArreteRestrictionEndDate(
        repository,
        id,
        businessDate,
        rejectUnknownExtension,
        dirtyDates,
      );
    }
    return [...new Set(dirtyDates)];
  }

  async lockArreteRestrictionsForArreteCadres(
    manager: EntityManager,
    arreteCadreIds: number[],
    includeDrafts = false,
  ): Promise<number[]> {
    if (arreteCadreIds.length === 0) {
      return [];
    }
    const repository = manager.getRepository(ArreteRestriction);
    const arretes = await repository.find(<FindManyOptions>{
      select: { id: true },
      where: {
        ...(includeDrafts ? {} : { statut: Not('a_valider') }),
        arretesCadre: { id: In(arreteCadreIds) },
      },
    });
    const ids = [...new Set(arretes.map(({ id }) => id))];
    if (ids.length === 0) {
      return [];
    }
    await this.lockArreteRestrictionGraph(repository, ids);
    return ids;
  }

  async invalidateComputationsFromWithManager(
    manager: EntityManager,
    date: string,
  ): Promise<void> {
    const [historicEpochColumn] = await manager.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'config' AND column_name = 'historicComputeEpoch'`,
    );
    const updated = await manager.query(
      `
        UPDATE config
        SET
          "computeMapDate" = LEAST(COALESCE("computeMapDate", $1::date), $1::date),
          "computeMapGeneration" = "computeMapGeneration" + 1,
          "computeStatsDate" = LEAST(COALESCE("computeStatsDate", $1::date), $1::date),
          "computeStatsGeneration" = "computeStatsGeneration" + 1
          ${historicEpochColumn ? ', "historicComputeEpoch" = "historicComputeEpoch" + 1' : ''}
        WHERE id = 1
        RETURNING id
      `,
      [date],
    );
    if (updated.length !== 1) {
      throw new Error('Unable to invalidate zone computations');
    }
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
    const dateFin = normalizeCivilDate(repealArreteRestrictionDto.dateFin);
    const businessDate = getCurrentParisCivilDate();
    const toReturn = await this.arreteRestrictionRepository.manager.transaction(
      'SERIALIZABLE',
      async (manager) => {
        const repository = manager.getRepository(ArreteRestriction);
        await this.lockArreteCadresForMutation(
          manager,
          ar.arretesCadre.map(({ id: arreteCadreId }) => arreteCadreId),
        );
        await this.lockArreteRestrictionGraph(repository, [id]);
        const current = await this.findOneForContinuity(repository, id);
        const authorizationState = await this.findOneForMutationAuthorization(
          repository,
          id,
        );
        if (
          !['a_venir', 'publie'].includes(current.statut) ||
          dateFin < current.dateDebut ||
          hasArreteMutationVersionChanged(ar, current) ||
          !(await this.canRepealArreteRestriction(
            authorizationState,
            repealArreteRestrictionDto,
            currentUser,
          ))
        ) {
          throw new HttpException(
            `L'arrêté a été modifié pendant son abrogation. Veuillez recommencer.`,
            HttpStatus.CONFLICT,
          );
        }
        const saved = await repository.save({
          id,
          ...repealArreteRestrictionDto,
          dateFin,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
          statut: getArreteLifecycleStatus(
            current.dateDebut,
            dateFin,
            businessDate,
          ),
        });
        Object.assign(
          saved,
          await this.synchronizeArreteRestrictionEndDate(
            repository,
            id,
            businessDate,
          ),
        );
        await this.invalidateComputationsFromWithManager(
          manager,
          normalizeCivilDate(current.dateDebut),
        );
        await this.enqueueCurrentZoneRecomputeWithManager(manager, [
          ar.departement.id,
        ]);
        return saved;
      },
    );
    this.requestCurrentZoneRecompute([ar.departement], 'ABROGATION AR');
    delete toReturn.dateFinSaisie;
    delete toReturn.dateFinCalculee;
    delete toReturn.dateFinSaisieConnue;
    return toReturn;
  }

  async checkBeforePublish(
    ar: ArreteRestriction,
    repository = this.arreteRestrictionRepository,
  ) {
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
    const arsWithSameZonesOrCommunes = await repository.find(<FindManyOptions>{
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

    const businessDate = getCurrentParisCivilDate();
    try {
      await this.arreteRestrictionRepository.manager.transaction(
        'SERIALIZABLE',
        async (manager) => {
          const repository = manager.getRepository(ArreteRestriction);
          const predecessorId = arrete.arreteRestrictionAbroge?.id;
          await this.lockArreteCadresForMutation(
            manager,
            arrete.arretesCadre.map(({ id: arreteCadreId }) => arreteCadreId),
          );
          await this.lockArreteRestrictionGraph(repository, [
            id,
            predecessorId,
          ]);
          const current = await this.findOneForContinuity(repository, id);
          const authorizationState = await this.findOneForMutationAuthorization(
            repository,
            id,
          );
          if (
            current.arreteRestrictionAbroge?.id !== predecessorId ||
            hasArreteComputationStateChanged(arrete, current) ||
            hasArreteMutationVersionChanged(arrete, current) ||
            !(await this.canRemoveArreteRestriction(
              authorizationState,
              curentUser,
            ))
          ) {
            throw new HttpException(
              `L'arrêté a été modifié pendant sa suppression. Veuillez recommencer.`,
              HttpStatus.CONFLICT,
            );
          }
          const dirtyFrom = current.dateDebut
            ? [normalizeCivilDate(current.dateDebut)]
            : [];
          if (predecessorId) {
            const predecessor = await this.findOneForContinuity(
              repository,
              predecessorId,
            );
            if (predecessor.dateDebut) {
              dirtyFrom.push(normalizeCivilDate(predecessor.dateDebut));
            }
          }
          await repository.update(
            { arreteRestrictionAbroge: { id } },
            { arreteRestrictionAbroge: null },
          );
          const deleted = await repository.delete(id);
          if (deleted.affected !== 1) {
            throw new Error(`Unable to delete restriction order ${id}`);
          }
          if (predecessorId) {
            await this.synchronizeArreteRestrictionEndDate(
              repository,
              predecessorId,
              businessDate,
            );
          }
          if (dirtyFrom.length > 0) {
            await this.invalidateComputationsFromWithManager(
              manager,
              dirtyFrom.sort()[0],
            );
          }
          if (current.statut !== 'a_valider') {
            await this.enqueueCurrentZoneRecomputeWithManager(manager, [
              arrete.departement.id,
            ]);
          }
        },
      );
    } catch (error) {
      if (error instanceof UnknownArreteEndDateProvenanceError) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      throw error;
    }
    if (arrete.statut !== 'a_valider') {
      this.requestCurrentZoneRecompute([arrete.departement], 'SUPPRESSION AR');
    }
    return;
  }

  async deleteByArreteCadreId(
    acId: number,
    manager: EntityManager,
    businessDate: string,
  ): Promise<string[]> {
    const repository = manager.getRepository(ArreteRestriction);
    const linked = await repository.find(<FindManyOptions>{
      select: {
        id: true,
        arreteRestrictionAbroge: { id: true },
      },
      relations: ['arreteRestrictionAbroge'],
      where: { arretesCadre: { id: acId } },
    });
    if (linked.length === 0) {
      return [];
    }
    const idsToDelete = linked.map(({ id }) => id);
    const predecessorIds = [
      ...new Set(
        linked
          .map((arrete) => arrete.arreteRestrictionAbroge?.id)
          .filter(
            (arreteId): arreteId is number =>
              arreteId !== undefined && !idsToDelete.includes(arreteId),
          ),
      ),
    ];
    await this.lockArreteRestrictionGraph(repository, [
      ...idsToDelete,
      ...predecessorIds,
    ]);
    const before = await Promise.all(
      [...idsToDelete, ...predecessorIds].map((arreteId) =>
        this.findOneForContinuity(repository, arreteId),
      ),
    );
    if (
      before
        .filter((arrete) => idsToDelete.includes(arrete.id))
        .some(
          (arrete) =>
            !arrete.arretesCadre.some((arreteCadre) => arreteCadre.id === acId),
        )
    ) {
      throw new HttpException(
        `Un arrêté lié a été modifié pendant la suppression. Veuillez recommencer.`,
        HttpStatus.CONFLICT,
      );
    }
    await repository.update(
      { arreteRestrictionAbroge: { id: In(idsToDelete) } },
      { arreteRestrictionAbroge: null },
    );
    const deleted = await repository.delete({ id: In(idsToDelete) });
    if (deleted.affected !== idsToDelete.length) {
      throw new Error(`Unable to delete restriction orders linked to ${acId}`);
    }
    for (const predecessorId of predecessorIds.sort(
      (left, right) => left - right,
    )) {
      await this.synchronizeArreteRestrictionEndDate(
        repository,
        predecessorId,
        businessDate,
      );
    }
    return before
      .map(({ dateDebut }) => dateDebut)
      .filter((date): date is string => !!date)
      .map(normalizeCivilDate);
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

  requestCurrentZoneRecompute(
    departements: Array<Pick<Departement, 'id'>>,
    reason: string,
  ): void {
    if (departements.length === 0) {
      return;
    }
    void this.processPendingCurrentZoneRecomputes().catch((error) =>
      this.logger.error(`ERREUR RECALCUL ZONES APRES ${reason}`, error),
    );
  }

  async enqueueCurrentZoneRecomputeWithManager(
    manager: EntityManager,
    departementIds: number[],
  ): Promise<void> {
    const ids = [...new Set(departementIds)].sort(
      (left, right) => left - right,
    );
    if (ids.length === 0) {
      return;
    }
    await manager.query(
      `
        INSERT INTO "current_zone_recompute_request" (
          "departementId", "generation", "requestedAt",
          "lastAttemptAt", "attemptCount", "lastError"
        )
        SELECT departement_id, 1, now(), NULL, 0, NULL
        FROM unnest($1::integer[]) AS departement_id
        ON CONFLICT ("departementId") DO UPDATE
        SET
          "generation" = "current_zone_recompute_request"."generation" + 1,
          "requestedAt" = now(),
          "lastError" = NULL
      `,
      [ids],
    );
  }

  @BusinessCron(CronExpression.EVERY_5_MINUTES)
  async processPendingCurrentZoneRecomputes(): Promise<void> {
    if (this.currentZoneRecomputeInFlight) {
      return this.currentZoneRecomputeInFlight;
    }
    const run = this.runPendingCurrentZoneRecomputes();
    this.currentZoneRecomputeInFlight = run;
    try {
      await run;
    } finally {
      if (this.currentZoneRecomputeInFlight === run) {
        this.currentZoneRecomputeInFlight = null;
      }
    }
  }

  private async runPendingCurrentZoneRecomputes(): Promise<void> {
    const queryRunner =
      this.arreteRestrictionRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    try {
      const [lockResult] = await queryRunner.query(
        `SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('current-zone-recompute')) AS locked`,
      );
      locked = lockResult?.locked === true;
      if (!locked) {
        return;
      }

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const requests = (await queryRunner.query(
          `
            SELECT "departementId", "generation"
            FROM "current_zone_recompute_request"
            ORDER BY "requestedAt", "departementId"
          `,
        )) as Array<{ departementId: number; generation: string }>;
        if (requests.length === 0) {
          return;
        }
        const departementIds = requests.map(({ departementId }) =>
          Number(departementId),
        );
        const generations = requests.map(({ generation }) => generation);
        try {
          const result = (await this.zoneAlerteComputedService.askCompute(
            isZonePublicationEnabled() ? [] : departementIds,
            false,
            false,
          )) as { skipped?: boolean } | undefined;
          if (result?.skipped) {
            throw new Error('Current zone recompute was skipped');
          }
          await this.statisticDepartementService.computeDepartementStatistics();
          await queryRunner.query(
            `
              DELETE FROM "current_zone_recompute_request" request
              USING unnest($1::integer[], $2::bigint[])
                AS completed("departementId", "generation")
              WHERE request."departementId" = completed."departementId"
                AND request."generation" = completed."generation"
            `,
            [departementIds, generations],
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await queryRunner.query(
            `
              UPDATE "current_zone_recompute_request" request
              SET
                "lastAttemptAt" = now(),
                "attemptCount" = "attemptCount" + 1,
                "lastError" = left($2, 4000)
              FROM unnest($1::integer[], $3::bigint[])
                AS attempted("departementId", "generation")
              WHERE request."departementId" = attempted."departementId"
                AND request."generation" = attempted."generation"
            `,
            [departementIds, message, generations],
          );
          throw error;
        }
      }
    } finally {
      try {
        if (locked) {
          const [unlockResult] = await queryRunner.query(
            `SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('current-zone-recompute'))`,
          );
          if (unlockResult?.pg_advisory_unlock !== true) {
            throw new Error(
              'Unable to release the current zone recompute lock',
            );
          }
        }
      } finally {
        await queryRunner.release();
      }
    }
  }

  /**
   * Mis à jour des statuts des AR en fonction de ceux des ACs
   * On reprend tout pour éviter que certains AR soient passés entre les mailles du filet (notamment l'historique ou autre)
   */
  async updateArreteRestrictionStatut(
    departements?: Departement[],
    computeHistoric?: boolean,
    dailyPublicationReuse?: DailyZonePublicationReuseContext,
  ) {
    const businessDate =
      dailyPublicationReuse?.scheduledFor ?? getCurrentParisCivilDate();
    const departementFilter = departements
      ? departements.map((departement) => departement.id)
      : null;
    const changedStatusCounts = { publie: 0, a_venir: 0, abroge: 0 };
    await this.arreteRestrictionRepository.manager.transaction(
      'SERIALIZABLE',
      async (manager) => {
        const repository = manager.getRepository(ArreteRestriction);
        const candidates = (await repository.query(
          `
            SELECT
              restriction_order.id,
              restriction_order."dateDebut"::text AS "dateDebut",
              restriction_order."dateFin"::text AS "dateFin",
              restriction_order.statut::text AS statut
            FROM arrete_restriction restriction_order
            LEFT JOIN LATERAL (
              SELECT MIN(bounds.end_date) AS resolved_end
              FROM (
                SELECT CASE
                  WHEN restriction_order."dateFinCalculee" = false
                    THEN restriction_order."dateFin"
                  WHEN restriction_order."dateFinSaisieConnue" = false
                    THEN restriction_order."dateFin"
                  ELSE restriction_order."dateFinSaisie"
                END AS end_date
                UNION ALL
                SELECT MIN(successor."dateDebut") - 1
                FROM arrete_restriction successor
                WHERE successor."arreteRestrictionAbrogeId" = restriction_order.id
                  AND successor.statut <> 'a_valider'
                  AND successor.id <> restriction_order.id
                  AND successor."dateDebut" IS NOT NULL
                  AND successor."dateDebut" > restriction_order."dateDebut"
                UNION ALL
                SELECT MIN(framework_order."dateFin")
                FROM arrete_cadre_arrete_restriction link
                JOIN arrete_cadre framework_order
                  ON framework_order.id = link."arreteCadreId"
                WHERE link."arreteRestrictionId" = restriction_order.id
                  AND framework_order.statut <> 'a_valider'
                  AND framework_order."dateFin" IS NOT NULL
                  AND framework_order."dateFin" >= restriction_order."dateDebut"
              ) bounds
            ) expected_end ON true
            WHERE restriction_order.statut <> 'a_valider'
              AND ($2::integer[] IS NULL OR restriction_order."departementId" = ANY($2::integer[]))
              AND (
                restriction_order.statut::text IS DISTINCT FROM (
                  CASE
                    WHEN EXISTS (
                      SELECT 1
                      FROM arrete_cadre_arrete_restriction link
                      JOIN arrete_cadre framework_order
                        ON framework_order.id = link."arreteCadreId"
                      WHERE link."arreteRestrictionId" = restriction_order.id
                        AND framework_order.statut = 'abroge'
                    ) THEN 'abroge'
                    WHEN restriction_order."dateDebut" > $1::date THEN 'a_venir'
                    WHEN restriction_order."dateFin" IS NOT NULL
                      AND restriction_order."dateFin" < $1::date THEN 'abroge'
                    WHEN EXISTS (
                      SELECT 1
                      FROM arrete_cadre_arrete_restriction link
                      JOIN arrete_cadre framework_order
                        ON framework_order.id = link."arreteCadreId"
                      WHERE link."arreteRestrictionId" = restriction_order.id
                        AND framework_order.statut = 'publie'
                    ) THEN 'publie'
                    ELSE 'a_venir'
                  END
                )
                OR (
                  restriction_order."dateFinCalculee" = true
                  AND restriction_order."dateFinSaisieConnue" = true
                  AND restriction_order."dateFin" IS DISTINCT FROM expected_end.resolved_end
                )
              )
            ORDER BY restriction_order.id
          `,
          [businessDate, departementFilter],
        )) as Array<
          Pick<ArreteRestriction, 'id' | 'dateDebut' | 'dateFin' | 'statut'>
        >;
        if (candidates.length > 0) {
          const ids = candidates.map(({ id }) => id);
          await this.lockArreteRestrictionGraph(repository, ids);
          const dirtyFrom: string[] = [];
          for (const previous of candidates) {
            const synchronized = await this.synchronizeArreteRestrictionEndDate(
              repository,
              previous.id,
              businessDate,
              false,
            );
            const missedStart =
              previous.statut === 'a_venir' &&
              normalizeCivilDate(previous.dateDebut) < businessDate;
            const missedEnd =
              previous.statut !== 'abroge' &&
              !!previous.dateFin &&
              normalizeCivilDate(previous.dateFin) <
                shiftCivilDate(businessDate, -1);
            if (
              !areCivilDatesEqual(previous.dateFin, synchronized.dateFin) ||
              missedStart ||
              missedEnd
            ) {
              dirtyFrom.push(normalizeCivilDate(previous.dateDebut));
            }
            if (synchronized.statut !== previous.statut) {
              changedStatusCounts[synchronized.statut] += 1;
            }
          }
          if (dirtyFrom.length > 0) {
            await this.invalidateComputationsFromWithManager(
              manager,
              dirtyFrom.sort()[0],
            );
          }
        }
        if (!dailyPublicationReuse) {
          const requestedDepartementIds = departementFilter?.length
            ? departementFilter
            : (
                (await manager.query(
                  `SELECT id FROM departement ORDER BY id`,
                )) as Array<{ id: number }>
              ).map(({ id }) => Number(id));
          await this.enqueueCurrentZoneRecomputeWithManager(
            manager,
            requestedDepartementIds,
          );
        }
      },
    );
    this.logger.log(
      `${changedStatusCounts.publie} Arrêtés Restriction publiés, ${changedStatusCounts.a_venir} à venir, ${changedStatusCounts.abroge} abrogés`,
    );

    if (!dailyPublicationReuse) {
      await this.processPendingCurrentZoneRecomputes();
      return;
    }
    try {
      await this.statisticDepartementService.computeDepartementStatistics();
    } catch (e) {
      this.logger.error('ERREUR COMPUTE DEPARTEMENTS STATISTICS', e);
    }
    const departementIds = departementFilter ?? [];
    return this.zoneAlerteComputedService.askCompute(
      departementIds,
      false,
      computeHistoric,
      false,
      dailyPublicationReuse,
    );
  }

  async catchUpHistoricComputations(
    requiredThrough: string,
    expectedSourceRevision?: string,
  ) {
    return this.zoneAlerteComputedService.computeHistoricPersistently(
      requiredThrough,
      expectedSourceRevision,
    );
  }

  async invalidateComputationsFrom(date: string): Promise<void> {
    await this.configService.setConfig(date, date);
  }

  /**
   * Vérification s'il faut envoyer des mails de relance tous les jours à 8h du matin
   */
  @BusinessCron(CronExpression.EVERY_DAY_AT_8AM)
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
    for (const [k, v] of Object.entries(original)) {
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
          object.splice(Number(k), 1);
          this.removeEmpty(object);
        } else {
          delete object[k];
        }
      }
    });
    return object;
  }
}
