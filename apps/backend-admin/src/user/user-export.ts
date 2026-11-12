import { User } from '@shared/entities/user.entity';

export function normalizeUserSearch(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[-_]/g, '')
    .toLocaleLowerCase('fr');
}

export function filterExportUsers(users: User[], search = ''): User[] {
  const words = normalizeUserSearch(search).split(/\s+/).filter(Boolean);
  return users.filter((user) => {
    const values = [
      user.last_name,
      user.first_name,
      user.email,
      user.role_departements?.join(' '),
      user.role_communes?.join(' '),
    ].map(normalizeUserSearch);
    return (
      words.length === 0 ||
      values.some((value) => words.every((word) => value.includes(word)))
    );
  });
}

function csvCell(value: unknown): string {
  let text = String(value ?? '');
  // CSV is opened in spreadsheet software: never turn account data into formulas.
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportUsersCsv(users: User[]): string {
  return (
    '\uFEFF' +
    [
      ['Nom', 'Prénom', 'Email', 'Rôle'],
      ...users.map((user) => [
        user.last_name,
        user.first_name,
        user.email,
        user.role,
      ]),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n')
  );
}
