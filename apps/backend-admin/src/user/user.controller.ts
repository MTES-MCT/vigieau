import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Res,
  Query,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from '@shared/entities/user.entity';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import snakecaseKeys from 'snakecase-keys';
import { UserDto } from './dto/user.dto';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { Public } from '../core/decorators/public.decorator';
import { DeleteResult } from 'typeorm';
import { DevGuard } from '../core/guards/dev.guard';
import { Response } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { exportUsersCsv, filterExportUsers } from './user-export';

class ExportUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

@UseGuards(AuthenticatedGuard)
@Controller('user')
@ApiTags('Utilisateurs')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('/dev')
  @Public()
  @UseGuards(DevGuard)
  @ApiOperation({ summary: 'Retourne tout les utilisateurs - dev' })
  @ApiResponse({
    status: 201,
    type: [UserDto],
  })
  async findAllDev(): Promise<UserDto[]> {
    const users: User[] = await this.userService.findAll();
    return plainToInstance(UserDto, camelcaseKeys(users, { deep: true }));
  }

  @Get()
  @ApiOperation({ summary: 'Retourne tout les utilisateurs' })
  @ApiResponse({
    status: 201,
    type: [UserDto],
  })
  async findAll(@Req() req): Promise<UserDto[]> {
    const users: User[] = await this.userService.findAll(req.session.user);
    return plainToInstance(UserDto, camelcaseKeys(users, { deep: true }));
  }

  @Get('/export')
  @UseGuards(RolesGuard)
  @Roles(['mte', 'departement'])
  @ApiOperation({
    summary: 'Exporter les utilisateurs autorisés, avec journalisation',
  })
  async export(
    @Req() req,
    @Query() query: ExportUsersQueryDto,
    @Res() res: Response,
  ) {
    const actor = await this.userService.findOne(req.session?.user?.email);
    if (!actor) throw new UnauthorizedException();
    if (!['mte', 'departement'].includes(actor.role))
      throw new ForbiddenException();
    const users = filterExportUsers(
      await this.userService.findAll(actor),
      query.search,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="utilisateurs_${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return res.send(exportUsersCsv(users));
  }

  @Get('/me')
  @ApiOperation({ summary: "Retourne l'utilisateur courant" })
  @ApiResponse({
    status: 201,
    type: UserDto,
  })
  async me(@Req() req): Promise<UserDto> {
    const user: User = await this.userService.findOne(
      req.session?.user ? req.session.user.email : req.user?.userinfo?.email,
    );
    return plainToInstance(UserDto, camelcaseKeys(user, { deep: true }));
  }

  @Post()
  @ApiOperation({ summary: "Création d'un nouvel utilisateur" })
  @ApiBody({
    description: 'User',
    type: CreateUserDto,
  })
  @ApiResponse({
    status: 201,
    type: UserDto,
  })
  @UseGuards(RolesGuard)
  @Roles(['mte', 'departement'])
  async create(@Req() req, @Body() createUserDto: CreateUserDto) {
    const user = await this.userService.create(
      req.session.user,
      plainToInstance(User, snakecaseKeys(<any>createUserDto)),
    );
    return plainToInstance(UserDto, camelcaseKeys(<any>user, { deep: true }));
  }

  @Patch(':email')
  @ApiOperation({ summary: "Mis à jour d'un utilisateur" })
  @ApiBody({
    description: 'User',
    type: UpdateUserDto,
  })
  @ApiResponse({
    status: 201,
    type: UserDto,
  })
  @UseGuards(RolesGuard)
  @Roles(['mte'])
  async update(
    @Param('email') email: string,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<UserDto> {
    const userModel = await this.userService.update(
      email,
      plainToInstance(User, snakecaseKeys(<any>updateUserDto)),
    );
    return plainToInstance(
      UserDto,
      camelcaseKeys(<any>userModel, { deep: true }),
    );
  }

  @Post('/check_rules')
  @ApiOperation({
    summary: "Indique que l'utilisateur a vérifié ses règles de gestion",
  })
  @ApiResponse({
    status: 201,
  })
  async checkRules(@Req() req): Promise<any> {
    await this.userService.checkRules(
      req.session?.user ? req.session.user.email : req.user?.userinfo?.email,
    );
    return;
  }

  @Delete(':email')
  @ApiOperation({ summary: "Suppression d'un utilisateur" })
  @UseGuards(RolesGuard)
  @Roles(['mte', 'departement'])
  remove(@Req() req, @Param('email') email: string) {
    return this.userService.remove(req.session.user, email);
  }

  @Post('clearTestData')
  @Public()
  @UseGuards(DevGuard)
  @ApiOperation({ summary: 'Suppression des données générées par les tests' })
  async clearTestData(): Promise<DeleteResult> {
    return this.userService.removeTestData();
  }
}
