import { unwrapTypeOrmDmlReturningRows } from './typeorm-query-result';

describe('unwrapTypeOrmDmlReturningRows', () => {
  it('unwraps the PostgreSQL UPDATE and DELETE result returned by TypeORM', () => {
    const rows = [{ id: 'publication-id' }];

    expect(unwrapTypeOrmDmlReturningRows([rows, 1])).toEqual(rows);
    expect(unwrapTypeOrmDmlReturningRows([[], 0])).toEqual([]);
  });

  it('keeps flat rows used by existing query mocks', () => {
    const rows = [{ id: 'publication-id' }];

    expect(unwrapTypeOrmDmlReturningRows(rows)).toEqual(rows);
    expect(unwrapTypeOrmDmlReturningRows([])).toEqual([]);
  });

  it('rejects inconsistent TypeORM affected-row metadata', () => {
    expect(() =>
      unwrapTypeOrmDmlReturningRows([[{ id: 'publication-id' }], 2]),
    ).toThrow('1 returned rows for 2 affected rows');
  });
});
