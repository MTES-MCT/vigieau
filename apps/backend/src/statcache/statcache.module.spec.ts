import { MODULE_METADATA } from '@nestjs/common/constants';
import { StatcacheModule } from './statcache.module';
import { StatcacheWorkerService } from './statcache-worker.service';

describe('StatcacheModule', () => {
  it('boots only the minimal database and data-cache composition', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      StatcacheModule,
    );
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      StatcacheModule,
    );
    const importNames = imports.map(
      (entry: { module?: { name?: string }; name?: string }) =>
        entry.module?.name ?? entry.name,
    );

    expect(imports).toHaveLength(4);
    expect(importNames).toEqual(
      expect.arrayContaining(['TypeOrmModule', 'LoggerModule', 'DataModule']),
    );
    expect(importNames).not.toEqual(
      expect.arrayContaining([
        'AppModule',
        'ScheduleModule',
        'CronModule',
        'SubscriptionsModule',
      ]),
    );
    expect(providers).toContain(StatcacheWorkerService);
  });
});
