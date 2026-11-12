export interface AuditRoute {
  method: string;
  path: string;
  action: string;
  label: string;
  mutation: boolean;
  resourceType: string;
  exempt?: string;
}

const entry = (
  method: string,
  path: string,
  action: string,
  label: string,
  mutation: boolean,
  resourceType: string,
): AuditRoute => ({ method, path, action, label, mutation, resourceType });

const orderRoutes = (
  path: string,
  type: string,
  label: string,
  publish: boolean,
): AuditRoute[] => [
  entry(
    'GET',
    `/${path}/search`,
    `${type}.list`,
    `Consultation des ${label}`,
    false,
    type,
  ),
  ...(publish
    ? [
        entry(
          'GET',
          `/${path}`,
          `${type}.list`,
          `Consultation des ${label}`,
          false,
          type,
        ),
      ]
    : []),
  entry(
    'GET',
    `/${path}/:id`,
    `${type}.read`,
    `Consultation d’un ${label}`,
    false,
    type,
  ),
  entry(
    'POST',
    `/${path}`,
    `${type}.create`,
    `Création d’un ${label}`,
    true,
    type,
  ),
  entry(
    'PATCH',
    `/${path}/:id`,
    `${type}.update`,
    `Modification d’un ${label}`,
    true,
    type,
  ),
  entry(
    'DELETE',
    `/${path}/:id`,
    `${type}.delete`,
    `Suppression d’un ${label}`,
    true,
    type,
  ),
  ...(publish
    ? [
        entry(
          'POST',
          `/${path}/:id/publier`,
          `${type}.publish`,
          `Publication d’un ${label}`,
          true,
          type,
        ),
        entry(
          'POST',
          `/${path}/:id/abroger`,
          `${type}.repeal`,
          `Abrogation d’un ${label}`,
          true,
          type,
        ),
      ]
    : []),
];

export const AUDIT_ROUTES: AuditRoute[] = [
  ...orderRoutes('arrete-cadre', 'arrete_cadre', 'arrêté cadre', true),
  ...orderRoutes(
    'arrete-restriction',
    'arrete_restriction',
    'arrêté de restriction',
    true,
  ),
  ...orderRoutes(
    'arrete-municipal',
    'arrete_municipal',
    'arrêté municipal',
    false,
  ),
  entry(
    'POST',
    '/arrete-restriction/:id/check',
    'arrete_restriction.check',
    'Vérification d’un arrêté',
    false,
    'arrete_restriction',
  ),
  entry(
    'GET',
    '/user/export',
    'user.export',
    'Export des utilisateurs',
    false,
    'user',
  ),
  entry(
    'GET',
    '/user',
    'user.list',
    'Consultation des utilisateurs',
    false,
    'user',
  ),
  entry(
    'POST',
    '/user',
    'user.create',
    'Création d’un utilisateur',
    true,
    'user',
  ),
  entry(
    'PATCH',
    '/user/:email',
    'user.update',
    'Modification d’un utilisateur',
    true,
    'user',
  ),
  entry(
    'DELETE',
    '/user/:email',
    'user.delete',
    'Suppression d’un utilisateur',
    true,
    'user',
  ),
  entry(
    'POST',
    '/user/check_rules',
    'user.check_rules',
    'Vérification des règles de gestion',
    true,
    'user',
  ),
  entry(
    'GET',
    '/parametres',
    'parametres.read',
    'Consultation des paramètres',
    false,
    'parametres',
  ),
  entry(
    'GET',
    '/parametres/:depCode',
    'parametres.read',
    'Consultation des paramètres départementaux',
    false,
    'parametres',
  ),
  entry(
    'POST',
    '/parametres/:depCode',
    'parametres.update',
    'Modification des paramètres départementaux',
    true,
    'parametres',
  ),
  entry(
    'GET',
    '/usage',
    'usage.list',
    'Consultation des usages',
    false,
    'usage',
  ),
  entry(
    'POST',
    '/usage',
    'usage.upsert',
    'Création ou modification d’un usage',
    true,
    'usage',
  ),
  entry(
    'GET',
    '/usage_feedback',
    'usage_feedback.list',
    'Consultation des retours usagers',
    false,
    'usage_feedback',
  ),
  entry(
    'GET',
    '/usage_feedback/search',
    'usage_feedback.list',
    'Recherche des retours usagers',
    false,
    'usage_feedback',
  ),
  entry(
    'DELETE',
    '/usage_feedback/:id',
    'usage_feedback.archive',
    'Archivage d’un retour usager',
    true,
    'usage_feedback',
  ),
  entry(
    'GET',
    '/fichier/:id/access',
    'fichier.access',
    'Demande d’accès à un document',
    false,
    'fichier',
  ),
  entry(
    'GET',
    '/audit-events',
    'audit.list',
    'Consultation du journal d’activité',
    false,
    'audit',
  ),
  entry(
    'GET',
    '/audit-events/:id',
    'audit.detail',
    'Consultation d’une action du journal',
    false,
    'audit',
  ),
  entry(
    'GET',
    '/auth/callback',
    'auth.login',
    'Connexion ProConnect',
    true,
    'user',
  ),
  entry(
    'GET',
    '/auth/login/dev/:email',
    'auth.login',
    'Connexion de développement',
    true,
    'user',
  ),
  entry('GET', '/auth/logout', 'auth.logout', 'Déconnexion', false, 'user'),
  entry(
    'GET',
    '/zone-alerte/arrete-cadre/:id',
    'zone_alerte.read',
    'Consultation des zones d’un arrêté',
    false,
    'arrete_cadre',
  ),
  entry(
    'GET',
    '/zone-alerte/operator/sandre',
    'zone_alerte.read',
    'Consultation du diagnostic SANDRE',
    false,
    'zone_alerte',
  ),
  entry(
    'GET',
    '/zone-alerte/:departementCode',
    'zone_alerte.read',
    'Consultation des zones départementales',
    false,
    'zone_alerte',
  ),
  ...[
    ['rollback', 'rollback', 'Retour à une publication précédente'],
    ['resume', 'resume', 'Reprise de la publication automatique'],
    [
      'availability/confirm-none',
      'confirm_none',
      'Certification de l’absence de zones',
    ],
    [
      'public-revision-mode',
      'revision_mode',
      'Modification du mode de révision',
    ],
  ].map(([path, action, label]) =>
    entry(
      'POST',
      `/zone-publication/${path}`,
      `zone_publication.${action}`,
      label,
      true,
      'zone_publication',
    ),
  ),
  entry(
    'POST',
    '/historic-backfill/prepare',
    'historic_backfill.prepare',
    'Préparation d’une reconstruction historique',
    true,
    'historic_backfill_run',
  ),
  entry(
    'GET',
    '/historic-backfill/:runId',
    'historic_backfill.read',
    'Consultation d’une reconstruction historique',
    false,
    'historic_backfill_run',
  ),
  ...[
    ['pause', 'pause', 'Pause d’une reconstruction historique'],
    ['resume', 'resume', 'Reprise d’une reconstruction historique'],
    [
      'artifacts/prepare',
      'artifacts_prepare',
      'Préparation des artefacts historiques',
    ],
    ['shadow/build', 'shadow_build', 'Construction du miroir historique'],
    [
      'shadow/department/build',
      'department_shadow_build',
      'Construction du miroir départemental',
    ],
    [
      'statistics/finalize',
      'statistics_finalize',
      'Finalisation des statistiques historiques',
    ],
    ['maps/finalize', 'maps_finalize', 'Finalisation des cartes historiques'],
  ].map(([path, action, label]) =>
    entry(
      'POST',
      `/historic-backfill/:runId/${path}`,
      `historic_backfill.${action}`,
      label,
      true,
      'historic_backfill_run',
    ),
  ),
];

