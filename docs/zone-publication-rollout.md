# Publication atomique des zones

Ce mécanisme remplace progressivement le cache local mutable par des publications
nationales immuables. Il ne modifie ni les écrans, ni les libellés, ni le parcours
utilisateur.

## Invariants

- L'admin continue d'alimenter `zone_alerte_computed` pour permettre un rollback.
- Une publication n'est candidate qu'après validation de ses zones, géométries,
  associations commune-zone et artefacts GeoJSON/PMTiles. Les deux URL
  immuables sont relues anonymement avant la mise en candidature.
- Un recalcul partiel conserve son périmètre historique et ne produit aucune
  publication versionnée. Le watchdog lance ensuite le recalcul national qui,
  seul, peut couvrir la révision source globale et produire une candidate.
- Un verrou advisory PostgreSQL de session couvre tout recalcul, partiel ou
  national. Une demande utilisateur attend la fin du calcul en cours comme
  auparavant; seul un worker de rattrapage du watchdog quitte proprement s'il est
  concurrent, puis le watchdog réévalue la révision.
- Le bootstrap du schéma exécute `synchronize` uniquement sur une base vierge,
  détectée par l'absence de la table baseline `user`, puis applique les
  migrations sous le même verrou. Dès cette table présente, tous les
  redémarrages sont strictement migrations-only, quel que soit l'environnement.
- Une publication non vide sans association commune-zone est rejetée. Une
  publication `0 zone / 0 lien` n'est valide que si aucun arrêté de restriction
  au statut `publie` n'existe dans la même transaction.
- Les seuils relatifs à l'active (densité, volumes de zones et de liens) sont
  désactivés par défaut pour ne pas bloquer une baisse saisonnière légitime.
- Une candidate n'est activée que lorsque toutes les instances API vivantes l'ont
  préchargée et que leur nombre atteint le minimum configuré.
- Tant que la publication n'est pas active, seuls ses artefacts immuables nommés
  par checksum sont écrits. Les alias S3 historiques, la date de calcul globale
  et les ressources data.gouv.fr ne sont promus qu'après l'activation.
- La promotion S3 est relançable et publie PMTiles stable en dernier. La promotion
  data.gouv.fr est une étape séparée : son indisponibilité ne bloque ni
  l'activation ni la promotion des alias historiques.
- L'activation valide et verrouille d'abord la source, l'état, la candidate et
  son quorum, puis tente le verrou partagé avec la promotion S3 juste avant de
  changer l'active. Si une promotion est en cours, elle rend la main et sera
  retentée par l'intervalle suivant sans bloquer les lignes verrouillées.
- L'API échange son snapshot en mémoire par une seule affectation. En cas d'échec,
  le dernier snapshot valide reste servi.
- Le front épingle la carte et les requêtes de restrictions au même
  `publicationId`, y compris sur l'accueil où seule la carte visible au breakpoint
  DSFR fournit le pin. Un `410` déclenche un seul rechargement du manifeste.
- Une archive PMTiles candidate est contrôlée avant affichage puis par le
  chargement d'une tuile réelle. Après épuisement des essais courts, seule la même
  date est retentée après 60 secondes ; une autre date n'est jamais conservée en
  fallback.
- Les publications actives et candidates ne sont jamais supprimées. Les quatre
  dernières publications retirées et toutes celles de moins de 48 heures sont
  conservées par défaut.

## Configuration

Ces variables sont portées par l'API admin, qui décide de l'activation :

```text
ZONE_PUBLICATION_ENABLED=false
ZONE_PUBLICATION_MIN_READY_INSTANCES=1  # preprod
ZONE_PUBLICATION_MIN_READY_INSTANCES=2  # prod
ZONE_PUBLICATION_INSTANCE_LEASE_SECONDS=30
ZONE_PUBLICATION_CANDIDATE_TIMEOUT_SECONDS=300
ZONE_PUBLICATION_RETRY_BACKOFF_SECONDS=300
ZONE_PUBLICATION_RETRY_MAX_BACKOFF_SECONDS=21600
ZONE_PUBLICATION_ORPHAN_TIMEOUT_SECONDS=4500
ZONE_PUBLICATION_ARTIFACT_TIMEOUT_MS=60000
ZONE_PUBLICATION_PROMOTION_RETRY_SECONDS=300
ZONE_PUBLICATION_S3_TIMEOUT_MS=60000
ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS=15000
ZONE_PUBLICATION_RETAIN_RETIRED=4
ZONE_PUBLICATION_RETENTION_HOURS=48
ZONE_PUBLICATION_INSTANCE_RETENTION_HOURS=24
```

