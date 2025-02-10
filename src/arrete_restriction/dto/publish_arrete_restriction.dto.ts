import { IsDateString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PublishArreteRestrictionDto {
  @IsDateString()
  @IsNotEmpty()
  @ApiProperty({
    example: '01/01/2024',
    description: "Date de début de validité de l'arrêté de restriction",
  })
  dateDebut: string;

  @IsDateString()
  @IsOptional()
  @ApiProperty({
    example: '31/12/2024',
    description: "Date de signature de l'arrêté de restriction",
  })
  dateSignature: string;

  @IsDateString()
  @IsOptional()
  @ApiProperty({
    example: '31/12/2024',
    description: "Date de fin de validité de l'arrêté de restriction",
  })
  dateFin: string;
}
