# Contre-audit RGAA du 21 août 2026

Périmètre : front public `apps/frontend`, à partir du commit audité
`b72c1e314d073bfc9be051216d9c068c76bee688`. Les applications admin et les API
ne sont pas concernées.

## Résultats

| Retour | État | Preuve principale |
| --- | --- | --- |
| RES-01 | Corrigé | Les graphiques statistiques ont une alternative tabulaire issue des mêmes données. |
| RES-02 | Corrigé | Figures, légendes, relations avec les tableaux et identifiants uniques. |
| RES-03 | Corrigé | États de chargement, succès et erreur annoncés sans remplacement du nœud de statut. |
| RES-04 | Corrigé | Chargeur nommé, `role="status"`, animation masquée et mouvement réduit pris en charge. |
| RES-05 | Corrigé | Layouts `/emails` structurés avec liens d'évitement, `main` unique et pied de page commun. |
| RES-06 | Partiel, contenu requis | Déclaration datée et technologies réellement employées ajoutées. Les données du nouvel audit (échantillon, outils et environnement) doivent venir de l'auditeur. |
| RES-07 | Bloqué, audit documentaire | Le rapport initial reste non balisé. La conformité PDF doit être vérifiée avec PAC 2024 et une lecture d'écran, puis les documents sources doivent être corrigés. |
| RES-08 | Corrigé | La colonne expose honnêtement le code INSEE, également dans l'export CSV. |
| RES-09 | Corrigé | En-têtes de lignes déclarés avec `scope="row"`. |
| RES-10 | Corrigé | La région de défilement n'est focalisable que lorsqu'un débordement horizontal est mesuré. |
| RES-11 | Corrigé | Job CI RGAA public, scripts dédiés et artefacts Cypress en cas d'échec. |
| RES-12 | À valider manuellement | Parcours NVDA/Firefox, VoiceOver/Safari, zoom 200/400 %, reflow 320 px et PDF/PAC. |
| RES-13 | Prêt au déploiement | Validation et publication depuis une branche isolée du historic backfill. |

## Validation automatisée

- Tests unitaires : 143/143.
- Cypress RGAA public : 77/77 sur 15 spécifications.
- Build Nuxt : réussi, 23 routes pré-rendues.
- ESLint : 0 erreur (370 avertissements préexistants).
- `git diff --check`, validation YAML et contrôle de périmètre admin/API : réussis.

Ces preuves automatisées ne remplacent pas le contre-audit manuel ni la
validation des documents PDF.
