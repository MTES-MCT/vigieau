import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ArreteRestrictionService } from './arrete_restriction.service';
import {
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  Paginate,
  Paginated,
  PaginatedSwaggerDocs,
  PaginateQuery,
} from 'nestjs-paginate';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import {
  ArreteRestrictionDto,
  arreteRestrictionPaginateConfig,
} from './dto/arrete_restriction.dto';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { CreateUpdateArreteRestrictionDto } from './dto/create_update_arrete_restriction.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { Utils } from '../core/utils';
import { FileUploadDto } from '../core/dto/file_upload.dto';
import { RepealArreteRestrictionDto } from './dto/repeal_arrete_restriction.dto';
import { PublishArreteRestrictionDto } from './dto/publish_arrete_restriction.dto';
import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';

@UseGuards(AuthenticatedGuard)
@Controller('arrete-restriction')
@ApiTags('Arrêtés de Restriction')
export class ArreteRestrictionController {
  constructor(
    private readonly arreteRestrictionService: ArreteRestrictionService,
  ) {
  }

  @Get('/search')
  @ApiOperation({ summary: 'Retourne les arrêtés de restrictions paginés' })
  @PaginatedSwaggerDocs(ArreteRestrictionDto, arreteRestrictionPaginateConfig)
  async findAll(
    @Paginate() query: PaginateQuery,
  ): Promise<Paginated<ArreteRestrictionDto>> {
    const paginated = await this.arreteRestrictionService.findAll(query);
    return plainToInstance(
      Paginated<ArreteRestrictionDto>,
      camelcaseKeys(paginated, { deep: true }),
    );
  }

  @Get('')
  @ApiOperation({ summary: 'Retourne des arrêtés de restriction' })
  @ApiResponse({
    status: 201,
    type: [ArreteRestrictionDto],
  })
  async find(
    @Req() req,
    @Query('depCode') depCode?: string,
  ): Promise<ArreteRestrictionDto[]> {
    const arretesRestriction = await this.arreteRestrictionService.find(
      req.session.user,
      depCode,
    );
    return plainToInstance(
      ArreteRestrictionDto,
      camelcaseKeys(arretesRestriction, { deep: true }),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retourne un arrêté de restriction' })
  @ApiResponse({
    status: 201,
    type: ArreteRestrictionDto,
  })
  async findOne(@Param('id') id: string): Promise<ArreteRestrictionDto> {
    const arreteRestriction = await this.arreteRestrictionService.findOne(+id);
    return plainToInstance(
      ArreteRestrictionDto,
      camelcaseKeys(arreteRestriction, { deep: true }),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Création d\'un arrêté de restriction' })
  @ApiResponse({
    status: 201,
    type: ArreteRestrictionDto,
  })
  async create(
    @Req() req,
    @Body() createArreteRestrictionDto: CreateUpdateArreteRestrictionDto,
  ): Promise<ArreteRestrictionDto> {
    const arreteRestriction = await this.arreteRestrictionService.create(
      createArreteRestrictionDto,
      req.session.user,
    );
    return plainToInstance(
      ArreteRestrictionDto,
      camelcaseKeys(arreteRestriction, { deep: true }),
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
  @ApiOperation({ summary: "Publication d'un arrêté de restriction" })
  async publish(
    @Req() req,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() publishArreteRestrictionDto: PublishArreteRestrictionDto,
  ): Promise<ArreteRestrictionDto> {
    // Impossible d'envoyer du null via form data
    if (!publishArreteRestrictionDto.dateFin) {
      publishArreteRestrictionDto.dateFin = null;
    }
    if (!publishArreteRestrictionDto.dateSignature) {
      publishArreteRestrictionDto.dateSignature = null;
    }
    const arreteRestriction = await this.arreteRestrictionService.publish(
      +id,
      file,
      publishArreteRestrictionDto,
      req.session.user,
    );
    return plainToInstance(
      ArreteRestrictionDto,
      camelcaseKeys(arreteRestriction, { deep: true }),
    );
  }

  @Post(':id/abroger')
  @ApiOperation({ summary: "Abrogement d'un arrêté de restriction" })
  async repeal(
    @Req() req,
    @Param('id') id: string,
    @Body() repealArreteRestrictionDto: RepealArreteRestrictionDto,
  ): Promise<ArreteRestrictionDto> {
    const arreteRestriction = await this.arreteRestrictionService.repeal(
      +id,
      repealArreteRestrictionDto,
      req.session.user,
    );
    return plainToInstance(
      ArreteRestrictionDto,
      camelcaseKeys(arreteRestriction, { deep: true }),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: "Edition d'un arrêté de restriction" })
  @ApiResponse({
    status: 201,
    type: ArreteRestrictionDto,
  })
  async update(
    @Req() req,
    @Param('id') id: string,
    @Body() updateArreteRestrictionDto: CreateUpdateArreteRestrictionDto,
  ): Promise<ArreteRestrictionDto> {
    const arreteRestriction = await this.arreteRestrictionService.update(
      +id,
      updateArreteRestrictionDto,
      req.session.user,
    );
    return plainToInstance(
      ArreteRestrictionDto,
      camelcaseKeys(arreteRestriction, { deep: true }),
    );
  }

  @Post(':id/check')
  @ApiOperation({
    summary: "Check d'un arrêté de restriction avant sa publication",
  })
  async check(
    @Param('id') id: string,
    @Body() publishArreteRestrictionDto?: PublishArreteRestrictionDto,
  ): Promise<any> {
    const ar: ArreteRestriction =
      await this.arreteRestrictionService.findOne(+id);
    // @ts-expect-error type
    const arBis: ArreteRestriction = {
      ...ar,
      ...{
        dateDebut: publishArreteRestrictionDto
          ? publishArreteRestrictionDto.dateDebut
          : ar.dateDebut,
        dateFin: publishArreteRestrictionDto
          ? publishArreteRestrictionDto.dateFin
          : ar.dateFin,
      },
    };
    return this.arreteRestrictionService.checkBeforePublish(arBis);
  }

  @Delete(':id')
  @ApiOperation({ summary: "Suppression d'un arrêté de restriction" })
  remove(@Req() req, @Param('id') id: string) {
    return this.arreteRestrictionService.remove(+id, req.session.user);
  }
}
