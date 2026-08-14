# Publication atomique des zones

Ce mécanisme remplace progressivement le cache local mutable par des publications
nationales immuables. Il ne modifie ni les écrans, ni les libellés, ni le parcours
utilisateur.

## Invariants

- L'admin continue d'alimenter `zone_alerte_computed` pour permettre un rollback.
- Une publication reste `validated` après validation de ses zones, géométries,
  associations commune-zone et artefacts GeoJSON/PMTiles. Elle ne devient
  candidate qu'après certification du snapshot communal courant et du
  rattrapage historique persistant de même révision et version. Les deux URL
  immuables sont relues anonymement avant cette attente.
- Un recalcul partiel conserve son périmètre historique et ne produit aucune
  publication versionnée ni statistique publique. Le watchdog lance ensuite le
  recalcul national qui, seul, peut couvrir la révision source globale, publier
  les statistiques et produire une candidate.
- Un verrou advisory PostgreSQL de session couvre tout recalcul, partiel ou
  national. Une demande utilisateur attend la fin du calcul en cours comme
  auparavant. Le watchdog teste ce verrou avant de créer son worker et rend la
  main s'il est occupé; le worker conserve le même contrôle pour couvrir une
  course entre ce pré-contrôle et son démarrage.
- La reprise durable du calcul quotidien transporte sa date civile Paris et la
  révision source attendue jusqu'au worker. Après acquisition du verrou global,
  elle réutilise une publication validée, candidate ou active déjà complète
  uniquement si sa date, sa révision et sa version de matérialisation
  correspondent exactement.
  Une publication de la veille n'est jamais réutilisée pour le jour courant.
- Le processus `clock` est l'unique propriétaire du rattrapage historique. Le
  worker de calcul courant ne peut ni le démarrer ni le mettre en file. Le
  registre persiste les deux curseurs historiques et leurs générations finales ;
  une invalidation à date identique rend donc l'ancien succès inéligible au tick
  suivant.
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
- L'activation exige aussi un snapshot communal national `ready` de la même date
  et de la même révision source. Hors première baseline, le marqueur historique
  et les deux curseurs legacy doivent couvrir J-1, aucune plage historique ne
  doit être sale et aucun calcul national du même jour civil Paris ne doit être
  en cours. Lorsqu'une exécution quotidienne est liée à la candidate, son
  rattrapage historique doit avoir réussi avec exactement les curseurs et
  générations encore présents dans `config`. Cette comparaison est refaite sous
  verrou à la mise en candidature puis à l'activation ; un ancien run sans ces
  métadonnées n'est jamais certifiant.
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
- Le passage d'un historique propre à une plage sale incrémente l'epoch
  statistique. L'API publique sert son dernier cache certifié pendant la
  reconstruction, puis échange le nouveau cache en une seule affectation après
  une double lecture stable de l'epoch. Les référentiels ont leur propre cache
  SWR et restent disponibles si les statistiques sont indisponibles.
- Le délai de préchargement d'une candidate ne commence qu'après la fin du
  rattrapage historique certifié. Pendant ce rattrapage, le watchdog conserve la
  publication validée réutilisable et ne relance pas un calcul national
  concurrent. Un échec conserve ensemble l'ancienne carte et l'ancienne
  situation.
- Si une publication devient `failed` ou `superseded` avant activation, son
  changement d'état invalide dans la même transaction le snapshot communal
  national `ready` correspondant, sauf si une autre publication utilisable
  porte la même date et la même révision. Les agrégats mensuels ignorent cette
  journée versionnée jusqu'à son recalcul, mais les barrières d'activation et
  d'export restent fermées. Le rattrapage remet la journée dans les agrégats
  avant toute publication ; un snapshot bootstrap ou sans révision source
  continue toujours de bloquer.
