# Historique communal : continuité et revalidation automatique

Ce correctif évite qu'une invalidation rétroactive fasse disparaître les journées
déjà calculées du graphique communal. Il automatise également la revalidation
de la réparation certifiée v2 du **11 juillet au 31 août 2026**, uniquement si
ses données sources et ses résultats restent strictement identiques à l'ancre
vérifiée. Il ne constitue pas un moteur générique de recalcul historique v3.

## Lecture publique

- L'API `/api/data/commune/:codeInsee` reste **strictement certifiée par défaut**.
  Le frontend demande explicitement `includeProvisional=true`.
- Dans la plage en cours de vérification, seules les journées possédant un
  snapshot national terminé, complet et cohérent avec le nombre de communes
  peuvent être affichées à titre provisoire. Les doublons, gravités invalides,
  snapshots manquants, partiels ou en cours de calcul restent exclus.
- Ces journées portent `dataStatus=provisional` et
  `dataStatusReason=historic-recalculation`. Graphiques, tableau et export
  signalent leur caractère provisoire. Aucune valeur manquante n'est inventée.
- La lecture ne modifie ni les données stockées ni leur certification. Après
  revalidation, les mêmes journées sont de nouveau servies sans marqueur
  provisoire.

## Traitement automatique

`HistoryRecoverySchedulerService` s'exécute uniquement dans le processus
`clock` : `RUN_BUSINESS_SCHEDULED_JOBS=true` et tâches planifiées non désactivées.
Un premier passage intervient **90 secondes après le démarrage**, puis toutes
les **30 minutes**. Un garde local et un verrou PostgreSQL de session empêchent
les exécutions concurrentes. Un échec déclenche un délai minimal de 30 minutes
avant une nouvelle tentative.

Le traitement suit quatre étapes :

1. Vérifier à faible coût que la réparation v2 épinglée reste la dernière
   réparation, que son audit et son attestation d'origine existent, et qu'elle
   n'est pas déjà active. Une réparation absente ou remplacée n'est pas reprise.
2. Lire les sources par lots de 100 et les résultats par lots de 50, avec pauses
   entre lots, dans une transaction de lecture seule cohérente. Les lectures
   sont limitées à **5 secondes par requête**, l'inspection à **15 minutes**, et
   l'attente d'un verrou à **50 ms**. Le verrou de session est détenu sur une
   connexion dédiée, sans transaction inactive pendant cette inspection.
3. Comparer les empreintes des entrées et sorties à l'ancre v2, vérifier le
   journal d'invalidation et toutes les protections de provenance existantes.
   Aucune restauration de backup ni réécriture des statistiques n'est lancée.
4. Si les preuves correspondent, publier une nouvelle attestation dans une
   transaction limitée à **3 secondes**, avec verrous non bloquants et nouvelle
   vérification du contexte et des versions des lignes. Une modification
   concurrente fait échouer la publication plutôt que de certifier un résultat
   périmé.

Le pool PostgreSQL doit comporter **au moins deux connexions**. Le verrou de
session est libéré sur la connexion qui l'a acquis. Si son nettoyage échoue,
la connexion est détruite au lieu d'être rendue au pool avec un verrou incertain.

### Signification des résultats

| Résultat                    | Conséquence                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `ATTESTED`                  | Équivalence vérifiée, nouvelle attestation publiée.                  |
| `ALREADY_ATTESTED`          | Aucun travail national ni nouvelle attestation nécessaire.           |
| `NOT_APPLICABLE`            | Ancre absente ou remplacée : aucune certification effectuée.         |
| `BUSY` / journal `DEFERRED` | Un autre traitement est prioritaire ; nouvelle tentative ultérieure. |
| Journal `NEEDS REVIEW`      | Vérification ou publication échouée ; aucune réussite annoncée.      |

**Une vraie modification historique de géométrie, de date ou de gravité n'est
pas corrigée par cette automatisation.** Si elle change les empreintes, la
certification est refusée et les journées disponibles restent provisoires.
Il faut alors examiner les sources datées et préparer une correction séparée.
Les causes d'invalidation non reconnues sont également refusées.

Ne pas activer `HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED` en production : les
anciens chemins de recalcul utiliseraient les géométries actuelles mutables.
Ce correctif ne modifie pas ce garde et n'autorise aucun replay aveugle.

## Vérification et déploiement

Pour cette release sans migration, déployer l'API publique, puis le frontend
public, puis l'admin qui contient l'automate. Les lecteurs stricts restent
compatibles pendant le déploiement progressif. Contrôler les révisions et les
healthchecks de chaque application ; ne pas arrêter les serveurs HTTP ni
modifier les paramètres de backfill.

Avant une application manuelle de l'automate, sa fonction
`automaticallyAttestHistoryBySourceEquivalence(dataSource, { apply: false })`
permet une inspection sans publication. `DRY_RUN` confirme l'inspection, pas une
certification effective. Un résultat `NEEDS REVIEW` doit être investigué ; ne
pas contourner les comparaisons ni modifier l'ancre pour faire passer le test.

Vérifications de sortie :

- Comparer `/api/data/commune/24547` et la même URL avec
  `?includeProvisional=true`. Les journées non certifiées ne doivent apparaître
  que dans la seconde réponse, avec leurs marqueurs explicites.
- Vérifier dans le navigateur les 52 journées du 11 juillet au 31 août,
  l'indication provisoire et l'export. Après attestation effective, vérifier la
  disparition de ces marqueurs et la présence des journées en lecture stricte.
- Contrôler les journaux du `clock` : un résultat positif attendu est
  `HISTORY RECOVERY ATTESTED`, jamais seulement un démarrage de tâche.
- Confirmer que les données courantes, les alertes et les autres processus
  continuent à fonctionner pendant l'inspection.

Les tests couvrent la récidive (invalidation d'une période restaurée), les 52
journées provisoires, les consommateurs stricts, la disparition des marqueurs
après certification, les snapshots invalides, l'idempotence, les modifications
réelles refusées, la concurrence et le nettoyage des verrous. Le scheduler est
testé séparément pour les gardes web/clock, le délai initial, l'arrêt, le
non-chevauchement et le délai après échec.

Les suites PostgreSQL sont exécutées en CI sous PostGIS 17-3.5, comme
l'environnement Compose. PostgreSQL 17 est nécessaire à la protection
`transaction_timeout` utilisée lors de l'attestation finale.

## Retour arrière

Redéployer la version précédente de l'admin arrête l'automatisation lors du
remplacement du `clock`. Attendre la fin ou l'annulation de l'inspection en
cours et vérifier les processus et verrous avant une autre intervention.

Le frontend peut être redéployé dans sa version précédente avant de revenir sur
l'API. Ce retour à l'ancien lecteur peut masquer de nouveau les journées
provisoires ; il ne les supprime pas de la base.

Ne supprimer ni statistiques, ni snapshots, ni audits ou attestations : les
attestations produites restent soumises aux protections de validité existantes
et sont compatibles avec les lecteurs précédents.
