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

### Publication des restrictions par commune

La publication quotidienne met à jour la ressource cumulative `Historique Communes` ainsi que la ressource de l'année en cours. L'UUID historique doit être renseigné dans `API_DATAGOUV_HISTORIQUE_COMMUNES_RESOURCE_ID`. Pour republier immédiatement l'historique complet :

```bash
npm run datagouv:publish-historique-communes
```

Pour initialiser la ressource d'une nouvelle année, exécuter la commande suivante puis renseigner l'identifiant retourné dans `API_DATAGOUV_COMMUNES_<ANNEE>_RESOURCE_ID`. Elle sera ensuite mise à jour par la publication quotidienne :

```bash
npm run datagouv:publish-communes -- 2026
```

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
