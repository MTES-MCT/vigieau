import { getCivilDateAtUtcNoon } from './daily-job-schedule';

export interface HistoricRunIdentityContext {
  sourceRevision?: string;
  materializationVersion?: number;
}

export interface HistoricCursorStateInput {
  mapCursor?: string | Date | null;
  statsCursor?: string | Date | null;
  mapGeneration?: string | number | null;
  statsGeneration?: string | number | null;
}

export interface HistoricConfigStateInput {
  computeMapDate?: string | Date | null;
  computeStatsDate?: string | Date | null;
  computeMapGeneration?: string | number | null;
  computeStatsGeneration?: string | number | null;
}

export interface HistoricRunIdentity extends HistoricRunIdentityContext {
  historicMapCursor: string | null;
  historicStatsCursor: string | null;
  historicMapGeneration: string;
  historicStatsGeneration: string;
}

export function normalizeHistoricCursorDate(
  value: string | Date | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
  try {
    getCivilDateAtUtcNoon(normalized);
  } catch {
    throw new Error(`Invalid historic cursor date: ${String(value)}`);
  }
  return normalized;
}

export function buildHistoricRunIdentity(
  state: HistoricCursorStateInput,
  context: HistoricRunIdentityContext = {},
): HistoricRunIdentity {
  return {
    ...(context.sourceRevision === undefined
      ? {}
      : { sourceRevision: context.sourceRevision }),
    ...(context.materializationVersion === undefined
      ? {}
      : { materializationVersion: context.materializationVersion }),
    historicMapCursor: normalizeHistoricCursorDate(state.mapCursor),
    historicStatsCursor: normalizeHistoricCursorDate(state.statsCursor),
    historicMapGeneration: String(state.mapGeneration ?? 0),
    historicStatsGeneration: String(state.statsGeneration ?? 0),
  };
}

export function buildHistoricRunIdentityFromConfig(
  config: HistoricConfigStateInput,
  context: HistoricRunIdentityContext = {},
): HistoricRunIdentity {
  return buildHistoricRunIdentity(
    {
      mapCursor: config.computeMapDate,
      statsCursor: config.computeStatsDate,
      mapGeneration: config.computeMapGeneration,
      statsGeneration: config.computeStatsGeneration,
    },
    context,
  );
}
