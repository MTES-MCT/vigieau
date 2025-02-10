import { forwardRef, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  DeleteResult,
  FindManyOptions,
  FindOptionsWhere,
  In,
  LessThan,
  LessThanOrEqual,
  Like,
  Repository,
} from 'typeorm';
import { ArreteCadre } from './entities/arrete_cadre.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from '../user/entities/user.entity';
import { paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { CreateUpdateArreteCadreDto } from './dto/create_update_arrete_cadre.dto';
import { arreteCadrePaginateConfig } from './dto/arrete_cadre.dto';
import { testArretesCadre } from '../core/test/data';
import { PublishArreteCadreDto } from './dto/publish_arrete_cadre.dto';
import { StatutArreteCadre } from './type/arrete_cadre.type';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RegleauLogger } from '../logger/regleau.logger';
import { RepealArreteCadreDto } from './dto/repeal_arrete_cadre.dto';
import { ArreteRestrictionService } from '../arrete_restriction/arrete_restriction.service';
import { DepartementService } from '../departement/departement.service';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';
import { MailService } from '../shared/services/mail.service';
import { UserService } from '../user/user.service';
import { FichierService } from '../fichier/fichier.service';
import { RestrictionService } from '../restriction/restriction.service';
import { UsageService } from '../usage/usage.service';
import moment from 'moment/moment';
import {
  ArreteCadreZoneAlerteCommunesService,
} from '../arrete_cadre_zone_alerte_communes/arrete_cadre_zone_alerte_communes.service';

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
  ) {
  }

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
    const whereClause: FindOptionsWhere<ArreteCadre> | null =
      !currentUser || currentUser.role === 'mte'
        ? { id }
        : {
          id,
          departements: {
            code: In(currentUser.role_departements),
          },
        };

    const qb = this.arreteCadreRepository.createQueryBuilder('arreteCadre')
      .select([
        'arreteCadre.id', 'arreteCadre.numero', 'arreteCadre.dateDebut', 'arreteCadre.dateFin', 'arreteCadre.statut',
        'fichier.id', 'fichier.nom', 'fichier.url', 'fichier.size',
        'departementPilote.id', 'departementPilote.code', 'departementPilote.nom',
        'zonesAlerte.id', 'zonesAlerte.code', 'zonesAlerte.nom', 'zonesAlerte.type', 'zonesAlerte.disabled', 'zonesAlerte.ressourceInfluencee',
        'departement.id', 'departement.code',
        'arretesRestriction.id', 'arretesRestriction.numero', 'arretesRestriction.statut',
        'arreteCadreAbroge.id', 'arreteCadreAbroge.numero', 'arreteCadreAbroge.dateDebut', 'arreteCadreAbroge.dateFin',
        'aczac.id', 'communes.id', 'communes.code', 'communes.nom',
      ])
      .leftJoin('arreteCadre.departementPilote', 'departementPilote')
      .leftJoin('arreteCadre.zonesAlerte', 'zonesAlerte')
      .leftJoin('zonesAlerte.departement', 'departement')
      .leftJoin('arreteCadre.arretesRestriction', 'arretesRestriction')
      .leftJoin('arreteCadre.fichier', 'fichier')
      .leftJoin('arreteCadre.arreteCadreAbroge', 'arreteCadreAbroge')
      .leftJoin('zonesAlerte.arreteCadreZoneAlerteCommunes', 'aczac', 'aczac.arreteCadreId = arreteCadre.id')
      .leftJoin('aczac.communes', 'communes')
      .where(whereClause)
      .orderBy('zonesAlerte.code', 'ASC');
    const [arreteCadre, usagesArreteCadre, departements]: any = await Promise.all(<any>[
      qb.getOne(),
      this.usageService.findByArreteCadre(id),
      this.departementService.findByArreteCadreId(id),
    ]);
    if (!arreteCadre) {
      throw new HttpException(
        `L'arrêté cadre n'existe pas ou vous n'avez pas les droits pour le consulter.`,
        HttpStatus.NOT_FOUND,
      );
    }
    arreteCadre.usages = usagesArreteCadre;
    arreteCadre.zonesAlerte.map(za => {
      if (za.arreteCadreZoneAlerteCommunes[0] && za.arreteCadreZoneAlerteCommunes[0].communes?.length > 0) {
        za.communes = structuredClone(za.arreteCadreZoneAlerteCommunes[0].communes);
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
      relations: [
        'departements',
        'zonesAlerte',
      ],
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
    const arreteCadre =
      await this.arreteCadreRepository.save(createArreteCadreDto);
    arreteCadre.usages = await this.usageService.updateAllByArreteCadre(arreteCadre);
    await this.arreteCadreZoneAlerteCommunesService.updateAllByArreteCadre(arreteCadre.id, createArreteCadreDto);

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
    const arreteCadre = await this.arreteCadreRepository.save({
      id,
      ...updateArreteCadreDto,
    });
    arreteCadre.usages = await this.usageService.updateAllByArreteCadre(arreteCadre);
    await this.arreteCadreZoneAlerteCommunesService.updateAllByArreteCadre(arreteCadre.id, updateArreteCadreDto);

    await this.repercussionOnAr(oldAc, arreteCadre);
    this.sendAciMails(oldAc, arreteCadre, currentUser);
    return arreteCadre;
  }

  async publish(
    id: number,
    arreteCadrePdf: Express.Multer.File,
    publishArreteCadreDto: PublishArreteCadreDto,
    currentUser: User,
  ): Promise<ArreteCadre> {
    if (
      publishArreteCadreDto.dateFin &&
      moment(publishArreteCadreDto.dateFin)
        .isBefore(publishArreteCadreDto.dateDebut, 'day')
    ) {
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
      const dateDebutAc = new Date(publishArreteCadreDto.dateDebut);
      const dateDebutAcAbroge = new Date(ac.arreteCadreAbroge.dateDebut);
      if (dateDebutAc.getTime() <= dateDebutAcAbroge.getTime()) {
        throw new HttpException(
          `La date de début de l'arrêté cadre doit être supérieur à celle de l'arrêté cadre abrogé.`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    let toSave: any = {
      id,
      ...publishArreteCadreDto,
    };
    // Upload du PDF de l'arrêté cadre
    if (arreteCadrePdf) {
      if (ac.fichier) {
        await this.arreteCadreRepository.update({ id: id }, { fichier: null });
        await this.fichierService.deleteById(ac.fichier.id);
      }
      const newFile = await this.fichierService.create(
        arreteCadrePdf,
        `arrete-cadre/${ac.id}/`,
      );
      toSave.fichier = { id: newFile.id };
    }
    toSave =
      new Date(publishArreteCadreDto.dateDebut) <= new Date()
        ? publishArreteCadreDto.dateFin &&
        new Date(publishArreteCadreDto.dateFin) <= new Date()
          ? { ...toSave, ...{ statut: <StatutArreteCadre>'abroge' } }
          : { ...toSave, ...{ statut: <StatutArreteCadre>'publie' } }
        : { ...toSave, ...{ statut: <StatutArreteCadre>'a_venir' } };
    const toReturn = await this.arreteCadreRepository.save(toSave);

    // Gestion des abrogations associées
    if (ac.arreteCadreAbroge) {
      const dateDebutAc = new Date(publishArreteCadreDto.dateDebut);
      const dateFinAcAbroge = ac.arreteCadreAbroge.dateFin ? new Date(ac.arreteCadreAbroge.dateFin) : null;
      if (
        !dateFinAcAbroge ||
        moment(dateFinAcAbroge).isSameOrAfter(moment(dateDebutAc), 'day')
      ) {
        const dateToSave = dateDebutAc;
        dateToSave.setDate(dateToSave.getDate() - 1);
        await this.arreteCadreRepository.update(
          {
            id: ac.arreteCadreAbroge.id,
          },
          {
            dateFin: dateToSave.toDateString(),
          },
        );
        if (moment(dateToSave).isBefore(moment(), 'day')) {
          await this.arreteCadreRepository.update(
            {
              id: ac.arreteCadreAbroge.id,
            },
            {
              statut: <StatutArreteCadre>'abroge',
            },
          );
        }
      }
    }
    this.arreteRestrictionService.updateArreteRestrictionStatut(ac.departements);
    return toReturn;
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
    let toSave = {
      id,
      ...repealArreteCadreDto,
    };
    if (moment(repealArreteCadreDto.dateFin).isBefore(moment(), 'day')) {
      toSave = { ...toSave, ...{ statut: <StatutArreteCadre>'abroge' } };
    }
    const toReturn = await this.arreteCadreRepository.save(toSave);
    await this.arreteRestrictionService.updateArreteRestrictionStatut(ac.departements);
    return toReturn;
  }

  async remove(id: number, curentUser: User) {
    if (!(await this.canRemoveArreteCadre(id, curentUser))) {
      throw new HttpException(
        `Vous ne pouvez supprimer un arrêté cadre que si il est sur votre département et qu'il n'est lié à aucun arrêté de restriction.`,
        HttpStatus.FORBIDDEN,
      );
    }

    await this.arreteRestrictionService.deleteByArreteCadreId(id);
    await this.arreteCadreRepository.delete(id);
    return;
  }

  async repercussionOnAr(oldAc: ArreteCadre, newAc: ArreteCadre) {
    // Supprimer / modifier les zones / usages de l'AC
    if (oldAc.statut === 'a_valider') {
      return;
    }
    const zonesDeleted = oldAc.zonesAlerte.filter(
      (za) => !newAc.zonesAlerte.some((nza) => nza.id === za.id),
    );
    const usagesDeleted = oldAc.usages.filter(
      (uac) =>
        !newAc.usages.some((nuac) => nuac.id === uac.id),
    );
    const usagesUpdated = newAc.usages.filter(
      (nuac) => {
        const oldUac = oldAc.usages.find(ouac => ouac.id === nuac.id);
        if (!oldUac) {
          return false;
        }
        return oldUac.nom !== nuac.nom
          || oldUac.thematique.id !== nuac.thematique.id
          || oldUac.concerneParticulier !== nuac.concerneParticulier
          || oldUac.concerneEntreprise !== nuac.concerneEntreprise
          || oldUac.concerneCollectivite !== nuac.concerneCollectivite
          || oldUac.concerneExploitation !== nuac.concerneExploitation
          || oldUac.concerneEso !== nuac.concerneEso
          || oldUac.concerneEsu !== nuac.concerneEsu
          || oldUac.concerneAep !== nuac.concerneAep
          || oldUac.descriptionVigilance !== nuac.descriptionVigilance
          || oldUac.descriptionAlerte !== nuac.descriptionAlerte
          || oldUac.descriptionAlerteRenforcee !== nuac.descriptionAlerteRenforcee
          || oldUac.descriptionCrise !== nuac.descriptionCrise;
      },
    );
    const oldUsagesUpdates = oldAc.usages.filter(u => usagesUpdated.some(uu => uu.id === u.id));
    await Promise.all(<any>[
      this.restrictionService.deleteZonesByArreteCadreId(
        zonesDeleted.map((z) => z.id),
        oldAc.id,
      ),
      this.usageService.updateUsagesArByArreteCadreId(
        oldUsagesUpdates,
        usagesUpdated,
        oldAc.id,
      ),
      this.usageService.deleteUsagesArByArreteCadreId(
        usagesDeleted.map((u) => u.nom),
        oldAc.id,
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
          arreteCadre.departements.some(
            (d) => user.role_departements.includes(d.code),
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
    return (
      arrete &&
      user.role === 'mte' || (
        !arrete.arretesRestriction.some((ar) =>
          ['a_venir', 'publie', 'abroge'].includes(ar.statut),
        ) &&
        arrete.departements.some((d) => user.role_departements.includes(d.code)))
    );
  }

  async canRepealArreteCadre(
    arrete: ArreteCadre,
    repealArreteCadre: RepealArreteCadreDto,
    user: User,
  ): Promise<boolean> {
    if (
      repealArreteCadre.dateFin &&
      moment(repealArreteCadre.dateFin)
        .isBefore(moment(arrete.dateDebut), 'day')
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
        arrete.departements.some((d) => user.role_departements.includes(d.code)))
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
          acLien: `https://${process.env.DOMAIN_NAME}/arrete-cadre/${newAc.id}/edition`,
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
          lien: `https://${process.env.DOMAIN_NAME}/arrete-cadre`,
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
        acLien: `https://${process.env.DOMAIN_NAME}/arrete-cadre/${newAc.id}/edition`,
      },
    );
  }

  /**
   * Mis à jour des statuts des AC tous les jours à 2h du matin
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async updateArreteCadreStatut() {
    const acAVenir = await this.arreteCadreRepository.find(<FindManyOptions>{
      where: {
        statut: 'a_venir',
        dateDebut: LessThanOrEqual(new Date()),
      },
    });
    await this.arreteCadreRepository.update(
      { id: In(acAVenir.map((ac) => ac.id)) },
      { statut: 'publie' },
    );
    this.logger.log(`${acAVenir.length} Arrêtés Cadre publiés`);

    const acPerime = await this.arreteCadreRepository.find(<FindManyOptions>{
      where: {
        statut: In(['a_venir', 'publie']),
        dateFin: LessThan(new Date()),
      },
    });
    await this.arreteCadreRepository.update(
      { id: In(acPerime.map((ac) => ac.id)) },
      { statut: 'abroge' },
    );
    this.logger.log(`${acPerime.length} Arrêtés Cadre abrogés`);

    this.arreteRestrictionService.updateArreteRestrictionStatut(null, true);
  }

  /**
   * Vérification s'il faut envoyer des mails de relance tous les jours à 8h du matin
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
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
          arreteLien: `https://${process.env.DOMAIN_NAME}/arrete-cadre/${ac.id}/edition`,
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
