import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
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
}
