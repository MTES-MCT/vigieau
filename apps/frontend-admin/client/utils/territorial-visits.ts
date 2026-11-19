interface DailyVisits {
  date: string;
  visits?: number | null;
}

export function aggregateTerritorialVisits(departments: { visits?: DailyVisits[] | null }[]) {
  const totals = new Map<string, number>();
  for (const department of departments) {
    const counted = new Set<string>();
    for (const { date, visits } of department.visits ?? []) {
      if (!counted.has(date)) {
        totals.set(date, (totals.get(date) ?? 0) + (visits || 0));
        counted.add(date);
      }
    }
  }
  return Array.from(totals, ([date, visits]) => ({ date, visits }))
    .filter(({ date }) => Number.isFinite(Date.parse(date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}
