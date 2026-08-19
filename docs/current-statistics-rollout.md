# Publication courante et statistiques sans coupure

Ce runbook accompagne la separation entre les editions administratives, les
mutations qui affectent reellement le public et la construction des artefacts
statistiques. Les ecritures administratives restent ouvertes pendant toutes les
phases.

## Invariants

- Un brouillon, son PDF ou une modification non publique ne change pas la
  revision publique et ne lance aucun calcul national.
- Une publication, une abrogation ou une modification d'un contenu deja public
  incremente la revision publique et alimente la queue dans la meme transaction.
- Le dernier cache certifie reste servi jusqu'a l'activation atomique du suivant.
- Les serveurs HTTP ne construisent aucun artefact lourd. Ils prechargent un
  candidat immuable et publient un acquittement lie a son identite complete.
- Deux acquittements compatibles sont requis en production avant activation.
- Une revision depassee, un verrou occupe ou un candidat pas encore pret sont
  des etats de reprise, pas des erreurs Sentry.
- Le rattrapage historique reste independant et ne bloque jamais le courant.

## Deploiement expand/contract

1. Restaurer une preproduction recente et neutraliser les sorties S3 et
   data.gouv.fr.
2. Prearmer les deux applications avec `PUBLIC_SOURCE_REVISION_ENABLED=false`,
   `CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED=false` et
   `STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED=false`. Garder
   `HISTORIC_CATCHUP_ENABLED=false` et `ADMIN_WRITES_DISABLED=false`.
3. Deployer d'abord l'admin. Le premier nouveau processus applique la migration
   additive sous `lock_timeout=3s`; une attente de verrou fait echouer la release
   sans couper les anciens processus. Pendant le rolling,
   `legacyDualWrite=true` maintient `revision` et `publicRevision` alignees pour
   les requetes encore traitees par un ancien binaire.
4. Deployer le frontend d'administration apres le backend admin. Verifier que
   les parcours de creation, sauvegarde, controle et publication AEP restent
   disponibles, notamment pour les brouillons D49 et D79, avant de poursuivre.
5. Deployer ensuite l'API publique avec deux instances 3XL. Les anciens inserts
   de queue et heartbeats restent compatibles avec le schema et l'artefact actif
   continue d'etre servi.
6. Deployer le frontend public. Il tolere temporairement l'absence des nouveaux
   endpoints pendant le rolling, mais toute reponse v2 `unavailable` doit masquer
   une ancienne zone et afficher le lien vers les services de l'Etat. Verifier
   dans un navigateur les parcours AEP D49 et D79, la carte et le bandeau
   statistique avant de poursuivre.
7. Verifier les identifiants de release et l'absence de tout ancien processus
   admin. Appeler en MTE `POST /api/zone-publication/public-revision-mode` avec
   `{"mode":"separated","apply":false}`, puis refaire exactement l'appel avec
   `apply:true`. Cette bascule atomique met `legacyDualWrite=false` et remet les
   101 departements en queue. Ne jamais l'appliquer tant qu'un ancien binaire
   admin peut encore accepter une ecriture.
8. Activer `PUBLIC_SOURCE_REVISION_ENABLED=true` d'abord sur l'API publique,
   puis sur l'admin. Attendre une revision identique sur les deux lectures avant
   le flag suivant.
9. Activer `CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED=true`, puis demarrer exactement
   un processus `currentzoneworker`. Le Procfile lui injecte
   `CURRENT_ZONE_RECOMPUTE_WORKER_PROCESS=true`; le web et le clock ne consomment
   plus la queue. Verifier une requete consommee et une revision depassee
   rebasee avant de poursuivre.
10. Garder `STATISTIC_CACHE_ARTIFACT_MODE=read-write`, demarrer exactement un
   processus `statcache`, puis activer
   `STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED=true` sur les deux API. Le worker
   est le seul materialiseur; les webs ne font que precharger le candidat.
11. Exiger `STATISTIC_CACHE_REQUIRED_ACKS=2`. Attendre deux acquittements complets
   de la meme identite (publication, revision, date, source, protocole et
   empreinte), puis une seconde lecture stable apres activation. Une erreur de
   prechargement reste liee au candidat et ne compte jamais comme acquittement.
12. Activer ensuite seulement les gates consommateurs, notamment
   `STATISTIC_CACHE_ARTIFACT_REQUIRED=true` cote admin. Conserver l'artefact
   precedent et le chemin legacy pendant au moins 48 heures et deux cycles
   quotidiens sains avant toute phase contract.

## Gates de production

- API admin et publique `live` et `ready` a HTTP 200.
- Aucun rejet `ADMIN_WRITES_DISABLED` et aucun processus one-off concurrent.
- Queue courante prise en moins de cinq minutes, sans tentative en erreur.
- Un seul `currentzoneworker`, un seul `statcache` et aucun materialiseur lourd
  dans les processus HTTP.
- Artefact actif utilisable pendant le calcul, puis candidat acquitte 2/2.
- Un trou historique n'est jamais comble artificiellement: `sparse-current`
  peut publier la seule date courante certifiee, tandis que
  `historicComplete=false` reste visible jusqu'au rattrapage dedie.
- `latestDate`, `currentPublishedDate` et la date metier attendue identiques en
  fin de cycle.
- D49 et D79: une disponibilite AEP `unavailable` masque toute ancienne zone et
  renvoie vers le site officiel; seul `confirmed_none` affiche explicitement
  l'absence de restriction. Une erreur ou reponse invalide de `/data/status`
  affiche un bandeau d'indisponibilite.
- Memoire de chaque web et worker sous 75 %, swap stable, aucun OOM/restart.
- Aucun evenement Sentry non gere pour une simple revision depassee.

## Rollback

1. Desactiver le producteur v2 et la consommation de queue sans fermer les
   ecritures: remettre `STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED=false` et
   `CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED=false`, puis ramener les deux workers a
   zero.
2. Remettre `STATISTIC_CACHE_ARTIFACT_REQUIRED=false` et
   `STATISTIC_CACHE_ARTIFACT_MODE=disabled`: les API reviennent au lecteur
   legacy sans modifier ni supprimer l'artefact actif.
3. Avant tout retour de `PUBLIC_SOURCE_REVISION_ENABLED` a `false`, appeler
   obligatoirement l'endpoint MTE avec
   `{"mode":"compatibility","apply":false}`, puis `apply:true`. Verifier que
   `legacyDualWrite=true` et que `publicRevision = revision`. Cette operation
   realigne les deux espaces de revision et remet les departements en queue.
   Remettre ensuite seulement `PUBLIC_SOURCE_REVISION_ENABLED=false` sur les
   deux applications dans la meme fenetre controlee. Un ancien binaire admin ne
   peut etre redeploye qu'apres ce gate.
4. Conserver la migration additive. Ne supprimer aucune colonne, queue ou
   publication pendant le rollback.
5. Verifier deux heartbeats publics, le cache certifie, la carte et les ecritures
   admin avant de clore l'incident.

## Historique

`HISTORIC_CATCHUP_ENABLED=false` reste le mode nominal tant que le worker
historique dedie n'est pas disponible. Ce worker utilise une revision source
immuable, des sorties de staging et un manifeste par date. Il est reprenable a
la journee et s'interrompt entre deux dates lorsqu'un calcul courant est en
attente. Sa promotion n'a lieu qu'apres controle complet de la plage.

Ce document remplace les phases de gel des ecritures et de mise a zero du clock
de `docs/zone-publication-rollout.md` pour le pipeline courant/statistiques. Les
maintenances historiques exceptionnelles conservent leur propre runbook.
