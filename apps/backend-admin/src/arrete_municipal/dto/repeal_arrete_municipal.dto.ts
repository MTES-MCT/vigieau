import { IsDateString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RepealArreteMunicipalDto {
  @IsDateString()
  @IsNotEmpty()
  @ApiProperty({
    example: '31/12/2024',
    description: "Date de fin de validité de l'arrêté municipal",
  })
  dateFin: string;
}
