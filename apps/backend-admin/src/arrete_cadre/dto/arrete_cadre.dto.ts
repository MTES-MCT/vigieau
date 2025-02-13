import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsString,
} from 'class-validator';
import { DepartementDto } from '../../departement/dto/departement.dto';
import { ZoneAlerteDto } from '../../zone_alerte/dto/zone_alerte.dto';
import { ArreteRestrictionDto } from '../../arrete_restriction/dto/arrete_restriction.dto';
import { FilterOperator, PaginateConfig } from 'nestjs-paginate';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { ApiProperty } from '@nestjs/swagger';
import { FichierDto } from '../../fichier/dto/fichier.dto';
import { Usage } from '@shared/entities/usage.entity';
import { UsageDto } from '../../usage/dto/usage.dto';

export class ArreteCadreDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;

  @IsString()
  @ApiProperty({ example: 'AC_0', description: "Numéro de l'arrêté cadre" })
  numero: string;

  @IsString()
  @ApiProperty({
    example: '01/01/2024',
    description: "Date de début de validité de l'arrêté cadre",
  })
  dateDebut: string;

  @IsString()
  @ApiProperty({
    example: '31/12/2024',
    description: "Date de fin de validité de l'arrêté cadre",
  })
  dateFin: string;

  @IsObject()
  @ApiProperty({ type: FichierDto })
  fichier: FichierDto;

  @IsObject()
  @ApiProperty({ type: DepartementDto })
  departementPilote: DepartementDto;

  @IsArray()
  @ApiProperty({ type: [DepartementDto] })
  departements: DepartementDto[];

  @IsArray()
  @ApiProperty({ type: [ZoneAlerteDto] })
  zonesAlerte: ZoneAlerteDto[];

  @IsArray()
  @ApiProperty({ type: [UsageDto] })
  usages: Usage[];

  @IsArray()
  @ApiProperty({ type: [ArreteRestrictionDto] })
  arretesRestriction: ArreteRestrictionDto[];

  @IsObject()
  @ApiProperty({ type: ArreteCadreDto })
  arreteCadreAbroge: ArreteCadreDto;
}

export const arreteCadrePaginateConfig: PaginateConfig<ArreteCadre> = {
  select: [
    'id',
    'numero',
    'dateDebut',
    'dateFin',
    'statut',
    'arretesRestriction.id',
    'arretesRestriction.numero',
    'arretesRestriction.statut',
    'arretesRestriction.departement.id',
    'arretesRestriction.departement.code',
    'zonesAlerte.id',
    'zonesAlerte.disabled',
  ],
  sortableColumns: ['dateDebut'],
  defaultSortBy: [['dateDebut', 'DESC']],
  nullSort: 'first',
  relations: [
    'zonesAlerte',
    'departements',
    'arretesRestriction',
    'arretesRestriction.departement',
    'departementPilote',
  ],
  searchableColumns: ['numero', 'departements.nom', 'departements.code'],
  filterableColumns: {
    statut: [FilterOperator.IN],
    'departements.id': [FilterOperator.EQ],
  },
};
