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

Le job PostgreSQL/PostGIS de la CI exécute désormais `matomo-statistics-run.postgres.spec.ts` avec `MATOMO_STATISTICS_POSTGRES_URL` sur la base éphémère `vigieau_ci`. Ce test vérifie l'exclusion entre instances, la conservation des autres tâches, la persistance des échecs et la reprise immédiate après correction de configuration. L'exécution GitHub de cette nouvelle étape reste à constater après publication de la modification.

## Déploiements

| Application / environnement | Révision | Déploiement Scalingo | État vérifié |
| --- | --- | --- | --- |
| Admin / préproduction | `79dd31ff77c44fc62751687e4569cd11c0039c9e` | `8085a490-7971-4c87-b219-b0e84bd226ba` | Succès |
| Admin / production | `dcfddfdc35fdf230dbf104ed84e49cb1aef81f54` | `1471c5c1-7db5-48ce-be0b-da39ee0f3083` | Succès |
| Backend / préproduction | `b3b2a27902269827ddd1949c20092ea6eeeada4d` | `e4e2c9ad-8ab1-4cdd-b292-5e4dda420d91` | Succès ; readiness, liveness et statistiques HTTP 200 |
| Backend / production | `dcfddfdc35fdf230dbf104ed84e49cb1aef81f54` | `8d76451c-0fd1-42ce-b59f-e54dcd2ec214` | Succès |
| Frontend public / préproduction | à renseigner | à renseigner | à renseigner |
| Frontend public / production | à renseigner | à renseigner | à renseigner |

Les deux déploiements admin ont été contrôlés : release HTML correcte, SHA des 33 JS identiques aux archives privées et URLs des maps en HTTP 404. Les sourcemaps ont été téléversées **manuellement pour les builds exacts**, ainsi que les maps Matomo ciblées des backends de préproduction et production. Le téléversement Sentry des prochaines releases n'est pas automatisé ; la collecte privée pendant le build ne remplace pas cette étape.

## Alertes et suivi restant

- Les règles de production `307`, `310`, `311`, `312` et de préproduction `353` à `356` sont séparées par environnement. Une erreur de préproduction ne doit pas être présentée comme un incident de production.
- **Blocage Matomo legacy** : le jeton configuré pour `stats.data.gouv.fr` est refusé. Il faut obtenir un jeton de lecture valide pour le site historique, remplacer `OLD_MATOMO_API_KEY` dans l'environnement concerné, puis vérifier une collecte complète. Les données déjà enregistrées sont conservées ; le délai entre tentatives limite la répétition sans masquer l'échec.
- Vérifier les nouvelles occurrences par environnement et release après déploiement, en distinguant les onglets encore ouverts sur un ancien bundle. Ne clôturer les groupes qu'après confirmation de leur correction ; ce lot ne démontre pas la disparition de toutes les erreurs Sentry.
