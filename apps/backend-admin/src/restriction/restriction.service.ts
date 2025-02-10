import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOneOptions, In, Not, Repository } from 'typeorm';
import { Restriction } from './entities/restriction.entity';
import { UsageService } from '../usage/usage.service';
import { CreateUpdateArreteRestrictionDto } from '../arrete_restriction/dto/create_update_arrete_restriction.dto';
import { CreateUpdateRestrictionDto } from './dto/create_update_restriction.dto';

@Injectable()
export class RestrictionService {
  constructor(
    @InjectRepository(Restriction)
    private readonly restrictionRepository: Repository<Restriction>,
    private readonly usageService: UsageService,
  ) {
  }

  async updateAll(
    arreteRestriction: CreateUpdateArreteRestrictionDto,
    arId: number,
  ): Promise<Restriction[]> {
    const restrictionsId = arreteRestriction.restrictions
      .filter((r) => r.id)
      .map((r) => r.id);
    await this.restrictionRepository.delete({
      arreteRestriction: {
        id: arId,
      },
      id: Not(In(restrictionsId)),
    });
    const restrictions: CreateUpdateRestrictionDto[] = arreteRestriction.restrictions.map(
      (r) => {
        if (r.isAep) {
          r.zoneAlerte = null;
        } else {
          r.communes = null;
        }
        // @ts-expect-error on ajoute seulement l'id
        r.arreteRestriction = { id: arId };
        return r;
      },
    );
    const rToReturn: Restriction[] =
      await this.restrictionRepository.save(restrictions);
    await Promise.all(
      rToReturn.map(async (r) => {
        r.usages =
          await this.usageService.updateAllByRestriction(r);
        return r;
      }),
    );
    return rToReturn;
  }

  async deleteZonesByArreteCadreId(zonesId: number[], acId: number) {
    if (zonesId.length < 1) {
      return;
    }
    const restrictionIds = await this.restrictionRepository
      .createQueryBuilder('restriction')
      .select('restriction.id')
      .leftJoin('restriction.arreteRestriction', 'arreteRestriction')
      .leftJoin('arreteRestriction.arretesCadre', 'arretesCadre')
      .leftJoin('restriction.zoneAlerte', 'zoneAlerte')
      .where('arretesCadre.id = :acId', { acId: acId })
      .andWhere('arreteRestriction.statut != :statut', { statut: 'abroge' })
      .andWhere('zoneAlerte.id IN (:...zonesId)', { zonesId: zonesId })
      .getMany();
    return this.restrictionRepository.delete({
      id: In(restrictionIds.map((r) => r.id)),
    });
  }

  async findOneByZoneAlerteComputed(zoneAlerteComputedId: number): Promise<Restriction> {
    return this.restrictionRepository.findOne(<FindOneOptions> {
      relations: ['arreteRestriction', 'zonesAlerteComputed'],
      where: {
        zonesAlerteComputed: {
          id: zoneAlerteComputedId,
        },
      },
    });
  }

  async findOneByZoneAlerteComputedHistoric(zoneAlerteComputedId: number): Promise<Restriction> {
    return this.restrictionRepository.findOne(<FindOneOptions> {
      relations: ['arreteRestriction', 'zonesAlerteComputedHistoric'],
      where: {
        zonesAlerteComputedHistoric: {
          id: zoneAlerteComputedId,
        },
      },
    });
  }
}
