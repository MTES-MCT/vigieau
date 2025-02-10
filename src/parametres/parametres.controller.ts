import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ParametresService } from './parametres.service';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import { ParametresDto } from './dto/parametres.dto';
import { Parametres } from './entities/parametres.entity';
import { CreateUpdateParametresDto } from './dto/create_update_parametres.dto';

@UseGuards(AuthenticatedGuard)
@Controller('parametres')
@ApiTags('Paramètres')
export class ParametresController {
  constructor(private readonly parametresService: ParametresService) {}

  @Get()
  @ApiOperation({ summary: "Retourne les règles de gestion d'un département" })
  @ApiResponse({
    status: 201,
    type: [ParametresDto],
  })
  async findAll(@Req() req): Promise<ParametresDto[]> {
    const parametres: Parametres[] = await this.parametresService.findAll(
      req.session.user,
    );
    return plainToInstance(
      ParametresDto,
      camelcaseKeys(parametres, { deep: true }),
    );
  }

  @Get(':depCode')
  @ApiOperation({ summary: "Retourne les règles de gestion d'un département" })
  @ApiResponse({
    status: 201,
    type: [ParametresDto],
  })
  async findOne(@Param('depCode') depCode: string): Promise<ParametresDto> {
    const parametres: Parametres = await this.parametresService.findOne(depCode);
    return plainToInstance(
      ParametresDto,
      camelcaseKeys(parametres, { deep: true }),
    );
  }

  @Post(':depCode')
  @ApiOperation({
    summary: "Création / Edition des règles de gestion d'un département",
  })
  @ApiBody({
    description: 'Paramètres',
    type: CreateUpdateParametresDto,
  })
  @ApiResponse({
    status: 201,
    type: ParametresDto,
  })
  async create(
    @Req() req,
    @Param('depCode') depCode: string,
    @Body() createUpdateParametresDto: CreateUpdateParametresDto,
  ) {
    const parametres = await this.parametresService.createUpdate(
      req.session.user,
      depCode,
      plainToInstance(Parametres, createUpdateParametresDto),
    );
    return plainToInstance(
      ParametresDto,
      camelcaseKeys(<any>parametres, { deep: true }),
    );
  }
}
