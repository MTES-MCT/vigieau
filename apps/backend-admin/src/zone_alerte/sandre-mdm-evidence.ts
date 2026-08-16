import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { load } from 'cheerio';
import { fingerprint } from './sandre-zone-reconciliation';
import {
  SandreMdmNomenclatureExpectation,
  SandreMdmZoneExpectation,
} from './sandre-zone-sync-approvals';

export const SANDRE_MDM_ZONE_RECORD_BASE_URL =
  'https://mdm.sandre.eaufrance.fr/id/zonealertesechresse';
export const SANDRE_MDM_MAX_ZONE_RECORD_BYTES = 2 * 1024 * 1024;
export const SANDRE_MDM_NOMENCLATURE_NODE_BASE_URL =
  'https://mdm.sandre.eaufrance.fr/node';
export const SANDRE_MDM_MAX_NOMENCLATURE_BYTES = 512 * 1024;
export const SANDRE_MDM_PROOF_ATTEMPTS = 5;
export const SANDRE_MDM_PROOF_TIMEOUT_MS = 3 * 60 * 1000;

export class SandreMdmTransientError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SandreMdmTransientError';
    this.cause = cause;
  }
}

export class SandreMdmProofDeadlineExceededError extends Error {
  readonly cause?: unknown;

  constructor(message = 'Sandre MDM proof deadline exceeded', cause?: unknown) {
    super(message);
    this.name = 'SandreMdmProofDeadlineExceededError';
    this.cause = cause;
  }
}

export interface SandreMdmProofBudget {
  readonly expiresAt: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  assertRemaining(context?: string, cause?: unknown): number;
}

export interface SandreMdmProofRetryOptions {
  attempts?: number;
  timeoutMs?: number;
  now?: () => number;
}

export async function loadSandreMdmProofWithRetry<T>(
  loadProof: (budget: SandreMdmProofBudget) => Promise<T>,
  waitForRetry: (
    attempt: number,
    budget: SandreMdmProofBudget,
  ) => Promise<void>,
  options: SandreMdmProofRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? SANDRE_MDM_PROOF_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? SANDRE_MDM_PROOF_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Invalid Sandre MDM proof retry budget');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid Sandre MDM proof deadline');
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new Error('Invalid Sandre MDM monotonic clock');
  }
  const expiresAt = startedAt + timeoutMs;
  if (!Number.isFinite(expiresAt)) {
    throw new Error('Invalid Sandre MDM proof deadline');
  }
  const deadlineController = new AbortController();
  const remainingMs = (): number => {
    const observedAt = now();
    if (!Number.isFinite(observedAt)) {
      throw new Error('Invalid Sandre MDM monotonic clock');
    }
    return Math.max(0, Math.ceil(expiresAt - observedAt));
  };
  const budget: SandreMdmProofBudget = {
    expiresAt,
    signal: deadlineController.signal,
    remainingMs,
    assertRemaining: (context = 'before the next operation', cause) => {
      if (deadlineController.signal.aborted) {
        throw deadlineController.signal.reason;
      }
      const remaining = remainingMs();
      if (remaining <= 0) {
        throw new SandreMdmProofDeadlineExceededError(
          `Sandre MDM proof deadline exceeded ${context}`,
          cause,
        );
      }
      return remaining;
    },
  };
  let rejectAtDeadline!: (error: SandreMdmProofDeadlineExceededError) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectAtDeadline = reject;
  });
  const deadlineTimer = setTimeout(() => {
    const error = new SandreMdmProofDeadlineExceededError();
    deadlineController.abort(error);
    rejectAtDeadline(error);
  }, budget.assertRemaining('before arming the proof deadline'));
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      budget.assertRemaining(`before attempt ${attempt}`);
      try {
        return await Promise.race([loadProof(budget), deadline]);
      } catch (error) {
        if (!(error instanceof SandreMdmTransientError)) {
          throw error;
        }
        budget.assertRemaining(`after attempt ${attempt}`, error);
        if (attempt === attempts) {
          throw Object.assign(
            new Error(
              `Sandre MDM proof retry budget exhausted after ${attempts} attempts`,
            ),
            { cause: error },
          );
        }
        await Promise.race([waitForRetry(attempt, budget), deadline]);
      }
    }
    throw new Error('Sandre MDM proof retry budget exhausted');
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export interface SandreMdmTransportResponse {
  status: number;
  contentType: string | null;
  finalUrl: string;
  body: string;
}

