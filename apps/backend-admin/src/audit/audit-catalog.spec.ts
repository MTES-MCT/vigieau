import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import {
  AUDIT_EXEMPTIONS,
  AUDIT_ROUTES,
  auditRequestMetadata,
  matchAuditRoute,
} from './audit-catalog';

function controllerFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = join(directory, entry.name);
    return entry.isDirectory()
      ? controllerFiles(name)
      : name.endsWith('.controller.ts')
        ? [name]
        : [];
  });
}
function decorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}
function argument(
  decorator: ts.Decorator,
): { name: string; path: string } | undefined {
  if (!ts.isCallExpression(decorator.expression)) return;
  const name = decorator.expression.expression.getText();
  const arg = decorator.expression.arguments[0];
  if (arg && !ts.isStringLiteral(arg)) return;
  return { name, path: arg ? (arg as ts.StringLiteral).text : '' };
}

describe('audit route contract', () => {
  it('covers every actual mutating controller route, including raw SQL operator commands', () => {
    const missing: string[] = [];
    for (const file of controllerFiles(join(__dirname, '..'))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      source.forEachChild((node) => {
        if (!ts.isClassDeclaration(node)) return;
        const controller = decorators(node)
          .map(argument)
          .find((item) => item?.name === 'Controller');
        if (!controller) return;
        for (const method of node.members) {
          for (const decorator of decorators(method)) {
            const route = argument(decorator);
            if (
              !route ||
              !['Post', 'Put', 'Patch', 'Delete'].includes(route.name)
            )
              continue;
            const path = `/${controller.path}/${route.path}`
              .replace(/\/{2,}/g, '/')
              .replace(/\/$/, '');
            const registered = [...AUDIT_ROUTES, ...AUDIT_EXEMPTIONS].find(
              (item) =>
                item.method === route.name.toUpperCase() && item.path === path,
            );
            if (!registered) missing.push(`${route.name} ${path}`);
            if (registered?.exempt)
              expect(
                [...decorators(node), ...decorators(method)].some((d) =>
                  d.getText().includes('DevGuard'),
                ),
              ).toBe(true);
          }
        }
      });
    }
    expect(missing).toEqual([]);
  });

  it('resolves business reads and literals before IDs and omits polling', () => {
    expect(
      matchAuditRoute('GET', '/api/user/export?search=secret')?.route.action,
    ).toBe('user.export');
    expect(
      matchAuditRoute('GET', '/api/arrete-cadre/search')?.route.action,
    ).toBe('arrete_cadre.list');
    expect(
      matchAuditRoute('GET', '/api/zone-alerte/date')?.route.exempt,
    ).toBeTruthy();
    expect(matchAuditRoute('GET', '/api/user/me')).toBeUndefined();
    expect(matchAuditRoute('GET', '/api/health/ready')).toBeUndefined();
    expect(
      matchAuditRoute('POST', '/api/arrete-restriction/42/check')?.route
        .mutation,
    ).toBe(false);
    expect(matchAuditRoute('GET', '/api/fichier/42/access')?.route.action).toBe(
      'fichier.access',
    );
  });

  it('never records free search text or OIDC callback query credentials', () => {
    expect(
      auditRequestMetadata(
        {
          code: 'secret',
          state: 'secret',
          search: 'personal name',
          page: '2',
          depCode: '33',
        },
        { password: 'secret', apply: false },
      ),
    ).toEqual({ page: '2', depCode: '33', simulation: true });
  });
});
