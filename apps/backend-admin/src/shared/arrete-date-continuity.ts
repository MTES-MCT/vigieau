import { StatutArreteCadre } from '@shared/types/arrete_cadre.type';
import {
  getParisSchedule,
  shiftCivilDate,
} from '../core/scheduling/daily-job-schedule';

export interface ArreteEndDateState {
  dateFin: string | null | undefined;
  dateFinSaisie: string | null | undefined;
  dateFinCalculee: boolean | null | undefined;
  dateFinSaisieConnue: boolean | null | undefined;
}

export interface ResolvedArreteEndDate {
  dateFin: string | null;
  dateFinSaisie: string | null;
  dateFinCalculee: boolean;
  dateFinSaisieConnue: boolean;
}

export interface ResolveArreteEndDateOptions {
  rejectUnknownExtension?: boolean;
}

export interface ArreteComputationState {
  dateDebut: string | null | undefined;
  dateFin: string | null | undefined;
  statut: StatutArreteCadre;
}

export interface HistoricStatisticRange {
  from: string;
  through: string | null;
}

export interface ArretePublicationState
  extends ArreteComputationState, ArreteEndDateState {}

export interface ArreteMutationVersion {
  updated_at?: Date | number | string | null;
}

export class UnknownArreteEndDateProvenanceError extends Error {
  constructor() {
    super(
      "La date de fin d'origine de l'arrêté remplacé n'est pas connue. La publication a été interrompue pour éviter de modifier cet arrêté sans base juridique.",
    );
  }
}

