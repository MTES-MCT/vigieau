import {
  CERTIFIED_PARAMETER_ANCHOR,
  CERTIFIED_PARAMETER_ANCHOR_DIGEST,
} from './certified-history-parameter-anchor';
import {
  HISTORICAL_PARAMETER_STATUS_EQUIVALENCE_POLICY,
  historicalParameterStatusInputEvidence,
  normalizeHistoricalParameterStatuses,
} from './history-parameter-status-equivalence';
import {
  canonicalEquivalenceJson,
  EquivalenceInput,
  sourceEquivalenceEvidence,
} from './history-source-equivalence';

function parameters(): EquivalenceInput[] {
  return structuredClone(CERTIFIED_PARAMETER_ANCHOR) as EquivalenceInput[];
}

function fullSource(): EquivalenceInput[] {
  const row = (section: string, key: string): EquivalenceInput => ({
    section,
    key,
    department: '01',
    payload: { disabled: false },
  });
  return [
    ...parameters(),
    ...['orders', 'zones', 'frameworkZoneCommunes', 'regions', 'basins'].map(
      (section) => row(section, '1'),
    ),
    ...Array.from({ length: 34943 }, (_, index) =>
      row('communes', String(index + 1)),
    ),
    ...Array.from({ length: 101 }, (_, index) =>
      row('departments', String(index + 1)),
    ),
  ];
}

function closeParameter398(rows: EquivalenceInput[]): EquivalenceInput[] {
  return rows.map((row) =>
    row.section === 'parameters' && row.key === '398'
      ? { ...row, payload: { ...row.payload, disabled: true } }
      : row,
  );
}

describe('historical parameter status equivalence', () => {
  const original = fullSource();
  const anchorEvidence = sourceEquivalenceEvidence(original);

  it('returns the exact original evidence without a normalization claim', () => {
    expect(
      historicalParameterStatusInputEvidence(original, anchorEvidence.digest),
    ).toEqual(anchorEvidence);
  });

  it('proves only the administrative status change against the original anchor', () => {
    const current = closeParameter398(original);
    const before = canonicalEquivalenceJson(current);
    for (const row of current) {
      Object.freeze(row.payload);
      Object.freeze(row);
    }
    Object.freeze(current);
    const raw = sourceEquivalenceEvidence(current);
    const actual = historicalParameterStatusInputEvidence(
      current,
      anchorEvidence.digest,
    );
    expect(actual).toEqual({
      ...anchorEvidence,
      policy: `${anchorEvidence.policy}+${HISTORICAL_PARAMETER_STATUS_EQUIVALENCE_POLICY}`,
      parameterStatusEquivalence: {
        policy: HISTORICAL_PARAMETER_STATUS_EQUIVALENCE_POLICY,
        rawInputDigest: raw.digest,
        rawParameterSectionDigest: raw.sections.parameters.digest,
        anchorParameterSectionDigest: CERTIFIED_PARAMETER_ANCHOR_DIGEST,
        normalizedInputDigest: anchorEvidence.digest,
        changes: [{ key: '398', anchorDisabled: false, currentDisabled: true }],
      },
    });
    expect(actual.parameterStatusEquivalence!.rawInputDigest).not.toBe(
      actual.digest,
    );
    expect(canonicalEquivalenceJson(current)).toBe(before);
  });

  it.each([null, undefined, 'true', 1, {}])(
    'rejects a non-boolean disabled flag (%p)',
    (disabled) => {
      const rows = parameters();
      rows[0].payload.disabled = disabled;
      expect(() => normalizeHistoricalParameterStatuses(rows)).toThrow(
        'invalid disabled flag',
      );
    },
  );

  it('rejects invalid status flags even when a caller supplies their raw digest', () => {
    const rows = fullSource();
    rows[0].payload.disabled = 'false';
    expect(() =>
      historicalParameterStatusInputEvidence(
        rows,
        sourceEquivalenceEvidence(rows).digest,
      ),
    ).toThrow('invalid disabled flag');
  });

  it('rejects a tampered injectable baseline against the fixed cryptographic anchor', () => {
    const tampered = parameters();
    tampered.find((row) => row.key === '398')!.payload.disabled = true;
    expect(() =>
      normalizeHistoricalParameterStatuses(parameters(), tampered),
    ).toThrow('anchor digest mismatch');
    expect(() =>
      normalizeHistoricalParameterStatuses(parameters(), parameters().slice(1)),
    ).toThrow('anchor digest mismatch');
  });

  it.each([
    ['superpositionCommune', 'no_all'],
    ['from', '2026-08-14'],
    ['through', '2026-08-30'],
    ['unexpectedMetadata', true],
  ])('rejects changes to parameter payload field %s', (field, value) => {
    const rows = closeParameter398(parameters());
    rows.find((row) => row.key === '398')!.payload[field] = value;
    expect(() => normalizeHistoricalParameterStatuses(rows)).toThrow(
      'differs beyond disabled',
    );
  });

  it('rejects changed departments, keys, missing rows, duplicate rows and renamed sections', () => {
    const rows = parameters();
    rows[0].department = 'unknown';
    expect(() => normalizeHistoricalParameterStatuses(rows)).toThrow(
      'differs beyond disabled',
    );
    rows[0] = { ...parameters()[0], key: '999999' };
    expect(() => normalizeHistoricalParameterStatuses(rows)).toThrow(
      'identities differ',
    );
    expect(() =>
      normalizeHistoricalParameterStatuses(parameters().slice(1)),
    ).toThrow('coverage differs');
    const duplicate = parameters();
    duplicate[1] = duplicate[0];
    expect(() => normalizeHistoricalParameterStatuses(duplicate)).toThrow(
      'identities differ',
    );
    rows[0] = { ...parameters()[0], section: 'orders' };
    expect(() => normalizeHistoricalParameterStatuses(rows)).toThrow(
      'coverage differs',
    );
  });

  it.each([
    'orders',
    'zones',
    'frameworkZoneCommunes',
    'communes',
    'departments',
    'regions',
    'basins',
  ])('keeps %s strictly pinned, including zone.disabled', (section) => {
    const rows = closeParameter398(fullSource());
    rows.find((row) => row.section === section)!.payload.disabled = true;
    expect(() =>
      historicalParameterStatusInputEvidence(rows, anchorEvidence.digest),
    ).toThrow('inputs differ from the certified anchor');
  });

  it('still requires full national and source section coverage', () => {
    expect(() =>
      historicalParameterStatusInputEvidence(
        closeParameter398(original.filter((row) => row.section !== 'orders')),
        anchorEvidence.digest,
      ),
    ).toThrow('Missing source section orders');
    expect(() =>
      historicalParameterStatusInputEvidence(
        closeParameter398(
          original.filter(
            (row) => row.section !== 'communes' || row.key !== '1',
          ),
        ),
        anchorEvidence.digest,
      ),
    ).toThrow('Incomplete national source coverage');
  });

  it('preserves the original anchor when no permitted normalization explains the mismatch', () => {
    expect(() =>
      historicalParameterStatusInputEvidence(original, '0'.repeat(64)),
    ).toThrow('inputs differ from the certified anchor');
  });
});
