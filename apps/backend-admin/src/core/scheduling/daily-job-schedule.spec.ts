import { getCivilDateAtUtcNoon } from './daily-job-schedule';

describe('daily job schedule', () => {
  it('converts a civil date to strict UTC noon', () => {
    expect(getCivilDateAtUtcNoon('2026-08-02').toISOString()).toBe(
      '2026-08-02T12:00:00.000Z',
    );
  });

  it.each([
    '',
    '2026-8-02',
    '2026-08-2',
    '2026-02-29',
    '2026-02-31',
    '2026-13-01',
  ])('rejects invalid civil date %p', (civilDate) => {
    expect(() => getCivilDateAtUtcNoon(civilDate)).toThrow(
      `Invalid civil date: ${civilDate}`,
    );
  });
});
