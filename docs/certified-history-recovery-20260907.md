# Reprise de l'historique certifie, 2026-09-07

## Etat et limites de cette intervention

Diagnostic etabli en lecture seule le 7 septembre 2026. La cause de la perte
de certification est identifiee ; les resultats corriges n'ont pas encore ete
recalcules ni certifies. Aucune ecriture de donnees de production, activation du
rattrapage, creation de base cloud ou suspension des ecritures admin n'a ete
effectuee pour cette investigation. Les alertes sont traitees separement dans
[production-monitoring.md](production-monitoring.md).

L'API publique sert le courant du 7 septembre avec 4 946 dates disponibles et
trois instances pretes. La plage du 11 juillet au 31 aout, soit 52 dates, est
exclue du cache public faute de certification active. Cela ne signifie pas que
les lignes historiques ont disparu de PostgreSQL.

## Cause verifiee

- La reparation `2d8f1cf4-ad79-492a-82cf-ac57c428f8f1`, source
  `vigieau-2026-07-11-2026-08-31-isolated-recompute-v2`, couvre les 52 dates.
  Elle a ete promue le 2 septembre a 21:39 UTC, a la revision source `168708`,
  et attestee jusqu'a l'epoque `796`.
- Les 52 snapshots nationaux existent encore, tous `completed`, avec
  `expectedCommuneCount=processedCommuneCount=34943` et ce meme identifiant de
  reparation. La vue `active_certified_history_repair` ne retourne aucune ligne.
- Les epoques `797` a `811` sont des invalidations
  `published-source-mutation`, toutes avec `fallback: false`. L'epoque `797`
  couvre seulement septembre et ne chevauche pas la reparation. A partir de
  `798`, plusieurs mutations chevauchent effectivement juillet/aout : debut au
  19 aout pour `798`, au 13 aout pour `805`, au 11 juillet pour `810`, au
  7 aout pour `811`. Ces exemples ne remplacent pas le releve SQL complet.
- Au releve : revision statistique `143`, publication courante `2026-09-07`,
  plage sale `2026-07-11..2026-08-31`, historique publie jusqu'au `2026-08-27`,
  epoque historique `811`, epoque globale `9`, curseurs cartes/statistiques au
  `2026-07-09`, revision source `185950`, revision publique source `168731`.
- Le backend admin deploye `7bd55680297c2f85b4baa08792eab9eefc0578a0` inclut
  deja les commits `db6b0cb` et `4ecdf47`. L'invalidation par plage et la
  protection du dry-run d'attestation ne sont donc pas des correctifs manquants
  sur ce deploiement.

La comparaison avec l'ancienne source v2 pourrait confirmer que les anciennes
valeurs sont encore stockees ; elle ne prouverait pas leur validite apres les
mutations retroactives. Reattester la v2 inchangee, supprimer des invalidations,
forcer des tags ou effacer la plage sale masquerait le probleme.

## Sources disponibles

L'inventaire Scalingo du 7 septembre confirme des backups conserves aux dates
suivantes : 19 et 26 juillet ; 2, 9, 16 et 30 aout ; puis du 31 aout au
7 septembre. Reconsulter leur statut, leur taille et leur identifiant avant
utilisation ; leur retention peut evoluer.

| Source confirmee | Identifiant | Utilite et limite |
| --- | --- | --- |
| Backup manuel du 2 septembre | `6a9847fb99c3cd5eb9c89768` | Reference conservee proche de la certification v2 ; son contenu exact doit etre inspecte. |
| Backup du 7 septembre | `6a9dfea099826944b38228f0` | Environ 4,3 Go ; point de depart pour observer les sources apres les mutations, pas preuve automatique des geometries historiques. |
| Volume Docker local `vigieau_postgres_data` | PostgreSQL 17, system ID `7647480344494395429` | 7,9 Gio, arret propre, dernier checkpoint le 23 aout a 21:00:08 UTC. Ne pas le traiter comme la source v2 construite en septembre. |

Le volume local a ete monte uniquement en lecture seule, sans demarrage de
PostgreSQL. Aucun clone historique Scalingo ni artefact de source certifiee n'a
ete retrouve dans les recherches locales ciblees. L'absence d'un fichier dans
ces recherches ne prouve pas l'absence d'une archive ailleurs.

Le plan de source v2 est code dans
[`build-certified-history-source.ts`](../apps/backend-admin/src/scripts/build-certified-history-source.ts).
Ses six identifiants historiques et son manifeste ne sont pas interchangeables
avec les backups actuellement conserves. Ne pas substituer un backup recent a
un identifiant epingle, ni modifier les digests pour faire accepter une source.

## Reprendre le diagnostic sans cette conversation

Depuis la racine du depot, verifier les deploiements et les processus, sans les
redemarrer :

