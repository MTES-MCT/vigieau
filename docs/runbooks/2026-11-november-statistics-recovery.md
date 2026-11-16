# Reprise bornée des statistiques des 13–15 novembre 2026

Cet opérateur importe uniquement les trois journées manquantes. Il ne rejoue
aucune géométrie en production et ne modifie ni les curseurs historiques,
ni les bornes sales de juillet–août, ni leurs attestations, ni la carte courante.
La publication du cache reste assurée par son worker normal.

## Sources et preuves

Calculer chaque journée dans le clone isolé de sa sauvegarde datée, avec le
script existant `recompute-commune-statistics`. Ne jamais utiliser le mode de
rejeu géométrique mutable en production.

| Journée | Sauvegarde Scalingo | publicRevision | historicComputeEpoch |
| --- | --- | --- | --- |
| 2026-11-13 | `6af7a48b9982694c45ec87e6` | 169371 | 1447 |
| 2026-11-14 | `6af8f64499c3cdf2e29e5563` | 169371 | 1447 |
| 2026-11-15 | `6afa47ca9982694c45ece5bf` | 169372 | 1447 |

Dans chaque clone, avant puis après calcul, produire l'empreinte des entrées
statistiques. Les deux résultats doivent être identiques ; conserver également
les empreintes des archives et les preuves de conservation des sources et
géométries. Le script utilise la projection existante
`history-source-equivalence.ts`, avec les deux bornes inclusives fixées au jour
concerné : il accepte automatiquement une clôture postérieure à la journée et
refuse une modification de ses entrées statistiques.

```sh
# Variables de connexion fournies par le canal sécurisé habituel.
export NOVEMBER_RECOVERY_EXPECTED_DATABASE=vigieau_nov13_2026
export NOVEMBER_RECOVERY_DATE=2026-11-13
node dist/apps/backend-admin/src/scripts/inspect-november-statistic-inputs.js > inputs-2026-11-13.json
```

Exporter un fichier JSON par journée, sans agrégats mensuels ni données de
fréquentation :

```json
{
  "date": "2026-11-13",
  "communes": [{"code": "21231", "date": "2026-11-13", "SOU": null, "SUP": "alerte", "AEP": null}],
  "departments": [{"code": "21", "restriction": {"date": "2026-11-13", "SOU": {"vigilance": 0, "alerte": 0, "alerte_renforcee": 0, "crise": 0}, "SUP": {"vigilance": 0, "alerte": 0, "alerte_renforcee": 0, "crise": 0}, "AEP": {"vigilance": 0, "alerte": 0, "alerte_renforcee": 0, "crise": 0}}}],
  "statistic": {"date": "2026-11-13", "departementSituation": {"21": {"max": "alerte", "sou": null, "sup": "alerte", "aep": null}}}
}
```

L'exemple est abrégé : la validation exige exactement les 34 943 codes communes
et les 101 codes départements de la cible, et la couverture nationale complète.

Créer le manifeste avec `version: 1`,
`runId: "vigieau-november-2026-recovery-v1"` et un tableau `days` contenant
exactement les trois sources. Chaque source porte les champs :

- `date`, `backupId`, `sourceDatabase`, `sourceRevision`, `historicComputeEpoch` ;
- `dumpSha256`, `geometryEvidenceSha256` et `statisticInputDigest` (ce dernier est
  `evidence.digest` de l'inspection datée) ;
- `payloadFile` relatif au manifeste et `payloadSha256`, empreinte SHA256 des
  octets exacts du fichier JSON.

## Inspection et application

Le mode par défaut est une transaction en lecture seule. La cible doit être
fraîche et certifiée, sans calcul courant ou historique en attente/en cours.
Tous les verrous sont tentés sans attente. Chaque requête est bornée à 120 s,
la transaction entière à 300 s ; aucune limite ne doit être relevée sans analyse.

```sh
export NOVEMBER_RECOVERY_MANIFEST=/chemin/recovery/manifest.json
export NOVEMBER_RECOVERY_EXPECTED_DATABASE=nom_exact_de_la_base_cible
export NOVEMBER_RECOVERY_APPLY=false
node dist/apps/backend-admin/src/scripts/import-november-statistics.js > dry-run.json 2> dry-run-progress.jsonl
```

Vérifier les trois preuves d'entrées, la chaîne complète des invalidations,
les compteurs, `inspectedBytes` et `elapsedMs`. La lecture ne transfère que les
points de novembre, leurs positions d'insertion et `xmin`. L'opérateur valide
strictement les dates et les doublons de novembre, puis insère les nouveaux points avec
`jsonb_insert` et compare `xmin` avant d'écrire. Les autres objets du tableau
et leur ordre relatif sont conservés, y compris si le tableau initial n'est
pas trié. Seul l'objet mensuel de novembre est remplacé avec `jsonb_set`.
Les versions de publication et la priorité courante sont contrôlées à chaque
lot ; le contrôle complet de l'historique protégé reste initial et final.
Une modification de celui-ci pendant les lots provoque un rollback intégral.
Le benchmark local sur 100 historiques de 5 065 journées mesure environ
180 ms de projection contre 476 ms avant optimisation ; le contrôle léger
coûte environ 0,33 ms contre 21 ms pour le contrôle complet. Ces valeurs
locales ne remplacent pas la mesure en production.
Sur les mêmes 100 lignes, trois transactions locales annulées mesurent
278–427 ms supplémentaires pour l'UPDATE/CAS, soit 460–612 ms au total.
La marge avant application doit donc intégrer le coût d'écriture JSONB/TOAST,
pas seulement celui de la simulation.
Si la durée mesurée ne laisse pas assez de marge pour l'écriture sous 300 s,
arrêter et analyser le coût après revue ; ne pas relever arbitrairement le délai.

L'application exige le champ `context` exact de cette inspection, un label
d'opérateur et la confirmation bornée :

```sh
export NOVEMBER_RECOVERY_APPLY=true
export NOVEMBER_RECOVERY_EXPECTED_CONTEXT=empreinte_context_du_dry_run
export NOVEMBER_RECOVERY_OPERATOR=identifiant_operateur
export NOVEMBER_RECOVERY_CONFIRMATION=IMPORT_CERTIFIED_NOVEMBER_2026_STATS
node dist/apps/backend-admin/src/scripts/import-november-statistics.js > applied.json 2> apply-progress.jsonl
```

Une modification concurrente annule toute la transaction. Les points déjà
identiques sont conservés ; toute divergence est refusée. Novembre est
recalculé à partir de toutes les journées présentes sur la cible après fusion,
donc conserve notamment la journée courante. Les autres mois et les données
analytiques restent intacts. L'audit utilise `source=system`, un acteur nul et
le label d'opérateur en métadonnées.

La transaction certifie uniquement les trois snapshots nationaux, puis
incrémente `statistic_publication_state.revision` par comparaison de version.
Après succès, attendre le worker de cache et vérifier les trois dates ainsi que
la conservation des dates déjà présentes et de la fraîcheur courante.

## Vérification locale

Les tests unitaires valident les contrats, les empreintes et les fusions.
Les tests PostgreSQL optionnels créent leurs schémas temporaires dans une base
de test dédiée et exercent 34 943 communes, le rollback, l'idempotence, les
verrous, la conservation des mois/attestations, la preuve d'équivalence datée,
100 historiques de plus de 5 000 journées et le refus d'un `xmin` concurrent.

```sh
NOVEMBER_RECOVERY_TEST_DATABASE_URL=connexion_base_de_test npm test -- --runInBand src/scripts/import-november-statistics.spec.ts src/scripts/import-november-statistics.postgres.spec.ts
```
