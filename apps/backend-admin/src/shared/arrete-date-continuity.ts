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

export interface ArreteMutationVersion {
  updated_at?: Date | number | string | null;
}

export class UnknownArreteEndDateProvenanceError extends Error {
  constructor() {
    super(
      "La date de fin d'origine de l'arrêté remplacé n'est pas connue. La publication a été interrompue pour éviter de prolonger cet arrêté sans base juridique.",
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
  // For legacy calculated boundaries, dateFinSaisie is the last conservative
  // ceiling known at migration time. It may be restored after a later
  // shortening, but it must never be exceeded without a verified legal end.
  const sourceEnd = sourceKnown
    ? trackedSourceEnd
    : (trackedSourceEnd ?? currentEnd);
  const constraintEnd = constraintEndDates
    .filter((date): date is string => !!date)
    .map(normalizeCivilDate)
    .reduce<string | null>(earliestDate, null);
  const resolvedEnd = earliestDate(sourceEnd, constraintEnd);

  if (
    options.rejectUnknownExtension !== false &&
    !sourceKnown &&
    sourceEnd &&
    constraintEnd &&
    constraintEnd > sourceEnd
  ) {
    throw new UnknownArreteEndDateProvenanceError();
  }

  if (!sourceKnown) {
    return {
      dateFin: resolvedEnd,
      dateFinSaisie: sourceEnd,
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