- L'identifiant de publication échouée enregistré par le dernier calcul
  quotidien est conservé au-delà de la rétention normale tant qu'aucun calcul
  quotidien plus récent de la même révision n'existe. Une reconstruction peut
  ainsi reprendre le calcul déjà certifié sans relancer les statistiques.
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
ZONE_PUBLICATION_ENABLED=false  # uniquement pendant bootstrap ou gel; true en exploitation
ZONE_PUBLICATION_MIN_READY_INSTANCES=1  # preprod
ZONE_PUBLICATION_MIN_READY_INSTANCES=2  # prod
ZONE_PUBLICATION_INSTANCE_LEASE_SECONDS=30
ZONE_PUBLICATION_HEALTH_PROGRESS_STALE_AFTER_SECONDS=1800
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
COMMUNE_STATISTICS_BATCH_SIZE=250  # entier compris entre 1 et 1000
HISTORIC_COMPUTE_CHUNK_DAYS=7  # entier compris entre 1 et 3660
HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED=false
HISTORIC_SKIP_COMMUNE_INTERSECTIONS=false
HISTORIC_DEPARTMENT_CONCURRENCY=1  # entier compris entre 1 et 4
HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED=false
HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS=7  # entier compris entre 1 et 31
```

`COMMUNE_STATISTICS_BATCH_SIZE` vaut `250` par défaut. Une valeur plus élevée
augmente la pression mémoire et PostgreSQL pendant la matérialisation communale ;
ne la monter jusqu'à `1000` qu'après mesure sur l'environnement cible.

Le rattrapage historique est découpé en workers d'au plus
`HISTORIC_COMPUTE_CHUNK_DAYS` jours. Le parent ne démarre le lot suivant qu'après
avoir vérifié les deux curseurs et leurs générations en base. Chaque journée,
chaque avancement atomique de curseur et chaque snapshot communal restent liés
à la révision source capturée au début du rattrapage. Un changement de révision
interrompt le lot, remet les curseurs à la première date sale et interdit la
certification de snapshots produits sous une autre révision. Les fichiers
GeoJSON et PMTiles datés du lot sont supprimés en `finally`, succès ou échec.

Pendant un bootstrap, n'augmenter la taille des chunks qu'après avoir mesuré un
lot complet sur l'environnement cible. La durée projetée du nouveau lot doit
conserver une marge d'au moins 30 minutes sous le timeout worker de quatre
heures. Un chunk plus long réduit les tris globaux de fin de lot, mais
n'accélère pas le calcul journalier. Comparer de la même façon toute hausse de
`COMMUNE_STATISTICS_BATCH_SIZE` sur plusieurs journées et revenir à la valeur
précédente lorsqu'aucun gain net n'est mesuré.

Les accélérations historiques sont strictement désactivées par défaut. Avec
`HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED=true`, un département n'est conservé
que pour une reprise du même jour ou depuis la veille exacte, avec la même
révision source, la même signature métier, la même version de matérialisation
et une empreinte identique des zones encore présentes en base. Un changement,
un gap ou un rewind force son recalcul. L'époque de calcul reste stable pendant
les avancées quotidiennes, mais change à chaque invalidation explicite des
curseurs. Sans époque et révision source certifiées, aucun checkpoint n'est
réutilisé.

Au démarrage de chaque worker computed, au plus 5 000 checkpoints appartenant
à une ancienne époque ou révision source sont supprimés. Les checkpoints d'un
autre mode de matérialisation mais du contexte courant sont conservés et
simplement ignorés. Une journée `D+1` interrompue ne reprend directement que
si les deux curseurs certifient `D`, que le snapshot communal national de `D`
est `completed` sous la révision attendue et qu'au moins un checkpoint de
`D+1` correspond exactement à l'époque, à la révision et au mode courants. `D+1`
doit aussi appartenir au chunk ; sinon le replay inclusif de `D` est conservé.

`HISTORIC_SKIP_COMMUNE_INTERSECTIONS=true` omet uniquement la table de liaison
historique entre zones et communes. Les GeoJSON, PMTiles et statistiques
communales utilisent les géométries et leurs propres intersections. Le mode est
inclus dans la signature des checkpoints, de sorte qu'un retour à `false`
recalcule les départements concernés.

`HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED=true` groupe uniquement l'écriture
communale des journées historiques legacy qui ne contiennent aucune zone. Les
GeoJSON, PMTiles, situations départementales, snapshots et avancées CAS restent
produits et certifiés journée par journée. La plage groupée est bornée par
`HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS`, à `7` par défaut et `31` au maximum.
Le tri JSONB reste globalement chronologique et la révision source ainsi que
l'époque historique sont contrôlées dans les transactions de progression et de
certification. Laisser ce mode désactivé jusqu'à la mesure d'un chunk complet
sur l'environnement cible.

Augmenter `HISTORIC_DEPARTMENT_CONCURRENCY` progressivement, d'abord de `1` à
`2`, puis seulement après plusieurs journées stables. Les dates, les fichiers,
les statistiques et les curseurs restent séquentiels. Ne jamais lancer un
second `clock` ni répartir manuellement des plages de dates : la table de
travail historique et les curseurs sont nationaux.

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
réécrire la version d'une publication existante. La version 4 publie le niveau
calculé après harmonisation communale dans le GeoJSON et le PMTiles. Les
exécutions quotidiennes et historiques incluent cette version dans leur identité
persistée, afin qu'un artefact produit avec un niveau source antérieur ne puisse
pas empêcher le recalcul national en version 4.

`ZONE_PUBLICATION_HEALTH_PROGRESS_STALE_AFTER_SECONDS` borne la durée pendant
laquelle le health public peut répondre `updating`. Cette réponse n'est autorisée
que si la publication active est encore réellement servie par toutes les instances
publiques vivantes, en nombre au moins égal au minimum configuré, que le `clock`
est sain et qu'un timestamp métier (état, snapshot, publication en cours ou
préchargement de candidate) a progressé dans cette fenêtre. Le heartbeat de
l'active prouve qu'elle est servie, mais ne suffit jamais à prolonger seul un
calcul bloqué. Un snapshot ne compte comme progrès que s'il porte la révision
source courante et concerne le jour métier ou la plage historique sale. Chaque
avancement CAS des curseurs historiques persiste aussi son propre timestamp; il
ne compte que pendant le run quotidien courant de même révision et version.

Lors d'un upgrade avec une publication déjà active, des curseurs legacy
`computeMapDate` et `computeStatsDate` tous deux nuls ne prouvent aucune date
historique : la migration laisse donc `historicPublishedThrough` nul et les
activations suivantes restent bloquées. Contrôler ce cas avant la bascule et
réconcilier explicitement les curseurs. Cette règle ne bloque pas la toute
première baseline d'une base neuve, qui initialise son propre marqueur J-1.

Après activation de la première baseline, `ZONE_PUBLICATION_ENABLED=true` est la
valeur nominale et doit rester configurée tant que le `clock` tourne. Laisser le
`clock` actif avec la valeur `false` réactive le calcul legacy : ses checkpoints
ne portent pas la révision de la publication active et la chaîne quotidienne
data.gouv.fr finit par être bloquée. La valeur `false` est donc réservée à un gel
avec `clock=0` ou à un rollback applicatif supervisé.

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
sont terminées. Le gate data.gouv.fr utilise la même identité historique
(curseurs et générations) avant et après les uploads ; une invalidation force la
republication du run et de ses ressources. Chaque commune doit contenir
exactement un enregistrement par jour depuis le 1er janvier jusqu'à la date
métier attendue.

Une ligne de calcul national restée `running` est reprise immédiatement après
l'acquisition d'un nouveau verrou de registre. En régime nominal, ce verrou est
conservé pendant tout le traitement; la phase de matérialisation possède en plus
son propre verrou PostgreSQL. Si la session du registre tombe avant l'arrêt du
processus, seuls les prétraitements idempotents peuvent brièvement se recroiser :
le second verrou empêche le chevauchement de deux matérialisations tant que sa
session PostgreSQL reste valide. Les publications HTTP externes ne bénéficient
pas de cette reprise accélérée et conservent une grâce de deux heures, afin qu'une
perte isolée de connexion PostgreSQL ne lance pas deux uploads concurrents.

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

Le rafraîchissement communal charge explicitement les géométries existantes et
n'écrit que les communes réellement modifiées. Une égalité GeoJSON incertaine est
confirmée avec `ST_Equals`; les géométries nouvelles ou différentes sont refusées
si PostGIS les considère vides ou invalides. Une réponse API GEO vide, dupliquée,
dépourvue d'un champ demandé ou inférieure à 90 % de la cardinalité départementale
connue est refusée avant toute écriture du département. Sur une base vide, la
réponse détaillée est comparée à un second index léger de l'API GEO avant le
bootstrap. Une exécution sans changement ne doit donc ni réécrire les communes ni
faire progresser la révision source.

Le rafraîchissement mensuel des géométries départementales applique la même
discipline : il verrouille puis compare chaque géométrie en SRID 4326 avec
`ST_Equals`, et n'écrit que les départements réellement différents. Il ne doit
donc pas invalider une publication lorsque le flux source est inchangé.

`SANDRE_ZONE_SYNC_MODE=paused` ne contacte pas le référentiel,
`SANDRE_ZONE_SYNC_MODE=audit` enregistre les décisions sans modifier les zones,
et `SANDRE_ZONE_SYNC_MODE=safe` applique uniquement les rapprochements non
ambigus. `SANDRE_FORCE_FULL_AUDIT_AFTER` accepte uniquement un instant UTC ISO
8601 non futur, par exemple `2026-08-02T12:00:00Z`. Il est obligatoire dans les
deux modes actifs `audit` et `safe`. Chaque département dont le dernier lot
`snapshot/audit` démarré après cet instant n'est pas `observed` est audité, y
compris si son observation précédente a moins de 24 heures. Un dernier lot
`blocked` prouve seulement que l'audit a été tenté et tempère sa relance
immédiate; un lot `blocked`, `failed` ou `started` plus récent invalide toujours
un ancien lot `observed` et n'autorise jamais le passage en `safe`. Sous le verrou
SANDRE national, `safe` vérifie d'abord que, pour chacun des 101 départements, le
dernier lot `snapshot/audit` postérieur au cutoff est `observed`, avant tout appel
SANDRE et toute écriture métier. Une valeur absente ou invalide interrompt le job
avant tout contact SANDRE et rend le health de synchronisation invalide. Seul le
mode `paused` autorise une valeur vide.

Un département bloqué est actuellement réévalué au plus tôt après cinq minutes,
donc à chaque cron de dix minutes tant que le blocage persiste. Ce choix permet
une reprise rapide après correction mais peut entretenir des appels SANDRE en cas
d'anomalie durable. Surveiller `blockedDepartments` et `blockedBatches`; une
valeur non nulle persistante doit déclencher une alerte opérateur et le passage en
`paused` pendant l'analyse. Aucun backoff implicite n'est ajouté sans état de
tentative persisté, afin d'éviter un délai caché ou incohérent après redémarrage.
Une zone gelée encore utilisée n'est rapprochée que si la généalogie officielle
SANDRE fournit un successeur linéaire strictement 1:1, actif, de même département
et de même type. Les références opérationnelles sont alors remappées dans la
transaction. Une référence est opérationnelle uniquement lorsque son arrêté est
`a_venir` ou `publie`. Les brouillons `a_valider` et les arrêtés `abroge`
conservent leur zone historique; lorsqu'une filiation 1:1 est certaine, son alias
est toutefois provisionné sans déplacer ces références afin que leur éventuelle
activation future soit remappée par le garde-fou PostgreSQL. Toute branche,
collision, source indisponible, généalogie périmée ou cible ambiguë bloque le
département si une référence opérationnelle est concernée. Le même cas reste
simplement différé pour un brouillon ou un historique.

Le champ d'affichage historique `zone_alerte.code`, les noms et la proximité des
géométries ne constituent jamais une identité SANDRE automatique. Une fusion ou
un découpage 1:N exige une décision métier et un rapprochement one-shot approuvé;
le mode `safe` doit rester bloquant plutôt que d'inférer ce choix.
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
   `master` valide une promotion ponctuelle mais ne remplace jamais cette
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

5. Retirer `NODE_TLS_REJECT_UNAUTHORIZED=0`, vérifier que
   `SKIP_SCHEMA_BOOTSTRAP` est absent ou vaut `false`, déployer
   `regleau-back-preprod`, conserver `clock=0`, puis restaurer `web` à sa
   formation initiale. Vérifier les migrations, la base, OAuth, S3, SANDRE,
   l'envoi de mail et les départements. `SKIP_SCHEMA_BOOTSTRAP=true` est réservé
   aux tests qui créent eux-mêmes leur schéma : en exploitation il empêcherait
   l'application des migrations au démarrage.
6. Déployer `vigieau-api-preprod`. Attendre plus d'une durée de lease (30 s), puis
   vérifier que `liveInstances` correspond exactement à la formation publique.
7. Passer uniquement `DISABLE_SCHEDULED_JOBS=false`, en gardant d'abord
   `clock=0`, les écritures gelées et SANDRE en pause. Activer ensuite
   `ZONE_PUBLICATION_ENABLED=true`, puis démarrer exactement `clock=1` en taille
   `2XL` avec `SANDRE_ZONE_SYNC_MODE=paused`. Le `clock` est indispensable au
   calcul quotidien et au rattrapage historique : attendre la baseline avec
   `clock=0` ne peut pas fonctionner. Attendre la baseline complète : candidate,
   quorum, statut `active`, `legacyPromotedAt`, manifeste et artefacts valides.
   `/api/health/zone-publication` peut répondre `updating` pendant la progression
   réelle, mais doit finir à `healthy`. Ne jamais modifier le pointeur actif
   directement en SQL. Avant l'audit SANDRE de l'étape 10, remettre le `clock` à
   zéro pour fixer le cutoff, puis le redémarrer comme indiqué.
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
   du canvas et plusieurs lectures Range réelles de l'archive PMTiles. Son mode
   Tarbes est `adaptive` par défaut : un 409 doit afficher la modale de précision
   attendue, tandis qu'un 200 doit naviguer vers `/situation` sans afficher cette
   modale ni produire d'erreur fatale. Le mode `strict` continue d'exiger le 409;
   `skip` désactive uniquement ce parcours.

9. Dans un vrai navigateur desktop et mobile, comparer Tarbes (`65440`) par
   sélection de commune, adresse précise et carte. Vérifier le rendu non vide de
   la carte, les requêtes de tuiles, la console, la date courante et une date
   historique.
10. Avec `clock=0`, fixer un cutoff et passer SANDRE en `audit`, puis démarrer
    exactement `clock=1` en taille `2XL` :

    ```bash
    SANDRE_AUDIT_AFTER=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    scalingo --app regleau-back-preprod env-set \
      SANDRE_FORCE_FULL_AUDIT_AFTER="$SANDRE_AUDIT_AFTER" \
      SANDRE_ZONE_SYNC_MODE=audit
    scalingo --app regleau-back-preprod scale --synchronous clock:1:2XL
    ```

    Vérifier le verrou singleton, le heartbeat, la mémoire et l'absence d'OOM.
    Attendre un cycle complet : le health audit doit être `healthy`, avec
    `trackedDepartments=totalDepartments=101`, `staleDepartments=0`,
    `forcedAuditCompletedDepartments=totalDepartments=101`,
    `pendingForcedAuditDepartments=0`, `blockedDepartments=0`, `failedBatches=0`
    et `blockedBatches=0`. `requiredObservationAfter` doit correspondre au cutoff
    configuré. Après examen des décisions, passer en `safe` en conservant
    exactement le même cutoff :

    ```bash
    scalingo --app regleau-back-preprod env-set \
      SANDRE_ZONE_SYNC_MODE=safe
    ```

    Au cron suivant, au plus dix minutes plus
    tard, le retraitement de chaque département jamais appliqué ou dont les hash
    ou dates source observés et appliqués diffèrent est déclenché sans attendre le
    cycle complet de 24 heures. La durée totale dépend ensuite du référentiel et
    du nombre de départements. Observer les éventuels départements bloqués ainsi
    que la publication atomique suivante. Attendre ensuite que les quatre
    endpoints répondent `200` :

    ```text
    GET https://api.admin.vigieau.incubateur.net/api/health/clock
    GET https://api.admin.vigieau.incubateur.net/api/health/zone-publication
    GET https://api.admin.vigieau.incubateur.net/api/health/sandre-references
    GET https://api.admin.vigieau.incubateur.net/api/health/sandre-synchronization
    GET https://api.admin.vigieau.incubateur.net/api/health/map-archives
    ```

    `sandre-references` doit renvoyer `status=healthy` et `total=0`. Il ignore les
    brouillons `a_valider` et les références purement historiques des arrêtés
    abrogés, mais bloque la reprise dès qu'un arrêté `a_venir` ou `publie` utilise
    encore une zone SANDRE désactivée. Le passage ultérieur d'un brouillon ou
    d'un arrêté abrogé vers un de ces statuts est contrôlé transactionnellement.
    En mode `safe`, le health SANDRE doit en plus afficher
    `trackedDepartments=appliedDepartments=totalDepartments=101`, avec
    `staleDepartments=0`, `staleAppliedDepartments=0`,
    `pendingApplicationDepartments=0`, `blockedDepartments=0`, `failedBatches=0`
    et `blockedBatches=0`. Attendre ensuite le recalcul et l'activation d'une
    publication alignée sur la nouvelle révision source : l'ancienne active peut
    continuer à servir pendant ce calcul, mais ne constitue pas la validation de
    sortie. `/api/health/zone-publication` doit répondre strictement `healthy`,
    avec tous ses contrôles à `true` hors `recentProgress`, avant tout smoke final
    et avant la levée du gel. Aucun front, cache ou dataset public ne doit être
    promu avant que ces contrôles et compteurs soient tous conformes.
    Pendant la phase d'observation, utiliser directement le health de
    synchronisation avec le mode attendu `audit`. Le smoke admin complet exige
    aussi zéro référence SANDRE opérationnelle invalide : il peut donc échouer
    normalement avant l'application des décisions auditées. Après la bascule,
    le smoke final doit être lancé avec `VIGIEAU_EXPECT_SANDRE_MODES=safe`,
    `VIGIEAU_EXPECT_DEPARTMENT_COUNT=101` et
    `VIGIEAU_EXPECT_MAP_ARCHIVES=disabled`; ne jamais autoriser les deux modes
    dans ce contrôle de sortie.

11. Exécuter seulement maintenant le smoke admin complet avec les URL front et
    API preprod. Ce smoke exige `status=healthy` sur
    `/api/health/zone-publication`; il n'accepte jamais `updating`, même avec une
    ancienne active encore servie. Comme aucun dataset data.gouv.fr de test n'est
    configuré, `never_succeeded` est attendu et exige
    `VIGIEAU_ALLOW_UNPUBLISHED_EXTERNAL=true`. Rejouer aussi les smokes public et
    navigateur; tous doivent être verts avant de remettre
    `ADMIN_WRITES_DISABLED=false`. `/resume` est lui-même bloqué pendant le gel :
    lever ce gel avant une reprise manuelle.

## Recalcul communal historique cible

Le script `recompute:commune-statistics` répare des dates communales précises
sans déplacer les curseurs de la chaîne historique. Avant une exécution en
production : geler les écritures admin, arrêter le `clock`, attendre la
libération des verrous historique et communal, créer un backup PostgreSQL et
contrôler son statut `done`. Le script désactive aussi ses jobs de démarrage,
prend les deux verrous de session, fixe la révision source et l'époque, puis
refuse toute certification si ce contexte change. Son contrôle préalable refuse
toute exécution tant qu'une ligne de barrière `bootstrap` existe : attendre que
la chaîne historique normale la lève ou restaurer le backup selon la procédure
d'incident avant de relancer. La conservation de cette barrière reste également
active comme défense secondaire pendant le calcul ciblé.

Une exécution nationale doit être confirmée explicitement et reste limitée à
100 dates par défaut. Les dates futures sont refusées. Exemple pour deux plages
disjointes en production :

```bash
scalingo --region osc-fr1 --app regleau-back-prod run --detached --size 2XL \
  -e DATE_FROM=2026-03-28 \
  -e DATE_TO=2026-06-05 \
  -e DATES=2026-06-20,2026-06-21,2026-06-22 \
  -e CONFIRM_NATIONAL_RECOMPUTE=true \
  -e HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED=false \
  npm run recompute:commune-statistics
