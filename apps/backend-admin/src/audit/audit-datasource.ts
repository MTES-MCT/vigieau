import type { DataSource, QueryRunner } from 'typeorm';
import { getAuditContext, isAuditEnabled } from './audit-context';
import { sanitizeAuditMetadata } from './audit.service';

const installed = new WeakSet<DataSource>();
const wrapped = new WeakSet<QueryRunner>();
const control =
  /^\s*(?:START\s+TRANSACTION|BEGIN\b|COMMIT\b|ROLLBACK\b|SAVEPOINT\b|RELEASE\s+SAVEPOINT\b|SET\s+TRANSACTION\b)/i;

/**
 * Scope PostgreSQL audit triggers to the actual connection and transaction.
 * Every statement is covered (including CTEs/functions), not just ORM save().
 * The per-runner queue keeps context + statement atomic for Promise.all callers.
 */
export function installDataSourceAudit(dataSource: DataSource): void {
  if (installed.has(dataSource)) return;
  installed.add(dataSource);
  const create = dataSource.createQueryRunner.bind(dataSource);
  dataSource.createQueryRunner = ((
    ...args: Parameters<DataSource['createQueryRunner']>
  ) => {
    const runner = create(...args);
    if (wrapped.has(runner)) return runner;
    wrapped.add(runner);
    const original = runner.query.bind(runner);
    let tail: Promise<unknown> = Promise.resolve();
    runner.query = ((...queryArgs: any[]) => {
      const context = isAuditEnabled() ? getAuditContext() : undefined;
      // Snapshot at invocation, not when a queued query finally obtains the connection.
      const serialized = context
        ? JSON.stringify({
            ...context,
            metadata: sanitizeAuditMetadata(context.metadata),
          })
        : null;
      const query = String(queryArgs[0]);
      const execute = async () => {
        if (control.test(query)) {
          if (
            context &&
            ((/^\s*(?:BEGIN\b|START\s+TRANSACTION)/i.test(query) &&
              !runner.isTransactionActive) ||
              /;\s*\S/.test(query))
          )
            throw new Error(
              'Audited transactions must use QueryRunner.startTransaction()',
            );
          return original(...(queryArgs as [string, any[]?, boolean?]));
        }
        if (!context) {
          if (isAuditEnabled() && runner.isTransactionActive)
            await original(
              "SELECT set_config('vigieau.audit_context', '', true)",
            );
          return original(...(queryArgs as [string, any[]?, boolean?]));
        }
        const ownTransaction = !runner.isTransactionActive;
        try {
          if (ownTransaction) await original('BEGIN');
          // SET LOCAL clears automatically at commit/rollback, including pool reuse.
          await original(
            "SELECT set_config('vigieau.audit_context', $1, true)",
            [serialized],
          );
          const result = await original(
            ...(queryArgs as [string, any[]?, boolean?]),
          );
          if (ownTransaction) await original('COMMIT');
          return result;
        } catch (error) {
          if (ownTransaction) {
            try {
              await original('ROLLBACK');
            } catch {
              /* Preserve the original failure. */
            }
          }
          throw error;
        }
      };
      const pending = tail.then(execute, execute);
      tail = pending.catch(() => undefined);
      return pending;
    }) as QueryRunner['query'];
    return runner;
  }) as DataSource['createQueryRunner'];
}
