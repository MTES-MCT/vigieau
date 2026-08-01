import { Module } from '@nestjs/common';
import { ZonePublicationService } from './zone_publication.service';

@Module({
  providers: [ZonePublicationService],
  exports: [ZonePublicationService],
})
export class ZonePublicationModule {}
