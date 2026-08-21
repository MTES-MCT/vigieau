const PROFILE_LABELS = {
  particulier: 'Particulier',
  exploitation: 'Agriculteur',
  entreprise: 'Entreprise',
  collectivite: 'Collectivité',
} as const;

export interface DailyStatisticsRow {
  arreteDownloads: number;
  date: string;
  restrictionsSearch: number;
  visits: number;
}

export interface ProfileStatisticsRow {
  count: number;
  label: string;
  percentage: number;
  profile: string;
}

export function getDailyStatisticsRows(stats: any): DailyStatisticsRow[] {
  return (stats?.statsByDay || []).map((entry: any) => ({
    arreteDownloads: Number(entry.arreteDownloads || 0),
    date: String(entry.date),
    restrictionsSearch: Number(entry.restrictionsSearch || 0),
    visits: Number(entry.visits || 0),
  }));
}

export function getProfileStatisticsRows(stats: any): ProfileStatisticsRow[] {
  const counts = Object.keys(PROFILE_LABELS).map((profile) => ({
    count: Number(stats?.profileRepartition?.[profile] || 0),
    label: PROFILE_LABELS[profile as keyof typeof PROFILE_LABELS],
    profile,
  }));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);

  return counts.map((entry) => ({
    ...entry,
    percentage: total === 0 ? 0 : entry.count * 100 / total,
  }));
}