```

La commande s'exécute dans la racine applicative du backend admin déployé, où le
script npm existe. Pour valider d'abord en preprod, remplacer uniquement l'app
par `regleau-back-preprod`. `HISTORIC_RECOMPUTE_MAX_DATES` ne doit être augmenté
explicitement qu'après revue de la plage. Les checkpoints restent désactivés
pour une réparation complète ; ne passer
`HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED=true` qu'après validation explicite de
la réutilisation des matérialisations existantes.

Pour une réparation départementale, définir `DEP_CODES` et ne pas fournir la
confirmation nationale, par exemple :

```bash
scalingo --region osc-fr1 --app regleau-back-prod run --detached --size 2XL \
  -e DATES=2026-06-20,2026-06-21,2026-06-22 \
  -e DEP_CODES=65 \
  -e HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED=false \
  npm run recompute:commune-statistics
```

Après succès national, vérifier pour chaque date le snapshot `national`
`completed`, sa révision source et l'égalité des nombres attendus et traités.
Après succès départemental, contrôler le scope exact
`departements:<codes-tries>` ; son statut peut rester `partial` lorsqu'aucun
snapshot national complet n'existait déjà pour la date. Dans les deux cas,
contrôler les doublons, un département témoin déjà complet et l'absence de
modification hors plage. Le script recalcule ensuite une fois chaque agrégat
mensuel concerné et effectue un tri final sous le verrou communal.

La ressource annuelle des communes peut être republiée après un recalcul
national ciblé sans attendre le rattrapage multiannuel uniquement lorsqu'aucune
barrière `bootstrap` n'existe. Tous les snapshots des dates réparées doivent être
`completed` sous la révision attendue, aucun snapshot non terminé ne doit
concerner l'année, et le générateur doit confirmer pour chaque commune la
couverture quotidienne exacte du 1er janvier à la date source attendue.
Contrôler le contenu et la date de la ressource annuelle, puis redémarrer le
`clock` et lever le gel. Une réparation départementale ne constitue jamais
cette autorisation.

La ressource historique multiannuelle reste bloquée jusqu'à la certification du
rattrapage global : `historicDirtyFrom` et `historicDirtyThrough` sont `NULL`,
les deux curseurs `computeMapDate` et `computeStatsDate` couvrent la date requise,
aucun snapshot n'est `running`, `failed` ou `partial`, et la barrière `bootstrap`
a été levée par la chaîne historique normale.

En cas d'échec, ne rien publier et ne pas redémarrer le `clock`. Contrôler les
snapshots `running`, `failed` et `partial`, puis soit rejouer idempotemment le
même scope et les mêmes dates après correction, soit restaurer le backup. Dans
les deux cas, reprendre tous les contrôles de sortie avant publication.

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

`/api/health/zone-publication` synthétise la chaîne complète sans exposer
d'identifiant, de révision numérique, de version ni d'erreur brute. `healthy`
exige l'activation du mécanisme, l'absence de pause et de candidate, une active
du jour et de la révision source courante sur la version de matérialisation du
code, toutes les instances publiques vivantes prêtes avec le minimum configuré,
la promotion legacy, les statistiques courantes du jour métier Paris avec un
snapshot national complet de la même révision source,
l'historique et les deux curseurs au moins à J-1, aucune plage sale et aucun
snapshot incomplet. Il revalide aussi le succès exact des runs quotidien et
historique avec les dates, curseurs et générations toujours présents en base.
`updating` reste un `200` uniquement pendant une progression récente et
vérifiable alors qu'une active continue d'être servie; le smoke de sortie la
refuse. Sans progrès récent, l'endpoint répond `503 stale`. Le health
data.gouv.fr reste volontairement séparé dans
`/api/health/external-publications`.

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

SELECT revision, "currentPublishedDate", "historicPublishedThrough",
       "historicDirtyFrom", "historicDirtyThrough", "updatedAt"
FROM statistic_publication_state
WHERE id = 1;

SELECT "snapshotDate", scope, status, "sourceRevision",
       "processedCommuneCount", "expectedCommuneCount", "startedAt",
       "completedAt", "updatedAt"
FROM statistic_commune_snapshot
ORDER BY "updatedAt" DESC, "snapshotDate" DESC, scope
LIMIT 10;

SELECT COUNT(*)::integer AS "incompleteSnapshotCount"
FROM statistic_commune_snapshot
WHERE status NOT IN ('ready', 'completed')
   OR "processedCommuneCount" <> "expectedCommuneCount";
```

