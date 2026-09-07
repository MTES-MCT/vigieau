# Remédiation Sentry du 7 septembre 2026

## Périmètre et corrections

- **Admin** : les formulaires d'arrêtés cadre et de restriction affichent les erreurs de chargement et permettent une nouvelle tentative. Aucun brouillon de remplacement n'est ouvert si sa source est indisponible. Création, duplication, abrogation et conservation des usages restent couvertes par les tests.
- **Frontend public** : protection des graphiques et tableaux pendant le chargement ou un changement de filtre, rejet des réponses de worker obsolètes, téléchargements sécurisés, tolérance au stockage navigateur indisponible et au cycle de vie de la carte.
- **Compatibilité navigateur** : suppression de la dépendance à l'import map `#entry` dans les deux frontends.
- **Préproduction SQL** : restauration des six colonnes de provenance des dates de fin et des deux index attendus. Vérification en lecture seule après réparation ; les mêmes objets existaient déjà en production, sans DDL appliqué à la production pour ce correctif.
- **Matomo** : requêtes POST avec délai maximal, validation des réponses avant écriture, conservation des statistiques existantes en cas d'échec, verrou PostgreSQL partagé et temporisation persistante entre instances. Les erreurs restent signalées avec un contexte explicite, sans exposer le jeton.
- **Sentry** : release des frontends renseignée ; contexte métier et HTTP ajouté aux erreurs admin. Seule la capture répétée du même objet erreur est dédupliquée : pas de suppression générale des erreurs 4xx ou des exceptions inconnues.

## Validation

| Vérification | Résultat constaté |
| --- | --- |
| Admin | 64 tests unitaires, 28 tests Cypress sur build compilé ; captures desktop/mobile contrôlées |
| Public | 191 tests unitaires, 20 tests Cypress sur build compilé ; `verify-pwa-build` réussi |
| Backend Matomo | 46 tests ciblés, dont 2 tests sur PostgreSQL 17 réel ; build et lint réussis |
| Extraction des sourcemaps | 4 tests ; 33 maps admin et 56 maps public privées, sans `.map`, `.map.gz` ou `.map.br` dans le répertoire public |

Le job PostgreSQL/PostGIS de la CI exécute désormais `matomo-statistics-run.postgres.spec.ts` avec `MATOMO_STATISTICS_POSTGRES_URL` sur la base éphémère `vigieau_ci`. Ce test vérifie l'exclusion entre instances, la conservation des autres tâches, la persistance des échecs et la reprise immédiate après correction de configuration. La [CI 34143352947](https://github.com/MTES-MCT/vigieau/actions/runs/34143352947) sur `d1b0c9d` est entièrement verte : onze jobs, dont cette étape PostgreSQL, les quatre builds et les cinq audits npm.

## Déploiements

| Application / environnement | Révision | Déploiement Scalingo | État vérifié |
| --- | --- | --- | --- |
| Admin / préproduction | `79dd31ff77c44fc62751687e4569cd11c0039c9e` | `8085a490-7971-4c87-b219-b0e84bd226ba` | Succès |
| Admin / production | `dcfddfdc35fdf230dbf104ed84e49cb1aef81f54` | `1471c5c1-7db5-48ce-be0b-da39ee0f3083` | Succès |
| Backend / préproduction | `b3b2a27902269827ddd1949c20092ea6eeeada4d` | `e4e2c9ad-8ab1-4cdd-b292-5e4dda420d91` | Succès ; readiness, liveness et statistiques HTTP 200 |
| Backend / production | `dcfddfdc35fdf230dbf104ed84e49cb1aef81f54` | `8d76451c-0fd1-42ce-b59f-e54dcd2ec214` | Succès |
| Frontend public / préproduction | `1ec33b27614f7675810fa76c8e9b3735209e4fc5` | `681adaa8-9bb7-4c97-8dc3-b0f158289bf2` | Succès |
| Frontend public / production | `d1b0c9de92d8ec29ecf474b1d95997c5288fc698` | `5c1cc742-6159-415b-b39b-43ab8e441bba` | Succès |

