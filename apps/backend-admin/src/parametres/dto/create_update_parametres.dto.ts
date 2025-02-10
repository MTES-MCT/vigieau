import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUpdateParametresDto {
  @IsString()
  @Matches(
    /^no$|^no_all$|^yes_distinct$|^yes_all$|^yes_except_aep$|^yes_only_aep$/,
  )
  @IsNotEmpty()
  @ApiProperty({
    example: 'yes_all',
    enum: [
      'no',
      'no_all',
      'yes_distinct',
      'yes_all',
      'yes_except_aep',
      'yes_only_aep',
    ],
    description:
      "Règle de gestion de superposition de zone à l'échelle de la commune",
  })
  superpositionCommune:
    | 'no'
    | 'no_all'
    | 'yes_distinct'
    | 'yes_all'
    | 'yes_except_aep'
    | 'yes_only_aep';
}
