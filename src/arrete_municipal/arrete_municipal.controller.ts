import {
  Body,
  Controller, Delete,
  Get,
  Param, Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ArreteMunicipalService } from './arrete_municipal.service';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Paginate, Paginated, PaginatedSwaggerDocs, PaginateQuery } from 'nestjs-paginate';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import { ArreteMunicipalDto, arreteMunicipalPaginateConfig } from './dto/arrete_municipal.dto';
import { CreateUpdateArreteMunicipalDto } from './dto/create_update_arrete_municipal.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { Utils } from '../core/utils';
import { RepealArreteMunicipalDto } from './dto/repeal_arrete_municipal.dto';

@UseGuards(AuthenticatedGuard)
@Controller('arrete-municipal')
@ApiTags('Arrêtés Municipaux')
export class ArreteMunicipalController {
  constructor(private readonly arreteMunicipalService: ArreteMunicipalService) {
  }

  @Get('/search')
  @ApiOperation({ summary: 'Retourne les arrêtés municipaux paginés' })
  @PaginatedSwaggerDocs(ArreteMunicipalDto, arreteMunicipalPaginateConfig)
  async findAll(
    @Req() req,
    @Paginate() query: PaginateQuery,
  ): Promise<Paginated<ArreteMunicipalDto>> {
    const paginated = await this.arreteMunicipalService.findAll(query, req.session.user);
    return plainToInstance(
      Paginated<ArreteMunicipalDto>,
      camelcaseKeys(paginated, { deep: true }),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retourne un arrêté municipal' })
  @ApiResponse({
    status: 201,
    type: ArreteMunicipalDto,
  })
  async findOne(@Param('id') id: string): Promise<ArreteMunicipalDto> {
    const arreteMunicipal = await this.arreteMunicipalService.findOne(+id);
    return plainToInstance(
      ArreteMunicipalDto,
      camelcaseKeys(arreteMunicipal, { deep: true }),
    );
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: Utils.pdfFileFilter,
      limits: {
        fileSize: 1e7,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Création d\'un arrêté municipal' })
  @ApiResponse({
    status: 201,
    type: ArreteMunicipalDto,
  })
  async create(
    @Req() req,
    @UploadedFile() file: Express.Multer.File,
    @Body() createArreteMunicipalDto: CreateUpdateArreteMunicipalDto,
  ): Promise<ArreteMunicipalDto> {
    createArreteMunicipalDto.communes = JSON.parse(createArreteMunicipalDto.communes);
    const arreteMunicipal = await this.arreteMunicipalService.create(
      createArreteMunicipalDto,
      file,
      req.session.user,
    );
    return plainToInstance(
      ArreteMunicipalDto,
      camelcaseKeys(arreteMunicipal, { deep: true }),
    );
  }

  @Patch(':id')
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: Utils.pdfFileFilter,
      limits: {
        fileSize: 1e7,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Edition d'un arrêté municipal" })
  @ApiResponse({
    status: 201,
    type: ArreteMunicipalDto,
  })
  async update(
    @Param('id') id: string,
    @Req() req,
    @UploadedFile() file: Express.Multer.File,
    @Body() editArreteMunicipalDto: CreateUpdateArreteMunicipalDto,
  ): Promise<ArreteMunicipalDto> {
    editArreteMunicipalDto.communes = JSON.parse(editArreteMunicipalDto.communes);
    const arreteMunicipal = await this.arreteMunicipalService.update(
      +id,
      editArreteMunicipalDto,
      file,
      req.session.user,
    );
    return plainToInstance(
      ArreteMunicipalDto,
      camelcaseKeys(arreteMunicipal, { deep: true }),
    );
  }


  // @Post(':id/abroger')
  // @ApiOperation({ summary: "Abrogement d'un arrêté municipal" })
  // async repeal(
  //   @Req() req,
  //   @Param('id') id: string,
  //   @Body() repealArreteMunicipalDto: RepealArreteMunicipalDto,
  // ): Promise<ArreteMunicipalDto> {
  //   const arreteMunicipal = await this.arreteMunicipalService.repeal(
  //     +id,
  //     repealArreteMunicipalDto,
  //     req.session.user,
  //   );
  //   return plainToInstance(
  //     ArreteMunicipalDto,
  //     camelcaseKeys(arreteMunicipal, { deep: true }),
  //   );
  // }

  @Delete(':id')
  @ApiOperation({ summary: "Suppression d'un arrêté municipal" })
  remove(@Req() req, @Param('id') id: string) {
    return this.arreteMunicipalService.remove(+id, req.session.user);
  }
}