Les trois seuils relatifs suivants sont optionnels et désactivés par défaut. Ils
ne doivent être définis qu'après analyse métier, car le nombre de zones, de
liens et leur densité peuvent légitimement baisser avec la saison :

```text
ZONE_PUBLICATION_MIN_LINK_DENSITY_PERCENT=
ZONE_PUBLICATION_MIN_ZONE_COUNT_PERCENT=
ZONE_PUBLICATION_MIN_COMMUNE_LINK_COUNT_PERCENT=
```

`ZONE_PUBLICATION_ENABLED` est strictement opt-in : seule la valeur `true`
active le watchdog, la construction et l'activation. La version de l'algorithme
est portée par `ZONE_PUBLICATION_MATERIALIZATION_VERSION` dans le code et par
`zone_publication.materializationVersion` en base. Incrémenter la constante
force un nouveau snapshot même si la révision source n'a pas changé. Ne jamais
réécrire la version d'une publication existante.

Après un échec, le watchdog attend
`ZONE_PUBLICATION_RETRY_BACKOFF_SECONDS * 2^(n-1)`, dans la limite de
`ZONE_PUBLICATION_RETRY_MAX_BACKOFF_SECONDS`. Le nombre `n` provient des
publications en échec persistées pour la même révision source et la même version
de matérialisation : le délai survit donc aux redémarrages et repart de sa valeur
initiale lors d'une nouvelle révision ou version.

Une promotion externe en échec est retentée après
`ZONE_PUBLICATION_PROMOTION_RETRY_SECONDS`. Les appels de mise à jour des
ressources data.gouv.fr sont bornés par `ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS` et
chaque copie S3 d'une promotion par `ZONE_PUBLICATION_S3_TIMEOUT_MS`.
Les erreurs restent portées par la publication active sans dégrader son statut.

La publication quotidienne data.gouv.fr applique aussi un timeout HTTP de
`DATAGOUV_HTTP_TIMEOUT_MS=60000` et un plafond global de
`DATAGOUV_RUN_TIMEOUT_MS=1800000`. Au dépassement, les appels annulables sont
interrompus; si une dépendance ne rend toujours pas la main après 30 secondes,
le processus `clock` s'arrête pour que Scalingo le remplace et libère ses verrous.
La ressource annuelle des communes est recherchée puis créée automatiquement au
changement d'année; son identifiant est conservé dans le registre PostgreSQL.
L'export refuse de démarrer tant que le recalcul communal du jour n'a pas atteint
son checkpoint persistant de complétude. Le calcul courant et le rattrapage
historique sont deux jobs persistants distincts; data.gouv.fr attend leur succès,
puis une publication active du même jour dont les promotions S3 et data.gouv.fr
sont terminées. Chaque commune doit contenir exactement un enregistrement par
jour depuis le 1er janvier jusqu'à la date métier attendue.

Les archives cartographiques annuelles restent désactivées par défaut avec
`DATAGOUV_MAP_ARCHIVES_ENABLED=false`. Les anciennes ressources configurées ont
disparu et la reconstruction historique actuelle charge plusieurs gigaoctets en
mémoire. Le job quotidien ne doit donc jamais les exécuter ni publier un ZIP
partiel. `/api/health/map-archives` expose explicitement `disabled`. Une future
réactivation exige des identifiants de ressources valides et un pipeline séparé,
streamé, avec inventaire complet des objets quotidiens avant promotion.

Le contrat d'une publication vide valide est explicite : `zoneCount=0`,
`communeLinkCount=0`, une collection GeoJSON sans feature, un artefact PMTiles
immuable lisible, et des endpoints zones/communes qui répondent `200` avec des
listes vides. Elle ne doit jamais être assimilée à une erreur de cache.

Le minimum doit correspondre au nombre nominal d'instances de l'API publique.
Une valeur trop haute bloque la candidate sans interrompre la version active. Une
valeur trop basse autorise une activation avant qu'une instance attendue soit
revenue en ligne.

