import { Controller, Delete, Get, Param, Req } from '@nestjs/common';
import { UsageFeedbackService } from './usage_feedback.service';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UsageFeedback, usageFeedbackPaginateConfig } from '@shared/entities/usage_feedback.entity';
import { Paginate, Paginated, PaginatedSwaggerDocs, PaginateQuery } from 'nestjs-paginate';

@Controller('usage_feedback')
export class UsageFeedbackController {
  constructor(private readonly usageFeedbackService: UsageFeedbackService) {
  }

  @Get()
  @ApiOperation({
    summary: 'Retourne tout les feedbacks suivant le rôle de l\'utilisateur',
  })
  @ApiResponse({
    status: 201,
    type: [UsageFeedback],
  })
  async findAll(@Req() req): Promise<UsageFeedback[]> {
    return this.usageFeedbackService.findAll(req.session.user)
  }

  @Get('/search')
  @ApiOperation({
    summary: 'Retourne les feedbacks paginés suivant le rôle de l\'utilisateur',
  })
  @PaginatedSwaggerDocs(UsageFeedback, usageFeedbackPaginateConfig)
  async paginate(@Req() req, @Paginate() query: PaginateQuery): Promise<Paginated<UsageFeedback>> {
    return this.usageFeedbackService.paginate(req.session.user, query)
  }

  @Delete(':id')
  @ApiOperation({ summary: "Archivage d'un feedback" })
  remove(@Req() req, @Param('id') id: string) {
    return this.usageFeedbackService.remove(req.session.user, id);
  }
}
