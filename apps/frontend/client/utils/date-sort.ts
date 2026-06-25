type DatedItem = {
  date?: string | number | Date | null;
};

const dateValue = (date: DatedItem['date']): number => {
  const time = new Date(date ?? '').getTime();

  return Number.isNaN(time) ? 0 : time;
};

export const sortByDateDesc = <T extends DatedItem>(items: T[]): T[] => {
  return [...items].sort((a, b) => dateValue(b.date) - dateValue(a.date));
};
