import {Controller, Get, Param, Req, UseGuards} from '@nestjs/common';
import {ZoneAlerteService} from './zone_alerte.service';
import {ApiOperation, ApiResponse, ApiTags} from '@nestjs/swagger';
import {ZoneAlerte} from '@shared/entities/zone_alerte.entity';
import {plainToInstance} from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import {ZoneAlerteDto, ZoneAlertGeomDto} from './dto/zone_alerte.dto';
import {AuthenticatedGuard} from '../core/guards/authenticated.guard';

@UseGuards(AuthenticatedGuard)
@Controller('zone-alerte')
@ApiTags("Zones d'alertes")
export class ZoneAlerteController {
    constructor(private readonly zoneAlerteService: ZoneAlerteService) {
    }

    @Get('/arrete-cadre/:id')
    @ApiOperation({
        summary:
            "Retourne toute les zones d'alerte avec leurs géométries d'un arrêté cadre",
    })
    @ApiResponse({
        status: 201,
        type: [ZoneAlertGeomDto],
    })
    async findByArreteCadreId(
        @Param('id') arId: string,
    ): Promise<ZoneAlertGeomDto[]> {
        const zonesAlerte: ZoneAlerte[] =
            await this.zoneAlerteService.findByArreteCadre(+arId);
        return plainToInstance(
            ZoneAlertGeomDto,
            camelcaseKeys(zonesAlerte, {deep: true}),
        );
    }

    @Get('/date')
    @ApiOperation({
        summary: "Retourne la dernière date de mise à jour des zones d'alerte par rapport au scope de l'utilisateur",
    })
    @ApiResponse({
        status: 201,
        type: String,
    })
    async getMaxUpdatedDate(@Req() req): Promise<string> {
        return await this.zoneAlerteService.getMaxUpdatedDate(req.session.user);
    }

    @Get(':departementCode')
    @ApiOperation({
        summary: "Retourne toute les zones d'alerte d'un département",
    })
    @ApiResponse({
        status: 201,
        type: [ZoneAlerteDto],
    })
    async findByDepartement(
        @Param('departementCode') departementCode: string,
    ): Promise<ZoneAlerteDto[]> {
        const zonesAlerte: ZoneAlerte[] =
            await this.zoneAlerteService.findByDepartement(departementCode);
        return plainToInstance(
            ZoneAlerteDto,
            camelcaseKeys(zonesAlerte, {deep: true}),
        );
    }
}
