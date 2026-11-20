import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  loadRecoveryBundle,
  mergeRecoveryDays,
  NOVEMBER_RECOVERY_RUN_ID,
  NOVEMBER_RECOVERY_SOURCES,
  recoverNovemberMonth,
  validateRecoveryPayload,
} from './import-november-statistics';

const day = (date: string, severity: string | null = null) => ({
  date,
  SOU: severity,
  SUP: null,
  AEP: null,
});
const area = { vigilance: 0, alerte: 0, alerte_renforcee: 0, crise: 0 };
function payload(date: string) {
  const departments = Array.from({ length: 101 }, (_, index) => ({
    code: String(index + 1).padStart(2, '0'),
    restriction: { date, SOU: area, SUP: area, AEP: area },
  }));
  return {
    date,
    communes: Array.from({ length: 34943 }, (_, index) => ({
      code: String(index + 1).padStart(5, '0'),
      ...day(date),
    })),
    departments,
    statistic: {
      date,
      departementSituation: Object.fromEntries(
        departments.map(({ code }) => [
          code,
          { max: null, sou: null, sup: null, aep: null },
        ]),
      ),
    },
  };
}

describe('bounded November statistic recovery', () => {
  it('keeps all outside dates and values and is idempotent', () => {
    const previous = [
      day('2026-07-11', 'crise'),
      day('2026-11-12', 'vigilance'),
      day('2026-11-16', 'crise'),
    ];
    const imported = [
      day('2026-11-13', 'alerte'),
      day('2026-11-14', 'alerte_renforcee'),
      day('2026-11-15', 'crise'),
    ];
    const baseline = canonicalJson(previous);
    const merged = mergeRecoveryDays(previous, imported);
    expect(merged.added).toBe(3);
    expect(
      merged.value.filter(
        (entry) => !imported.some(({ date }) => date === entry.date),
      ),
    ).toEqual(previous);
    expect(canonicalJson(previous)).toBe(baseline);
    expect(mergeRecoveryDays(merged.value, imported)).toEqual({
      value: merged.value,
      added: 0,
    });
  });

  it('rejects divergent existing values and an attempt to overwrite the current day', () => {
    expect(() =>
      mergeRecoveryDays(
        [day('2026-11-13', 'crise')],
        [day('2026-11-13', 'alerte')],
      ),
    ).toThrow('diverges');
    expect(() => mergeRecoveryDays([], [day('2026-11-16')])).toThrow('outside');
    expect(() =>
      mergeRecoveryDays([day('2026-11-12'), day('2026-11-12')], []),
    ).toThrow('duplicated');
  });

  it('rejects invalid civil dates within November', () => {
    expect(() => mergeRecoveryDays([day('2026-11-31')], [])).toThrow('invalid');
    expect(() => mergeRecoveryDays([day('2026-11-00')], [])).toThrow('invalid');
  });

  it('rebuilds only November using preserved current and previous target days', () => {
    const months = [
      { date: '2026-07', ponderation: 17 },
      { date: '2026-10', ponderation: 4 },
      { date: '2026-11', ponderation: 4.5 },
    ];
    const days = [
      day('2026-11-12', 'vigilance'),
      day('2026-11-13', 'alerte'),
      day('2026-11-14', 'alerte_renforcee'),
      day('2026-11-15', 'crise'),
      day('2026-11-16', 'crise'),
    ];
    expect(recoverNovemberMonth(months, days)).toEqual([
      ...months.slice(0, 2),
      { date: '2026-11', ponderation: 13.5 },
    ]);
    expect(months[2].ponderation).toBe(4.5);
  });

  it('requires every commune, department and national department situation', () => {
    const source: any = NOVEMBER_RECOVERY_SOURCES[0];
    const complete = payload(source.date);
    expect(validateRecoveryPayload(complete, source).communes).toHaveLength(
      34943,
    );
    expect(() =>
      validateRecoveryPayload(
        { ...complete, communes: complete.communes.slice(1) },
        source,
      ),
    ).toThrow('34943');
    expect(() =>
      validateRecoveryPayload(
        {
          ...complete,
          communes: [...complete.communes.slice(1), complete.communes[1]],
        },
        source,
      ),
    ).toThrow('unique');
    expect(() =>
      validateRecoveryPayload(
        { ...complete, departments: complete.departments.slice(1) },
        source,
      ),
    ).toThrow('101');
    const national = structuredClone(complete.statistic);
    delete national.departementSituation['01'];
    expect(() =>
      validateRecoveryPayload({ ...complete, statistic: national }, source),
    ).toThrow('coverage');
    expect(() =>
      validateRecoveryPayload(
        { ...complete, statistic: { ...complete.statistic, visits: 0 } },
        source,
      ),
    ).toThrow('unexpected');
  });

  it('pins all backup/date pairs and verifies every payload hash', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'vigieau-november-manifest-'),
    );
    try {
      const sources = [];
      for (const source of NOVEMBER_RECOVERY_SOURCES) {
        const bytes = JSON.stringify(payload(source.date));
        const payloadFile = `${source.date}.json`;
        await writeFile(join(directory, payloadFile), bytes);
        sources.push({
          ...source,
          dumpSha256: 'a'.repeat(64),
          sourceDatabase: 'isolated_clone',
          sourceRevision: source.sourceRevision,
          historicComputeEpoch: source.historicComputeEpoch,
          geometryEvidenceSha256: 'b'.repeat(64),
          statisticInputDigest: 'f'.repeat(64),
          payloadFile,
          payloadSha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
      const path = join(directory, 'manifest.json');
      const manifest = {
        version: 1,
        runId: NOVEMBER_RECOVERY_RUN_ID,
        days: sources,
      };
      await writeFile(path, JSON.stringify(manifest));
      await expect(loadRecoveryBundle(path)).resolves.toHaveProperty(
        'days.length',
        3,
      );
      await writeFile(join(directory, sources[0].payloadFile), '{}');
      await expect(loadRecoveryBundle(path)).rejects.toThrow('digest mismatch');
      sources[0].backupId = sources[1].backupId;
      await writeFile(path, JSON.stringify(manifest));
      await expect(loadRecoveryBundle(path)).rejects.toThrow(
        'Wrong dated backup',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