Les tâches métier (`SANDRE`, data.gouv.fr, statistiques, communes et changements
de statut planifiés) s'exécutent uniquement dans le processus Scalingo `clock`.
La variable globale `RUN_BUSINESS_SCHEDULED_JOBS` reste à `false` : la commande
du `Procfile` la force à `true` uniquement pour `clock`. La variable
`DISABLE_SCHEDULED_JOBS` doit rester à `false`; sa valeur `true` coupe aussi le
heartbeat et rend le processus volontairement non sain.

`SANDRE_ZONE_SYNC_MODE=paused` ne contacte pas le référentiel,
`SANDRE_ZONE_SYNC_MODE=audit` enregistre les décisions sans modifier les zones,
et `SANDRE_ZONE_SYNC_MODE=safe` applique uniquement les rapprochements non
ambigus. Un département bloqué est réévalué au cron suivant après cinq minutes.
Une zone gelée encore utilisée n'est rapprochée que si la généalogie officielle
SANDRE fournit un successeur linéaire strictement 1:1, actif, de même département
et de même type. Les références opérationnelles sont alors remappées dans la
transaction; les arrêtés abrogés conservent leur historique. Toute branche,
collision, source indisponible ou cible ambiguë bloque le département sans
écriture persistée.
`SANDRE_HEALTH_STALE_AFTER_SECONDS=108000` fixe le délai maximal sans observation
réussie. `/api/health/sandre-synchronization` ne passe au vert en production que
si le mode est `safe`, `trackedDepartments=totalDepartments=101`,
`appliedDepartments=totalDepartments=101`, et si `staleDepartments`,
`staleAppliedDepartments`, `pendingApplicationDepartments`,
`blockedDepartments`, `failedBatches` et `blockedBatches` sont tous nuls. Le mode
`audit` est accepté uniquement pendant la validation preprod explicite des
décisions; ses applications et écarts en attente ne le rendent pas rouge, car il
n'effectue volontairement aucune écriture.

## Déploiement preprod

1. Attendre tous les jobs CI verts sur le SHA exact à déployer. Tant que le
   workflow `production-smoke.yml` n'est pas fusionné sur la branche par défaut
   `master`, son cron horaire ne s'exécute pas. Un lancement manuel depuis
   `develop` valide une promotion ponctuelle mais ne remplace jamais cette
   condition : l'intervention n'est pas considérée terminée tant que le workflow
   n'est pas présent sur `master` et qu'un premier cron planifié n'a pas réussi.
2. Relever les formations, tailles, variables et le nombre nominal d'instances
   de l'API publique. En preprod, le quorum attendu est `1`.
3. Obtenir un gel réel avec la release actuellement en place : scaler le `web`
   admin à zéro, puis le `clock` à zéro s'il existe. Configurer en une fois :

   ```text
   ADMIN_WRITES_DISABLED=true
   ZONE_PUBLICATION_ENABLED=false
   DISABLE_SCHEDULED_JOBS=true
   RUN_BUSINESS_SCHEDULED_JOBS=false
   SANDRE_ZONE_SYNC_MODE=paused
   ZONE_PUBLICATION_MIN_READY_INSTANCES=1
   ```

4. Créer le backup seulement après ce gel :

   ```bash
   scalingo --app regleau-back-preprod addons
   scalingo --app regleau-back-preprod --addon <postgres_uuid> backups-create
   scalingo --app regleau-back-preprod --addon <postgres_uuid> backups
   ```

   Noter l'identifiant du nouveau backup et vérifier qu'il est le plus récent,
   au statut `done` et de taille strictement positive.

5. Retirer `NODE_TLS_REJECT_UNAUTHORIZED=0`, déployer `regleau-back-preprod`,
   conserver `clock=0`, puis restaurer `web` à sa formation initiale. Vérifier les
   migrations, la base, OAuth, S3, SANDRE, l'envoi de mail et les départements.
6. Déployer `vigieau-api-preprod`. Attendre plus d'une durée de lease (30 s), puis
   vérifier que `liveInstances` correspond exactement à la formation publique.
7. Passer uniquement `DISABLE_SCHEDULED_JOBS=false`, en gardant `clock=0`, les
   écritures gelées et SANDRE en pause. Activer ensuite
   `ZONE_PUBLICATION_ENABLED=true` et attendre la baseline complète : candidate,
   quorum, statut `active`, `legacyPromotedAt`, manifeste et artefacts valides.
   Ne jamais modifier le pointeur actif directement en SQL.
