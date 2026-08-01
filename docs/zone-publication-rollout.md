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
l'ensemble des copies S3 d'une promotion par `ZONE_PUBLICATION_S3_TIMEOUT_MS`.
Les erreurs restent portées par la publication active sans dégrader son statut.

Le contrat d'une publication vide valide est explicite : `zoneCount=0`,
`communeLinkCount=0`, une collection GeoJSON sans feature, un artefact PMTiles
immuable lisible, et des endpoints zones/communes qui répondent `200` avec des
listes vides. Elle ne doit jamais être assimilée à une erreur de cache.

Le minimum doit correspondre au nombre nominal d'instances de l'API publique.
Une valeur trop haute bloque la candidate sans interrompre la version active. Une
valeur trop basse autorise une activation avant qu'une instance attendue soit
revenue en ligne.

## Déploiement preprod

1. Identifier l'add-on PostgreSQL et créer un backup :

   ```bash
   scalingo --app regleau-back-preprod addons
   scalingo --app regleau-back-preprod --addon <postgres_uuid> backups-create
   scalingo --app regleau-back-preprod --addon <postgres_uuid> backups
   ```

2. Configurer `ZONE_PUBLICATION_ENABLED=false` et
   `ZONE_PUBLICATION_MIN_READY_INSTANCES=1` sur `regleau-back-preprod`.
3. Déployer `regleau-back-preprod`. Ce déploiement applique la migration additive
   sans construire ni activer de publication. L'API publique existante continue
   à lire `zone_alerte_computed`.
4. Déployer `vigieau-api-preprod` et vérifier qu'elle sait lire le nouveau schéma
   tout en continuant à servir l'ancien cache lorsqu'aucune publication n'est
   active.
5. Passer `ZONE_PUBLICATION_ENABLED=true` sur `regleau-back-preprod`, puis attendre
   la construction, le préchargement, l'activation et la promotion S3 d'une
   publication. `legacyPromotedAt` doit être renseigné avant de poursuivre. Ne
   jamais forcer le pointeur actif par SQL.
6. Vérifier le manifeste et les trois endpoints de santé, puis seulement déployer
   `preservonsleau-front-preprod` :

   ```text
   GET https://api.vigieau.incubateur.net/api/health/live
   GET https://api.vigieau.incubateur.net/api/health/ready
   GET https://api.vigieau.incubateur.net/api/health/cache
   GET https://api.vigieau.incubateur.net/api/zones/publication
   ```

7. Comparer sur plusieurs communes, dont Tarbes (`65440`), une recherche par
   commune et une recherche par coordonnées. Vérifier aussi la carte courante et
   une date historique.

## Déploiement production

Reprendre la même séquence avec :

- `regleau-back-prod`, avec `ZONE_PUBLICATION_MIN_READY_INSTANCES=2` ;
- `preservonsleau-api-prod` ;
- `preservonsleau-front-prod` ;
- `https://api.vigieau.beta.gouv.fr/api/health/*` et
  `https://api.vigieau.beta.gouv.fr/api/zones/publication`.

Créer et contrôler le backup PostgreSQL avant le déploiement admin. La première
publication doit être observée jusqu'à `active`, puis jusqu'à un
`legacyPromotedAt` non nul avant de clore l'intervention. Un
`dataGouvPromotedAt` nul signale une mise à jour data.gouv.fr encore en reprise et
doit rester supervisé.

## Diagnostic

Le endpoint `/api/health/ready` reste à `200` si un ancien snapshot utilisable est
conservé. `/api/health/cache` passe à `503` si le pointeur, le préchargement ou le
contrôle de version n'est pas à jour. Le diagnostic n'expose ni erreur brute, ni
identifiant d'instance.

Dans `pgsql-console`, contrôler sans écrire :

```sql
SELECT * FROM zone_publication_state WHERE id = 1;

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

Le pointeur PostgreSQL est atomique et chaque copie S3 remplace un objet de façon
indépendante. S3 et data.gouv.fr ne fournissent pas de transaction commune pour
la paire GeoJSON/PMTiles : en cas d'incident intermédiaire, le service recopie
idempotemment l'ensemble et privilégie temporairement l'ancien alias à la
publication d'un artefact non validé.

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

1. Passer d'abord `ZONE_PUBLICATION_ENABLED=false` sur l'API admin et attendre
   son redémarrage. Cela arrête le watchdog et empêche toute candidate restante
   d'être activée pendant le rollback.
2. Revenir au front précédent : il réutilise l'URL PMTiles historique,
   toujours publiée.
3. Revenir ensuite à l'API publique précédente : `zone_alerte_computed` est restée
   alimentée pendant toute la transition.
4. Revenir enfin à l'API admin précédente si nécessaire.
5. Conserver les tables `zone_publication*` pendant le rollback applicatif. La
   migration est additive et l'ancien code les ignore.
6. N'exécuter le `down` de la migration qu'après retour complet des trois services,
   vérification fonctionnelle et décision explicite : il supprime l'historique des
   publications.
