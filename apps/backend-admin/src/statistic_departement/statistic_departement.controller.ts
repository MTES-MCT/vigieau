import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StatisticDepartementService } from './statistic_departement.service';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import { StatisticDepartement } from '@shared/entities/statistic_departement.entity';
import type { Response } from 'express';

@UseGuards(AuthenticatedGuard)
@Controller('statistic_departement')
@ApiTags('Statistiques par département')
export class StatisticDepartementController {
  constructor(
    private readonly statisticDepartementService: StatisticDepartementService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Retourne les statistiques des départements associés',
  })
  @ApiResponse({
    status: 201,
    type: [StatisticDepartement],
  })
  async findAll(
    @Req() req,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StatisticDepartement[]> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const statisticDepartements: StatisticDepartement[] =
      await this.statisticDepartementService.findAll(req.session.user);
    return plainToInstance(
      StatisticDepartement,
      camelcaseKeys(statisticDepartements, { deep: true }),
    );
  }
}
