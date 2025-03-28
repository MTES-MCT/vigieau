import { Module } from '@nestjs/common';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Usage } from '@shared/entities/usage.entity';
import { UsageFeedback } from '@shared/entities/usage_feedback.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Usage, UsageFeedback]),
  ],
  controllers: [UsageController],
  providers: [UsageService],
})
export class UsageModule {
}
