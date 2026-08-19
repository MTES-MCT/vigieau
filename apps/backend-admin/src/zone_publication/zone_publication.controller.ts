import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
} from 'class-validator';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { RolesGuard } from '../core/guards/roles.guard';
import { ZonePublicationOperatorService } from './zone_publication_operator.service';

class ZonePublicationRollbackDto {
  @IsOptional()
  @IsUUID()
  publicationId?: string;

  @IsOptional()
  @IsBoolean()
  apply?: boolean;
}

class ConfirmNoAvailableZoneDto {
  @IsString()
  @Matches(/^\s*(?:2[ab]|\d{2,3})\s*$/i)
  departmentCode: string;

  @IsIn(['AEP', 'SOU', 'SUP'])
  zoneType: 'AEP' | 'SOU' | 'SUP';

  @IsString()
  @Matches(/^\d+$/)
  publicRevision: string;

  @IsOptional()
  @Matches(/^https:\/\//i)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  officialUrl?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  asOf?: string;
}

class PublicRevisionModeDto {
  @IsIn(['compatibility', 'separated'])
  mode: 'compatibility' | 'separated';

  @IsOptional()
  @IsBoolean()
  apply?: boolean;
}

@UseGuards(AuthenticatedGuard, RolesGuard)
@Controller('zone-publication')
export class ZonePublicationController {
  constructor(
    private readonly operatorService: ZonePublicationOperatorService,
  ) {}

  @Get('health')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Diagnostiquer la publication des zones' })
  getHealth(): Promise<Record<string, unknown>> {
    return this.operatorService.getOperationalState();
  }

  @Post('rollback')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Préparer ou appliquer un rollback de publication' })
  prepareRollback(@Body() input: ZonePublicationRollbackDto) {
    return this.operatorService.prepareRollback(input);
  }

  @Post('resume')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Reprendre la publication automatique des zones' })
  resumeAutomaticPublishing() {
    return this.operatorService.resumeAutomaticPublishing();
  }

  @Post('availability/confirm-none')
  @Roles(['mte'])
  @ApiOperation({
    summary: "Certifier explicitement l'absence de zones d'un type",
  })
  confirmNoAvailableZone(@Body() input: ConfirmNoAvailableZoneDto) {
    return this.operatorService.confirmNoAvailableZone(input);
  }

  @Post('public-revision-mode')
  @Roles(['mte'])
  @ApiOperation({
    summary:
      'Préparer ou appliquer la bascule de compatibilité de la révision publique',
  })
  setPublicRevisionMode(@Body() input: PublicRevisionModeDto) {
    return this.operatorService.setPublicRevisionMode(input);
  }
}
