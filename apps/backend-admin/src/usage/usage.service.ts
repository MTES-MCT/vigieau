import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { Restriction } from '@shared/entities/restriction.entity';
import { Usage } from '@shared/entities/usage.entity';
import { User } from '@shared/entities/user.entity';
import { FindManyOptions, In, Not, Repository } from 'typeorm';
import { FindOptionsWhere } from 'typeorm/find-options/FindOptionsWhere';
import { CreateUpdateUsageDto } from './dto/create_usage.dto';

@Injectable()
export class UsageService {
  constructor(
    @InjectRepository(Usage)
    private readonly usageRepository: Repository<Usage>,
  ) {}

  findOne(nom: string): Promise<Usage> {
    return this.usageRepository.findOne({
      relations: ['thematique'],
      where: { nom },
    });
  }

  async findAll(curentUser: User): Promise<Usage[]> {
    if (curentUser.role === 'commune') {
      return [];
    }

    return await this.usageRepository
      .createQueryBuilder('usage')
      .select()
      .distinctOn(['usage.nom'])
      .leftJoinAndSelect('usage.thematique', 'thematique')
      .leftJoin('usage.arreteCadre', 'arreteCadre')
      .leftJoin('arreteCadre.departements', 'departements')
      .where('usage."arreteCadreId" is not null')
      .andWhere(
        curentUser.role === 'mte'
          ? '1 = 1'
          : 'departements.code IN(:...code_dep)',
        {
          code_dep: curentUser.role_departements,
        },
      )
      .orderBy('usage.nom', 'ASC')
      .getMany();
  }

  async create(usage: CreateUpdateUsageDto): Promise<Usage> {
    if (
      (!usage.concerneEso && !usage.concerneEsu && !usage.concerneAep) ||
      (!usage.concerneParticulier &&
        !usage.concerneCollectivite &&
        !usage.concerneEntreprise &&
        !usage.concerneExploitation)
    ) {
      throw new HttpException(
        `Il faut au moins un usager et un type de ressouce pour créer un usage.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const usageExists = await this.findOne(usage.nom);
    if (usageExists) {
      usage.id = usageExists.id;
    }
    await this.usageRepository.save(usage);
    return this.findOne(usage.nom);
  }

  async updateAllByRestriction(restriction: Restriction): Promise<Usage[]> {
    const usagesId = restriction.usages
      .filter((u) => u.id)
      .map((u) => u.id)
      .flat();
    // SUPPRESSION DES ANCIENS USAGES
    if (usagesId.length > 0) {
      await this.usageRepository.delete(<FindOptionsWhere<Usage>>{
        restriction: {
          id: restriction.id,
        },
        id: Not(In(usagesId)),
      });
    } else {
      await this.usageRepository.delete(<FindOptionsWhere<Usage>>{
        restriction: {
          id: restriction.id,
        },
      });
    }
    const usages: Usage[] = restriction.usages.map((u) => {
      // @ts-expect-error on ajoute seulement l'id
      u.restriction = { id: restriction.id };
      return u;
    });
    return this.usageRepository.save(usages);
  }

  async updateAllByArreteCadre(arreteCadre: ArreteCadre): Promise<Usage[]> {
    const usagesId = arreteCadre.usages.map((u) => u.id).flat();
    // SUPPRESSION DES ANCIENS USAGES
    await this.usageRepository.delete(<FindOptionsWhere<Usage>>{
      arreteCadre: {
        id: arreteCadre.id,
      },
      id: Not(In(usagesId)),
    });
    const usages: Usage[] = arreteCadre.usages.map((u) => {
      // @ts-expect-error on ajoute seulement l'id
      u.arreteCadre = { id: arreteCadre.id };
      return u;
    });
    return this.usageRepository.save(usages);
  }

  findByArreteCadre(arreteCadreId: number) {
    return this.usageRepository.find(<FindManyOptions>{
      select: {
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
      relations: ['thematique'],
      where: {
        arreteCadre: {
          id: arreteCadreId,
        },
      },
      order: {
        nom: 'ASC',
      },
    });
  }

  async updateUsagesArByArreteCadreId(
    oldUsagesAc: Usage[],
    usagesAc: Usage[],
    acId: number,
  ) {
    const updates = [];
    for (const u of usagesAc) {
      const oldUsage = oldUsagesAc.find((ou) => ou.id === u.id);
      const tmp = await this.usageRepository.find(<FindManyOptions>{
        where: {
          restriction: {
            arreteRestriction: {
              arretesCadre: {
                id: acId,
              },
            },
          },
          nom: oldUsage.nom,
        },
      });
      const usageUpdated = {
        nom: u.nom,
        thematique: u.thematique,
        concerneParticulier: u.concerneParticulier,
        concerneEntreprise: u.concerneEntreprise,
        concerneCollectivite: u.concerneCollectivite,
        concerneExploitation: u.concerneExploitation,
        concerneEso: u.concerneEso,
        concerneEsu: u.concerneEsu,
        concerneAep: u.concerneAep,
        descriptionVigilance: u.descriptionVigilance,
        descriptionAlerte: u.descriptionAlerte,
        descriptionAlerteRenforcee: u.descriptionAlerteRenforcee,
        descriptionCrise: u.descriptionCrise,
      };
      tmp.forEach((usageToUpdate) => {
        updates.push(
          this.usageRepository.update(usageToUpdate.id, usageUpdated),
        );
      });
    }
    await Promise.all(updates);
  }

  async deleteUsagesArByArreteCadreId(usagesNom: string[], acId: number) {
    if (usagesNom.length < 1) {
      return;
    }
    const usagesArreteRestrictionsId = await this.usageRepository
      .createQueryBuilder('usage')
      .select('usage.id')
      .leftJoin('usage.restriction', 'restriction')
      .leftJoin('restriction.arreteRestriction', 'arreteRestriction')
      .leftJoin('arreteRestriction.arretesCadre', 'arretesCadre')
      .where('arretesCadre.id = :acId', { acId: acId })
      .andWhere('arreteRestriction.statut != :statut', { statut: 'abroge' })
      .andWhere('usage.nom IN (:...usagesNom)', { usagesNom: usagesNom })
      .getMany();
    return this.usageRepository.delete({
      id: In(usagesArreteRestrictionsId.map((u) => u.id)),
    });
  }
}
