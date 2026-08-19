import { ConfigService } from '@nestjs/config';
import { DataSource, type DataSourceOptions } from 'typeorm';

export function createDatabaseOptions(
  configService: ConfigService,
): DataSourceOptions {
  const user = configService.get<string>('DATABASE_USER');
  const password = configService.get<string>('DATABASE_PASSWORD');
  const host = configService.get<string>('DATABASE_HOST');
  const port = configService.get<string>('DATABASE_PORT');
  const dbName = configService.get<string>('DATABASE_NAME');
  const sslCert = configService.get('DATABASE_SSL_CERT');
  const queryParam = sslCert ? 'sslmode=require' : '';
  const url = `postgres://${user}:${password}@${host}:${port}/${dbName}${queryParam ? '?' + queryParam : ''}`;

  return {
    type: 'postgres',
    url,
    entities: [`${__dirname}/../../../**/*.entity{.ts,.js}`],
    logging: ['error', 'schema'],
    migrations: [`${__dirname}/migrations/**/*{.ts,.js}`],
    synchronize: false,
    maxQueryExecutionTime: 1000,
    ssl: configService.get('NODE_ENV') !== 'local',
    extra:
      configService.get('NODE_ENV') !== 'local'
        ? {
            ssl: {
              rejectUnauthorized: false,
            },
          }
        : {},
  };
}

export function createDatabaseDataSource(options?: DataSourceOptions) {
  if (!options) {
    throw new Error('Database options are required');
  }
  return new DataSource(options).initialize();
}
