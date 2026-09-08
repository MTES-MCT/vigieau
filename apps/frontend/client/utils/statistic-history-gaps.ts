const DAY_MS = 24 * 60 * 60 * 1000;

// A daily observation can be 25 hours after the previous one at a DST change.
export const MAX_DAILY_STATISTIC_GAP_MS = 25 * 60 * 60 * 1000;

export interface MissingStatisticPeriod {
  start: string;
  end: string;
  days: number;
}

export function findMissingStatisticPeriods(series: { date: string }[] | null): MissingStatisticPeriod[] {
  const dates = [...new Set((series ?? []).map(({ date }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Number.NaN;
    }
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? timestamp : Number.NaN;
  }).filter(Number.isFinite))].sort((a, b) => a - b);
  const periods: MissingStatisticPeriod[] = [];

  for (let index = 1; index < dates.length; index++) {
    const previous = dates[index - 1];
    const current = dates[index];
    if (current - previous > DAY_MS) {
      periods.push({
        start: new Date(previous + DAY_MS).toISOString().slice(0, 10),
        end: new Date(current - DAY_MS).toISOString().slice(0, 10),
        days: (current - previous) / DAY_MS - 1,
      });
    }
  }
  return periods;
}
