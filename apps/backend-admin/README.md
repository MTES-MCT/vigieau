# VigiEau Admin - Backend

## Description

## Installation

### Pré-requis

Vous aurez besoin de [NodeJS](https://nodejs.org/) 24.x et npm 11.x pour lancer ce projet.

Nous vous recommandons de regarder la [documentation de NestJS](https://nestjs.com/).

### Variables d'environnement

```bash
cp env.example .env
```

- NODE_ENV : local / dev / prod
- PORT : Port sur lequel tournera le serveur
- OAUTH2_CLIENT : Se référer à la documentation de [ProConnect](https://www.proconnect.gouv.fr/)
- SESSION_SECRET : Token JWT
- DATABASE : Informations pour se connecter à la DB (Postgres)
- WEBSITE_URL : Site web du frontend (http://localhost:3000 en local)
- DOMAIN : Domaine sur lequel tourne le serveur (localhost en local)
- API_DATAGOUV : Informations pour se connecter à Datagouv et pouvoir upload automatiquement les données de VigiEau
- S3 : Informations pour se connecter aux buckets S3
- MAIL : Informations pour se connecter à la boite mail
- MAIL_MTE : Mail générique à renseigner pour l'envoi de mail systématique à une adresse
- DOMAIN_NAME : Domaine du frontend (localhost:3000 en local)
- PATH_TO_WRITE_FILE : Dossier pour stocker les fichiers temporaires ou le serveur peut lire / écrire
- CLOCK_LEADERSHIP_ACQUIRE_TIMEOUT_SECONDS : Durée maximale pendant laquelle un nouveau processus `clock` attend la libération du verrou PostgreSQL lors d'un rolling deploy (600 secondes par défaut)
- CLOCK_LEADERSHIP_RETRY_SECONDS : Intervalle entre deux tentatives d'acquisition du verrou du `clock` (2 secondes par défaut)
- COMMUNE_STATISTICS_BATCH_SIZE : Nombre de communes traitées par transaction lors du calcul des statistiques (250 par défaut, entier compris entre 1 et 1000)
- HISTORIC_COMPUTE_CHUNK_DAYS : Nombre maximal de jours traités par un worker de rattrapage historique (7 par défaut, entier compris entre 1 et 3660)
- HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED : Réutilise les départements inchangés entre deux journées historiques consécutives lorsque la révision source est certifiée (`false` par défaut)
- HISTORIC_SKIP_COMMUNE_INTERSECTIONS : Ne matérialise pas les liens zone-commune historiques, inutiles aux GeoJSON, PMTiles et statistiques (`false` par défaut)
- HISTORIC_DEPARTMENT_CONCURRENCY : Nombre maximal de départements historiques calculés simultanément (1 par défaut, entier compris entre 1 et 4)
- ZONE_PUBLICATION_HEALTH_PROGRESS_STALE_AFTER_SECONDS : Délai maximal sans progression métier récente pendant lequel le health de publication peut encore répondre `updating` avec une ancienne active servie (1800 secondes par défaut)

Le processus `clock` ne publie son heartbeat et ne démarre ses tâches planifiées qu'après avoir acquis son verrou PostgreSQL exclusif. Pendant un rolling deploy, le nouveau processus retente ce verrou dans la fenêtre configurée ; si elle expire, son démarrage échoue au lieu de créer un second ordonnanceur. Lors d'un arrêt gracieux, l'ancien processus attend la fin de ses tâches planifiées avant de libérer le verrou.

Le `clock` est l'unique propriétaire du rattrapage historique. Les workers de
calcul courant ne le déclenchent jamais. Chaque succès historique est lié aux
deux curseurs et à leurs générations finales ; une invalidation, même à date
identique, rend donc automatiquement l'ancien succès inéligible. Les barrières
de publication et l'export data.gouv.fr exigent cette même identité.

### Publication des restrictions par commune

La publication quotidienne met à jour la ressource cumulative `Historique Communes` ainsi que la ressource de l'année en cours. L'UUID historique doit être renseigné dans `API_DATAGOUV_HISTORIQUE_COMMUNES_RESOURCE_ID`. Pour republier immédiatement l'historique complet :

```bash
npm run datagouv:publish-historique-communes
```

Cette commande est fail-closed : elle utilise la journée planifiée à partir de
06:00 (heure de Paris), exige une frontière historique complète et certifiée,
puis vérifie que son identité n'a changé ni avant ni après l'envoi.

Pour initialiser la ressource d'une nouvelle année, exécuter la commande suivante puis renseigner l'identifiant retourné dans `API_DATAGOUV_COMMUNES_<ANNEE>_RESOURCE_ID`. Elle sera ensuite mise à jour par la publication quotidienne :

```bash
npm run datagouv:publish-communes -- 2026
```

Pour une année passée, la date source autoritaire est le 31 décembre de cette
année, mais la commande exige toujours la frontière historique certifiée de la
journée planifiée courante. La plage annuelle doit être incluse dans cette
frontière ; une plage dirty non certifiée bloque donc la publication avant tout
envoi vers data.gouv.fr.

### Installation des dépendances

```bash
npm install
```

### Lancer nuxt en mode développement

Démarre le serveur sur http://localhost:3001

```bash
npm run start:dev
```

### Générer le code de production

Génère le code de production de l’application:

```bash
npm run build
```

## Contribution

Les Pull Requests sont les bienvenues. Pour des changements majeurs merci d'ouvrir auparavant une issue pour en discuter.

Assurez-vous de mettre à jour les tests en conséquence.

## License

[MIT](https://choosealicense.com/licenses/mit/)
