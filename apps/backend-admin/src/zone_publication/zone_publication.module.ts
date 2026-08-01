import { Module } from '@nestjs/common';
import { ZonePublicationService } from './zone_publication.service';
import { ZonePublicationController } from './zone_publication.controller';
import { ZonePublicationOperatorService } from './zone_publication_operator.service';

@Module({
  controllers: [ZonePublicationController],
  providers: [ZonePublicationService, ZonePublicationOperatorService],
  exports: [ZonePublicationService],
})
export class ZonePublicationModule {}
