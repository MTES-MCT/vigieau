import { exportUsersCsv, filterExportUsers } from './user-export';

describe('audited server-side user export', () => {
  const users = [
    {
      email: 'lea@example.test',
      first_name: 'Léa',
      last_name: 'Du-Pont',
      role: 'departement',
      role_departements: ['33'],
    },
    {
      email: 'paul@example.test',
      first_name: 'Paul',
      last_name: 'Martin',
      role: 'commune',
      role_communes: ['75056'],
    },
  ] as any;
  it('filters only the already authorized collection, without treating input as a regexp', () => {
    expect(filterExportUsers(users, 'léa')[0].email).toBe('lea@example.test');
    expect(filterExportUsers(users, 'du pont')[0].email).toBe(
      'lea@example.test',
    );
    expect(filterExportUsers(users, '75056')[0].email).toBe(
      'paul@example.test',
    );
    expect(filterExportUsers(users, '.*')).toEqual([]);
    expect(filterExportUsers([], '')).toEqual([]);
  });
  it('escapes quotes, newlines and formula prefixes', () => {
    const csv = exportUsersCsv([
      {
        last_name: '=WEBSERVICE("x")',
        first_name: 'A,"B"\nC',
        email: '@example',
        role: 'mte',
      },
    ] as any);
    expect(csv).toContain('"\'=WEBSERVICE(""x"")"');
    expect(csv).toContain('"A,""B""\nC"');
    expect(csv).toContain('"\'@example"');
    expect(csv).not.toContain('undefined');
  });
});
