export interface StatisticObservationStatus {
  date: string;
  dataStatus?: 'provisional';
  dataStatusReason?: 'historic-recalculation';
}

export interface ProvisionalStatisticPeriod {
  start: string;
  end: string;
  days: number;
}

export const isProvisionalStatistic = (row: StatisticObservationStatus | undefined): boolean =>
  row?.dataStatus === 'provisional';

export const getStatisticRowStatusLabel = (row: StatisticObservationStatus | undefined): string =>
  isProvisionalStatistic(row) ? 'Provisoire (recalcul en cours)' : 'Certifi\u00E9e';

export function findProvisionalStatisticPeriods(series: StatisticObservationStatus[] | null): ProvisionalStatisticPeriod[] {
  const dates = [...new Set((series ?? []).filter(isProvisionalStatistic).map(({ date }) => date))]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)
      && Number.isFinite(Date.parse(`${date}T00:00:00.000Z`))
      && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date)
    .sort();
  const periods: ProvisionalStatisticPeriod[] = [];
  for (const date of dates) {
    const last = periods.at(-1);
    if (last && Date.parse(date) - Date.parse(last.end) === 24 * 60 * 60 * 1000) {
      last.end = date;
      last.days += 1;
    } else {
      periods.push({ start: date, end: date, days: 1 });
    }
  }
  return periods;
}

export const getStatisticPointStyle = (row: StatisticObservationStatus | undefined): 'triangle' | 'circle' =>
  isProvisionalStatistic(row) ? 'triangle' : 'circle';
