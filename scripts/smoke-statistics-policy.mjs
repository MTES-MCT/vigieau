const PARIS_TIME_ZONE = "Europe/Paris";
export const DEFAULT_STATISTICS_DEADLINE = "06:00";

function parseDeadline(deadline) {
  const match = /^(\d{2}):(\d{2})$/.exec(deadline);
  if (!match) {
    throw new Error("VIGIEAU_STATISTICS_DEADLINE must use the HH:mm format");
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error("VIGIEAU_STATISTICS_DEADLINE must be a valid Paris time");
  }
  return hour * 60 + minute;
}

function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function getStatisticFreshnessPolicy({
  now = new Date(),
  deadline = DEFAULT_STATISTICS_DEADLINE,
  maximumLagDays,
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("VIGIEAU_STATISTICS_NOW must be a valid date");
  }
  if (
    maximumLagDays !== undefined &&
    (!Number.isInteger(maximumLagDays) || maximumLagDays < 0)
  ) {
    throw new Error(
      "VIGIEAU_STATISTICS_MAXIMUM_LAG_DAYS must be a non-negative integer",
    );
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: PARIS_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
  const deadlineMinute = parseDeadline(deadline);
  const afterDeadline = currentMinute >= deadlineMinute;

  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    expectedPublishedDate: afterDeadline
      ? `${parts.year}-${parts.month}-${parts.day}`
      : shiftDate(`${parts.year}-${parts.month}-${parts.day}`, -1),
    deadline,
    afterDeadline,
    maximumLagDays: afterDeadline ? 0 : (maximumLagDays ?? 1),
  };
}
