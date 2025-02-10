import { Controller, Get, UseGuards } from '@nestjs/common';
import { DevGuard } from './core/guards/dev.guard';

@Controller('app')
export class AppController {
  constructor() {}

  @UseGuards(DevGuard)
  @Get('__coverage__')
  public getCoverage() {
    if (global['__coverage__']) {
      return { coverage: global['__coverage__'] };
    }
  }
}
