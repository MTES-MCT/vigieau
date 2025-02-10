import { CreateUpdateParametresDto } from './create_update_parametres.dto';
import { IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ParametresDto extends CreateUpdateParametresDto {
  @IsNumber()
  @ApiProperty({ example: 1, description: 'Identifiant BDD' })
  id: number;
}