Une publication `active` avec `legacyPromotedAt IS NULL` continue d'être servie
par les API versionnées, mais les consommateurs historiques utilisent encore les
anciens alias S3. La promotion est retentée automatiquement. data.gouv.fr n'est
jamais mis à jour avant `legacyPromotedAt`; un `dataGouvPromotedAt` nul avec un
alias promu indique uniquement une reprise data.gouv.fr en attente.

Le endpoint admin `/api/zone-publication/health`, réservé au rôle `mte`, expose
le pointeur actif, la candidate, le quorum et la pause automatique. Son bloc
`statistics` donne la révision publiée, les marqueurs courant et historique, la
plage historique à recalculer, le dernier snapshot mis à jour avec sa progression
et le nombre de snapshots incomplets. Un snapshot `ready` a fini son calcul mais
attend encore l'activation atomique; il n'est donc pas compté comme incomplet.
Les endpoints
`/api/health/clock`, `/api/health/zone-publication`,
`/api/health/external-publications`,
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
Les constructions abandonnées et les publications validées qui ne sont liées à
aucune exécution quotidienne persistante sont rendues purgeables après 75 minutes
par défaut. Une publication validée liée au rattrapage en cours reste réutilisable
jusqu'à sa certification ou jusqu'à un changement de révision source. Les
heartbeats de processus vieux de plus de 24 heures sont supprimés.

