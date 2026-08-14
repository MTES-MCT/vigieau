const PARIS_TIME_ZONE = 'Europe/Paris';

export const DEFAULT_STATISTIC_PUBLICATION_DEADLINE = '06:00';

export type StatisticPublicationExpectation = {
  today: string;
  expectedPublishedDate: string;
  deadline: string;
  afterDeadline: boolean;
};

function parseDeadline(deadline: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(deadline);
  if (!match) {
    throw new Error('STATISTIC_PUBLICATION_DEADLINE must use the HH:mm format');
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(
      'STATISTIC_PUBLICATION_DEADLINE must be a valid Paris time',
    );
  }
  return hour * 60 + minute;
}

function shiftIsoDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function getStatisticPublicationExpectation(
  now = new Date(),
  deadline = DEFAULT_STATISTIC_PUBLICATION_DEADLINE,
): StatisticPublicationExpectation {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Statistic publication health requires a valid date');
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: PARIS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
  const afterDeadline = currentMinute >= parseDeadline(deadline);

  return {
    today,
    expectedPublishedDate: afterDeadline ? today : shiftIsoDate(today, -1),
    deadline,
    afterDeadline,
  };
}

export function getPublicationLagDays(
  publishedDate: string | null,
  expectedPublishedDate: string,
): number | null {
  if (!publishedDate) {
    return null;
  }
  const difference = Math.round(
    (Date.parse(`${expectedPublishedDate}T00:00:00Z`) -
      Date.parse(`${publishedDate}T00:00:00Z`)) /
      86_400_000,
  );
  return Math.max(0, difference);
}
