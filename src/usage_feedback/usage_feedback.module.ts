import { Module } from '@nestjs/common';
import { UsageFeedbackService } from './usage_feedback.service';
import { UsageFeedbackController } from './usage_feedback.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageFeedback } from './entities/usage_feedback.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UsageFeedback])],
  controllers: [UsageFeedbackController],
  providers: [UsageFeedbackService],
})
export class UsageFeedbackModule {}
