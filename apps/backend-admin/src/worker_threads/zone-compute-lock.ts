import { DataSource, QueryRunner } from 'typeorm';

const DEPARTMENT_LOCK_TIMEOUT_MS = 60 * 60 * 1000;
const GLOBAL_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

export type ZoneComputeLockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

async function tryAcquireGlobalComputeLock(
  dataSource: DataSource,
  options: {
    skipIfBusy: boolean;
    retryDelayMs: number;
    timeoutMs: number;
  },
): Promise<QueryRunner | null> {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const [lockResult] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-global')) AS locked",
      );
      if (lockResult?.locked === true) {
        return queryRunner;
      }
    } catch (error) {
      await queryRunner.release();
      throw error;
    }
    await queryRunner.release();
    if (options.skipIfBusy) {
      return null;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the zone compute lock');
    }
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
  }
}

async function acquireDepartmentLocks(
  queryRunner: QueryRunner,
  depsIds: number[],
  acquiredDepartmentIds: number[],
  skipIfBusy: boolean,
): Promise<boolean> {
  const departmentIds =
    depsIds.length > 0
      ? [...new Set(depsIds)].sort((left, right) => left - right)
      : (await queryRunner.query('SELECT id FROM departement ORDER BY id')).map(
          (row) => Number(row.id),
        );
  const deadline = Date.now() + DEPARTMENT_LOCK_TIMEOUT_MS;

  for (const departmentId of departmentIds) {
    while (true) {
      const [lockResult] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau:sandre-zone-sync'), $1) AS locked",
        [departmentId],
      );
      if (lockResult?.locked === true) {
        acquiredDepartmentIds.push(departmentId);
        break;
      }
      if (skipIfBusy) {
        return false;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for department ${departmentId} zone synchronization`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return true;
}

export async function withZoneComputeLock<T>(
  dataSource: DataSource,
  depsIds: number[],
  task: () => Promise<T>,
  input?: {
    skipIfBusy?: boolean;
    retryDelayMs?: number;
    timeoutMs?: number;
  },
): Promise<ZoneComputeLockResult<T>> {
  const queryRunner = await tryAcquireGlobalComputeLock(dataSource, {
    skipIfBusy: input?.skipIfBusy === true,
    retryDelayMs: input?.retryDelayMs ?? 1000,
    timeoutMs: input?.timeoutMs ?? GLOBAL_LOCK_TIMEOUT_MS,
  });
  if (!queryRunner) {
    return { acquired: false };
  }

  const departmentIds: number[] = [];
  try {
    const departmentsAcquired = await acquireDepartmentLocks(
      queryRunner,
      depsIds,
      departmentIds,
      input?.skipIfBusy === true,
    );
    if (!departmentsAcquired) {
      return { acquired: false };
    }
    return { acquired: true, value: await task() };
  } finally {
    let unlockError: unknown;
    for (const departmentId of [...departmentIds].reverse()) {
      try {
        const [unlockResult] = await queryRunner.query(
          "SELECT pg_advisory_unlock(hashtext('vigieau:sandre-zone-sync'), $1) AS unlocked",
          [departmentId],
        );
        if (unlockResult?.unlocked !== true) {
          throw new Error(
            `Unable to release department ${departmentId} zone synchronization lock`,
          );
        }
      } catch (error) {
        unlockError ??= error;
      }
    }
    try {
      const [unlockResult] = await queryRunner.query(
        "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-global')) AS unlocked",
      );
      if (unlockResult?.unlocked !== true) {
        throw new Error('Unable to release the zone compute lock');
      }
    } catch (error) {
      unlockError ??= error;
    }
    try {
      await queryRunner.release();
    } catch (error) {
      unlockError ??= error;
    }
    if (unlockError) {
      throw unlockError;
    }
  }
}
