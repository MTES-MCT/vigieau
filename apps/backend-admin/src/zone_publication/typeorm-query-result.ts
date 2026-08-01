export function unwrapTypeOrmDmlReturningRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) {
    throw new Error('Unexpected TypeORM DML result: expected an array');
  }

  if (
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    const [rows, affected] = result as [T[], number];
    if (rows.length !== affected) {
      throw new Error(
        `Unexpected TypeORM DML result: ${rows.length} returned rows for ${affected} affected rows`,
      );
    }
    return rows;
  }

  return result as T[];
}
