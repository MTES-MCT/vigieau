import { Controller, Get } from '@nestjs/common';
import { AntivirusService } from './antivirus.service';

@Controller('health/antivirus')
export class AntivirusController {
  constructor(private readonly antivirus: AntivirusService) {}

  @Get()
  check() {
    return this.antivirus.health();
  }
}
