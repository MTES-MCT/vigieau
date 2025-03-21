import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ZonesService } from './zones.service';
import { ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { FindZonesQueryDto, ZoneDto } from './dto/zone.dto';

@Controller('zones')
export class ZonesController {
  constructor(private readonly zonesService: ZonesService) {
  }

  @Get()
  @ApiOperation({ summary: 'Récupérer les zones d\'alertes et leurs restrictions associées à un adresse ou une commune' })
  @ApiResponse({
    status: 201,
    type: ZoneDto,
  })
  @ApiResponse({ status: 400, description: 'Les paramètres lon/lat ou commune sont requis ou invalides.' })
  @ApiResponse({ status: 404, description: 'Aucune zone d’alerte sur cette commune.' })
  @ApiResponse({
    status: 409,
    description: 'Plusieurs zones de même type présentes sur une commune, utilisez les lon / lat.',
  })
  @ApiResponse({
    status: 500,
    description: 'Plusieurs zones de même type présentes, impossible de renvoyer des restrictions cohérentes.',
  })
  @ApiQuery({ name: 'lon', description: 'Longitude (obligatoire si pas de commune)', required: false })
  @ApiQuery({ name: 'lat', description: 'Latitude (obligatoire si pas de commune)', required: false })
  @ApiQuery({ name: 'commune', description: 'Code commune INSEE (obligatoire si pas de lon / lat)', required: false })
  @ApiQuery({
    name: 'profil',
    description: 'Profil (optionnel)',
    enum: ['particulier', 'entreprise', 'collectivité', 'exploitation'],
    required: false,
  })
  @ApiQuery({ name: 'zoneType', description: 'Type de zone (optionnel)', enum: ['AEP', 'SUP', 'SOU'], required: false })
  async findAll(@Query() query: FindZonesQueryDto): Promise<any[]> {
    return this.zonesService.find(query.lon, query.lat, query.commune, query.profil, query.zoneType);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer une zone d\'alerte' })
  @ApiResponse({
    status: 201,
    type: ZoneDto,
  })
  @ApiResponse({ status: 404, description: 'NOT FOUND' })
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<any> {
    return this.zonesService.findOne(id);
  }

  @Get('departement/:depCode')
  @ApiOperation({ summary: 'Récupérer les zones d\'alerte d\'un département' })
  @ApiResponse({
    status: 201,
    type: ZoneDto,
  })
  @ApiResponse({ status: 404, description: 'NOT FOUND' })
  async findByDepartement(@Param('depCode') depCode: string): Promise<any> {
    return this.zonesService.findByDepartement(depCode);
  }
}
