import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restriction } from '@shared/entities/restriction.entity';
import { RestrictionService } from './restriction.service';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Restriction]),
    UsageModule,
  ],
  controllers: [],
  providers: [RestrictionService],
  exports: [RestrictionService],
})
export class RestrictionModule {
}
