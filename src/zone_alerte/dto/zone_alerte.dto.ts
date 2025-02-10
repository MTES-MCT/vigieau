import {
  IsArray,
  IsBoolean,
  IsJSON,
  IsNumber,
  IsObject, IsOptional,
  IsString, ValidateNested,
} from 'class-validator';
import { DepartementDto } from '../../departement/dto/departement.dto';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CommuneDto } from '../../commune/dto/commune.dto';

export class ZoneAlerteDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;

  @IsString()
  @ApiProperty({ example: 'ZA_01', description: "Code de la zone d'alerte" })
  code: string;

  @IsString()
  @ApiProperty({
    example: 'SUP',
    description: "Type de la zone d'alerte",
    enum: ['SUP', 'SOU'],
  })
  type: string;

  @IsBoolean()
  @ApiProperty({
    example: false,
    description: "Est-ce que la zone d'alerte est une ressource stockéee / regulée ?",
  })
  ressourceInfluencee: boolean;

  @IsString()
  @ApiProperty({
    example: 'Zone superficielle Ain 01',
    description: "Nom de la zone d'alerte",
  })
  nom: string;

  @IsNumber()
  @ApiProperty({
    example: 1,
    description: "Numéro de version de la zone d'alerte",
  })
  numeroVersion: number;

  @IsBoolean()
  @ApiProperty({
    example: false,
    description: "Est-ce que la zone d'alerte est désactivitée ?",
  })
  disabled: boolean;

  @IsObject()
  departement: DepartementDto;

  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  @Type(() => CommuneDto)
  @ApiProperty({ type: [CommuneDto] })
  communes: CommuneDto[];
}

export class ZoneAlertGeomDto extends ZoneAlerteDto {
  @IsJSON()
  @ApiProperty({
    example: '',
    description: "Geojson compressé de la zone d'alerte",
  })
  geom: any;
}
