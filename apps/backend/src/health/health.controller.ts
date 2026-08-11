import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DataService } from '../data/data.service';
import { ZonesService } from '../zones/zones.service';

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly zonesService: ZonesService,
    private readonly dataService: DataService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: "Vérifier que le processus de l'API est vivant" })
  live() {
    return { status: 'ok' as const };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Vérifier que les caches publics sont exploitables',
  })
  @ApiResponse({ status: 200, description: 'Les caches sont prêts.' })
  @ApiResponse({ status: 503, description: "Un cache n'est pas prêt." })
  async ready() {
    const [cacheStatus, statisticStatus] = await Promise.all([
      this.zonesService.getCacheStatus(true),
      this.dataService.getStatisticCacheStatus(true),
    ]);
    if (!cacheStatus.usable) {
      throw new HttpException(cacheStatus, HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (!statisticStatus.usable) {
      throw new HttpException(statisticStatus, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return cacheStatus;
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Consulter le diagnostic du cache statistique' })
  @ApiResponse({ status: 200, description: 'Le cache statistique est frais.' })
  @ApiResponse({
    status: 503,
    description: "Le cache statistique n'est pas frais.",
  })
  async statistics() {
    const cacheStatus = await this.dataService.getStatisticCacheStatus(true);
    if (!cacheStatus.fresh) {
      throw new HttpException(cacheStatus, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return cacheStatus;
  }

  @Get('cache')
  @ApiOperation({ summary: 'Consulter le diagnostic du cache des zones' })
  @ApiResponse({ status: 200, description: 'Le cache est frais.' })
  @ApiResponse({ status: 503, description: "Le cache n'est pas frais." })
  async cache() {
    const cacheStatus = await this.zonesService.getCacheStatus(true);
    if (!cacheStatus.fresh) {
      throw new HttpException(cacheStatus, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return cacheStatus;
  }
}
