import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import { Roles } from '../core/decorators/roles.decorator';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { HistoricBackfillArtifactQueueService } from './historic-backfill-artifact-queue.service';
import { HistoricBackfillFinalizerService } from './historic-backfill-finalizer.service';
import { HistoricBackfillMapFinalizerService } from './historic-backfill-map-finalizer.service';
import { HistoricBackfillQueueService } from './historic-backfill-queue.service';
import { isHistoricBackfillEnabled } from './historic-backfill.config';

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class PrepareHistoricBackfillDto {
  @Matches(CIVIL_DATE_PATTERN)
  @IsISO8601({ strict: true })
  mapDateFrom: string;

  @Matches(CIVIL_DATE_PATTERN)
  @IsISO8601({ strict: true })
  statisticDateFrom: string;

  @Matches(CIVIL_DATE_PATTERN)
  @IsISO8601({ strict: true })
  dateThrough: string;
}

export class HistoricBackfillRunParamsDto {
  @IsUUID()
  runId: string;
}

export class FinalizeHistoricBackfillDto {
  @IsOptional()
  @IsBoolean()
  apply?: boolean;
}

export class BuildHistoricBackfillShadowDto {
  @IsInt()
  @Min(1)
  departementId: number;

  @IsString()
  @Matches(/^\d+$/)
  departmentGeneration: string;
}

@UseGuards(AuthenticatedGuard, RolesGuard)
@Controller('historic-backfill')
export class HistoricBackfillController {
  constructor(
    private readonly queue: HistoricBackfillQueueService,
    private readonly artifactQueue: HistoricBackfillArtifactQueueService,
    private readonly statisticsFinalizer: HistoricBackfillFinalizerService,
    private readonly mapFinalizer: HistoricBackfillMapFinalizerService,
  ) {}

  @Post('prepare')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Préparer une reconstruction historique' })
  prepare(@Body() input: PrepareHistoricBackfillDto) {
    this.assertEnabled();
    return this.queue.prepare(input);
  }

  @Get(':runId')
  @Roles(['mte'])
  @ApiOperation({ summary: "Consulter l'état d'une reconstruction historique" })
  status(@Param() params: HistoricBackfillRunParamsDto) {
    return this.queue.status(params.runId);
  }

  @Post(':runId/pause')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Suspendre une reconstruction historique' })
  pause(@Param() params: HistoricBackfillRunParamsDto) {
    this.assertEnabled();
    return this.queue.pause(params.runId);
  }

  @Post(':runId/resume')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Reprendre une reconstruction historique' })
  resume(@Param() params: HistoricBackfillRunParamsDto) {
    this.assertEnabled();
    return this.queue.resume(params.runId);
  }

  @Post(':runId/artifacts/prepare')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Préparer les artefacts historiques nationaux' })
  prepareArtifacts(@Param() params: HistoricBackfillRunParamsDto) {
    this.assertEnabled();
    return this.artifactQueue.prepare(params.runId);
  }

  @Post(':runId/shadow/build')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Construire la table miroir des statistiques' })
  buildShadow(@Param() params: HistoricBackfillRunParamsDto) {
    this.assertEnabled();
    return this.statisticsFinalizer.buildShadow(params.runId);
  }

  @Post(':runId/shadow/department/build')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Reconstruire le miroir d’un département' })
  buildDepartmentShadow(
    @Param() params: HistoricBackfillRunParamsDto,
    @Body() input: BuildHistoricBackfillShadowDto,
  ) {
    this.assertEnabled();
    return this.statisticsFinalizer.buildDepartmentShadow({
      runId: params.runId,
      departementId: input.departementId,
      departmentGeneration: input.departmentGeneration,
    });
  }

  @Post(':runId/statistics/finalize')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Vérifier ou publier les statistiques historiques' })
  finalizeStatistics(
    @Param() params: HistoricBackfillRunParamsDto,
    @Body() input: FinalizeHistoricBackfillDto = {},
  ) {
    this.assertEnabled();
    return this.statisticsFinalizer.finalizeStatistics(
      params.runId,
      input.apply === true,
    );
  }

  @Post(':runId/maps/finalize')
  @Roles(['mte'])
  @ApiOperation({ summary: 'Vérifier ou publier les cartes historiques' })
  finalizeMaps(
    @Param() params: HistoricBackfillRunParamsDto,
    @Body() input: FinalizeHistoricBackfillDto = {},
  ) {
    this.assertEnabled();
    return input.apply
      ? this.mapFinalizer.apply(params.runId)
      : this.mapFinalizer.dryRun(params.runId);
  }

  private assertEnabled(): void {
    if (!isHistoricBackfillEnabled()) {
      throw new ServiceUnavailableException(
        'Historic backfill is disabled by configuration',
      );
    }
  }
}