export const AUDIT_EXEMPTIONS: AuditRoute[] = [
  ['POST', '/user/clearTestData'],
  ['POST', '/arrete-cadre/populateTestData'],
  ['POST', '/arrete-cadre/clearTestData'],
].map(([method, path]) => ({
  ...entry(method, path, 'test.fixture', 'Données de test', false, ''),
  exempt: 'Route de fixtures exclusivement protégée par DevGuard.',
}));
AUDIT_EXEMPTIONS.push({
  ...entry(
    'GET',
    '/zone-alerte/date',
    'technical.poll',
    'Vérification de publication',
    false,
    '',
  ),
  exempt: 'Rafraîchissement automatique de la version publiée.',
});

const normalize = (path: string) =>
  `/${path}`
    .replace(/\/{2,}/g, '/')
    .replace(/^\/api(?=\/|$)/, '')
    .replace(/\/$/, '') || '/';
export function matchAuditRoute(
  method: string,
  pathname: string,
): { route: AuditRoute; params: Record<string, string> } | undefined {
  const path = normalize(pathname.split('?')[0]);
  // Explicit exemptions and literal routes must precede :id patterns.
  const routes = [...AUDIT_EXEMPTIONS, ...AUDIT_ROUTES].sort(
    (a, b) => Number(a.path.includes(':')) - Number(b.path.includes(':')),
  );
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const names: string[] = [];
    const pattern = route.path
      .split('/')
      .map((part) =>
        part.startsWith(':')
          ? (names.push(part.slice(1)), '([^/]+)')
          : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('/');
    const match = new RegExp(`^${pattern}/?$`).exec(path);
    if (match) {
      const params: Record<string, string> = {};
      names.forEach((name, index) => {
        try {
          params[name] = decodeURIComponent(match[index + 1]).slice(0, 200);
        } catch {
          params[name] = '';
        }
      });
      return { route, params };
    }
  }
}

const SYSTEM_ACTION_LABELS: Record<string, string> = {
  'current_zone.recompute': 'Recalcul des zones en vigueur',
  'historic_backfill.execute': 'Exécution d’une reconstruction historique',
  'historic_backfill.artifact_execute': 'Production d’un artefact historique',
  'audit.purge': 'Purge des traces arrivées à expiration',
};
export const auditActionLabel = (action: string): string =>
  AUDIT_ROUTES.find((route) => route.action === action)?.label ??
  SYSTEM_ACTION_LABELS[action] ??
  action;

export const AUDIT_DRY_RUN_BY_DEFAULT = new Set([
  'zone_publication.rollback',
  'zone_publication.revision_mode',
  'historic_backfill.statistics_finalize',
  'historic_backfill.maps_finalize',
]);

/** Search text, signed links, auth query parameters and free text are excluded. */
export function auditRequestMetadata(
  query: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'page',
    'limit',
    'depCode',
    'departementCode',
    'sortBy',
    'filter.statut',
    'filter.departement.code',
  ]) {
    const value = query[key];
    if (
      typeof value === 'string' &&
      value.length <= 100 &&
      /^[\w.,: -]+$/.test(value)
    )
      result[key] = value;
  }
  if (typeof body?.apply === 'boolean') result.simulation = !body.apply;
  return result;
}
