import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { BusinessCron } from '../core/scheduling/business-cron';
import { shiftCivilDate } from '../core/scheduling/daily-job-schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { User } from '@shared/entities/user.entity';
import moment from 'moment/moment';
import { paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import {
  DeleteResult,
  EntityManager,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  In,
  Like,
  Repository,
} from 'typeorm';
import { ArreteCadreZoneAlerteCommunesService } from '../arrete_cadre_zone_alerte_communes/arrete_cadre_zone_alerte_communes.service';
import { ArreteRestrictionService } from '../arrete_restriction/arrete_restriction.service';
import { testArretesCadre } from '../core/test/data';
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
import { UsageService } from '../usage/usage.service';
import { UserService } from '../user/user.service';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';
import type { DailyZonePublicationReuseContext } from '../zone_publication/zone_publication.service';
import { arreteCadrePaginateConfig } from './dto/arrete_cadre.dto';
import { CreateUpdateArreteCadreDto } from './dto/create_update_arrete_cadre.dto';
import { PublishArreteCadreDto } from './dto/publish_arrete_cadre.dto';
import { RepealArreteCadreDto } from './dto/repeal_arrete_cadre.dto';

@Injectable()
export class ArreteCadreService {
  private readonly logger = new RegleauLogger('ArreteCadreService');

  constructor(
    @InjectRepository(ArreteCadre)
    private readonly arreteCadreRepository: Repository<ArreteCadre>,
    @Inject(forwardRef(() => ArreteRestrictionService))
    private readonly arreteRestrictionService: ArreteRestrictionService,
    private readonly departementService: DepartementService,
    private readonly zoneAlerteService: ZoneAlerteService,
    private readonly mailService: MailService,
    private readonly userService: UserService,
    private readonly fichierService: FichierService,
    private readonly restrictionService: RestrictionService,
    private readonly usageService: UsageService,
    private readonly arreteCadreZoneAlerteCommunesService: ArreteCadreZoneAlerteCommunesService,
    private readonly configService: ConfigService,
  ) {}

  async findAll(query: PaginateQuery): Promise<Paginated<ArreteCadre>> {
    const paginateConfig = arreteCadrePaginateConfig;
    const paginateToReturn = await paginate(
      query,
      this.arreteCadreRepository,
      paginateConfig,
    );

    // Récupérer tous les départements, car on filtre sur les départements
    const departements = await Promise.all(
      paginateToReturn.data.map((ac) => {
        return this.departementService.findByArreteCadreId(ac.id);
      }),
    );
    paginateToReturn.data.forEach((ac, index) => {
      ac.departements = departements[index];
    });

    return paginateToReturn;
  }

  async find(currentUser?: User, depCode?: string): Promise<ArreteCadre[]> {
    const whereClause: FindOptionsWhere<ArreteCadre> | null = {
      statut: In(['a_venir', 'publie']),
      departements: {
        code:
          !currentUser || currentUser.role === 'mte' || depCode
            ? depCode
            : In(currentUser.role_departements),
      },
    };
    const acToReturn = await this.arreteCadreRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        dateDebut: true,
        dateFin: true,
        statut: true,
        zonesAlerte: {
          id: true,
          code: true,
          nom: true,
          type: true,
          disabled: true,
          ressourceInfluencee: true,
          departement: {
            id: true,
            code: true,
          },
        },
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
      relations: [
        'zonesAlerte',
        'zonesAlerte.departement',
        'usages',
        'usages.thematique',
      ],
      where: whereClause,
      order: {
        zonesAlerte: {
          code: 'ASC',
        },
        usages: {
          nom: 'ASC',
        },
      },
    });
    await Promise.all(
      acToReturn.map(async (ac) => {
        ac.arretesRestriction =
          await this.arreteRestrictionService.findByArreteCadreAndDepartement(
            ac.id,
            depCode,
          );
        return ac;
      }),
    );
    return acToReturn.filter((ac) => !ac.zonesAlerte.some((za) => za.disabled));
  }

  async findOne(id: number, currentUser?: User) {
    const qb = this.arreteCadreRepository
      .createQueryBuilder('arreteCadre')
      .select([
        'arreteCadre.id',
        'arreteCadre.numero',
        'arreteCadre.dateDebut',
        'arreteCadre.dateFin',
        'arreteCadre.statut',
        'arreteCadre.updated_at',
        'fichier.id',
        'fichier.nom',
        'fichier.url',
        'fichier.size',
        'departementPilote.id',
        'departementPilote.code',
        'departementPilote.nom',
        'zonesAlerte.id',
        'zonesAlerte.code',
        'zonesAlerte.nom',
        'zonesAlerte.type',
        'zonesAlerte.disabled',
        'zonesAlerte.ressourceInfluencee',
        'departement.id',
        'departement.code',
        'arretesRestriction.id',
        'arretesRestriction.numero',
        'arretesRestriction.statut',
        'arreteCadreAbroge.id',
        'arreteCadreAbroge.numero',
        'arreteCadreAbroge.dateDebut',
        'arreteCadreAbroge.dateFin',
        'aczac.id',
        'communes.id',
        'communes.code',
        'communes.nom',
      ])
      .leftJoin('arreteCadre.departementPilote', 'departementPilote')
      .leftJoin('arreteCadre.zonesAlerte', 'zonesAlerte')
      .leftJoin('zonesAlerte.departement', 'departement')
      .leftJoin('arreteCadre.arretesRestriction', 'arretesRestriction')
      .leftJoin('arreteCadre.fichier', 'fichier')
      .leftJoin('arreteCadre.arreteCadreAbroge', 'arreteCadreAbroge')
      .leftJoin(
        'zonesAlerte.arreteCadreZoneAlerteCommunes',
        'aczac',
        'aczac.arreteCadreId = arreteCadre.id',
      )
      .leftJoin('aczac.communes', 'communes')
      .where({ id })
      .orderBy('zonesAlerte.code', 'ASC');
    const [arreteCadre, usagesArreteCadre, departements]: any =
      await Promise.all(<any>[
        qb.getOne(),
        this.usageService.findByArreteCadre(id),
        this.departementService.findByArreteCadreId(id),
      ]);
    if (
      !arreteCadre ||
      (currentUser &&
        currentUser.role !== 'mte' &&
        !departements.some((d) =>
          currentUser.role_departements.includes(d.code),
        ))
    ) {
      throw new HttpException(
        `L'arrêté cadre n'existe pas ou vous n'avez pas les droits pour le consulter.`,
        HttpStatus.NOT_FOUND,
      );
    }
    arreteCadre.usages = usagesArreteCadre;
    arreteCadre.zonesAlerte.map((za) => {
      if (
        za.arreteCadreZoneAlerteCommunes[0] &&
        za.arreteCadreZoneAlerteCommunes[0].communes?.length > 0
      ) {
        za.communes = structuredClone(
          za.arreteCadreZoneAlerteCommunes[0].communes,
        );
      }
      delete za.arreteCadreZoneAlerteCommunes;
      return za;
    });
    if (departements) {
      arreteCadre.departements = departements;
    }
    return arreteCadre;
  }

  async findDatagouv(): Promise<ArreteCadre[]> {
    return this.arreteCadreRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        dateDebut: true,
        dateFin: true,
        statut: true,
        fichier: {
          url: true,
        },
        departementPilote: {
          code: true,
        },
        departements: {
          code: true,
        },
        zonesAlerte: {
          id: true,
          idSandre: true,
          nom: true,
          code: true,
          type: true,
        },
      },
      relations: [
        'fichier',
        'departementPilote',
        'departements',
        'zonesAlerte',
      ],
      where: {
        statut: In(['a_venir', 'publie', 'abroge']),
      },
      order: {
        dateDebut: 'ASC',
      },
    });
  }

  findByArreteRestrictionId(id: number): Promise<ArreteCadre[]> {
    return this.arreteCadreRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
        statut: true,
        dateDebut: true,
        dateFin: true,
        zonesAlerte: {
          id: true,
          code: true,
          nom: true,
          type: true,
          ressourceInfluencee: true,
          disabled: true,
          departement: {
            id: true,
            code: true,
            nom: true,
          },
        },
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
      relations: [
        'zonesAlerte',
        'zonesAlerte.departement',
        'arretesRestriction',
        'usages',
        'usages.thematique',
      ],
      where: {
        arretesRestriction: {
          id: id,
        },
      },
    });
  }

  findByDepartement(depCode: string): Promise<ArreteCadre[]> {
    return this.arreteCadreRepository.find(<FindManyOptions>{
      select: {
        id: true,
        numero: true,
      },
      relations: ['departements', 'zonesAlerte'],
      where: {
        departements: {
          code: depCode,
        },
        zonesAlerte: {
          disabled: true,
        },
        statut: In(['a_venir', 'publie']),
      },
    });
  }

  async create(
    createArreteCadreDto: CreateUpdateArreteCadreDto,
    currentUser?: User,
  ): Promise<ArreteCadre> {
    // Check ACI
    await this.checkAci(createArreteCadreDto, false, currentUser);
    const arreteCadre = await this.arreteCadreRepository.manager.transaction(
      'SERIALIZABLE',
      async (manager) => {
        const repository = manager.getRepository(ArreteCadre);
        const saved = await repository.save(createArreteCadreDto);
        saved.usages = await this.usageService.updateAllByArreteCadre(
          saved,
          manager,
        );
        await this.arreteCadreZoneAlerteCommunesService.updateAllByArreteCadre(
          saved.id,
          createArreteCadreDto,
          manager,
        );
        return saved;
      },
    );

    this.sendAciMails(null, arreteCadre, currentUser);
    return arreteCadre;
  }

  async update(
    id: number,
    updateArreteCadreDto: CreateUpdateArreteCadreDto,
    currentUser: User,
  ): Promise<ArreteCadre> {
    const oldAc = await this.findOne(id, currentUser);
    if (!(await this.canUpdateArreteCadre(oldAc, currentUser))) {
      throw new HttpException(
        `Vous ne pouvez éditer un arrêté cadre que si il est sur votre département et n'est pas abrogé.`,
        HttpStatus.FORBIDDEN,
      );
    }
    await this.checkAci(updateArreteCadreDto, true, currentUser);
    let arreteCadre: ArreteCadre;
    if (oldAc.statut === 'a_valider') {
      arreteCadre = await this.arreteCadreRepository.manager.transaction(
        'SERIALIZABLE',
        async (manager) => {
          const repository = manager.getRepository(ArreteCadre);
          await this.lockArreteCadreGraph(repository, [id]);
          const current = await this.findOneForContinuity(repository, id);
          const authorizationState = await this.findOneForMutationAuthorization(
            repository,
            id,
          );
          if (
            current.statut !== 'a_valider' ||
            hasArreteMutationVersionChanged(oldAc, current) ||
            !(await this.canUpdateArreteCadre(authorizationState, currentUser))
          ) {
            throw new HttpException(
              `L'arrêté a été modifié pendant son enregistrement. Veuillez recommencer.`,
              HttpStatus.CONFLICT,
            );
          }
          await this.arreteRestrictionService.lockArreteRestrictionsForArreteCadres(
            manager,
            [id],
            true,
          );
          const beforeMutation = {
            ...authorizationState,
            usages: await this.usageService.findByArreteCadre(id, manager),
          } as ArreteCadre;
          const saved = await repository.save({
            id,
            ...updateArreteCadreDto,
          });
          saved.usages = await this.usageService.updateAllByArreteCadre(
            saved,
            manager,
          );
          await this.arreteCadreZoneAlerteCommunesService.updateAllByArreteCadre(
            saved.id,
            updateArreteCadreDto,
            manager,
          );
          await this.repercussionOnAr(beforeMutation, saved, manager);
          return saved;
        },
      );
    } else {
      const initialPredecessorId = oldAc.arreteCadreAbroge?.id;
      const hasPredecessorUpdate = Object.prototype.hasOwnProperty.call(
        updateArreteCadreDto,
        'arreteCadreAbroge',
      );
      const nextPredecessorId = hasPredecessorUpdate
        ? updateArreteCadreDto.arreteCadreAbroge?.id
        : initialPredecessorId;
      const nextDepartementIds = (
        updateArreteCadreDto.departements ?? oldAc.departements
      ).map(({ id: departementId }) => departementId);
      if (nextPredecessorId === id) {
        throw new HttpException(
          `Un arrêté ne peut pas s'abroger lui-même.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      const businessDate = getCurrentParisCivilDate();
      try {
        arreteCadre = await this.arreteCadreRepository.manager.transaction(
          'SERIALIZABLE',
          async (manager) => {
            const repository = manager.getRepository(ArreteCadre);
            const affectedIds = [
              ...new Set(
                [id, initialPredecessorId, nextPredecessorId].filter(
                  (arreteId): arreteId is number => arreteId !== undefined,
                ),
              ),
            ].sort((left, right) => left - right);
            const before = await this.lockAndValidateArreteCadreChain(
              repository,
              id,
              initialPredecessorId,
              nextPredecessorId,
              nextDepartementIds,
            );
            const current = before.find((arrete) => arrete.id === id);
            if (
              !current ||
              current.arreteCadreAbroge?.id !== initialPredecessorId ||
              hasArreteComputationStateChanged(oldAc, current) ||
              hasArreteMutationVersionChanged(oldAc, current)
            ) {
              throw new HttpException(
                `L'arrêté a été modifié pendant son enregistrement. Veuillez recommencer.`,
                HttpStatus.CONFLICT,
              );
            }
            const authorizationState =
              await this.findOneForMutationAuthorization(repository, id);
            if (
              !(await this.canUpdateArreteCadre(
                authorizationState,
                currentUser,
              ))
            ) {
              throw new HttpException(
                `L'arrêté a été modifié pendant son enregistrement. Veuillez recommencer.`,
                HttpStatus.CONFLICT,
              );
            }
            await this.arreteRestrictionService.lockArreteRestrictionsForArreteCadres(
              manager,
              affectedIds,
              true,
            );
            const beforeMutation = {
              ...authorizationState,
              usages: await this.usageService.findByArreteCadre(id, manager),
            } as ArreteCadre;
            const saved = await repository.save({
              id,
              ...updateArreteCadreDto,
            });
            const savedCurrent = await this.findOneForContinuity(
              repository,
              id,
            );
            if (
              savedCurrent.arreteCadreAbroge?.id !== nextPredecessorId ||
              savedCurrent.departements.length !== nextDepartementIds.length ||
              savedCurrent.departements.some(
                ({ id: departementId }) =>
                  !nextDepartementIds.includes(departementId),
              )
            ) {
              throw new HttpException(
                `Le lien entre les arrêtés n'a pas pu être enregistré. Veuillez recommencer.`,
                HttpStatus.CONFLICT,
              );
            }
            for (const affectedId of affectedIds) {
              const synchronized = await this.synchronizeArreteCadreEndDate(
                repository,
                affectedId,
                businessDate,
              );
              if (affectedId === id) {
                Object.assign(saved, synchronized);
              }
            }
            saved.usages = await this.usageService.updateAllByArreteCadre(
              saved,
              manager,
            );
            await this.arreteCadreZoneAlerteCommunesService.updateAllByArreteCadre(
              saved.id,
              updateArreteCadreDto,
              manager,
            );
            await this.repercussionOnAr(beforeMutation, saved, manager);
            const dirtyDates = [
              ...before
                .filter(({ id: arreteId }) => affectedIds.includes(arreteId))
                .map(({ dateDebut }) => dateDebut)
                .filter((date): date is string => !!date)
                .map(normalizeCivilDate),
              ...(await this.arreteRestrictionService.reconcileArreteRestrictionsForArreteCadres(
                manager,
                affectedIds,
                businessDate,
              )),
            ];
            if (dirtyDates.length > 0) {
              await this.arreteRestrictionService.invalidateComputationsFromWithManager(
                manager,
                dirtyDates.sort()[0],
              );
            }
            await this.arreteRestrictionService.enqueueCurrentZoneRecomputeWithManager(
              manager,
              [
                ...oldAc.departements.map(
                  ({ id: departementId }) => departementId,
                ),
                ...nextDepartementIds,
              ],
            );
            return saved;
          },
        );
      } catch (error) {
        if (error instanceof UnknownArreteEndDateProvenanceError) {
          throw new HttpException(error.message, HttpStatus.CONFLICT);
        }
        throw error;
      }
    }
    if (oldAc.statut !== 'a_valider') {
      this.arreteRestrictionService.requestCurrentZoneRecompute(
        [...oldAc.departements, ...(updateArreteCadreDto.departements ?? [])],
        'MODIFICATION AC',
      );
    }
    this.sendAciMails(oldAc, arreteCadre, currentUser);
    delete arreteCadre.dateFinSaisie;
    delete arreteCadre.dateFinCalculee;
    delete arreteCadre.dateFinSaisieConnue;
    return arreteCadre;
  }

  async publish(
    id: number,
    arreteCadrePdf: Express.Multer.File,
    publishArreteCadreDto: PublishArreteCadreDto,
    currentUser: User,
  ): Promise<ArreteCadre> {
    let dateDebut: string;
    let dateFin: string | null;
    try {
      dateDebut = normalizeCivilDate(publishArreteCadreDto.dateDebut);
      dateFin = publishArreteCadreDto.dateFin
        ? normalizeCivilDate(publishArreteCadreDto.dateFin)
        : null;
    } catch {
      throw new HttpException(
        `Les dates de l'arrêté cadre sont invalides.`,
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
    const ac = await this.findOne(id, currentUser);
    if (!(await this.canUpdateArreteCadre(ac, currentUser))) {
      throw new HttpException(
        `Vous ne pouvez publier un arrêté cadre que si il est sur votre département et n'est pas abrogé.`,
        HttpStatus.FORBIDDEN,
      );
    }
    if (!arreteCadrePdf && !ac.fichier) {
      throw new HttpException(
        `Le PDF de l'arrêté cadre est obligatoire.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (ac.arreteCadreAbroge) {
      if (dateDebut <= ac.arreteCadreAbroge.dateDebut) {
        throw new HttpException(
          `La date de début de l'arrêté cadre doit être supérieur à celle de l'arrêté cadre abrogé.`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    let toSave: any = {
      id,
      ...publishArreteCadreDto,
      dateDebut,
      dateFin,
    };
    let newFile: { id: number } | null = null;
    if (arreteCadrePdf) {
      newFile = await this.fichierService.createImmutable(
        arreteCadrePdf,
        `arrete-cadre/${ac.id}/`,
      );
      toSave.fichier = { id: newFile.id };
    }
    const businessDate = getCurrentParisCivilDate();
    toSave = {
      ...toSave,
      statut: getArreteLifecycleStatus(dateDebut, dateFin, businessDate),
    };
    let toReturn: ArreteCadre;
    try {
      toReturn = await this.arreteCadreRepository.manager.transaction(
        'SERIALIZABLE',
        async (manager) => {
          const repository = manager.getRepository(ArreteCadre);
          const initialPredecessorId = ac.arreteCadreAbroge?.id;
          const locked = await this.lockAndValidateArreteCadreChain(
            repository,
            id,
            initialPredecessorId,
            initialPredecessorId,
            ac.departements.map(({ id: departementId }) => departementId),
            dateDebut,
          );
          const current = locked.find((arrete) => arrete.id === id);
          if (
            !current ||
            current.arreteCadreAbroge?.id !== initialPredecessorId ||
            hasArreteComputationStateChanged(ac, current) ||
            hasArreteMutationVersionChanged(ac, current)
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
            !(await this.canUpdateArreteCadre(authorizationState, currentUser))
          ) {
            throw new HttpException(
              `L'arrêté a été modifié pendant sa publication. Veuillez recommencer.`,
              HttpStatus.CONFLICT,
            );
          }
          if (
            authorizationState.arreteCadreAbroge &&
            dateDebut <= authorizationState.arreteCadreAbroge.dateDebut
          ) {
            throw new HttpException(
              `L'arrêté a été modifié pendant sa publication. Veuillez recommencer.`,
              HttpStatus.CONFLICT,
            );
          }
          await this.arreteRestrictionService.lockArreteRestrictionsForArreteCadres(
            manager,
            [id, initialPredecessorId].filter(
              (arreteId): arreteId is number => arreteId !== undefined,
            ),
          );

          const saved = await repository.save({
            ...toSave,
            ...getPublicationEndDateProvenance(current, dateFin),
          });
          const synchronized = await this.synchronizeArreteCadreEndDate(
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
          if (initialPredecessorId) {
            const predecessor = await this.findOneForContinuity(
              repository,
              initialPredecessorId,
            );
            const synchronizedPredecessor =
              await this.synchronizeArreteCadreEndDate(
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
          dirtyDates.push(
            ...(await this.arreteRestrictionService.reconcileArreteRestrictionsForArreteCadres(
              manager,
              [id, initialPredecessorId].filter(
                (arreteId): arreteId is number => arreteId !== undefined,
              ),
              businessDate,
            )),
          );
          if (newFile) {
            dirtyDates.push(normalizeCivilDate(dateDebut));
          }
          if (dirtyDates.length > 0) {
            await this.arreteRestrictionService.invalidateComputationsFromWithManager(
              manager,
              dirtyDates.sort()[0],
            );
          }
          await this.arreteRestrictionService.enqueueCurrentZoneRecomputeWithManager(
            manager,
            ac.departements.map(({ id: departementId }) => departementId),
          );
          return saved;
        },
      );
    } catch (error) {
      if (newFile) {
        await this.fichierService
          .deleteById(newFile.id)
          .catch((cleanupError) =>
            this.logger.error(
              'ERREUR NETTOYAGE PDF APRES ECHEC PUBLICATION AC',
              cleanupError,
            ),
          );
      }
      if (error instanceof UnknownArreteEndDateProvenanceError) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      throw error;
    }
    if (!arreteCadrePdf) {
      toReturn.fichier = ac.fichier;
    }
    this.arreteRestrictionService.requestCurrentZoneRecompute(
      ac.departements,
      'PUBLICATION AC',
    );
    delete toReturn.dateFinSaisie;
    delete toReturn.dateFinCalculee;
    delete toReturn.dateFinSaisieConnue;
    return toReturn;
  }

  private async lockArreteCadreGraph(
    repository: Repository<ArreteCadre>,
    rootIds: Array<number | undefined>,
  ): Promise<void> {
    const definedRootIds = rootIds.filter(
      (arreteId): arreteId is number => arreteId !== undefined,
    );
    const related = await repository.find(<FindManyOptions>{
      select: { id: true },
      where: [
        { id: In(definedRootIds) },
        { arreteCadreAbroge: { id: In(definedRootIds) } },
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
      .createQueryBuilder('arreteCadre')
      .select('arreteCadre.id')
      .where('arreteCadre.id IN (:...ids)', { ids: idsToLock })
      .orderBy('arreteCadre.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    if (locked.length !== idsToLock.length) {
      throw new HttpException(
        `Un arrêté lié a été modifié pendant la publication. Veuillez recommencer.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async loadPredecessorChain(
    repository: Repository<ArreteCadre>,
    currentId: number,
    predecessorId?: number,
  ): Promise<ArreteCadre[]> {
    const chain: ArreteCadre[] = [];
    const seen = new Set<number>([currentId]);
    let cursor = predecessorId;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        throw new HttpException(
          `La chaîne d'abrogation des arrêtés cadre contient un cycle.`,
          HttpStatus.CONFLICT,
        );
      }
      seen.add(cursor);
      const arrete = await this.findOneForContinuity(repository, cursor);
      chain.push(arrete);
      cursor = arrete.arreteCadreAbroge?.id;
    }
    return chain;
  }

  private async lockAndValidateArreteCadreChain(
    repository: Repository<ArreteCadre>,
    currentId: number,
    initialPredecessorId?: number,
    nextPredecessorId?: number,
    nextDepartementIds?: number[],
    nextDateDebut?: string,
  ): Promise<ArreteCadre[]> {
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
    await this.lockArreteCadreGraph(repository, ids);
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
    const currentDepartementIds =
      nextDepartementIds ?? current.departements.map(({ id }) => id);
    const invalidDirectSuccessor = current.arretesCadre.find(
      (successor) =>
        successor.statut !== 'a_valider' &&
        (successor.id === currentId ||
          !currentDateDebut ||
          !successor.dateDebut ||
          normalizeCivilDate(successor.dateDebut) <=
            normalizeCivilDate(currentDateDebut) ||
          !successor.departements.some(({ id: departementId }) =>
            currentDepartementIds.includes(departementId),
          )),
    );
    if (invalidDirectSuccessor) {
      throw new HttpException(
        `La chaîne d'abrogation des arrêtés cadre est incohérente.`,
        HttpStatus.CONFLICT,
      );
    }

    const seen = new Set<number>([currentId]);
    let successor = current;
    let predecessorId = nextPredecessorId;
    while (predecessorId !== undefined) {
      if (seen.has(predecessorId)) {
        throw new HttpException(
          `La chaîne d'abrogation des arrêtés cadre contient un cycle.`,
          HttpStatus.CONFLICT,
        );
      }
      seen.add(predecessorId);
      const predecessor = byId.get(predecessorId);
      const successorDateDebut =
        successor.id === currentId && nextDateDebut
          ? nextDateDebut
          : successor.dateDebut;
      const successorDepartementIds =
        successor.id === currentId && nextDepartementIds
          ? nextDepartementIds
          : successor.departements.map(({ id }) => id);
      if (
        !predecessor ||
        predecessor.statut === 'a_valider' ||
        !predecessor.dateDebut ||
        !successorDateDebut ||
        normalizeCivilDate(predecessor.dateDebut) >=
          normalizeCivilDate(successorDateDebut) ||
        !predecessor.departements.some(({ id: departementId }) =>
          successorDepartementIds.includes(departementId),
        )
      ) {
        throw new HttpException(
          `La chaîne d'abrogation des arrêtés cadre est incohérente.`,
          HttpStatus.CONFLICT,
        );
      }
      successor = predecessor;
      predecessorId = predecessor.arreteCadreAbroge?.id;
    }
    return locked;
  }

  private findOneForContinuity(
    repository: Repository<ArreteCadre>,
    id: number,
  ): Promise<ArreteCadre> {
    return repository.findOneOrFail(<FindOneOptions>{
      select: {
        id: true,
        dateDebut: true,
        dateFin: true,
        dateFinSaisie: true,
        dateFinCalculee: true,
        dateFinSaisieConnue: true,
        statut: true,
        updated_at: true,
        departements: { id: true },
        arreteCadreAbroge: { id: true },
        arretesCadre: {
          id: true,
          dateDebut: true,
          statut: true,
          departements: { id: true },
        },
      },
      relations: [
        'arreteCadreAbroge',
        'arretesCadre',
        'arretesCadre.departements',
        'departements',
      ],
      where: { id },
    });
  }

  private findOneForMutationAuthorization(
    repository: Repository<ArreteCadre>,
    id: number,
  ): Promise<ArreteCadre> {
    return repository.findOneOrFail(<FindOneOptions>{
      select: {
        id: true,
        dateDebut: true,
        dateFin: true,
        statut: true,
        updated_at: true,
        fichier: { id: true },
        departements: { id: true, code: true },
        zonesAlerte: { id: true, disabled: true },
        arretesRestriction: { id: true, statut: true },
        arreteCadreAbroge: { id: true, dateDebut: true },
      },
      relations: [
        'fichier',
        'departements',
        'zonesAlerte',
        'arretesRestriction',
        'arreteCadreAbroge',
      ],
      where: { id },
    });
  }

  private async synchronizeArreteCadreEndDate(
    repository: Repository<ArreteCadre>,
    id: number,
    businessDate: string,
    rejectUnknownExtension = true,
  ): Promise<Partial<ArreteCadre>> {
    const arrete = await this.findOneForContinuity(repository, id);
    const validSuccessors = arrete.arretesCadre.filter(
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
      arrete.arretesCadre.filter(
        (successor) => successor.statut !== 'a_valider',
      ).length
    ) {
      this.logger.error(
        `CHAINE ABROGATION AC INCOHERENTE IGNORÉE POUR ${arrete.id}`,
        '',
      );
    }
    const successorConstraint = getPredecessorEndDateConstraint(
      validSuccessors.map(({ dateDebut }) => dateDebut),
    );
    const resolved = resolveArreteEndDate(arrete, [successorConstraint], {
      rejectUnknownExtension,
    });
    const statut =
      arrete.statut === 'a_valider'
        ? arrete.statut
        : getArreteLifecycleStatus(
            arrete.dateDebut,
            resolved.dateFin,
            businessDate,
          );
    const update = { ...resolved, statut };
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
      throw new Error(`Unable to synchronize framework order ${id}`);
    }
    return update;
  }

  async repeal(
    id: number,
    repealArreteCadreDto: RepealArreteCadreDto,
    currentUser: User,
  ): Promise<ArreteCadre> {
    const ac = await this.findOne(id, currentUser);
    if (
      !(await this.canRepealArreteCadre(ac, repealArreteCadreDto, currentUser))
    ) {
      throw new HttpException(
        `Abrogation impossible.`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const dateFin = normalizeCivilDate(repealArreteCadreDto.dateFin);
    const businessDate = getCurrentParisCivilDate();
    const toReturn = await this.arreteCadreRepository.manager.transaction(
      'SERIALIZABLE',
      async (manager) => {
        const repository = manager.getRepository(ArreteCadre);
        await this.lockArreteCadreGraph(repository, [id]);
        const current = await this.findOneForContinuity(repository, id);
        const authorizationState = await this.findOneForMutationAuthorization(
          repository,
          id,
        );
        if (
          !['a_venir', 'publie'].includes(current.statut) ||
          dateFin < current.dateDebut ||
          hasArreteMutationVersionChanged(ac, current) ||
          !(await this.canRepealArreteCadre(
            authorizationState,
            repealArreteCadreDto,
            currentUser,
          ))
        ) {
          throw new HttpException(
            `L'arrêté a été modifié pendant son abrogation. Veuillez recommencer.`,
            HttpStatus.CONFLICT,
          );
        }
        await this.arreteRestrictionService.lockArreteRestrictionsForArreteCadres(
          manager,
          [id],
        );
        const saved = await repository.save({
          id,
          ...repealArreteCadreDto,
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
          await this.synchronizeArreteCadreEndDate(
            repository,
            id,
            businessDate,
          ),
        );
        const dirtyDates = [
          normalizeCivilDate(current.dateDebut),
          ...(await this.arreteRestrictionService.reconcileArreteRestrictionsForArreteCadres(
            manager,
            [id],
            businessDate,
          )),
        ];
        await this.arreteRestrictionService.invalidateComputationsFromWithManager(
          manager,
          dirtyDates.sort()[0],
        );
        await this.arreteRestrictionService.enqueueCurrentZoneRecomputeWithManager(
          manager,
          ac.departements.map(({ id: departementId }) => departementId),
        );
        return saved;
      },
    );
    this.arreteRestrictionService.requestCurrentZoneRecompute(
      ac.departements,
      'ABROGATION AC',
    );
    delete toReturn.dateFinSaisie;
    delete toReturn.dateFinCalculee;
    delete toReturn.dateFinSaisieConnue;
    return toReturn;
  }

  async remove(id: number, curentUser: User) {
    if (!(await this.canRemoveArreteCadre(id, curentUser))) {
      throw new HttpException(
        `Vous ne pouvez supprimer un arrêté cadre que si il est sur votre département et qu'il n'est lié à aucun arrêté de restriction.`,
        HttpStatus.FORBIDDEN,
      );
    }
    const arrete = await this.findOne(id, curentUser);
    const predecessorId = arrete.arreteCadreAbroge?.id;
    const businessDate = getCurrentParisCivilDate();
    try {
      await this.arreteCadreRepository.manager.transaction(
        'SERIALIZABLE',
        async (manager) => {
          const repository = manager.getRepository(ArreteCadre);
          await this.lockArreteCadreGraph(repository, [id, predecessorId]);
          const current = await this.findOneForContinuity(repository, id);
          const authorizationState = await this.findOneForMutationAuthorization(
            repository,
            id,
          );
          if (
            current.arreteCadreAbroge?.id !== predecessorId ||
            hasArreteComputationStateChanged(arrete, current) ||
            hasArreteMutationVersionChanged(arrete, current) ||
            !this.canRemoveArreteCadreState(authorizationState, curentUser)
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
          dirtyFrom.push(
            ...(await this.arreteRestrictionService.deleteByArreteCadreId(
              id,
              manager,
              businessDate,
            )),
          );
          await repository.update(
            { arreteCadreAbroge: { id } },
            { arreteCadreAbroge: null },
          );
          const deleted = await repository.delete(id);
          if (deleted.affected !== 1) {
            throw new Error(`Unable to delete framework order ${id}`);
          }
          if (predecessorId) {
            await this.synchronizeArreteCadreEndDate(
              repository,
              predecessorId,
              businessDate,
            );
          }
          if (dirtyFrom.length > 0) {
            await this.arreteRestrictionService.invalidateComputationsFromWithManager(
              manager,
              dirtyFrom.sort()[0],
            );
          }
          if (current.statut !== 'a_valider') {
            await this.arreteRestrictionService.enqueueCurrentZoneRecomputeWithManager(
              manager,
              arrete.departements.map(({ id: departementId }) => departementId),
            );
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
      this.arreteRestrictionService.requestCurrentZoneRecompute(
        arrete.departements,
        'SUPPRESSION AC',
      );
    }
    return;
  }

  async repercussionOnAr(
    oldAc: ArreteCadre,
    newAc: ArreteCadre,
    manager?: EntityManager,
  ) {
    // Supprimer / modifier les zones / usages de l'AC
    if (oldAc.statut === 'a_valider') {
      return;
    }
    const zonesDeleted = oldAc.zonesAlerte.filter(
      (za) => !newAc.zonesAlerte.some((nza) => nza.id === za.id),
    );
    const usagesDeleted = oldAc.usages.filter(
      (uac) => !newAc.usages.some((nuac) => nuac.id === uac.id),
    );
    const usagesUpdated = newAc.usages.filter((nuac) => {
      const oldUac = oldAc.usages.find((ouac) => ouac.id === nuac.id);
      if (!oldUac) {
        return false;
      }
      return (
        oldUac.nom !== nuac.nom ||
        oldUac.thematique.id !== nuac.thematique.id ||
        oldUac.concerneParticulier !== nuac.concerneParticulier ||
        oldUac.concerneEntreprise !== nuac.concerneEntreprise ||
        oldUac.concerneCollectivite !== nuac.concerneCollectivite ||
        oldUac.concerneExploitation !== nuac.concerneExploitation ||
        oldUac.concerneEso !== nuac.concerneEso ||
        oldUac.concerneEsu !== nuac.concerneEsu ||
        oldUac.concerneAep !== nuac.concerneAep ||
        oldUac.descriptionVigilance !== nuac.descriptionVigilance ||
        oldUac.descriptionAlerte !== nuac.descriptionAlerte ||
        oldUac.descriptionAlerteRenforcee !== nuac.descriptionAlerteRenforcee ||
        oldUac.descriptionCrise !== nuac.descriptionCrise
      );
    });
    const oldUsagesUpdates = oldAc.usages.filter((u) =>
      usagesUpdated.some((uu) => uu.id === u.id),
    );
    await Promise.all(<any>[
      this.restrictionService.deleteZonesByArreteCadreId(
        zonesDeleted.map((z) => z.id),
        oldAc.id,
        manager,
      ),
      this.usageService.updateUsagesArByArreteCadreId(
        oldUsagesUpdates,
        usagesUpdated,
        oldAc.id,
        manager,
      ),
      this.usageService.deleteUsagesArByArreteCadreId(
        usagesDeleted.map((u) => u.nom),
        oldAc.id,
        manager,
      ),
    ]);
  }

  async canUpdateArreteCadre(
    arreteCadre: ArreteCadre,
    user: User,
  ): Promise<boolean> {
    return (
      arreteCadre &&
      (user.role === 'mte' ||
        (arreteCadre.statut !== 'abroge' &&
          arreteCadre.departements.some((d) =>
            user.role_departements.includes(d.code),
          ) &&
          !arreteCadre.zonesAlerte.some((za) => za.disabled)))
    );
  }

  async canRemoveArreteCadre(id: number, user: User): Promise<boolean> {
    const arrete = await this.findOne(id, user);
    /**
     * On peut supprimer un AC s'il est sur le département de l'utilisateur
     * ou si le département de l'utilisateur est le département pilote de l'AC
     * et qu'il n'est lié à aucun AR en cours ou abrogé
     */
    return this.canRemoveArreteCadreState(arrete, user);
  }

  private canRemoveArreteCadreState(arrete: ArreteCadre, user: User): boolean {
    return (
      (arrete && user.role === 'mte') ||
      (!arrete.arretesRestriction.some((ar) =>
        ['a_venir', 'publie', 'abroge'].includes(ar.statut),
      ) &&
        arrete.departements.some((d) =>
          user.role_departements.includes(d.code),
        ))
    );
  }

  async canRepealArreteCadre(
    arrete: ArreteCadre,
    repealArreteCadre: RepealArreteCadreDto,
    user: User,
  ): Promise<boolean> {
    if (
      repealArreteCadre.dateFin &&
      moment(repealArreteCadre.dateFin).isBefore(
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
        arrete.departements.some((d) =>
          user.role_departements.includes(d.code),
        ))
    );
  }

  private async checkAci(
    createUpdateArreteCadreDto: CreateUpdateArreteCadreDto,
    isUpdate: boolean,
    currentUser?: User,
  ): Promise<void> {
    if (createUpdateArreteCadreDto.departements.length < 2) {
      return;
    }

    /** Si c'est un ACI, on met le premier département en tant que département pilote **/
    const depPilote = await this.departementService.find(
      createUpdateArreteCadreDto.departements[0].id,
    );
    /**
     * Si c'est un update, on vérifie seulement que le département est bien dedans
     */
    if (
      isUpdate &&
      currentUser?.role === 'departement' &&
      !createUpdateArreteCadreDto.departements.some(
        (d) => d.id === depPilote.id,
      )
    ) {
      throw new HttpException(
        `Vous ne pouvez pas modifier un ACI qui ne concerne pas votre département.`,
        HttpStatus.FORBIDDEN,
      );
    }
    // @ts-expect-error objet non complet
    createUpdateArreteCadreDto.departementPilote = depPilote;
  }

  private async sendAciMails(
    oldAc: ArreteCadre,
    newAc: ArreteCadre,
    user?: User,
  ) {
    if (!user) {
      return;
    }
    if (newAc.departements.length < 2) {
      return;
    }
    /**
     * On récupère tous les départements et leurs zones associées
     * pour vérifier le type de mail à envoyer
     */
    const depsInAci = await this.departementService.findByArreteCadreId(
      newAc.id,
      true,
    );
    const newDepsEnAttente = depsInAci.filter(
      (d) =>
        !d.zonesAlerte.some((za) =>
          newAc.zonesAlerte.some((nza) => nza.id === za.id),
        ),
    );
    const oldDepsEnAttente = depsInAci.filter(
      (d) =>
        !d.zonesAlerte.some((za) =>
          oldAc?.zonesAlerte.some((nza) => nza.id === za.id),
        ),
    );
    /**
     * Si tous les départements ont rempli leurs zones
     * Et que ce n'était pas rempli avant, on envoie le mail de finalisation
     */
    if (newDepsEnAttente.length < 1 && oldDepsEnAttente.length > 0 && oldAc) {
      const usersDepPilote = await this.userService.findByDepartementsId([
        newAc.departementPilote.id,
      ]);
      await this.mailService.sendEmails(
        usersDepPilote.map((u) => u.email),
        `Toutes les DDT ont finalisé leur saisie de l’ACI ${newAc.numero}`,
        'finalisation_aci',
        {
          acNumero: newAc.numero,
          acLien: `https://${this.configService.get('DOMAIN_NAME')}/arrete-cadre/${newAc.id}/edition`,
        },
      );
      return;
    }
    /**
     * S'il y a une différence de départements finalisés, on envoie un mail à la DDT pilote
     */
    const depsDifferents = [
      ...newDepsEnAttente.filter(
        (nd) => !oldDepsEnAttente.some((od) => nd.id === od.id),
      ),
      ...oldDepsEnAttente.filter(
        (od) => !newDepsEnAttente.some((nd) => nd.id === od.id),
      ),
    ];
    if (depsDifferents.length > 0 && oldAc) {
      const newDepsFinalise = depsInAci.filter((d) =>
        d.zonesAlerte.some((za) =>
          newAc.zonesAlerte.some((nza) => nza.id === za.id),
        ),
      );
      const usersDepPilote = await this.userService.findByDepartementsId([
        newAc.departementPilote.id,
      ]);
      await this.mailService.sendEmails(
        usersDepPilote.map((u) => u.email),
        `Des DDTs ont complétés l’ACI ${newAc.numero}`,
        'maj_aci',
        {
          departementNom: newAc.departementPilote.nom,
          acNumero: newAc.numero,
          lien: `https://${this.configService.get('DOMAIN_NAME')}/arrete-cadre`,
          departementsTermine: newDepsFinalise,
          departementsEnAttente: newDepsEnAttente,
        },
      );
    }

    /**
     * Pour prévenir les DDTs non pilote,
     * on filtre par ceux qui étaient déjà présents avant (pour éviter les doublons)
     * et on vérifie l'user pour savoir si on doit envoyer un mail au pilote
     */
    const depsToSendMail = newAc.departements.filter((d) => {
      return (
        !oldAc?.departements.some((od) => od.id === d.id) &&
        !(user.role === 'mte' || user.role_departements.includes(d.code))
      );
    });
    if (depsToSendMail.length < 1) {
      return;
    }
    const usersToSendMail = await this.userService.findByDepartementsId(
      depsToSendMail.map((d) => d.id),
    );
    await this.mailService.sendEmails(
      usersToSendMail.map((u) => u.email),
      `La DDT ${newAc.departementPilote.nom} vous invite à compléter l’ACI ${newAc.numero}`,
      'creation_aci',
      {
        departementNom: newAc.departementPilote.nom,
        acNumero: newAc.numero,
        acLien: `https://${this.configService.get('DOMAIN_NAME')}/arrete-cadre/${newAc.id}/edition`,
      },
    );
  }

  /**
   * Met à jour les statuts des AC et lance le recalcul national associé.
   */
  async updateArreteCadreStatut(
    computeHistoric = true,
    dailyPublicationReuse?: DailyZonePublicationReuseContext,
  ) {
    const businessDate =
      dailyPublicationReuse?.scheduledFor ?? getCurrentParisCivilDate();
    const changedStatusCounts = { publie: 0, a_venir: 0, abroge: 0 };
    await this.arreteCadreRepository.manager.transaction(
      'SERIALIZABLE',
      async (manager) => {
        const repository = manager.getRepository(ArreteCadre);
        const candidates = (await repository.query(
          `
            SELECT
              framework_order.id,
              framework_order."dateDebut"::text AS "dateDebut",
              framework_order."dateFin"::text AS "dateFin",
              framework_order.statut::text AS statut
            FROM arrete_cadre framework_order
            LEFT JOIN LATERAL (
              SELECT MIN(bounds.end_date) AS resolved_end
              FROM (
                SELECT CASE
                  WHEN framework_order."dateFinCalculee" = false
                    THEN framework_order."dateFin"
                  WHEN framework_order."dateFinSaisieConnue" = false
                    THEN framework_order."dateFin"
                  ELSE framework_order."dateFinSaisie"
                END AS end_date
                UNION ALL
                SELECT MIN(successor."dateDebut") - 1
                FROM arrete_cadre successor
                WHERE successor."arreteCadreAbrogeId" = framework_order.id
                  AND successor.statut <> 'a_valider'
                  AND successor.id <> framework_order.id
                  AND successor."dateDebut" IS NOT NULL
                  AND successor."dateDebut" > framework_order."dateDebut"
              ) bounds
            ) expected_end ON true
            WHERE framework_order.statut <> 'a_valider'
              AND (
                framework_order.statut::text IS DISTINCT FROM (
                  CASE
                    WHEN framework_order."dateDebut" > $1::date THEN 'a_venir'
                    WHEN framework_order."dateFin" IS NOT NULL
                      AND framework_order."dateFin" < $1::date THEN 'abroge'
                    ELSE 'publie'
                  END
                )
                OR (
                  framework_order."dateFinCalculee" = true
                  AND framework_order."dateFinSaisieConnue" = true
                  AND framework_order."dateFin" IS DISTINCT FROM expected_end.resolved_end
                )
              )
            ORDER BY framework_order.id
          `,
          [businessDate],
        )) as Array<
          Pick<ArreteCadre, 'id' | 'dateDebut' | 'dateFin' | 'statut'>
        >;
        if (candidates.length === 0) {
          return;
        }
        const ids = candidates.map(({ id }) => id);
        await this.lockArreteCadreGraph(repository, ids);
        await this.arreteRestrictionService.lockArreteRestrictionsForArreteCadres(
          manager,
          ids,
        );
        const dirtyFrom: string[] = [];
        for (const previous of candidates) {
          const synchronized = await this.synchronizeArreteCadreEndDate(
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
        dirtyFrom.push(
          ...(await this.arreteRestrictionService.reconcileArreteRestrictionsForArreteCadres(
            manager,
            ids,
            businessDate,
            false,
          )),
        );
        if (dirtyFrom.length > 0) {
          await this.arreteRestrictionService.invalidateComputationsFromWithManager(
            manager,
            dirtyFrom.sort()[0],
          );
        }
        if (!dailyPublicationReuse) {
          const affectedDepartements = (await manager.query(
            `
              SELECT DISTINCT link."departementId" AS id
              FROM "arrete_cadre_departement" link
              WHERE link."arreteCadreId" = ANY($1::integer[])
              ORDER BY link."departementId"
            `,
            [ids],
          )) as Array<{ id: number }>;
          await this.arreteRestrictionService.enqueueCurrentZoneRecomputeWithManager(
            manager,
            affectedDepartements.map(({ id }) => Number(id)),
          );
        }
      },
    );
    this.logger.log(
      `${changedStatusCounts.publie} Arrêtés Cadre publiés, ${changedStatusCounts.a_venir} à venir, ${changedStatusCounts.abroge} abrogés`,
    );

    if (dailyPublicationReuse) {
      return this.arreteRestrictionService.updateArreteRestrictionStatut(
        null,
        computeHistoric,
        dailyPublicationReuse,
      );
    }
    return this.arreteRestrictionService.updateArreteRestrictionStatut(
      null,
      computeHistoric,
    );
  }

  async catchUpHistoricComputations(
    requiredThrough: string,
    expectedSourceRevision?: string,
  ) {
    return this.arreteRestrictionService.catchUpHistoricComputations(
      requiredThrough,
      expectedSourceRevision,
    );
  }

  /**
   * Vérification s'il faut envoyer des mails de relance tous les jours à 8h du matin
   */
  @BusinessCron(CronExpression.EVERY_DAY_AT_8AM)
  async sendArreteCadreEmails() {
    const [ac15ARelancer, ac2ARelancer] = await Promise.all([
      this.getAcAtXDays(15),
      this.getAcAtXDays(2),
    ]);
    for (const ac of ac15ARelancer.concat(ac2ARelancer)) {
      const usersToSendMail = await this.userService.findByDepartementsId(
        ac.departements.map((d) => d.id),
      );
      const nbJoursFin = ac15ARelancer.some((a) => a.id === ac.id) ? 15 : 2;
      await this.mailService.sendEmails(
        usersToSendMail.map((u) => u.email),
        `L'arrêté ${ac.numero} se termine dans ${nbJoursFin} jours`,
        'relance_arrete',
        {
          arreteNumero: ac.numero,
          arreteDateFin: ac.dateFin,
          joursFin: nbJoursFin,
          isAc: true,
          isAr: false,
          arreteLien: `https://${this.configService.get('DOMAIN_NAME')}/arrete-cadre/${ac.id}/edition`,
        },
      );
    }
  }

  private getAcAtXDays(days: number) {
    return this.arreteCadreRepository
      .createQueryBuilder('arrete_cadre')
      .leftJoinAndSelect('arrete_cadre.departements', 'departement')
      .where('arrete_cadre.statut IN (:...statuts)', {
        statuts: ['a_venir', 'publie'],
      })
      .having(
        `DATE_PART('day', "dateFin"::timestamp - CURRENT_DATE::timestamp) = ${days}`,
      )
      .groupBy('arrete_cadre.id')
      .addGroupBy('departement.id')
      .getMany();
  }

  /************************************************************************************ TEST FUNCTIONS ************************************************************************************/

  /**
   * Ajouts d'arrêtés cadres pour les tests E2E
   */
  async populateTestData(): Promise<void> {
    for (const ac of testArretesCadre) {
      switch (ac.numero) {
        case 'CYTEST_001':
          ac.departements = [await this.departementService.findByCode('2A')];
          break;
        case 'CYTEST_002':
          ac.departements = [await this.departementService.findByCode('2A')];
          ac.zonesAlerte = await this.zoneAlerteService.findByDepartement('2A');
          // ac.usagesArreteCadre = await this.usageArreteCadreService.findByArreteCadre();
          break;
        case 'CYTEST_003':
          ac.departements = [await this.departementService.findByCode('2A')];
          ac.zonesAlerte = await this.zoneAlerteService.findByDepartement('2A');
          // ac.usagesArreteCadre = await this.usageArreteCadreService.findByArreteCadre();
          break;
        case 'CYTEST_004':
          ac.departements = [
            await this.departementService.findByCode('2A'),
            await this.departementService.findByCode('2B'),
          ];
          ac.zonesAlerte = await this.zoneAlerteService.findByDepartement('2A');
          // ac.usagesArreteCadre = await this.usageArreteCadreService.findByArreteCadre();
          break;
        case 'CYTEST_005':
          ac.departements = [
            await this.departementService.findByCode('2B'),
            await this.departementService.findByCode('2A'),
          ];
          ac.zonesAlerte = await this.zoneAlerteService.findByDepartement('2A');
          // ac.usagesArreteCadre = await this.usageArreteCadreService.findByArreteCadre();
          break;
        case 'CYTEST_006':
          ac.departements = [await this.departementService.findByCode('2A')];
          // ac.usagesArreteCadre = await this.usageArreteCadreService.findByArreteCadre();
          break;
        case 'CYTEST_007':
          ac.departements = [await this.departementService.findByCode('2B')];
          ac.zonesAlerte = await this.zoneAlerteService.findByDepartement('2B');
          // ac.usagesArreteCadre = await this.usageArreteCadreService.findByArreteCadre();
          break;
      }
      await this.create(structuredClone(ac), null);
    }
    return;
  }

  /**
   * Suppression des données générées par les tests E2E
   * Par convention les données générées par les tests E2E sont préfixées par CYTEST
   */
  removeTestData(): Promise<DeleteResult> {
    return this.arreteCadreRepository.delete({ numero: Like('CYTEST%') });
  }
}
