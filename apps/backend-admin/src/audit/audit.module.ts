import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditMiddleware } from './audit.middleware';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditMiddleware],
  exports: [AuditService, AuditMiddleware],
})
export class AuditModule {}
