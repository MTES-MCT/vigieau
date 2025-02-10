import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Statistic } from './entities/statistic.entity';
import { ZoneAlerteComputed } from '../zone_alerte_computed/entities/zone_alerte_computed.entity';
import { DepartementService } from '../departement/departement.service';
import { Utils } from '../core/utils';
import { max } from 'lodash';
import { ZoneAlerte } from '../zone_alerte/entities/zone_alerte.entity';
import { RegleauLogger } from '../logger/regleau.logger';

@Injectable()
export class StatisticService {
  private readonly logger = new RegleauLogger('StatisticService');

  constructor(@InjectRepository(Statistic)
              private readonly statisticRepository: Repository<Statistic>,
              private readonly departementService: DepartementService) {
  }

  async computeDepartementsSituation(zonesComputed: ZoneAlerteComputed[], date?: string) {
    this.logger.log(`COMPUTING DEPARTEMENT SITUATION - ${date}`);
    const departements = await this.departementService.findAllLight();
    const dateString = date ? date : new Date().toISOString().split('T')[0];
    let statistic: Statistic = await this.statisticRepository.findOne({
      where: {
        date: dateString,
      },
    });
    if (!statistic) {
      statistic = <Statistic>{
        date: dateString,
        departementSituation: {},
      };
    } else {
      statistic['departementSituation'] = {};
    }
    departements.forEach(d => {
      const depZones = zonesComputed.filter(z => z.departement.code === d.code);
      statistic.departementSituation[d.code] = {
        max: depZones.length > 0 ? Utils.getNiveauInversed(max(depZones.map(z => Utils.getNiveau(z.restriction?.niveauGravite)))) : null,
        sup: depZones.filter(z => z.type === 'SUP').length > 0 ? Utils.getNiveauInversed(max(depZones.filter(z => z.type === 'SUP').map(z => Utils.getNiveau(z.restriction?.niveauGravite)))) : null,
        sou: depZones.filter(z => z.type === 'SOU').length > 0 ? Utils.getNiveauInversed(max(depZones.filter(z => z.type === 'SOU').map(z => Utils.getNiveau(z.restriction?.niveauGravite)))) : null,
        aep: depZones.filter(z => z.type === 'AEP').length > 0 ? Utils.getNiveauInversed(max(depZones.filter(z => z.type === 'AEP').map(z => Utils.getNiveau(z.restriction?.niveauGravite)))) : null,
      };
    });

    await this.statisticRepository.save(statistic);
  }

  async computeDepartementsSituationHistoric(zones: ZoneAlerte[], dateString: string) {
    this.logger.log(`COMPUTING DEPARTEMENT SITUATION - ${dateString}`);
    const departements = await this.departementService.findAllLight();
    let statistic: Statistic = await this.statisticRepository.findOne({
      where: {
        date: dateString,
      },
    });
    if (!statistic) {
      statistic = <Statistic>{
        date: dateString,
        departementSituation: {},
      };
    } else {
      statistic['departementSituation'] = {};
    }
    departements.forEach(d => {
      const depZones = zones.filter(z => z.departement.code === d.code);
      statistic.departementSituation[d.code] = {
        max: depZones.length > 0 ? Utils.getNiveauInversed(max(depZones.map(z => Utils.getNiveau(z.restrictions[0]?.niveauGravite)))) : null,
        sup: depZones.filter(z => z.type === 'SUP').length > 0 ? Utils.getNiveauInversed(max(depZones.filter(z => z.type === 'SUP').map(z => Utils.getNiveau(z.restrictions[0]?.niveauGravite)))) : null,
        sou: depZones.filter(z => z.type === 'SOU').length > 0 ? Utils.getNiveauInversed(max(depZones.filter(z => z.type === 'SOU').map(z => Utils.getNiveau(z.restrictions[0]?.niveauGravite)))) : null,
        aep: null,
      };
    });

    await this.statisticRepository.save(statistic);
  }

}
