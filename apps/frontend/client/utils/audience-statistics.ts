export function statisticCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function knownCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, count]) => statisticCount(count) !== null));
}

export function sumKnownCounts(values: unknown[]): number | null {
  const counts = values.map(statisticCount).filter((count): count is number => count !== null);
  return counts.length ? counts.reduce((sum, count) => sum + count, 0) : null;
}

export function statisticPercentage(count: unknown, total: unknown): string {
  const value = statisticCount(count);
  const sum = statisticCount(total);
  return value !== null && sum !== null && sum > 0
    ? `${((value * 100) / sum).toFixed(2)}%`
    : 'Non disponible';
}

export function repartitionScale(repartition: Record<string, number>) {
  const counts = Object.values(repartition);
  return counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null;
}

export function repartitionColor(count: number, scale: { min: number; max: number }): string {
  const ratio = scale.max === scale.min ? (scale.max > 0 ? 1 : 0) : (count - scale.min) / (scale.max - scale.min);
  return `rgb(${Math.round(255 - ratio * 206)}, ${Math.round(255 - ratio * 206)}, ${Math.round(255 - ratio * 135)})`;
}

function statisticDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function normalizeAudienceStatistics(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const days = Array.isArray(source.statsByDay) ? source.statsByDay : [];
  const statsByDay = days.filter((day) => day && statisticDate(day.date)).map((day) => ({
    date: day.date,
    visits: statisticCount(day.visits),
    restrictionsSearch: statisticCount(day.restrictionsSearch),
    arreteDownloads: statisticCount(day.arreteDownloads),
  }));
  const observedDates = statsByDay.filter(day => [day.visits, day.restrictionsSearch, day.arreteDownloads].some(count => count !== null))
    .map(day => day.date).sort();
  const period = source.period as { from?: string; to?: string } | null;
  const from = statisticDate(period?.from);
  const to = statisticDate(period?.to);
  return {
    subscriptions: statisticCount(source.subscriptions),
    profileRepartition: knownCounts(source.profileRepartition),
    departementRepartition: knownCounts(source.departementRepartition),
    regionRepartition: knownCounts(source.regionRepartition),
    statsByDay,
    period: from && to && from <= to ? { from, to }
      : observedDates.length ? { from: observedDates[0], to: observedDates.at(-1)! } : null,
    lastDataDate: statisticDate(source.lastDataDate) || observedDates.at(-1) || null,
    stale: source.stale === true,
    partial: source.partial === true,
  };
}
