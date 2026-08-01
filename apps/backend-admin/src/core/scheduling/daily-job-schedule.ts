export const NATIONAL_DAILY_COMPUTE_JOB_KEY = 'compute:national-daily';
export const NATIONAL_HISTORIC_CATCHUP_JOB_KEY = 'compute:historic-catchup';

export interface ParisSchedule {
  date: string;
  hour: number;
}

export function getParisSchedule(now: Date): ParisSchedule {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
  };
}

export function shiftCivilDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function getScheduledCivilDate(now: Date, startHour: number): string {
  const schedule = getParisSchedule(now);
  return schedule.hour < startHour
    ? shiftCivilDate(schedule.date, -1)
    : schedule.date;
}
