import { IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CreateUpdateRestrictionDto } from './create_update_restriction.dto';

export class RestrictionDto extends CreateUpdateRestrictionDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;
}
