import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ZonesService } from '../zones/zones.service';

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly zonesService: ZonesService) {}

  @Get('live')
  @ApiOperation({ summary: "Vérifier que le processus de l'API est vivant" })
  live() {
    return { status: 'ok' as const };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Vérifier que le cache des zones est exploitable' })
  @ApiResponse({ status: 200, description: 'Le cache est prêt.' })
  @ApiResponse({ status: 503, description: "Le cache n'est pas prêt." })
  async ready() {
    const cacheStatus = await this.zonesService.getCacheStatus(true);
    if (!cacheStatus.usable) {
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