export function normalizeCivilDate(date: string): string {
  const civilDate = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(civilDate)) {
    throw new Error(`Invalid civil date: ${date}`);
  }
  const parsed = new Date(`${civilDate}T12:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== civilDate
  ) {
    throw new Error(`Invalid civil date: ${date}`);
  }
  return civilDate;
}

export function areCivilDatesEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (
    (left ? normalizeCivilDate(left) : null) ===
    (right ? normalizeCivilDate(right) : null)
  );
}

export function getCurrentParisCivilDate(now = new Date()): string {
  return getParisSchedule(now).date;
}

export function getArreteLifecycleStatus(
  dateDebut: string,
  dateFin: string | null | undefined,
  businessDate = getCurrentParisCivilDate(),
): StatutArreteCadre {
  const normalizedStart = normalizeCivilDate(dateDebut);
  const normalizedEnd = dateFin ? normalizeCivilDate(dateFin) : null;
  const normalizedBusinessDate = normalizeCivilDate(businessDate);

  if (normalizedStart > normalizedBusinessDate) {
    return 'a_venir';
  }
  if (normalizedEnd && normalizedEnd < normalizedBusinessDate) {
    return 'abroge';
  }
  return 'publie';
}

export interface ReconciledArreteLifecycleState {
  dateDebut: string;
  dateFin: string | null | undefined;
  dateFinCalculee: boolean | null | undefined;
  resolvedDateFin: string | null | undefined;
  statut: StatutArreteCadre;
}

export function getReconciledArreteLifecycleStatus(
  current: ReconciledArreteLifecycleState,
  businessDate = getCurrentParisCivilDate(),
): StatutArreteCadre {
  // On legacy rows, the persisted status can be the only evidence of repeal.
  if (
    current.statut === 'abroge' &&
    current.dateFinCalculee === false &&
    ((!current.dateFin && !current.resolvedDateFin) ||
      (!!current.dateFin &&
        !!current.resolvedDateFin &&
        normalizeCivilDate(current.dateFin) ===
          normalizeCivilDate(current.resolvedDateFin) &&
        normalizeCivilDate(current.dateFin) > normalizeCivilDate(businessDate)))
  ) {
    return 'abroge';
  }
  return getArreteLifecycleStatus(
    current.dateDebut,
    current.resolvedDateFin,
    businessDate,
  );
}

export function getPredecessorEndDateConstraint(
  successorStartDates: string[],
): string | null {
  if (successorStartDates.length === 0) {
    return null;
  }
  const earliestStart = successorStartDates.map(normalizeCivilDate).sort()[0];
  return shiftCivilDate(earliestStart, -1);
}

export function getPublicationEndDateProvenance(
  current: ArreteEndDateState,
  submittedEndDate: string | null,
): Pick<
  ResolvedArreteEndDate,
  'dateFinSaisie' | 'dateFinCalculee' | 'dateFinSaisieConnue'
> {
  if (areCivilDatesEqual(current.dateFin, submittedEndDate)) {
    return {
      dateFinSaisie: current.dateFinSaisie
        ? normalizeCivilDate(current.dateFinSaisie)
        : null,
      dateFinCalculee: current.dateFinCalculee === true,
      dateFinSaisieConnue: current.dateFinSaisieConnue !== false,
    };
  }
  return {
    dateFinSaisie: null,
    dateFinCalculee: false,
    dateFinSaisieConnue: true,
  };
}

export function hasArreteComputationStateChanged(
  before: ArreteComputationState,
  after: ArreteComputationState,
): boolean {
  return (
    (before.dateDebut ? normalizeCivilDate(before.dateDebut) : null) !==
      (after.dateDebut ? normalizeCivilDate(after.dateDebut) : null) ||
    (before.dateFin ? normalizeCivilDate(before.dateFin) : null) !==
      (after.dateFin ? normalizeCivilDate(after.dateFin) : null) ||
    before.statut !== after.statut
  );
}

export function getArreteHistoricStatisticRanges(
  before: ArreteComputationState | null,
  after: ArreteComputationState | null,
): HistoricStatisticRange[] {
  const boundaries = new Map<string, number>();
  const addBoundary = (date: string) => {
    boundaries.set(date, (boundaries.get(date) ?? 0) + 1);
  };

  for (const state of [before, after]) {
    if (!state) {
      continue;
    }
    const from =
      state.dateDebut === null || state.dateDebut === undefined
        ? null
        : normalizeCivilDate(state.dateDebut);
    const through =
      state.dateFin === null || state.dateFin === undefined
        ? null
        : normalizeCivilDate(state.dateFin);
    if (state.statut !== 'publie' && state.statut !== 'abroge') {
      continue;
    }
    if (!from || (through && through < from)) {
      continue;
    }
    addBoundary(from);
    if (through) {
      addBoundary(shiftCivilDate(through, 1));
    }
  }

  // Inclusive intervals become half-open boundaries; shared days cancel out.
  const ranges: HistoricStatisticRange[] = [];
  let from: string | null = null;
  for (const [date, count] of [...boundaries.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (count % 2 === 0) {
      continue;
    }
    if (from === null) {
      from = date;
    } else {
      ranges.push({ from, through: shiftCivilDate(date, -1) });
      from = null;
    }
  }
  if (from !== null) {
    ranges.push({ from, through: null });
  }
  return ranges;
}

export function hasArretePublicationStateChanged(
  before: ArretePublicationState,
  after: ArretePublicationState,
): boolean {
  return (
    hasArreteComputationStateChanged(before, after) ||
    !areCivilDatesEqual(before.dateFinSaisie, after.dateFinSaisie) ||
    (before.dateFinCalculee === true) !== (after.dateFinCalculee === true) ||
    (before.dateFinSaisieConnue !== false) !==
      (after.dateFinSaisieConnue !== false)
  );
}

export function hasArreteMutationVersionChanged(
  before: ArreteMutationVersion,
  after: ArreteMutationVersion,
): boolean {
  const normalizeVersion = (
    value: ArreteMutationVersion['updated_at'],
  ): number | null => {
    if (value === null || value === undefined) {
      return null;
    }
    const timestamp =
      value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  };

  return (
    normalizeVersion(before.updated_at) !== normalizeVersion(after.updated_at)
  );
}

function earliestDate(
  left: string | null,
  right: string | null,
): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left < right ? left : right;
}

export function resolveArreteEndDate(
  state: ArreteEndDateState,
  constraintEndDates: Array<string | null | undefined>,
  options: ResolveArreteEndDateOptions = {},
): ResolvedArreteEndDate {
  const currentEnd = state.dateFin ? normalizeCivilDate(state.dateFin) : null;
  const trackedSourceEnd = state.dateFinCalculee
    ? state.dateFinSaisie
      ? normalizeCivilDate(state.dateFinSaisie)
      : null
    : currentEnd;
  const sourceKnown = state.dateFinCalculee
    ? state.dateFinSaisieConnue !== false
    : true;
  const sourceEnd = sourceKnown ? trackedSourceEnd : currentEnd;
  const constraintEnd = constraintEndDates
    .filter((date): date is string => !!date)
    .map(normalizeCivilDate)
    .reduce<string | null>(earliestDate, null);
  const resolvedEnd = earliestDate(sourceEnd, constraintEnd);

  if (!sourceKnown) {
    // A migrated legacy boundary is only a classification, not evidence of
    // the originally entered legal end. Scheduled reconciliation must leave
    // it byte-for-byte unchanged; interactive mutations must be blocked when
    // their constraints would move it, until an operator confirms provenance.
    if (
      options.rejectUnknownExtension !== false &&
      !areCivilDatesEqual(currentEnd, constraintEnd)
    ) {
      throw new UnknownArreteEndDateProvenanceError();
    }
    return {
      dateFin: currentEnd,
      dateFinSaisie: state.dateFinSaisie
        ? normalizeCivilDate(state.dateFinSaisie)
        : null,
      dateFinCalculee: true,
      dateFinSaisieConnue: false,
    };
  }
  const isCalculated = resolvedEnd !== sourceEnd;
  return {
    dateFin: resolvedEnd,
    dateFinSaisie: isCalculated ? sourceEnd : null,
    dateFinCalculee: isCalculated,
    dateFinSaisieConnue: true,
  };
}
