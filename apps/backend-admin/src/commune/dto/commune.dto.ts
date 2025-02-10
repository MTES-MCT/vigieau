import { IsJSON, IsNumber, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CommuneDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;

  @IsString()
  @ApiProperty({ example: '2B033', description: 'Code INSEE de la commune' })
  code: string;

  @IsString()
  @ApiProperty({ example: 'Bastia', description: 'Nom de la commune' })
  nom: string;

  @IsJSON()
  @ApiProperty({
    example: '',
    description: 'Geojson compressé de la commune',
  })
  geom: any;
}
