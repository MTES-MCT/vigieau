import { IsArray, IsString } from 'class-validator';
import { UserRole } from '@shared/types/user-role.type';
import { ApiProperty } from '@nestjs/swagger';

export class UserDto {
  @IsString()
  @ApiProperty({
    example: 'test@exemple.com',
    description: "Email de l'utilisateur",
  })
  email: string;

  @IsString()
  @ApiProperty({
    example: 'Prénom',
    description: "Prénom de l'utilisateur",
  })
  firstName: string;

  @IsString()
  @ApiProperty({
    example: 'Nom',
    description: "Nom de l'utilisateur",
  })
  lastName: string;

  @IsString()
  @ApiProperty({
    example: 'departement',
    enum: ['mte', 'departement'],
    description: "Rôle de l'utilisateur",
  })
  role: UserRole;

  @IsString()
  @ApiProperty({
    example: '01',
    description:
      "Département associé à l'utilisateur lorsque son rôle n'est pas MTE",
  })
  roleDepartement: string;

  @IsArray()
  @ApiProperty({
    example: '["01"]',
    description:
      "Départements associés à l'utilisateur lorsque son rôle n'est pas MTE",
  })
  roleDepartements: string[];
}