Les lignes et associations PostgreSQL sont purgées selon cette politique, mais
les artefacts GeoJSON/PMTiles immuables sur S3 ne le sont pas. Leur suppression
reste volontairement hors périmètre tant qu'une API fiable ne permet pas de
lister, rapprocher puis supprimer uniquement les objets qui ne sont référencés
par aucune publication conservée. Une alerte de volumétrie S3 doit donc être
configurée côté hébergeur avant la mise en production.

## Rollback

1. Mettre `clock=0`, `SANDRE_ZONE_SYNC_MODE=paused` et vider
   `SANDRE_FORCE_FULL_AUDIT_AFTER`. Laisser
   `ZONE_PUBLICATION_ENABLED=true` pour permettre le préchargement de la cible.
2. Appeler `POST /api/zone-publication/rollback` avec `apply=false` et un
   `publicationId` explicite. Vérifier la cible et les bloqueurs, puis répéter avec
   exactement le même identifiant et `apply=true`. Une candidate normale encore
   en attente est remplacée atomiquement; une autre candidate de rollback bloque
   l'opération. Le dry-run refuse une publication d'une autre révision source ou
   d'une ancienne version de matérialisation : les statistiques ne sont pas
   versionnées par publication, donc un rollback inter-révision ne permettrait
   pas de prouver leur cohérence. La cible doit aussi avoir un snapshot national
   `completed` certifié pour son jour et ne laisser aucun snapshot incomplet
   jusqu'à cette date.
3. Attendre son préchargement par le quorum et son activation normale. Vérifier
   le manifeste, Tarbes, la carte et `legacyPromotedAt`. Ne jamais modifier le
   pointeur actif directement en SQL. Après le préchargement, l'activation
   revalide les mêmes invariants et prend, dans cet ordre, les verrous de calcul
   national puis historique; elle reste sans écriture et répond `busy` si l'un
   des deux calculs est en cours. Une plage historique sale bloque aussi le
   dry-run, l'apply et l'activation. Elle reconstruit ensuite le mois de la cible,
   supprime les snapshots futurs incomplets et borne le curseur historique à la
   date restaurée avant le basculement atomique.
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

Pendant la marche avant normale, `historicPublishedThrough` peut temporairement
dépasser `currentPublishedDate` lorsque le catch-up de J-1 se termine avant
l'activation de J. Cet état transitoire est attendu; seul le rollback recule
explicitement le curseur historique avec la date restaurée.
