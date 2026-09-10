import { Module } from '@nestjs/common';
import { HistoryRecoverySchedulerService } from './history-recovery-scheduler.service';

@Module({ providers: [HistoryRecoverySchedulerService] })
export class HistoryRecoveryModule {}