```sh
scalingo --region osc-fr1 --app regleau-back-prod deployments
scalingo --region osc-fr1 --app regleau-back-prod ps
scalingo --region osc-fr1 --app preservonsleau-api-prod ps
scalingo --region osc-fr1 --app regleau-back-prod addons
```

Relever l'identifiant de l'addon PostgreSQL, sans afficher de credentials :

```sh
: "${PROD_POSTGRES_ADDON:?Identifiant de l'addon PostgreSQL de production}"
scalingo --region osc-fr1 --app regleau-back-prod \
  --addon "$PROD_POSTGRES_ADDON" backups
scalingo --region osc-fr1 --app regleau-back-prod pgsql-console
```

Dans la console SQL, executer une transaction explicitement en lecture seule :

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '250ms';

SELECT current_database(), now();
SELECT id, "sourceRunId", "dateFrom", "dateThrough", "dayCount",
       "historicComputeEpoch", "publicationRevisionAfter", "promotedAt"
FROM certified_history_repair_audit
ORDER BY "promotedAt" DESC LIMIT 5;

SELECT "repairId", "attestedThroughEpoch", "attestedAt"
FROM certified_history_repair_attestation
WHERE "repairId" = '2d8f1cf4-ad79-492a-82cf-ac57c428f8f1'::uuid
ORDER BY "attestedAt" DESC;

SELECT "epochAfter", "affectedRange"::text, "invalidatesStatistics",
       "invalidatesMaps", cause, "sourceRevision", context, "createdAt",
       "affectedRange" && daterange('2026-07-11', '2026-09-01', '[)')
         AS overlaps_repair
FROM historic_range_invalidation
WHERE "epochAfter" > 796
ORDER BY "epochAfter";

SELECT id, "sourceRunId", "attestedThroughEpoch"
FROM active_certified_history_repair;

SELECT "snapshotDate", status, "expectedCommuneCount",
       "processedCommuneCount", "certifiedHistoryRepairId"
FROM statistic_commune_snapshot
WHERE scope = 'national'
  AND "snapshotDate" BETWEEN DATE '2026-07-11' AND DATE '2026-08-31'
ORDER BY "snapshotDate";

SELECT p.revision, p."currentPublishedDate", p."historicDirtyFrom",
       p."historicDirtyThrough", p."historicPublishedThrough",
       c."historicComputeEpoch", c."historicBackfillGlobalEpoch",
       c."computeMapDate", c."computeStatsDate",
       s.revision AS source_revision, s."publicRevision"
