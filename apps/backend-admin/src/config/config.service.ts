import {Injectable} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {Brackets, Repository} from 'typeorm';
import {Config} from '@shared/entities/config.entity';

@Injectable()
export class ConfigService {

    constructor(
        @InjectRepository(Config)
        private readonly configRepository: Repository<Config>,
    ) {
        this.initConfig();
    }

    async initConfig() {
        const count = await this.configRepository.count();
        if (count > 0) {
            return;
        }
        await this.configRepository.save({});
    }

    getConfig() {
        return this.configRepository.findOne({where: {id: 1}});
    }

    async setConfig(computeMapDate?: string, computeStatsDate?: string, computeZoneAlerteComputedDate?: Date, force?: boolean) {
        if (computeMapDate) {
            const qb = this.configRepository.createQueryBuilder()
                .update()
                .set({computeMapDate})
                .where('id = 1');
            if (!force) {
                qb.andWhere(new Brackets(qb => {
                    qb.where("computeMapDate > :computeMapDate", {computeMapDate})
                        .orWhere("computeMapDate IS NULL");
                }));
            }
            await qb.execute();
        }

        if (computeStatsDate) {
            const qb = this.configRepository.createQueryBuilder()
                .update()
                .set({computeStatsDate})
                .where('id = 1');
            if (!force) {
                qb.andWhere(new Brackets(qb => {
                    qb.where("computeStatsDate > :computeStatsDate", {computeStatsDate})
                        .orWhere("computeStatsDate IS NULL");
                }));
            }
            await qb.execute();
        }

        if (computeZoneAlerteComputedDate) {
            const qb = this.configRepository.createQueryBuilder()
                .update()
                .set({computeZoneAlerteComputedDate})
                .where('id = 1');
            if (!force) {
                qb.andWhere(new Brackets(qb => {
                    qb.where("computeZoneAlerteComputedDate < :computeZoneAlerteComputedDate", {computeZoneAlerteComputedDate})
                        .orWhere("computeZoneAlerteComputedDate IS NULL");
                }));
            }
            await qb.execute();
        }
    }

    async resetConfig() {
        return this.configRepository.update({id: 1}, {
            computeMapDate: null,
            computeStatsDate: null,
        });
    }
}