8. Déployer les deux fronts `preservonsleau-front-preprod` et
   `regleau-front-preprod`, puis vérifier :

   ```text
   GET https://api.vigieau.incubateur.net/api/health/live
   GET https://api.vigieau.incubateur.net/api/health/ready
   GET https://api.vigieau.incubateur.net/api/health/cache
   GET https://api.vigieau.incubateur.net/api/zones/publication
   GET https://admin.vigieau.incubateur.net/
   GET https://admin.vigieau.incubateur.net/api/health/live
   ```

   Exécuter `smoke-public.mjs` et `smoke-browser.mjs` avec les URL preprod
   explicites. Le second contrôle un contexte WebGL vivant, le contenu des pixels
   du canvas et plusieurs lectures Range réelles de l'archive PMTiles.

9. Dans un vrai navigateur desktop et mobile, comparer Tarbes (`65440`) par
   sélection de commune, adresse précise et carte. Vérifier le rendu non vide de
   la carte, les requêtes de tuiles, la console, la date courante et une date
   historique.
10. Passer SANDRE en `audit`, puis démarrer exactement `clock=1` en taille `2XL`.
    Vérifier le verrou singleton, le heartbeat, la mémoire et l'absence d'OOM.
    Attendre un cycle complet : le health audit doit être `healthy`, avec
    `trackedDepartments=totalDepartments=101`, `staleDepartments=0`,
    `blockedDepartments=0`, `failedBatches=0` et `blockedBatches=0`. Après examen
    des décisions, passer en `safe`. Au cron suivant, au plus dix minutes plus
    tard, le retraitement de chaque département jamais appliqué ou dont les hash
    ou dates source observés et appliqués diffèrent est déclenché sans attendre le
    cycle complet de 24 heures. La durée totale dépend ensuite du référentiel et
    du nombre de départements. Observer les éventuels départements bloqués ainsi
    que la publication atomique suivante. Attendre ensuite que les quatre
    endpoints répondent `200` :

    ```text
    GET https://api.admin.vigieau.incubateur.net/api/health/clock
    GET https://api.admin.vigieau.incubateur.net/api/health/sandre-references
    GET https://api.admin.vigieau.incubateur.net/api/health/sandre-synchronization
    GET https://api.admin.vigieau.incubateur.net/api/health/map-archives
    ```

    `sandre-references` doit renvoyer `status=healthy` et `total=0`. Il ignore les
    références purement historiques des arrêtés abrogés, mais bloque la reprise
    dès qu'un arrêté opérationnel utilise encore une zone SANDRE désactivée.
    En mode `safe`, le health SANDRE doit en plus afficher
    `trackedDepartments=appliedDepartments=totalDepartments=101`, avec
    `staleDepartments=0`, `staleAppliedDepartments=0`,
    `pendingApplicationDepartments=0`, `blockedDepartments=0`, `failedBatches=0`
    et `blockedBatches=0`. Aucun front, cache ou dataset public ne doit être promu
    avant que ces compteurs soient tous conformes.
    Pendant la phase d'observation, lancer le smoke avec
    `VIGIEAU_EXPECT_SANDRE_MODES=audit`,
    `VIGIEAU_EXPECT_DEPARTMENT_COUNT=101` et
    `VIGIEAU_EXPECT_MAP_ARCHIVES=disabled`. Après la bascule, le smoke final doit
    être relancé avec `VIGIEAU_EXPECT_SANDRE_MODES=safe`; ne jamais autoriser les
    deux modes dans ce contrôle de sortie.

11. Exécuter seulement maintenant le smoke admin complet avec les URL front et
    API preprod. Comme aucun dataset data.gouv.fr de test n'est configuré,
    `never_succeeded` est attendu et exige
    `VIGIEAU_ALLOW_UNPUBLISHED_EXTERNAL=true`. Rejouer aussi les smokes public et
    navigateur; tous doivent être verts avant de remettre
    `ADMIN_WRITES_DISABLED=false`. `/resume` est lui-même bloqué pendant le gel :
    lever ce gel avant une reprise manuelle.

## Déploiement production

Reprendre strictement la séquence preprod après son succès, avec :

