import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { CommunesModule } from '../communes/communes.module';
import { HttpModule } from '@nestjs/axios';
import { ZonesModule } from '../zones/zones.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AbonnementMail } from '@shared/entities/abonnement_mail.entity';
import { BrevoModule } from '../brevo/brevo.module';
import { MattermostModule } from '../mattermost/mattermost.module';
import { CronModule } from '../cron/cron.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AbonnementMail]),
    CommunesModule,
    HttpModule,
    ZonesModule,
    BrevoModule,
    MattermostModule,
    CronModule
  ],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {
}
