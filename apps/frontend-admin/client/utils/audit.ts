import { DateTime } from 'luxon';

export interface AuditFilters {
  from: string;
  to: string;
  actor: string;
  action: string;
  result: string;
  resourceType: string;
  resourceId: string;
  departement: string;
}

export const auditResultLabels: Record<string, string> = {
  started: 'En cours',
  accepted: 'Traitement accepté',
  applied: 'Changements enregistrés',
  read: 'Consultation réussie',
  succeeded: 'Réussie',
  failed: 'Échouée',
  denied: 'Refusée',
  partial: 'Partielle',
  unknown: 'Issue non confirmée',
  simulated: 'Simulation',
  simulation: 'Simulation',
};

export const auditResourceLabels: Record<string, string> = {
  arrete_cadre: 'Arrêté cadre',
  arrete_restriction: 'Arrêté de restriction',
  arrete_municipal: 'Arrêté municipal',
  restriction: 'Restriction',
  user: 'Utilisateur',
  parametres: 'Paramètres départementaux',
  usage: 'Usage',
  usage_feedback: 'Retour usager',
  fichier: 'Document',
  zone_alerte: 'Zone d’alerte',
  zone_publication: 'Publication des zones',
  historic_backfill: 'Reconstruction historique',
  audit: 'Journal d’activité',
};

const commonActions: Record<string, string> = {
  create: 'Création',
  update: 'Modification',
  publish: 'Publication',
  repeal: 'Abrogation',
  delete: 'Suppression',
  read: 'Consultation',
  list: 'Consultation de la liste',
};
const orderActions = Object.keys(commonActions);
export const auditActionGroups = [
  { label: 'Authentification', prefix: 'auth', actions: { login: 'Connexion', logout: 'Déconnexion' } },
  ...['arrete_cadre', 'arrete_restriction', 'arrete_municipal'].map((prefix) => ({
    label: auditResourceLabels[prefix],
    prefix,
    actions: Object.fromEntries(
      orderActions
        .filter((action) => prefix !== 'arrete_municipal' || !['publish', 'repeal'].includes(action))
        .map((action) => [action, commonActions[action]]),
    ),
  })),
  {
    label: 'Utilisateurs',
    prefix: 'user',
    actions: {
      create: 'Création',
      update: 'Modification des droits',
      delete: 'Suppression',
      list: 'Consultation',
      export: 'Export CSV',
      check_rules: 'Vérification des règles',
    },
  },
  { label: 'Paramètres', prefix: 'parametres', actions: { read: 'Consultation', update: 'Modification' } },
  { label: 'Usages', prefix: 'usage', actions: { list: 'Consultation', upsert: 'Création ou modification' } },
  { label: 'Retours usagers', prefix: 'usage_feedback', actions: { list: 'Consultation', archive: 'Archivage' } },
  { label: 'Documents', prefix: 'fichier', actions: { access: 'Demande d’accès' } },
  { label: 'Journal d’activité', prefix: 'audit', actions: { list: 'Consultation du journal', detail: 'Consultation d’un détail' } },
  {
    label: 'Publication des zones',
    prefix: 'zone_publication',
    actions: {
      rollback: 'Retour à une publication précédente',
      resume: 'Reprise',
      confirm_none: 'Certification d’absence de zones',
      revision_mode: 'Modification du mode de révision',
    },
  },
  {
    label: 'Reconstruction historique',
    prefix: 'historic_backfill',
    actions: {
      prepare: 'Préparation',
      pause: 'Pause',
      resume: 'Reprise',
      artifacts_prepare: 'Préparation des artefacts',
      shadow_build: 'Reconstruction des communes',
      department_shadow_build: 'Reconstruction des départements',
      statistics_finalize: 'Finalisation des statistiques',
      maps_finalize: 'Finalisation des cartes',
      read: 'Consultation',
    },
  },
];

