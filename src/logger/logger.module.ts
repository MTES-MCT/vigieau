import { Module } from '@nestjs/common';
import { RegleauLogger } from './regleau.logger';

@Module({
  providers: [RegleauLogger],
  exports: [RegleauLogger],
})
export class LoggerModule {}
