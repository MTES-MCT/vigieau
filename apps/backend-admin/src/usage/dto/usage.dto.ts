import { IsBoolean, IsNumber, IsObject, IsString } from 'class-validator';
import { ThematiqueDto } from '../../thematique/dto/thematique.dto';
import { ApiProperty } from '@nestjs/swagger';

export class UsageDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;

  @IsString()
  @ApiProperty({
    example: 'Arrosage des plantes',
    description: "Nom de l'usage",
  })
  nom: string;

  @IsObject()
  @ApiProperty({ type: ThematiqueDto })
  thematique: ThematiqueDto;

  @IsBoolean()
  @ApiProperty({
    example: true,
    description: 'Est-ce que cet usage est un modèle (Guide Sécheresse) ?',
  })
  isTemplate: boolean;

  @IsBoolean()
  @ApiProperty({
    example: true,
    description: 'Modèle - Est-ce que cet usage concerne les particuliers ?',
  })
  concerneParticulier: boolean;

  @IsBoolean()
  @ApiProperty({
    example: true,
    description: 'Modèle - Est-ce que cet usage concerne les entreprises ?',
  })
  concerneEntreprise: boolean;

  @IsBoolean()
  @ApiProperty({
    example: true,
    description: 'Modèle - Est-ce que cet usage concerne les collectivités ?',
  })
  concerneCollectivite: boolean;

  @IsBoolean()
  @ApiProperty({
    example: true,
    description:
      'Modèle - Est-ce que cet usage concerne les exploitations agricoles ?',
  })
  concerneExploitation: boolean;

  @IsBoolean()
  @ApiProperty({
    example: true,
    description:
      'Modèle - Est-ce que cet usage concerne les eaux souterraines ?',
  })
  concerneEso: boolean;

  @IsBoolean()
  @ApiProperty({
    example: true,
    description:
      'Modèle - Est-ce que cet usage concerne les eaux superficielles ?',
  })
  concerneEsu: boolean;

  @IsBoolean()
  @ApiProperty({
    example: true,
    description: "Modèle - Est-ce que cet usage concerne l'eau potableZ ?",
  })
  concerneAep: boolean;

  @IsString()
  @ApiProperty({
    example: 'Pas de restrictions',
    description:
      'Modèle - Description des restrictions en situation de vigilance',
  })
  descriptionVigilance: string;

  @IsString()
  @ApiProperty({
    example: 'Pas de restrictions',
    description: "Modèle - Description des restrictions en situation d'alerte",
  })
  descriptionAlerte: string;

  @IsString()
  @ApiProperty({
    example: 'Interdiction de 8h à 20h',
    description:
      "Modèle - Description des restrictions en situation d'alerte renforcée",
  })
  descriptionAlerteRenforcee: string;

  @IsString()
  @ApiProperty({
    example: 'Interdiction totale',
    description: 'Modèle - Description des restrictions en situation de crise',
  })
  descriptionCrise: string;
}
