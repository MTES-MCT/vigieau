import {
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ZonesService } from './zones.service';
import { ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import {
  FindZonesQueryDto,
  ZoneDto,
  ZonePublicationDto,
  ZonePublicationQueryDto,
  ZonesWithAvailabilityDto,
} from './dto/zone.dto';

@Controller('zones')
export class ZonesController {
  constructor(private readonly zonesService: ZonesService) {}

  @Get()
  @ApiOperation({
    summary:
      "Récupérer les zones d'alertes et leurs restrictions associées à un adresse ou une commune",
  })
  @ApiResponse({
    status: 201,
    type: ZoneDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Les paramètres lon/lat ou commune sont requis ou invalides.',
  })
  @ApiResponse({
    status: 404,
    description: 'Aucune zone d’alerte sur cette commune.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Plusieurs zones de même type présentes sur une commune, utilisez les lon / lat.',
  })
  @ApiResponse({
    status: 500,
    description:
      'Plusieurs zones de même type présentes, impossible de renvoyer des restrictions cohérentes.',
  })
  @ApiResponse({
    status: 410,
    description: "La publication demandée n'est plus disponible.",
  })
  @ApiQuery({
    name: 'lon',
    description: 'Longitude (obligatoire si pas de commune)',
    required: false,
  })
  @ApiQuery({
    name: 'lat',
    description: 'Latitude (obligatoire si pas de commune)',
    required: false,
  })
  @ApiQuery({
    name: 'commune',
    description: 'Code commune INSEE (obligatoire si pas de lon / lat)',
    required: false,
  })
  @ApiQuery({
    name: 'profil',
    description: 'Profil (optionnel)',
    enum: ['particulier', 'entreprise', 'collectivité', 'exploitation'],
    required: false,
  })
  @ApiQuery({
    name: 'zoneType',
    description: 'Type de zone (optionnel)',
    enum: ['AEP', 'SUP', 'SOU'],
    required: false,
  })
  @ApiQuery({
    name: 'publicationId',
    description: 'Identifiant de publication versionnée (optionnel)',
    required: false,
  })
  async findAll(@Query() query: FindZonesQueryDto): Promise<any[]> {
    return this.zonesService.find(
      query.lon,
      query.lat,
      query.commune,
      query.profil,
      query.zoneType,
      query.publicationId,
    );
  }

  @Get('v2')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      "Récupérer les zones et la disponibilité certifiée des données par type d'eau",
  })
  @ApiResponse({ status: 200, type: ZonesWithAvailabilityDto })
  async findAllV2(
    @Query() query: FindZonesQueryDto,
  ): Promise<ZonesWithAvailabilityDto> {
    return this.zonesService.findWithAvailability(
      query.lon,
      query.lat,
      query.commune,
      query.profil,
      query.zoneType,
      query.publicationId,
    );
  }

  @Get('publication')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Récupérer la publication active des zones' })
  @ApiResponse({
    status: 404,
    description: "Aucune publication versionnée n'est encore disponible.",
  })
  @ApiResponse({ status: 200, type: ZonePublicationDto })
  async getPublication(): Promise<ZonePublicationDto> {
    return this.zonesService.getPublication();
  }

  @Get(':id')
  @ApiOperation({ summary: "Récupérer une zone d'alerte" })
  @ApiResponse({
    status: 201,
    type: ZoneDto,
  })
  @ApiResponse({ status: 404, description: 'NOT FOUND' })
  @ApiQuery({
    name: 'publicationId',
    description: 'Identifiant de publication versionnée (optionnel)',
    required: false,
  })
  @ApiResponse({ status: 410, description: 'Publication indisponible.' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ZonePublicationQueryDto,
  ): Promise<any> {
    return this.zonesService.findOne(id, query.publicationId);
  }

  @Get('departement/:depCode')
  @ApiOperation({ summary: "Récupérer les zones d'alerte d'un département" })
  @ApiQuery({
    name: 'publicationId',
    description: 'Identifiant de publication versionnée (optionnel)',
    required: false,
  })
  @ApiResponse({
    status: 201,
    type: ZoneDto,
  })
  @ApiResponse({ status: 404, description: 'NOT FOUND' })
  @ApiResponse({ status: 410, description: 'Publication indisponible.' })
  async findByDepartement(
    @Param('depCode') depCode: string,
    @Query() query: ZonePublicationQueryDto,
  ): Promise<any> {
    return this.zonesService.findByDepartement(depCode, query.publicationId);
  }
}