- `regleau-back-prod`, avec `ZONE_PUBLICATION_MIN_READY_INSTANCES` égal au nombre
  nominal réellement observé de processus `web` de l'API publique ;
- `preservonsleau-api-prod` ;
- `preservonsleau-front-prod` et `regleau-front-prod` ;
- `https://api.vigieau.beta.gouv.fr/api/health/*` et
  `https://api.vigieau.beta.gouv.fr/api/zones/publication`.

Scaler d'abord l'ancien `web` admin à zéro, puis créer et contrôler le backup
PostgreSQL post-gel. Retirer `NODE_TLS_REJECT_UNAUTHORIZED=0` uniquement après la
validation preprod. La première publication doit être observée jusqu'à `active`, puis jusqu'à un
`legacyPromotedAt` non nul avant de clore l'intervention. Un
`dataGouvPromotedAt` nul signale une mise à jour data.gouv.fr encore en reprise et
doit rester supervisé.

En production, le succès et la fraîcheur de data.gouv.fr sont obligatoires. Le
smoke public, le smoke admin strict, le smoke data.gouv.fr et les contrôles dans
un navigateur réel doivent tous passer avant de lever le gel des écritures.
`/api/health/sandre-references` doit répondre `200`, avec un total nul, juste
avant cette levée. Le smoke public conserve un minimum absolu d'une zone par
défaut (`VIGIEAU_MIN_ZONE_COUNT=1`) : une carte nationale vide bloque donc la
promotion, sans imposer un seuil relatif incompatible avec la saisonnalité.
Le smoke production exige `SANDRE_ZONE_SYNC_MODE=safe`, une synchronisation
SANDRE fraîche et `VIGIEAU_EXPECT_MAP_ARCHIVES=disabled`.

Le smoke data.gouv.fr ne se limite pas à `last_modified` : il ouvre l'archive
annuelle des communes, inspecte tout son JSON, ouvre l'historique Zip64 par Range et vérifie
que la date maximale contenue correspond à la date attendue par le scheduler
(date de Paris, veille avant 06:00). L'archive historique de plusieurs gigaoctets
est contrôlée sur un préfixe décompressé borné afin que le cron reste soutenable.

## Diagnostic

Le endpoint `/api/health/ready` reste à `200` si un ancien snapshot utilisable est
conservé. `/api/health/cache` passe à `503` si le pointeur, le préchargement ou le
contrôle de version n'est pas à jour. Le diagnostic n'expose ni erreur brute, ni
identifiant d'instance.

Dans `pgsql-console`, contrôler sans écrire :

```sql
SELECT "activePublicationId", "candidatePublicationId",
       "automaticPublishingPaused", "automaticPublishingPausedAt", "updatedAt"
FROM zone_publication_state
WHERE id = 1;

SELECT id, revision, "sourceRevision", status, "zoneCount",
       "materializationVersion", "communeLinkCount", "createdAt", "activatedAt",
       "legacyPromotedAt", "dataGouvPromotedAt", "promotionLastAttemptAt",
       "promotionError"
FROM zone_publication
ORDER BY revision DESC
LIMIT 10;

SELECT "activePublicationId", "candidatePublicationId", "zoneCount",
       "communeLinkCount", "lastError", "heartbeatAt"
FROM zone_publication_instance
ORDER BY "heartbeatAt" DESC;
```

Une publication `active` avec `legacyPromotedAt IS NULL` continue d'être servie
par les API versionnées, mais les consommateurs historiques utilisent encore les
anciens alias S3. La promotion est retentée automatiquement. data.gouv.fr n'est
jamais mis à jour avant `legacyPromotedAt`; un `dataGouvPromotedAt` nul avec un
alias promu indique uniquement une reprise data.gouv.fr en attente.

Le endpoint admin `/api/zone-publication/health`, réservé au rôle `mte`, expose
le pointeur actif, la candidate, le quorum et la pause automatique. Les endpoints
`/api/health/clock`, `/api/health/external-publications`,
`/api/health/sandre-references`, `/api/health/sandre-synchronization` et
`/api/health/map-archives` ne renvoient aucune erreur brute ni secret et
servent aux alertes techniques. Le smoke admin passe aussi par
`https://admin.vigieau.beta.gouv.fr/api/health/live` pour contrôler le ProxyPass.
Le smoke planifié contrôle Tarbes, le GeoJSON immuable, le rendu réel de la carte,
les lectures de tuiles PMTiles et les dates effectivement contenues dans les ZIP
data.gouv.fr.

