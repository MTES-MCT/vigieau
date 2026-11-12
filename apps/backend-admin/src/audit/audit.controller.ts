import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';

@Controller('audit-events')
@ApiTags('Journal d’activité')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(@Req() req: any, @Query() query: Record<string, unknown>) {
    await this.audit.requireMte(req.session?.user);
    return this.audit.list(query);
  }

  @Get(':id')
  async detail(
    @Req() req: any,
    @Param('id') id: string,
    @Query('resourceCursor') cursor?: string,
  ) {
    await this.audit.requireMte(req.session?.user);
    return this.audit.detail(id, cursor);
  }
}