Les quatre déploiements frontend ont été contrôlés : release HTML correcte, SHA des 33 JS admin et 56 JS publics identiques aux archives privées dans chaque environnement, URLs des maps en HTTP 404. Les routes profondes de duplication admin et de données surface publiques répondent HTTP 200. Les sourcemaps ont été téléversées **manuellement pour les builds exacts**, ainsi que les maps des cinq modules statistiques ciblés du backend dans les deux environnements. Les quatre modules backend modifiés ont les mêmes SHA compilés localement et dans chaque image déployée. Le téléversement Sentry des prochaines releases n'est pas automatisé ; la collecte privée pendant le build ne remplace pas cette étape.

Le backend prod a ses trois processus web et son processus statcache en fonctionnement. Les routes de santé, readiness, santé statistique et statistiques répondent HTTP 200 ; caches utilisables et frais, sans `lastError` au contrôle. Aucun changement de schéma de production ni mode maintenance n'a été appliqué. Le backend préprod a reçu uniquement le correctif Matomo sur sa base antérieure, sans promotion implicite des traitements historiques.

Le premier essai public préprod par archive a échoué avant démarrage du build (`PROJECT_DIR` non trouvé), sans remplacement de l'application existante. Les déploiements suivants ont utilisé l'intégration GitHub Scalingo. La dernière révision publique diffère de la préprod uniquement par des corrections de lint sans changement fonctionnel du frontend public.

## Alertes et suivi restant

- Les règles de production `307`, `310`, `311`, `312` et de préproduction `353` à `356` sont séparées par environnement. Une erreur de préproduction ne doit pas être présentée comme un incident de production.
- Les groupes SQL `309390`, `317391`, `309981` sont résolus après vérification des six colonnes et deux index. Le groupe périodique `309390` n'a plus d'occurrence après 15:40 UTC, avant la réparation. Aucun autre groupe n'a été clôturé en masse.
- **Blocage Matomo legacy** : le jeton configuré pour `stats.data.gouv.fr` est refusé. Il faut obtenir un jeton de lecture valide pour le site historique, remplacer `OLD_MATOMO_API_KEY` dans l'environnement concerné, puis vérifier une collecte complète. Les données déjà enregistrées sont conservées ; le délai entre tentatives limite la répétition sans masquer l'échec.
- **Lenteur admin encore ouverte** : le cas réel [duplication 37731](https://admin.vigieau.beta.gouv.fr/arrete-restriction/37731/duplication) affiche désormais l'erreur de chargement au lieu de planter. Le bouton Réessayer a chargé correctement le formulaire, le département 47 et les six arrêtés cadre source, sans enregistrement ni publication. Les logs du 7 septembre donnent une réponse GET en 10 816 ms, puis 417 ms au réessai ; d'autres appels atteignent 15 secondes. Le dépassement intermittent du délai client de dix secondes n'est pas corrigé par ce lot. Isoler coût SQL, hydratation des relations et contention avant optimisation ; ne pas augmenter globalement les timeouts ni affirmer que la lenteur a disparu.
- Vérifier les nouvelles occurrences par environnement et release après déploiement, en distinguant les onglets encore ouverts sur un ancien bundle. Ne clôturer les groupes qu'après confirmation de leur correction ; ce lot ne démontre pas la disparition de toutes les erreurs Sentry.

### Prochaine correction de latence

`apps/backend-admin/src/arrete_restriction/arrete_restriction.service.ts:251` charge l'arrêté puis ses arrêtés cadre en parallèle ; les collections restrictions, communes, usages et zones multiplient les lignes des jointures. La lecture des arrêtés cadre est dans `apps/backend-admin/src/arrete_cadre/arrete_cadre.service.ts:308`.

Mesurer séparément les deux lectures et la sérialisation en préprod. Construire une fixture PostgreSQL comportant six arrêtés cadre et de nombreuses collections. Fractionner uniquement les collections responsables en lectures groupées par identifiants, sans modifier globalement la stratégie TypeORM. Comparer la réponse complète avant/après : identifiants, ordre, variantes, consignes, abrogations et permissions, ainsi que latence à froid/chaud et nombre de requêtes. Les seules traces actuelles ne permettent pas d'attribuer la lenteur au SQL plutôt qu'à l'hydratation Node.
