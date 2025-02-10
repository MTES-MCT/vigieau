import { IsNumber, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FichierDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;

  @IsString()
  @ApiProperty({ example: 'exemple.pdf', description: 'Nom du fichier' })
  nom: string;

  @IsString()
  @ApiProperty({
    example: 'http://exemple.com/exemple.fr',
    description: 'Url du fichier',
  })
  url: string;

  @IsString()
  @ApiProperty({ example: 10, description: 'Taille du fichier (en octet)' })
  size: string;
}
