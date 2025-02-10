import {
  Controller,
  Get,
  Param,
  UseGuards,
  Req,
  Post,
  Body,
  Patch,
  Delete,
  UseInterceptors,
  UploadedFile,
  Query,
} from '@nestjs/common';
import { ArreteCadreService } from './arrete_cadre.service';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import {
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import {
  ArreteCadreDto,
  arreteCadrePaginateConfig,
} from './dto/arrete_cadre.dto';
import {
  Paginate,
  Paginated,
  PaginatedSwaggerDocs,
  PaginateQuery,
} from 'nestjs-paginate';
import { CreateUpdateArreteCadreDto } from './dto/create_update_arrete_cadre.dto';
import { Public } from '../core/decorators/public.decorator';
import { DeleteResult } from 'typeorm';
import { PublishArreteCadreDto } from './dto/publish_arrete_cadre.dto';
import { RepealArreteCadreDto } from './dto/repeal_arrete_cadre.dto';
import { Utils } from '../core/utils';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileUploadDto } from '../core/dto/file_upload.dto';
import { DevGuard } from '../core/guards/dev.guard';

@UseGuards(AuthenticatedGuard)
@Controller('arrete-cadre')
@ApiTags('Arrêtés Cadre')
export class ArreteCadreController {
  constructor(private readonly arreteCadreService: ArreteCadreService) {}

  @Get('/search')
  @ApiOperation({ summary: 'Retourne les arrêtés cadres paginés' })
  @PaginatedSwaggerDocs(ArreteCadreDto, arreteCadrePaginateConfig)
  async findAll(
    @Paginate() query: PaginateQuery,
  ): Promise<Paginated<ArreteCadreDto>> {
    const paginated = await this.arreteCadreService.findAll(query);
    return plainToInstance(
      Paginated<ArreteCadreDto>,
      camelcaseKeys(paginated, { deep: true }),
    );
  }

  @Get('')
  @ApiOperation({ summary: 'Retourne des arrêtés cadre' })
  @ApiResponse({
    status: 201,
    type: [ArreteCadreDto],
  })
  async find(
    @Req() req,
    @Query('depCode') depCode?: string,
  ): Promise<ArreteCadreDto[]> {
    const arretesCadre = await this.arreteCadreService.find(
      req.session.user,
      depCode,
    );
    return plainToInstance(
      ArreteCadreDto,
      camelcaseKeys(arretesCadre, { deep: true }),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retourne un arrêté cadre' })
  @ApiResponse({
    status: 201,
    type: ArreteCadreDto,
  })
  async findOne(@Param('id') id: string): Promise<ArreteCadreDto> {
    const arreteCadre = await this.arreteCadreService.findOne(+id);
    return plainToInstance(
      ArreteCadreDto,
      camelcaseKeys(arreteCadre, { deep: true }),
    );
  }

  @Post()
  @ApiOperation({ summary: "Création d'un arrêté cadre" })
  @ApiResponse({
    status: 201,
    type: ArreteCadreDto,
  })
  async create(
    @Req() req,
    @Body() createArreteCadreDto: CreateUpdateArreteCadreDto,
  ): Promise<ArreteCadreDto> {
    const arreteCadre = await this.arreteCadreService.create(
      createArreteCadreDto,
      req.session.user,
    );
    return plainToInstance(
      ArreteCadreDto,
      camelcaseKeys(arreteCadre, { deep: true }),
    );
  }

  @Post(':id/publier')
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: Utils.pdfFileFilter,
      limits: {
        fileSize: 1e7,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 201,
    type: FileUploadDto,
  })
  @ApiOperation({ summary: "Publication d'un arrêté cadre" })
  async publish(
    @Req() req,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() publishArreteCadreDto: PublishArreteCadreDto,
  ): Promise<ArreteCadreDto> {
    // Impossible d'envoyer du null via form data
    if (!publishArreteCadreDto.dateFin) {
      publishArreteCadreDto.dateFin = null;
    }
    // TODO vérifier que l'AC est bien complet (zones, usages, etc.)
    const arreteCadre = await this.arreteCadreService.publish(
      +id,
      file,
      publishArreteCadreDto,
      req.session.user,
    );
    return plainToInstance(
      ArreteCadreDto,
      camelcaseKeys(arreteCadre, { deep: true }),
    );
  }

  @Post(':id/abroger')
  @ApiOperation({ summary: "Abrogement d'un arrêté cadre" })
  async repeal(
    @Req() req,
    @Param('id') id: string,
    @Body() repealArreteCadreDto: RepealArreteCadreDto,
  ): Promise<ArreteCadreDto> {
    const arreteCadre = await this.arreteCadreService.repeal(
      +id,
      repealArreteCadreDto,
      req.session.user,
    );
    return plainToInstance(
      ArreteCadreDto,
      camelcaseKeys(arreteCadre, { deep: true }),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: "Edition d'un arrêté cadre" })
  @ApiResponse({
    status: 201,
    type: ArreteCadreDto,
  })
  async update(
    @Req() req,
    @Param('id') id: string,
    @Body() updateArreteCadreDto: CreateUpdateArreteCadreDto,
  ): Promise<ArreteCadreDto> {
    const arreteCadre = await this.arreteCadreService.update(
      +id,
      updateArreteCadreDto,
      req.session.user,
    );
    return plainToInstance(
      ArreteCadreDto,
      camelcaseKeys(arreteCadre, { deep: true }),
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: "Suppression d'un arrêté cadre" })
  remove(@Req() req, @Param('id') id: string) {
    return this.arreteCadreService.remove(+id, req.session.user);
  }

  @Post('populateTestData')
  @Public()
  @UseGuards(DevGuard)
  @ApiOperation({
    summary: 'Génération des données nécessaires pour les tests',
  })
  async populateTestData(): Promise<void> {
    return this.arreteCadreService.populateTestData();
  }

  @Post('clearTestData')
  @Public()
  @UseGuards(DevGuard)
  @ApiOperation({ summary: 'Suppression des données générées par les tests' })
  async clearTestData(): Promise<DeleteResult> {
    return this.arreteCadreService.removeTestData();
  }
}
