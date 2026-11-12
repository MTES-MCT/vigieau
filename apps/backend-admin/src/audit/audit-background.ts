import { AuditService } from './audit.service';
import {
  isAuditEnabled,
  systemAuditContext,
  withAuditContext,
  type AuditContext,
} from './audit-context';

export interface AuditJobReference {
  kind: string;
  reference: string;
}

export async function startAuditJob(
  audit: AuditService | undefined,
  action: string,
  references: AuditJobReference[],
): Promise<AuditContext | undefined> {
  if (!audit || !isAuditEnabled()) return undefined;
  const context = systemAuditContext(action);
  const eventId = await audit.recordEvent(
    'started',
    { stage: 'background' },
    context,
  );
  for (const ref of references)
    await audit.link(eventId, ref.kind, ref.reference);
  return context;
}

export async function finishAuditJob(
  audit: AuditService | undefined,
  context: AuditContext | undefined,
  result: string,
): Promise<void> {
  if (!audit || !context) return;
  const phase = ['completed', 'processed'].includes(result)
    ? 'succeeded'
    : ['failed', 'terminal'].includes(result)
      ? 'failed'
      : 'unknown';
  try {
    await audit.recordEvent(
      phase,
      { stage: 'background', jobResult: result },
      context,
    );
  } catch {
    // Work may already be committed: an audit outage is not a job failure.
    audit.reportFailure(context.operationId);
  }
}

export async function executeAuditedJob<T extends string>(
  audit: AuditService | undefined,
  action: string,
  references: AuditJobReference[],
  work: () => Promise<T>,
): Promise<T> {
  const context = await startAuditJob(audit, action, references);
  if (!context) return work();
  return withAuditContext(context, async () => {
    try {
      const result = await work();
      await finishAuditJob(audit, context, result);
      return result;
    } catch (error) {
      await audit.recordBestEffort(
        'failed',
        { stage: 'background', errorCode: 'BACKGROUND_FAILURE' },
        context,
      );
      throw error;
    }
  });
}
