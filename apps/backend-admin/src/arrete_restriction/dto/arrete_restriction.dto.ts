import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FilterOperator, PaginateConfig } from 'nestjs-paginate';
import { ArreteRestriction } from '../entities/arrete_restriction.entity';
import { DepartementDto } from '../../departement/dto/departement.dto';
import { ZoneAlerteDto } from '../../zone_alerte/dto/zone_alerte.dto';
import { RestrictionDto } from '../../restriction/dto/restriction.dto';

export class ArreteRestrictionDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;

  @IsString()
  @ApiProperty({
    example: 'AR_0',
    description: "Numéro de l'arrêté de restriction",
  })
  numero: string;

  @IsString()
  @ApiProperty({
    example: '01/01/2024',
    description: "Date de début de validité de l'arrêté de restriction",
  })
  dateDebut: string;

  @IsString()
  @ApiProperty({
    example: '31/12/2024',
    description: "Date de fin de validité de l'arrêté de restriction",
  })
  dateFin: string;

  @IsString()
  @ApiProperty({
    example: '25/12/2023',
    description: "Date de signature de l'arrêté de restriction",
  })
  dateSignature: string;

  @IsBoolean()
  @ApiProperty({
    example: false,
    description:
      "Des niveaux de gravité spécifiques vont-ils être définis pour l'AEP ?",
  })
  niveauGraviteSpecifiqueEap: boolean;

  @IsString()
  @IsIn(['esu', 'eso', 'max'])
  @ApiProperty({
    example: 'max',
    description:
      "Si niveau niveauGraviteSpecifiqueEap = false, quelle ressource sera utilisée pour communiquer sur l'AEP ?",
  })
  ressourceEapCommunique: 'esu' | 'eso' | 'max';

  @IsObject()
  departement: DepartementDto;

  @IsArray()
  @ApiProperty({ type: [ZoneAlerteDto] })
  zonesAlerte: ZoneAlerteDto[];

  @IsArray()
  @ApiProperty({ type: [RestrictionDto] })
  restrictions: RestrictionDto[];

  @IsObject()
  @ApiProperty({ type: ArreteRestrictionDto })
  arreteRestrictionAbroge: ArreteRestrictionDto;
}

export const arreteRestrictionPaginateConfig: PaginateConfig<ArreteRestriction> =
  {
    select: [
      'id',
      'numero',
      'statut',
      'dateDebut',
      'dateFin',
      'dateSignature',
      'arretesCadre.id',
      'arretesCadre.numero',
      'departement.id',
      'departement.code',
      'departement.nom',
      'restrictions.id',
      'restrictions.zoneAlerte.id',
      'restrictions.zoneAlerte.disabled',
    ],
    sortableColumns: ['dateDebut'],
    defaultSortBy: [['dateDebut', 'DESC']],
    nullSort: 'first',
    relations: [
      'arretesCadre',
      'departement',
      'restrictions',
      'restrictions.zoneAlerte',
    ],
    searchableColumns: [
      'numero',
      'arretesCadre.numero',
      'departement.nom',
      'departement.code',
    ],
    filterableColumns: {
      statut: [FilterOperator.IN],
      'departement.id': [FilterOperator.EQ],
    },
  };
