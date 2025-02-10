import { IsArray, IsNumber, IsString } from 'class-validator';
import { ZoneAlerteDto } from '../../zone_alerte/dto/zone_alerte.dto';
import { ApiProperty } from '@nestjs/swagger';

export class DepartementDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;

  @IsString()
  @ApiProperty({ example: '01', description: 'Code du département' })
  code: string;

  @IsString()
  @ApiProperty({ example: 'Ain', description: 'Nnom du département' })
  nom: string;

  @IsArray()
  @ApiProperty({ type: [ZoneAlerteDto] })
  zonesAlerte: ZoneAlerteDto[];
}