FROM statistic_publication_state p
CROSS JOIN config c
CROSS JOIN zone_publication_source_state s
WHERE p.id = 1 AND c.id = 1 AND s.id = 1;
ROLLBACK;
```

Les sorties peuvent contenir du contexte operationnel interne : les conserver
dans un repertoire restreint, pas dans un ticket public. Les backups contiennent
des donnees applicatives sensibles et ne doivent jamais etre ajoutes au depot.

## Chemin de recherche v3 isole, sans gel de production

1. Utiliser un repertoire prive sur disque sous `/home`, hors depot.
   Ne pas mettre les archives ou le cluster dans `/tmp`, qui est un tmpfs
   d'environ 13 Go. Les 123 Go libres observes sous `/home` doivent etre
   recontroles avant tout telechargement ; mesurer aussi la taille restauree,
   les index, les WAL et la marge necessaire aux tables de travail.
2. Telecharger uniquement des backups existants `done`, sans creer de backup
   manuel ni de nouvelle base cloud. Archiver le SHA-256, la liste du dump,
   l'heure source et la version PostgreSQL. Exemple, apres validation de la
   marge disque et de `RECOVERY_DIR` :

   ```sh
   : "${RECOVERY_DIR:?Repertoire prive sur disque sous /home}"
   : "${PROD_POSTGRES_ADDON:?Identifiant PostgreSQL verifie}"
   scalingo --region osc-fr1 --app regleau-back-prod \
     --addon "$PROD_POSTGRES_ADDON" backups-download \
     --backup 6a9dfea099826944b38228f0 \
     --output "$RECOVERY_DIR/prod-20260907.tar.gz"
   sha256sum "$RECOVERY_DIR/prod-20260907.tar.gz"
   tar -tzf "$RECOVERY_DIR/prod-20260907.tar.gz"
   ```

3. Restaurer dans un nouveau cluster local PostgreSQL 17/PostGIS isole, avec
   stockage dedie et port loopback libre. Ne pas reutiliser ou demarrer le
   volume `vigieau_postgres_data` original. Ne pas toucher au PostgreSQL
   `diagdiag` existant sur le port 5432. Aucun processus applicatif du clone ne
   doit emettre vers mail, SANDRE, S3 public, data.gouv.fr ou la production.
   Lire les references historiques restaurees en mode read-only et conserver
   les corrections dans une base de travail locale distincte.
4. Rattacher chaque invalidation chevauchante aux mutations metier exactes,
   departements, types d'eau et intervalles concernes. Comparer l'etat avant
   et apres mutation a partir des backups et des preuves metier disponibles.
   Un debut de plage ne suffit pas a identifier toutes les valeurs a changer.
5. Etablir la provenance des geometries de zones et communes pertinentes a
   chaque date. Un backup recent contient des geometries canoniques mutables :
   il ne prouve pas leur validite retrospective. Comparer les empreintes avec
   les backups dates disponibles ; expliciter les periodes sans preuve, les
   geometries modifiees et la decision metier de correction. Ne pas extrapoler
   silencieusement une geometrie actuelle aux 52 jours.
6. Recalculer d'abord un pilote departement/date representatif uniquement sur
   le clone, apres validation des sources et geometries. L'opt-in
   `HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED=true` reste strictement local a
   cette recherche. Une execution technique reussie n'est pas une
   certification. Verifier les communes sans changement, les transitions de
   severite et les valeurs nulles, puis etendre seulement le perimetre justifie.
7. Construire un nouveau manifeste v3 documente : provenance par date,
   mutations incorporees, preuves geometriques, revision du code, comptages et
   digests communaux/departementaux/nationaux. Comparer tous les resultats aux
   sources, preserver les donnees hors plage et recalculer les agregats mensuels
   concernes. Les scripts actuels epinglent v1/v2 : leur extension v3 et ses
   tests doivent faire l'objet d'une modification explicite, pas d'un renommage
   de source ou d'un contournement de leurs controles.

## Conditions avant toute promotion

La preparation et la validation v3 peuvent avancer sans gel des ecritures
admin. Une mutation concurrente doit faire abandonner une promotion devenue
obsolete, jamais etre ecrasee par la restauration.

- Relever de nouveau les revisions, epoques, plages invalidantes et curseurs
  immediatement avant le dry-run, puis avant l'application. Toute mutation
  historique pertinente survenue apres le cutoff du clone doit etre integree
  ou bloquer la promotion. Une egalite avec un vieux backup ne suffit pas.
- Concevoir et mesurer sur clone une application ciblee, idempotente, par lots
  courts, avec timeouts explicites et reprise. Laisser la queue, les snapshots
  et les publications courantes prioritaires. Tester une ecriture admin
  concurrente et l'annulation propre du lot ; ne pas bloquer les web/admin.
- Conserver l'ancien cache utilisable jusqu'a l'activation atomique d'une
  certification valide. Revalider la couverture exacte et tous les digests
  avant l'attestation ; ne jamais promouvoir uniquement des tags de snapshots.
- Ne pas employer telle quelle la promotion du backfill generique : elle peut
  detenir les verrous du calcul courant pendant des ecritures volumineuses avec
  un `statement_timeout` de 30 minutes. De plus, son `prepare` demanderait ici
  la plage du 9 juillet au 6 septembre et elargirait la plage sale. Ce n'est pas
  une reparation bornee aux 52 dates et son opt-in geometrique reste reserve
  au clone.
- Meme le dry-run `attest` existant prend un verrou consultatif de snapshots
  pendant la comparaison des 34 943 communes. Ne pas le confondre avec un
  simple SELECT de diagnostic sans impact sur l'ordonnancement.
- Apres activation, attendre un artefact statistique stable sur toutes les
  instances. Verifier les 52 dates, les dates voisines, le courant, les 101
  departements et les 34 943 communes, puis les exports data.gouv.fr reellement
  republies et leur contenu. Le canari de
  `scripts/smoke-certified-history-policy.mjs` doit correspondre aux preuves
  v3 ; ne pas conserver ou remplacer son digest sans comparaison documentee.

Les invariants techniques sont dans
[`historic-commune-backfill.md`](historic-commune-backfill.md),
[`HistoricRangeAwareCertifiedRepair`](../apps/backend-admin/src/migrations/1788199200000-HistoricRangeAwareCertifiedRepair.ts)
et
[`complete-certified-history-restoration.ts`](../apps/backend-admin/src/scripts/complete-certified-history-restoration.ts).
Les commandes generiques de ces documents ne constituent pas une autorisation
de lever les protections identifiees ici.

## Delai et criteres de cloture

Aucun delai de resolution fiable n'est mesure a ce stade. Avant une estimation,
mesurer le telechargement et la restauration d'un backup, la preuve et le calcul
d'un pilote representatif, les besoins disque/WAL, puis la duree des lots de
validation/promotion et leur comportement sous ecritures concurrentes. Une
vitesse de telechargement ou un ancien benchmark ne donne pas a elle seule une
date de livraison.

L'incident reste ouvert tant que les nouvelles valeurs ne sont pas justifiees,
certifiees, exposees sur toutes les instances et presentes dans les exports
historiques actualises. Avoir trouve les backups et explique les invalidations
ne constitue pas une restauration terminee.
