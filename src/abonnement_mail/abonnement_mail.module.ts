import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AbonnementMail } from './entities/abonnement_mail.entity';
import { AbonnementMailService } from './abonnement_mail.service';

@Module({
  imports: [TypeOrmModule.forFeature([AbonnementMail])],
  providers: [AbonnementMailService],
  exports: [AbonnementMailService],
  controllers: [],
})
export class AbonnementMailModule {}
