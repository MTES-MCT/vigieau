import { IsEmail, IsNumber, IsPhoneNumber, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FilterOperator, PaginateConfig } from 'nestjs-paginate';
import { ArreteMunicipal } from '../entities/arrete_municipal.entity';

class UpdateLinkNestedObjectDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;
}

export class CreateUpdateArreteMunicipalDto {
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

  @IsString()
  @ApiProperty({ example: '[01001, 01002]', description: 'Tableau de communes concernées par l\'arrêté municipal' })
  communes: string;

  @IsString()
  @ApiProperty({ example: 'John', description: 'Prénom de l\'utilisateur qui a crée l\'arrêté municipal' })
  userFirstName: string;

  @IsString()
  @ApiProperty({ example: 'Doe', description: 'Nom de l\'utilisateur qui a crée l\'arrêté municipal' })
  userLastName: string;

  @IsEmail()
  @ApiProperty({ example: 'john.doe@example.com', description: 'Email de l\'utilisateur qui a crée l\'arrêté municipal' })
  userEmail: string;

  @IsPhoneNumber('FR')
  @ApiProperty({ example: '(+33) 1 22 33 44 55', description: 'Numéro de téléphone de l\'utilisateur qui a crée l\'arrêté municipal' })
  userPhone: string;
}

export const arreteMunicipalPaginateConfig: PaginateConfig<ArreteMunicipal> =
  {
    select: [
      'id',
      'statut',
      'dateDebut',
      'dateFin',
      'statut',
      'userFirstName',
      'userLastName',
      'userEmail',
      'communes.id',
      'communes.code',
      'communes.nom',
      'fichier.id',
      'fichier.nom',
      'fichier.url',
      'fichier.size',
    ],
    sortableColumns: ['dateDebut'],
    defaultSortBy: [['dateDebut', 'DESC']],
    nullSort: 'first',
    relations: [
      'communes',
      'fichier',
    ],
    searchableColumns: [],
    filterableColumns: {
      statut: [FilterOperator.IN],
    },
  };