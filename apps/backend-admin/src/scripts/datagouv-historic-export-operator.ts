import {
  HistoricExportReadiness,
  HistoricExportReadinessIdentity,
} from '../datagouv/historic-export-readiness.service';

export interface HistoricExportReadinessGate {
  evaluate(scheduledFor: string): Promise<HistoricExportReadiness>;
  assertReady(expected: HistoricExportReadinessIdentity): Promise<void>;
}

export async function publishWithHistoricExportReadiness<T>(
  readinessService: HistoricExportReadinessGate,
  scheduledFor: string,
  publish: (identity: HistoricExportReadinessIdentity) => Promise<T>,
): Promise<T> {
  const readiness = await readinessService.evaluate(scheduledFor);
  if (readiness.status !== 'ready') {
    throw new Error(
      `Publication data.gouv historique bloquée pour ${scheduledFor}: ${readiness.blocker}`,
    );
  }

  const identity = readiness.identity;
  await readinessService.assertReady(identity);
  const result = await publish(identity);
  await readinessService.assertReady(identity);
  return result;
}
