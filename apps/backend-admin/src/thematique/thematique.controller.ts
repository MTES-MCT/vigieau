import { Controller, Get, UseGuards } from '@nestjs/common';
import { ThematiqueService } from './thematique.service';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import { ThematiqueDto } from './dto/thematique.dto';
import { Thematique } from '@shared/entities/thematique.entity';

@UseGuards(AuthenticatedGuard)
@Controller('thematique')
@ApiTags('Thématique')
export class ThematiqueController {
  constructor(private readonly thematiqueService: ThematiqueService) {}

  @Get()
  @ApiOperation({
    summary: 'Retourne toutes les thématiques',
  })
  @ApiResponse({
    status: 201,
    type: [ThematiqueDto],
  })
  async findAll(): Promise<ThematiqueDto[]> {
    const thematiques: Thematique[] = await this.thematiqueService.findAll();
    return plainToInstance(
      ThematiqueDto,
      camelcaseKeys(thematiques, { deep: true }),
    );
  }
}
