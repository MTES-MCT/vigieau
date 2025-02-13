import { Body, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { Controller } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UsageService } from './usage.service';
import { plainToInstance } from 'class-transformer';
import camelcaseKeys from 'camelcase-keys';
import { UsageDto } from './dto/usage.dto';
import { Usage } from '@shared/entities/usage.entity';
import { CreateUpdateUsageDto } from './dto/create_usage.dto';

@UseGuards(AuthenticatedGuard)
@Controller('usage')
@ApiTags('Usage')
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get()
  @ApiOperation({
    summary: "Retourne tout les usages suivant les droits de l'utilisateur",
  })
  @ApiResponse({
    status: 201,
    type: [UsageDto],
  })
  async findAll(@Req() req): Promise<UsageDto[]> {
    const usages: Usage[] = await this.usageService.findAll(req.session.user);
    return plainToInstance(UsageDto, camelcaseKeys(usages, { deep: true }));
  }

  @Post()
  @ApiOperation({ summary: "Création d'un nouvel usage" })
  @ApiBody({
    description: 'Usage',
    type: CreateUpdateUsageDto,
  })
  @ApiResponse({
    status: 201,
    type: UsageDto,
  })
  async create(@Body() createUsageDto: CreateUpdateUsageDto): Promise<UsageDto> {
    const usage = await this.usageService.create(createUsageDto);
    return plainToInstance(UsageDto, camelcaseKeys(<any>usage, { deep: true }));
  }
}
