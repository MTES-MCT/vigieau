import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { CreateUpdateUsageDto } from '../../usage/dto/create_usage.dto';

class UpdateLinkNestedObjectDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;
}

class UpdateZoneAlerteDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;

  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  @Type(() => UpdateLinkNestedObjectDto)
  @ApiProperty({ type: [UpdateLinkNestedObjectDto] })
  communes: UpdateLinkNestedObjectDto[];
}

export class CreateUpdateArreteCadreDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({ example: 'AC_0', description: "Numéro de l'arrêté cadre" })
  numero: string;

  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  @Type(() => UpdateLinkNestedObjectDto)
  @ApiProperty({ type: [UpdateLinkNestedObjectDto] })
  departements: UpdateLinkNestedObjectDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  @Type(() => UpdateZoneAlerteDto)
  @ApiProperty({ type: [UpdateZoneAlerteDto] })
  zonesAlerte: UpdateZoneAlerteDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  @Type(() => CreateUpdateUsageDto)
  @ApiProperty({ type: [CreateUpdateUsageDto] })
  usages: CreateUpdateUsageDto[];

  @IsObject()
  @ValidateNested()
  @IsOptional()
  @Type(() => UpdateLinkNestedObjectDto)
  @ApiProperty({ type: UpdateLinkNestedObjectDto })
  arreteCadreAbroge: UpdateLinkNestedObjectDto;
}
