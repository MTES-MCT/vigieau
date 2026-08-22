import {
  DATABASE_POOL_MAX_DEFAULT,
  parseDatabasePoolMax,
} from './database-pool';

describe('parseDatabasePoolMax', () => {
  it.each([undefined, '', '  '])('uses the default for %p', (value) => {
    expect(parseDatabasePoolMax(value)).toBe(DATABASE_POOL_MAX_DEFAULT);
  });

  it.each([
    ['1', 1],
    [' 2 ', 2],
    ['20', 20],
  ])('parses %p', (value, expected) => {
    expect(parseDatabasePoolMax(value)).toBe(expected);
  });

  it.each(['0', '-1', '1.5', 'abc', '21'])('rejects %p', (value) => {
    expect(() => parseDatabasePoolMax(value)).toThrow('DATABASE_POOL_MAX');
  });
});
