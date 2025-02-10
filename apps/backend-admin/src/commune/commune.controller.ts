import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CommuneService } from './commune.service';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import { CommuneDto } from './dto/commune.dto';

@UseGuards(AuthenticatedGuard)
@Controller('commune')
@ApiTags('Communes')
export class CommuneController {
  constructor(private readonly communeService: CommuneService) {}

  @Get('')
  @ApiOperation({ summary: 'Retourne des communes' })
  @ApiResponse({
    status: 201,
    type: [CommuneDto],
  })
  async find(
    @Req() req,
    @Query('depCode') depCodes?: string,
    @Query('withGeom') withGeom?: string,
  ): Promise<CommuneDto[]> {
    const communes = await this.communeService.find(
      depCodes?.split(','),
      withGeom === 'true',
      req.session.user,
    );
    return plainToInstance(CommuneDto, camelcaseKeys(communes, { deep: true }));
  }
}
