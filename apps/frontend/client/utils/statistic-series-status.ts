import type { StatisticDataStatus } from '../dto/data-status.dto';
import type { MissingStatisticPeriod } from './statistic-history-gaps';
import type { ProvisionalStatisticPeriod, StatisticObservationStatus } from './statistic-provisional';

interface StatisticSeriesStatusContext {
  series: StatisticObservationStatus[] | null;
  waterType: string;
  loading?: boolean;
  missingPeriods: MissingStatisticPeriod[];
  provisionalPeriods: ProvisionalStatisticPeriod[];
}

interface StatisticSeriesStatusPresentation {
  title: string;
  description: string;
  type: 'info' | 'warning';
  details: string[];
}

const formatDate = (date: string): string => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`));

const periodDetail = (period: MissingStatisticPeriod | ProvisionalStatisticPeriod, provisional: boolean): string => {
  const dates = period.days === 1
    ? `Le ${formatDate(period.start)}`
    : `Du ${formatDate(period.start)} au ${formatDate(period.end)}`;
  const label = provisional ? 'de donn\u00E9es provisoires' : 'sans donn\u00E9e';
  return `${dates} : ${period.days} ${period.days === 1 ? 'jour' : 'jours'} ${label}.`;
};

export function getStatisticSeriesStatusPresentation(
  status: StatisticDataStatus | null,
  { series, waterType, loading, missingPeriods, provisionalPeriods }: StatisticSeriesStatusContext,
): StatisticSeriesStatusPresentation | null {
  if (loading || !series?.length) return null;

  const currentUpdating = status?.usable && !status.currentFresh && status.latestDate
    && series.some(({ date }) => date === status.latestDate);
  const waterHistoryLimited = (waterType === '' || waterType === 'AEP')
    && series.some(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < '2024-04-28');
  const currentDescription = 'Les donn\u00E9es affich\u00E9es restent consultables pendant leur actualisation.';
  const waterDescription = "Les donn\u00E9es sur l'eau potable ne sont pas disponibles avant le 28/04/2024.";
  const secondaryDetails = [
    ...(currentUpdating ? [currentDescription] : []),
    ...(waterHistoryLimited ? [waterDescription] : []),
  ];

  if (missingPeriods.length) {
    return {
      title: 'Donn\u00E9es manquantes',
      description: 'Les donn\u00E9es manquantes ne signifient pas une absence de restrictions.',
      type: 'warning',
      details: [
        ...missingPeriods.map((period) => periodDetail(period, false)),
        ...provisionalPeriods.map((period) => periodDetail(period, true)),
        ...secondaryDetails,
      ],
    };
  }

  if (provisionalPeriods.length) {
    const period = provisionalPeriods[0];
    const values = provisionalPeriods.length > 1
      ? 'Certaines valeurs'
      : `Les valeurs du ${formatDate(period.start)}${period.days > 1 ? ` au ${formatDate(period.end)}` : ''}`;
    return {
      title: 'Donn\u00E9es provisoires',
      description: `${values} restent consultables pendant leur recalcul et peuvent \u00E9voluer.`,
      type: 'info',
      details: [
        ...(provisionalPeriods.length > 1 ? provisionalPeriods.map((item) => periodDetail(item, true)) : []),
        ...secondaryDetails,
      ],
    };
  }

  if (currentUpdating) {
    return {
      title: 'Mise \u00E0 jour en cours',
      description: currentDescription,
      type: 'info',
      details: waterHistoryLimited ? [waterDescription] : [],
    };
  }

  if (waterHistoryLimited) {
    return {
      title: 'Donn\u00E9es historiques sur l\u2019eau potable limit\u00E9es',
      description: waterDescription,
      type: 'info',
      details: [],
    };
  }

  return null;
}