export interface SandreMdmZoneRecordEvidence {
  codeSandre: string;
  url: string;
  byteLength: number;
  rawSha256: string;
  projection: 'zone_alert_evolution_v1';
  projectionSha256: string;
  requiredEvolution: SandreMdmZoneExpectation['requiredEvolution'];
}

export interface SandreMdmNomenclatureEvidence {
  url: string;
  byteLength: number;
  rawSha256: string;
  projection: {
    nid: string;
    nomenclatureCode: string;
    title: string;
    code: string;
    mnemonic: string;
  };
  projectionSha256: string;
}

export async function fetchSandreMdmZoneRecordEvidence(
  expectation: SandreMdmZoneExpectation,
  transport: (url: string) => Promise<SandreMdmTransportResponse>,
): Promise<SandreMdmZoneRecordEvidence> {
  if (!/^\d{1,32}$/.test(expectation.codeSandre)) {
    throw new Error('Invalid Sandre MDM zone code');
  }
  const url = `${SANDRE_MDM_ZONE_RECORD_BASE_URL}/${expectation.codeSandre}/json`;
  const response = await transport(url);
  if (
    response.status !== 200 ||
    response.finalUrl !== url ||
    response.contentType?.split(';', 1)[0].trim().toLowerCase() !==
      'application/json'
  ) {
    throw new Error(
      `Invalid Sandre MDM response for zone ${expectation.codeSandre}`,
    );
  }
  const byteLength = Buffer.byteLength(response.body, 'utf8');
  if (byteLength === 0 || byteLength > SANDRE_MDM_MAX_ZONE_RECORD_BYTES) {
    throw new Error(
      `Invalid Sandre MDM source size for zone ${expectation.codeSandre}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error(
      `Invalid Sandre MDM JSON for zone ${expectation.codeSandre}`,
    );
  }
  const projection = projectSandreMdmZoneRecord(parsed);
  const codeValues = projection.code as Array<Record<string, unknown>>;
  if (
    codeValues.length !== 1 ||
    codeValues[0]?.value !== expectation.codeSandre
  ) {
    throw new Error(
      `Sandre MDM zone code mismatch for ${expectation.codeSandre}`,
    );
  }
  const projectionSha256 = fingerprint(projection);
  if (projectionSha256 !== expectation.projectionSha256) {
    throw new Error(
      `Sandre MDM projection changed for zone ${expectation.codeSandre}`,
    );
  }
  if (expectation.requiredEvolution) {
    assertSandreMdmEvolution(projection, expectation.requiredEvolution);
  }
  return {
    codeSandre: expectation.codeSandre,
    url,
    byteLength,
    rawSha256: createHash('sha256').update(response.body).digest('hex'),
    projection: 'zone_alert_evolution_v1',
    projectionSha256,
    requiredEvolution: expectation.requiredEvolution,
  };
}

export async function fetchSandreMdmNomenclatureEvidence(
  expectation: SandreMdmNomenclatureExpectation,
  transport: (url: string) => Promise<SandreMdmTransportResponse>,
): Promise<SandreMdmNomenclatureEvidence> {
  const url = `${SANDRE_MDM_NOMENCLATURE_NODE_BASE_URL}/${expectation.nid}`;
  const response = await transport(url);
  const mediaType = response.contentType?.split(';', 1)[0].trim().toLowerCase();
  if (
    response.status !== 200 ||
    response.finalUrl !== url ||
    (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml')
  ) {
    throw new Error('Invalid Sandre MDM nomenclature response');
  }
  const byteLength = Buffer.byteLength(response.body, 'utf8');
  if (byteLength === 0 || byteLength > SANDRE_MDM_MAX_NOMENCLATURE_BYTES) {
    throw new Error('Invalid Sandre MDM nomenclature source size');
  }
  const projection = projectSandreMdmNomenclatureNode(
    response.body,
    expectation.nid,
    expectation.nomenclatureCode,
  );
  const projectionSha256 = fingerprint(projection);
  if (projectionSha256 !== expectation.projectionSha256) {
    throw new Error('Sandre MDM nomenclature projection changed');
  }
  return {
    url,
    byteLength,
    rawSha256: createHash('sha256').update(response.body).digest('hex'),
    projection,
    projectionSha256,
  };
}

export function projectSandreMdmNomenclatureNode(
  html: string,
  nid: string,
  nomenclatureCode: string,
): SandreMdmNomenclatureEvidence['projection'] {
  const $ = load(html);
  const root = $(`#node-${nid}.node-nsa_${nomenclatureCode}`);
  if (root.length !== 1) {
    throw new Error('Invalid Sandre MDM nomenclature root');
  }
  const titles = root.find('h2');
  if (titles.length !== 1) {
    throw new Error('Invalid Sandre MDM nomenclature title');
  }
  const fieldValue = (label: string): string => {
    const fields = root.find('.field').filter((_index, field) => {
      const labels = $(field).find('.field-label');
      return (
        labels.length === 1 &&
        labels.first().text().replace(/\s+/g, ' ').trim() === `${label}:`
      );
    });
    if (fields.length !== 1) {
      throw new Error(`Invalid Sandre MDM nomenclature field ${label}`);
    }
    const items = fields.first().find('.field-item');
    if (items.length !== 1) {
      throw new Error(`Invalid Sandre MDM nomenclature value ${label}`);
    }
    return items.first().text().replace(/\s+/g, ' ').trim();
  };
  return {
    nid,
    nomenclatureCode,
    title: titles.first().text().replace(/\s+/g, ' ').trim(),
    code: fieldValue('CdElement'),
    mnemonic: fieldValue('MnElement'),
  };
}

export function projectSandreMdmZoneRecord(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Sandre MDM zone record');
  }
  const record = value as Record<string, unknown>;
  const requiredKeys = [
    'nid',
    'title',
    'changed',
    'field_zas_cdzas',
    'field_zas_statutzas',
    'field_zas_typeevolution',
    'field_zas_dateevolution',
    'field_zas_comevolution',
    'field_zas_subitevolution',
    'field_zas_codealternatif',
    'field_zas_datecreazas',
    'field_zas_datemajzas',
  ];
  if (
    requiredKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key),
    ) ||
    typeof record.nid !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.changed !== 'string' ||
    requiredKeys
      .filter((key) => !['nid', 'title', 'changed'].includes(key))
      .some((key) => !Array.isArray(record[key]))
  ) {
    throw new Error('Incomplete Sandre MDM zone record');
  }
  return {
    nid: record.nid,
    title: record.title,
    changed: record.changed,
    code: record.field_zas_cdzas,
    status: record.field_zas_statutzas,
    evolutionTypes: record.field_zas_typeevolution,
    evolutionDates: record.field_zas_dateevolution,
    evolutionComments: record.field_zas_comevolution,
    undergoes: record.field_zas_subitevolution,
    alternate: record.field_zas_codealternatif,
    dateCreated: record.field_zas_datecreazas,
    dateUpdated: record.field_zas_datemajzas,
  };
}

function assertSandreMdmEvolution(
  projection: Record<string, unknown>,
  expected: NonNullable<SandreMdmZoneExpectation['requiredEvolution']>,
): void {
  const types = projection.evolutionTypes as Array<Record<string, unknown>>;
  const dates = projection.evolutionDates as Array<Record<string, unknown>>;
  const comments = projection.evolutionComments as Array<
    Record<string, unknown>
  >;
  if (types.length !== dates.length || types.length !== comments.length) {
    throw new Error('Sandre MDM evolution arrays are misaligned');
  }
  const matches = types.filter(
    (type, index) =>
      type?.nid === expected.typeNid &&
      dates[index]?.value === expected.date &&
      comments[index]?.value === expected.comment,
  );
  if (matches.length !== 1) {
    throw new Error('Expected exactly one Sandre MDM split evolution');
  }
}
