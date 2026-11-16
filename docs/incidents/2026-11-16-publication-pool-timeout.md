# Publication des restrictions bloquée après le 12 novembre 2026

## Cause et impact constatés

Le déploiement du journal d'activité (`9e8833e`) a ajouté
`connectionTimeoutMillis: 5000` aux options du pool PostgreSQL commun. Les
workers de calcul rechargent le même `AppModule`. Dans `pg-pool`, cette option
limite aussi l'attente d'une connexion occupée, pas seulement l'ouverture d'une
connexion réseau.

Les lots géographiques lancent plusieurs requêtes en parallèle et conservent
une connexion pour le verrou global. Une attente légitime dépassant cinq
secondes interrompt désormais le calcul, notamment pendant l'harmonisation
`YES_DISTINCT` de l'Aisne. Le premier échec conservé date du 12 novembre à
14:40:33 UTC ; 89 recalculs ont échoué jusqu'au 16 novembre à 10:45:19 UTC.
Le contrôle de publication a signalé l'incident le 12 novembre à 16:26 UTC
(issue #70). La disponibilité HTTP et la santé du journal ne détectent pas,
à elles seules, l'échec d'un calcul national.

La production sert toujours la publication `760d1047-cdfe-4c9f-8b6c-da49083cdd76`
(révision 574, date métier du 12 novembre). La file comporte 101 départements
pour les calculs quotidiens et 15 demandes courantes. Les quatre signalements
ont des arrêtés correctement publiés en base, mais leurs prédécesseurs sont
encore présents dans la publication publique :

| Département | Arrêté attendu | ID attendu | ID encore servi |
| --- | --- | --- | --- |
| 07 | 07-2026-11-13-00006 | 38505 | 38475 |
| 21 | 1812 | 38508 | 38303 |
| 41 | 41-2026-11-12-00002 | 38495 | 38405 |
| 71 | 71-2026-11-13-00001 | 38503 | 38416 |

La préproduction reproduit la même expiration. Aucun arrêté ne doit être
republié par les utilisateurs pour corriger cet incident.

## Correctif et reprise

Rétablir les options antérieures du pool métier, sans délai global d'acquisition.
La taille maximale du pool et les paramètres TLS restent identiques. L'audit
conserve ses délais locaux de deux secondes, le rejet des écritures tardives et
ses garanties transactionnelles ; le worker conserve son délai global existant.

Valider le calcul géographique en préproduction, puis déployer le backend
d'administration en production. Réutiliser les demandes persistées. Si leur
backoff retarde la reprise, avancer seulement `nextAttemptAt`, sous les verrous
`current-zone-recompute` puis `sandre-zone-sync`, avec vérification des générations
et révisions. Conserver toutes les autres colonnes et tracer explicitement cette
opération : le seul changement de `nextAttemptAt` n'est pas capturé comme une
modification métier par les triggers.

La publication courante est découplée de l'historique ancien dans le code livré.
Ne pas modifier les curseurs historiques, forcer une certification ou activer
le rejeu historique mutable pour cette reprise.

## Vérification de résolution

- Test de saturation du vrai `pg-pool` avec client injecté, sans dépendance réseau,
  et test des options effectivement utilisées par `AppModule`.
- Tests du budget local d'audit et de l'absence d'écriture après expiration.
- Recalcul national complet, publication du jour certifiée puis activée et
  préchargée par les instances API ; un second passage automatique sans erreur.
- `/api/health/zone-publication` : HTTP 200 **et** `status: healthy`.
- `/api/data/status` : `status: ready`, `usable`, `currentFresh` et `fresh` vrais,
  date courante ; `/api/health/cache` et `/api/health/statistics` en HTTP 200.
- Contrôle des quatre arrêtés, gravités, cartes et liens PDF réellement servis.
- `historicStatus: incomplete` ou `historicComplete: false` est suivi séparément ;
  cela ne remplace pas les contrôles de fraîcheur courante.

Les preuves de déploiement, reprises et contrôles finaux sont conservées dans
le compte rendu de livraison. Ne pas déclarer l'incident résolu sur la seule
base d'un build réussi ou d'un processus `running`.
