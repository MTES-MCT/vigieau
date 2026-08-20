import { ApiProperty } from '@nestjs/swagger';
import { ArreteDto } from './arrete.dto';
import { UsageDto } from './usage.dto';
import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class ZoneDto {
  @ApiProperty({ example: 1, description: "Id de la zone d'alerte" })
  id: number;

  @ApiProperty({ example: 1, description: "Id SANDRE de la zone d'alerte" })
  idSandre: number;

  @ApiProperty({
    example: 1,
    description: "Id SANDRE de la zone d'alerte - ISO SANDRE",
  })
  gid: number;

  @ApiProperty({
    example: '01_ZONE_SUP',
    description: "Code de la zone d'alerte",
  })
  code: string;

  @ApiProperty({
    example: '01_ZONE_SUP',
    description: "Code de la zone d'alerte - ISO SANDRE",
  })
  CdZAS: string;

  @ApiProperty({
    example: 'Zone superficielle en aval de la rivière',
    description: "Nom de la zone d'alerte",
  })
  nom: string;

  @ApiProperty({
    example: 'Zone superficielle en aval de la rivière',
    description: "Nom de la zone d'alerte - ISO SANDRE",
  })
  LbZAS: string;

  @ApiProperty({
    enum: ['AEP', 'SOU', 'SUP'],
    example: 'SUP',
    description:
      "Type de la zone d'alerte (SOU / eau souterraine, SUP / eau superficielle ou AEP / eau potable)",
  })
  type: string;

  @ApiProperty({
    enum: ['AEP', 'SOU', 'SUP'],
    example: 'SUP',
    description:
      "Type de la zone d'alerte (SOU / eau souterraine, SUP / eau superficielle ou AEP / eau potable) - ISO SANDRE",
  })
  TypeZAS: string;

  @ApiProperty({
    example: true,
    description: 'Cette ressource naturelle est-elle influencée / stockée ?',
  })
  ressourceInfluencee: boolean;

  @ApiProperty({
    enum: ['vigilance', 'alerte', 'alerte_renforcee', 'crise'],
    example: 'alerte_renforcee',
    description: "Niveau de gravité de la zone d'alerte",
  })
  niveauGravite: string;

  @ApiProperty({ example: '01', description: 'Code du département' })
  departement: string;

  @ApiProperty()
  arrete: ArreteDto;

  @ApiProperty({
    example: 'https://example.com/arrete.pdf',
    description: "Lien du PDF de l'arrêté municipal",
  })
  arreteMunicipalCheminFichier: string;

  @ApiProperty({ type: [UsageDto] })
  usages: UsageDto[];
}

export class FindZonesQueryDto {
  @IsOptional()
  @IsLongitude()
  lon?: string;

  @IsOptional()
  @IsLatitude()
  lat?: string;

  @IsOptional()
  @IsString()
  commune?: string;

  @IsOptional()
  @IsString()
  profil?: string;

  @IsOptional()
  @IsString()
  zoneType?: string;

  @IsOptional()
  @IsUUID()
  publicationId?: string;
}

export class ZonePublicationQueryDto {
  @IsOptional()
  @IsUUID()
  publicationId?: string;
}

export class ZonePublicationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: '42' })
  revision: string;

  @ApiProperty({ nullable: true })
  geojsonUrl: string | null;

  @ApiProperty({ nullable: true })
  geojsonChecksum: string | null;

  @ApiProperty({ nullable: true })
  pmtilesUrl: string | null;

  @ApiProperty({ nullable: true })
  pmtilesChecksum: string | null;

  @ApiProperty({ nullable: true, required: false })
  contentFingerprint?: string;

  @ApiProperty({ example: 123 })
  zoneCount: number;
}

export type ZoneAvailabilityStatus =
  | 'available'
  | 'confirmed_none'
  | 'unavailable';

export type ZoneAvailabilityFreshness = 'current' | 'updating';

export class ZoneTypeAvailabilityDto {
  @ApiProperty({
    enum: ['available', 'confirmed_none', 'unavailable'],
    example: 'available',
  })
  status: ZoneAvailabilityStatus;

  @ApiProperty({ nullable: true, required: false })
  asOf?: string | null;

  @ApiProperty({ nullable: true, required: false })
  sourceRevision?: string | null;

  @ApiProperty({
    enum: ['current', 'updating'],
    required: false,
    example: 'updating',
  })
  freshness?: ZoneAvailabilityFreshness;

  @ApiProperty({ nullable: true, required: false })
  pendingSince?: string | null;

  @ApiProperty({ nullable: true, required: false })
  officialUrl?: string | null;
}

export class ZonesWithAvailabilityDto {
  @ApiProperty({ type: [ZoneDto] })
  zones: ZoneDto[];

  @ApiProperty({
    additionalProperties: {
      $ref: '#/components/schemas/ZoneTypeAvailabilityDto',
    },
  })
  availability: Record<'AEP' | 'SUP' | 'SOU', ZoneTypeAvailabilityDto>;
}