const fieldLabels: Record<string, string> = {
  numero: 'Numéro',
  nom: 'Nom',
  statut: 'Statut',
  date_debut: 'Date de début',
  dateDebut: 'Date de début',
  date_fin: 'Date de fin',
  dateFin: 'Date de fin',
  date_signature: 'Date de signature',
  dateSignature: 'Date de signature',
  dateFinSaisie: 'Date de fin saisie',
  dateFinCalculee: 'Date de fin calculée',
  niveau_gravite: 'Niveau de gravité',
  niveauGravite: 'Niveau de gravité',
  email: 'E-mail',
  first_name: 'Prénom',
  last_name: 'Nom',
  role: 'Rôle',
  role_departement: 'Département',
  role_departements: 'Départements autorisés',
  role_communes: 'Communes autorisées',
  check_rules: 'Vérification des règles',
  fichierId: 'Document',
  arreteCadreId: 'Arrêté cadre',
  arreteRestrictionId: 'Arrêté de restriction',
  zoneAlerteId: 'Zone d’alerte',
  communeId: 'Commune',
  departementId: 'Département',
  usageId: 'Usage',
  size: 'Taille (octets)',
  archive: 'Archivé',
  archived: 'Archivé',
  active: 'Actif',
  sha256: 'Empreinte du document',
};

export const auditFieldLabel = (field: string) => fieldLabels[field] || field.replace(/_/g, ' ');
export const auditResultLabel = (result: string) => auditResultLabels[result] || result;
export const auditResourceLabel = (resource: string) => auditResourceLabels[resource] || resource;
export const auditActorLabel = (email?: string, source?: string) => email || (source === 'system' ? 'Système' : 'Auteur non identifié');

export function formatAuditDate(value: string): string {
  const date = DateTime.fromISO(value, { zone: 'utc' });
  return date.isValid ? date.setZone('Europe/Paris').setLocale('fr').toFormat('dd/MM/yyyy à HH:mm:ss') : 'Date inconnue';
}

export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (Array.isArray(value)) return value.length ? value.map(formatAuditValue).join(', ') : 'Aucun';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export function defaultAuditFilters(now = new Date()): AuditFilters {
  const today = DateTime.fromJSDate(now, { zone: 'Europe/Paris' });
  return {
    from: today.minus({ days: 29 }).toISODate(),
    to: today.toISODate(),
    actor: '',
    action: '',
    result: '',
    resourceType: '',
    resourceId: '',
    departement: '',
  };
}

export function auditFiltersQuery(filters: AuditFilters, cursor: string | null = null): string {
  const params = new URLSearchParams({ limit: '50' });
  for (const key of ['from', 'to'] as const) {
    const value = filters[key];
    if (!value) continue;
    const date = DateTime.fromISO(value, { zone: 'Europe/Paris' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !date.isValid) throw new Error('La période saisie est invalide.');
    params.set(key, (key === 'from' ? date.startOf('day') : date.endOf('day')).toUTC().toISO());
  }
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('La date de début doit précéder la date de fin.');
  for (const key of ['actor', 'action', 'result', 'resourceType', 'resourceId', 'departement'] as const) {
    if (filters[key].trim()) params.set(key, filters[key].trim());
  }
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function fileAccessUrl(id: unknown): string {
  const value = String(id ?? '');
  return /^[1-9]\d*$/.test(value) ? `/api/fichier/${value}/access` : '';
}

export function userExportUrl(search: string): string {
  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  return `/api/user/export${params.size ? `?${params}` : ''}`;
}

export function matchesUserSearch(
  user: { lastName?: string; firstName?: string; email?: string; roleDepartements?: string[]; roleCommunes?: string[] },
  search: string,
): boolean {
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[-_]/g, '').toLocaleLowerCase('fr');
  const words = normalize(search).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return [user.lastName, user.firstName, user.email, user.roleDepartements?.join(' '), user.roleCommunes?.join(' ')].some((value) => {
    const field = normalize(value || '');
    return words.every((word) => field.includes(word));
  });
}
