import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import path from 'path';
import { DataModule } from '../data/data.module';
import {
  createDatabaseDataSource,
  createDatabaseOptions,
} from '../database-options';
import { LoggerModule } from '../logger/logger.module';
import { StatcacheWorkerService } from './statcache-worker.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: path.resolve(__dirname, '../../../../../.env'),
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync(<TypeOrmModuleAsyncOptions>{
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: createDatabaseOptions,
      dataSourceFactory: createDatabaseDataSource,
    }),
    LoggerModule,
    DataModule,
  ],
  providers: [StatcacheWorkerService],
})
export class StatcacheModule {}
