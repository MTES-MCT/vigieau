<script setup lang="ts">
import type { AuditDetail, AuditResource, AuditRow } from '~/dto/audit.dto';
import { auditActorLabel, auditFieldLabel, auditResourceLabel, auditResultLabel, formatAuditDate, formatAuditValue } from '~/utils/audit';

defineProps<{ detail: AuditDetail }>();
defineEmits<{ openOperation: [operation: AuditRow] }>();
const fields = (resource: AuditResource) =>
  resource.changedFields?.length
    ? resource.changedFields
    : [...new Set([...Object.keys(resource.before || {}), ...Object.keys(resource.after || {})])];
const metadataLabels: Record<string, string> = {
  httpStatus: 'Statut HTTP',
  durationMs: 'Durée (ms)',
  errorCode: 'Code d’erreur',
  stage: 'Étape',
  outcome: 'Résultat métier',
  externalOutcome: 'Résultat externe',
  returnedCount: 'Nombre de résultats',
  fileName: 'Document',
  size: 'Taille (octets)',
  mimeType: 'Type de document',
  sha256: 'Empreinte SHA-256',
  verdict: 'Résultat antivirus',
  engineVersion: 'Version de l’antivirus',
  networkAddress: 'Adresse réseau observée par l’API',
  userAgent: 'Navigateur',
  responseClosed: 'Connexion interrompue',
};
const visibleMetadata = (metadata: Record<string, unknown> = {}) =>
  Object.entries(metadata).filter(([key, value]) => metadataLabels[key] && value !== null && value !== undefined);
</script>

<template>
  <div class="audit-detail">
    <h3>{{ detail.actionLabel || detail.action }}</h3>
    <p>
      {{ auditActorLabel(detail.actor?.email, detail.source) }} — {{ formatAuditDate(detail.occurredAt) }} —
      <strong><span v-if="detail.simulation">Simulation — </span>{{ auditResultLabel(detail.result) }}</strong>
    </p>
    <p v-if="detail.result === 'unknown'">Le résultat n’a pas été confirmé. Cela ne signifie pas qu’aucune modification n’a eu lieu.</p>
    <p v-if="detail.result === 'partial'">Certaines étapes ont été enregistrées, mais l’opération n’a pas entièrement abouti.</p>
    <p v-if="detail.action === 'fichier.access'">
      Cette trace correspond à une demande d’accès au document. Elle ne prouve pas sa lecture.
    </p>
    <p v-if="detail.resourceCount">{{ detail.resources.length }} ressource(s) affichée(s) sur {{ detail.resourceCount }}.</p>
    <p v-if="detail.actor?.role">
      Rôle lors de l’action : {{ { mte: 'MTE', departement: 'Département', commune: 'Commune' }[detail.actor.role] || detail.actor.role }}.
    </p>
    <p v-if="detail.actor?.departements?.length">Départements autorisés : {{ detail.actor.departements.join(', ') }}.</p>
    <p v-if="detail.actor?.communes?.length">Communes autorisées : {{ detail.actor.communes.join(', ') }}.</p>
    <section
      v-for="(resource, index) in detail.resources"
      :key="resource.id || `${resource.resourceType}-${resource.resourceId}-${index}`"
      class="fr-mb-3w"
    >
      <h4>{{ auditResourceLabel(resource.resourceType) }} {{ resource.resourceId }}</h4>
      <p>
        {{
          {
            INSERT: 'Création',
            UPDATE: 'Modification',
            DELETE: 'Suppression',
            insert: 'Création',
            update: 'Modification',
            delete: 'Suppression',
          }[resource.operation] || resource.operation
        }}
      </p>
      <div
        class="fr-table audit-changes"
        tabindex="0"
        role="region"
        aria-label="Changements avant et après, défilement horizontal possible"
      >
        <table>
          <caption>
            Changements enregistrés
          </caption>
          <thead>
            <tr>
              <th scope="col">Champ</th>
              <th scope="col">Avant</th>
              <th scope="col">Après</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in fields(resource)" :key="field">
              <th scope="row">{{ auditFieldLabel(field) }}</th>
              <td>{{ formatAuditValue(resource.before?.[field]) }}</td>
              <td>{{ formatAuditValue(resource.after?.[field]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <p v-if="detail.hasChanges === false">Aucune modification en base enregistrée pour cette action.</p>
    <p v-else-if="!detail.resources.length">Aucun changement de données associé à cette action.</p>
    <section v-if="detail.relatedOperations?.length" class="fr-mb-3w">
      <h4>Actions et traitements associés</h4>
      <ul>
        <li v-for="operation in detail.relatedOperations" :key="operation.id" class="fr-mb-1w">
          {{ formatAuditDate(operation.occurredAt) }} — {{ operation.actionLabel || operation.action }} —
          {{ auditResultLabel(operation.result) }}
          <button type="button" class="fr-btn fr-btn--tertiary fr-btn--sm" @click="$emit('openOperation', operation)">
            Voir le détail
          </button>
        </li>
      </ul>
      <p v-if="detail.relatedOperationsTruncated">Seules les premières actions associées sont affichées.</p>
    </section>
    <details v-if="detail.events?.length || detail.causality?.length" class="fr-mt-2w">
      <summary>Étapes et références de l’opération</summary>
      <p class="fr-mt-2w">Référence : {{ detail.id }}</p>
      <p v-if="detail.eventsTruncated">Les {{ detail.events.length }} premières étapes sont affichées.</p>
      <ul>
        <li v-for="event in detail.events" :key="event.id" class="fr-mb-2w">
          {{ formatAuditDate(event.occurredAt) }} — {{ auditResultLabel(event.phase) }}
          <dl v-if="visibleMetadata(event.metadata).length">
            <template v-for="[key, value] in visibleMetadata(event.metadata)" :key="key">
              <dt>{{ metadataLabels[key] }}</dt>
              <dd>{{ formatAuditValue(value) }}</dd>
            </template>
          </dl>
          <p v-if="event.requestId">
            Requête : {{ event.requestId }}<span v-if="event.route"> — {{ event.method }} {{ event.route }}</span>
          </p>
        </li>
      </ul>
      <p v-if="detail.causalityTruncated">Les {{ detail.causality.length }} premières références sont affichées.</p>
      <ul v-if="detail.causality?.length">
        <li v-for="(link, index) in detail.causality" :key="`${link.kind}-${link.reference}-${index}`">
          {{ link.kind }} : {{ link.reference }}
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.audit-detail {
  overflow-wrap: anywhere;
}
.audit-changes {
  overflow-x: auto;
}
.audit-changes td {
  white-space: pre-wrap;
  vertical-align: top;
}
.audit-changes th[scope='row'] {
  min-width: 7rem;
  overflow-wrap: normal;
}
.audit-detail summary {
  cursor: pointer;
  text-decoration: underline;
}
</style>
