import {
  CERTIFIED_PARAMETER_ANCHOR,
  CERTIFIED_PARAMETER_ANCHOR_DIGEST,
} from './certified-history-parameter-anchor';
import {
  canonicalEquivalenceJson,
  EquivalenceInput,
  equivalenceDigest,
  sourceEquivalenceEvidence,
} from './history-source-equivalence';

export const HISTORICAL_PARAMETER_STATUS_EQUIVALENCE_POLICY =
  'historic-parameter-disabled-irrelevant-v1';

export interface HistoricalParameterStatusChange {
  key: string;
  anchorDisabled: boolean;
  currentDisabled: boolean;
}

export interface HistoricalParameterStatusEquivalence {
  policy: typeof HISTORICAL_PARAMETER_STATUS_EQUIVALENCE_POLICY;
  rawInputDigest: string;
  rawParameterSectionDigest: string;
  anchorParameterSectionDigest: string;
  normalizedInputDigest: string;
  changes: HistoricalParameterStatusChange[];
}

export type HistoricalInputEvidence = ReturnType<
  typeof sourceEquivalenceEvidence
> & {
  parameterStatusEquivalence?: HistoricalParameterStatusEquivalence;
};

function sortedParameters(
  rows: readonly EquivalenceInput[],
): EquivalenceInput[] {
  return rows
    .filter((row) => row.section === 'parameters')
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function assertBooleanStatuses(rows: readonly EquivalenceInput[]): void {
  for (const row of rows) {
    if (typeof row.payload?.disabled !== 'boolean') {
      throw new Error(
        `Historical parameter ${row.key} has an invalid disabled flag`,
      );
    }
  }
}

/**
 * Historic parameter selection uses inclusive dates, never disabled. Preserve
 * every identifier, clipped interval, rule, and other input exactly. The anchor
 * itself must still hash to the original, independently verified section.
 */
export function normalizeHistoricalParameterStatuses(
  rows: readonly EquivalenceInput[],
  anchorRows: readonly EquivalenceInput[] = CERTIFIED_PARAMETER_ANCHOR,
): {
  rows: EquivalenceInput[];
  changes: HistoricalParameterStatusChange[];
  rawParameterSectionDigest: string;
} {
  const anchor = sortedParameters(anchorRows);
  if (
    anchorRows.length !== 110 ||
    anchor.length !== 110 ||
    equivalenceDigest(anchor) !== CERTIFIED_PARAMETER_ANCHOR_DIGEST
  ) {
    throw new Error('Certified historical parameter anchor digest mismatch');
  }
  assertBooleanStatuses(anchor);
  const parameters = sortedParameters(rows);
  assertBooleanStatuses(parameters);
  if (parameters.length !== anchor.length) {
    throw new Error(
      'Historical parameter coverage differs from the certified anchor',
    );
  }
  const normalizedByKey = new Map<string, EquivalenceInput>();
  const changes: HistoricalParameterStatusChange[] = [];
  for (let index = 0; index < anchor.length; index += 1) {
    const baseline = anchor[index];
    const current = parameters[index];
    if (current.key !== baseline.key || normalizedByKey.has(current.key)) {
      throw new Error(
        'Historical parameter identities differ from the certified anchor',
      );
    }
    const normalized = {
      ...current,
      payload: { ...current.payload, disabled: baseline.payload.disabled },
    };
    if (
      canonicalEquivalenceJson(normalized) !==
      canonicalEquivalenceJson(baseline)
    ) {
      throw new Error(
        `Historical parameter ${current.key} differs beyond disabled`,
      );
    }
    if (current.payload.disabled !== baseline.payload.disabled) {
      changes.push({
        key: current.key,
        anchorDisabled: baseline.payload.disabled as boolean,
        currentDisabled: current.payload.disabled as boolean,
      });
    }
    normalizedByKey.set(current.key, normalized);
  }
  return {
    rows: rows.map((row) =>
      row.section === 'parameters' ? normalizedByKey.get(row.key)! : row,
    ),
    changes,
    rawParameterSectionDigest: equivalenceDigest(parameters),
  };
}

export function historicalParameterStatusInputEvidence(
  rows: EquivalenceInput[],
  expectedAnchorInputDigest: string,
): HistoricalInputEvidence {
  assertBooleanStatuses(sortedParameters(rows));
  const raw = sourceEquivalenceEvidence(rows);
  if (raw.digest === expectedAnchorInputDigest) return raw;

  const normalized = normalizeHistoricalParameterStatuses(rows);
  const evidence = sourceEquivalenceEvidence(normalized.rows);
  if (evidence.digest !== expectedAnchorInputDigest) {
    throw new Error(
      'Historical source inputs differ from the certified anchor after parameter status normalization',
    );
  }
  return {
    ...evidence,
    policy: `${evidence.policy}+${HISTORICAL_PARAMETER_STATUS_EQUIVALENCE_POLICY}`,
    parameterStatusEquivalence: {
      policy: HISTORICAL_PARAMETER_STATUS_EQUIVALENCE_POLICY,
      rawInputDigest: raw.digest,
      rawParameterSectionDigest: normalized.rawParameterSectionDigest,
      anchorParameterSectionDigest: CERTIFIED_PARAMETER_ANCHOR_DIGEST,
      normalizedInputDigest: evidence.digest,
      changes: normalized.changes,
    },
  };
}
