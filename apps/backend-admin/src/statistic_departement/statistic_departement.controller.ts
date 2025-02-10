import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StatisticDepartementService } from './statistic_departement.service';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import { StatisticDepartement } from './entities/statistic_departement.entity';

@UseGuards(AuthenticatedGuard)
@Controller('statistic_departement')
@ApiTags('Statistiques par département')
export class StatisticDepartementController {
  constructor(private readonly statisticDepartementService: StatisticDepartementService) {
  }

  @Get()
  @ApiOperation({ summary: 'Retourne les statistiques des départements associés' })
  @ApiResponse({
    status: 201,
    type: [StatisticDepartement],
  })
  async findAll(@Req() req): Promise<StatisticDepartement[]> {
    const statisticDepartements: StatisticDepartement[] = this.statisticDepartementService.findAll(req.session.user);
    return plainToInstance(
      StatisticDepartement,
      camelcaseKeys(statisticDepartements, { deep: true }),
    );
  }
}