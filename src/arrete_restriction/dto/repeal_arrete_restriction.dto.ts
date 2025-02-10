import { IsDateString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RepealArreteRestrictionDto {
  @IsDateString()
  @IsNotEmpty()
  @ApiProperty({
    example: '31/12/2024',
    description: "Date de fin de validité de l'arrêté de restriciton",
  })
  dateFin: string;
}
