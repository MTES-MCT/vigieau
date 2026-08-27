import './instrument';

process.env.DISABLE_SCHEDULED_JOBS = 'true';
process.env.RUN_BUSINESS_SCHEDULED_JOBS = 'false';
process.env.SKIP_SCHEMA_BOOTSTRAP = 'true';
process.env.SKIP_STARTUP_DATA_LOADS = 'true';
process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS = 'true';

async function bootstrapHistoricBackfillWorker(): Promise<void> {
  const [{ NestFactory }, { AppModule }, { RegleauLogger }, worker, handler] =
    await Promise.all([
      import('@nestjs/core'),
      import('./app.module.js'),
      import('./logger/regleau.logger.js'),
      import('./historic_backfill/historic-backfill-worker-loop.js'),
      import('./historic_backfill/historic-backfill-task-handler.js'),
    ]);
  const app = await NestFactory.createApplicationContext(AppModule);
  app.useLogger(app.get(RegleauLogger));
  app.enableShutdownHooks();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await app
      .get(worker.HistoricBackfillWorkerLoop)
      .run(app.get(handler.HistoricBackfillTaskHandlerService).handle, {
        signal: shutdown.signal,
      });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await app.close();
  }
}

void bootstrapHistoricBackfillWorker().catch((error) => {
  console.error('HISTORIC BACKFILL WORKER BOOTSTRAP ERROR', error);
  process.exit(1);
});