Le pointeur PostgreSQL est atomique et chaque copie S3 remplace un objet de façon
indépendante. S3 et data.gouv.fr ne fournissent pas de transaction commune pour
la paire GeoJSON/PMTiles. L'API et le front VigiEau ne lisent donc jamais cette
paire d'alias pendant une bascule : ils restent épinglés aux deux artefacts
immuables validés de la publication active. Les alias historiques ne servent
qu'aux consommateurs legacy ; en cas d'incident entre deux copies, ils peuvent
temporairement pointer vers deux versions différentes jusqu'au prochain essai.
Le marqueur de promotion reste absent, le healthcheck passe en erreur et le
service recopie idempotemment les quatre alias à l'essai suivant. data.gouv.fr
reçoit directement les URL immuables et son marqueur n'est posé qu'après les
deux mises à jour réussies.

Une candidate qui reste en attente indique normalement qu'une instance publique
manque, n'a pas fini son préchargement ou a détecté des compteurs incohérents.
Après cinq minutes par défaut, elle passe en échec sans remplacer l'active si au
moins une instance vivante n'a pas pu la lire ou l'acquitter. Si toutes les
instances vivantes sont prêtes mais que leur nombre est inférieur au minimum
attendu, elle reste en attente : ce cas signale une capacité manquante et ne
déclenche pas de recalcul national en boucle. Le watchdog attend son délai de
reprise avant de relancer un échec de lecture.
Les constructions abandonnées et les publications validées jamais devenues
candidates sont rendues purgeables après 75 minutes par défaut. Les heartbeats
de processus vieux de plus de 24 heures sont supprimés.

Les lignes et associations PostgreSQL sont purgées selon cette politique, mais
les artefacts GeoJSON/PMTiles immuables sur S3 ne le sont pas. Leur suppression
reste volontairement hors périmètre tant qu'une API fiable ne permet pas de
lister, rapprocher puis supprimer uniquement les objets qui ne sont référencés
par aucune publication conservée. Une alerte de volumétrie S3 doit donc être
configurée côté hébergeur avant la mise en production.

## Rollback

1. Mettre `clock=0` et `SANDRE_ZONE_SYNC_MODE=paused`. Laisser
   `ZONE_PUBLICATION_ENABLED=true` pour permettre le préchargement de la cible.
2. Appeler `POST /api/zone-publication/rollback` avec `apply=false` et un
   `publicationId` explicite. Vérifier la cible et les bloqueurs, puis répéter avec
   exactement le même identifiant et `apply=true`. Une candidate normale encore
   en attente est remplacée atomiquement; une autre candidate de rollback bloque
   l'opération.
3. Attendre son préchargement par le quorum et son activation normale. Vérifier
   le manifeste, Tarbes, la carte et `legacyPromotedAt`. Ne jamais modifier le
   pointeur actif directement en SQL.
4. Une fois le rollback logique vérifié, `ZONE_PUBLICATION_ENABLED=false` peut
   être utilisé si l'on veut aussi arrêter les promotions et recalculs. La pause
   reste persistée en base à travers les redémarrages.
5. Revenir au front précédent : il réutilise l'URL PMTiles historique,
   toujours publiée.
6. Revenir ensuite à l'API publique précédente : `zone_alerte_computed` est restée
   alimentée pendant toute la transition.
7. Revenir enfin à l'API admin précédente si nécessaire. Garder
   `DISABLE_SCHEDULED_JOBS=true` et `clock=0`, car une ancienne release admin
   exécute encore les cron dans le processus web.
8. Conserver les tables `zone_publication*` pendant le rollback applicatif. La
   migration est additive et l'ancien code les ignore.
9. N'exécuter le `down` de la migration qu'après retour complet des trois services,
   vérification fonctionnelle et décision explicite : il supprime l'historique des
   publications.

Après résolution de l'incident, remettre `ZONE_PUBLICATION_ENABLED=true` puis
appeler `POST /api/zone-publication/resume` avec un compte `mte`. Cette reprise
est volontairement explicite; elle annule aussi une candidate de rollback encore
en attente. `ADMIN_WRITES_DISABLED` doit déjà être à `false` pour que cet endpoint
soit accessible.
