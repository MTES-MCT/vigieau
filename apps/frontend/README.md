![Logo VigiEau](https://vigieau.gouv.fr/logo_vigie_eau.svg)

# VigiEau - frontend

## Description

VigiEau a été lancée par le Ministère de la Transition Ecologique pour aider les citoyens à avoir un accès facile et clair à
l'information concernant les restrictions en vigueur lors d'épisodes d'alertes sécheresse.

## Installation

### Pré-requis

Vous aurez besoin de [NodeJS](https://nodejs.org/) 24.22.3 et npm 12.2.1 pour lancer ce projet.

Nous vous recommandons de regarder la [documentation de Nuxt 3](https://v3.nuxtjs.org)
et la [documentation de VueDsfr](https://vue-dsfr.netlify.app).

### Variables d'environnement

```bash
cp env.example .env
```

Doc [API Adresse](https://adresse.data.gouv.fr/api-doc/adresse)

Doc [API Geo](https://geo.api.gouv.fr/decoupage-administratif)

Doc [API Sécheresse](https://github.com/MTES-MCT/secheresse-api)

### Installation des dépendances

```bash
npm install
```

### Lancer nuxt en mode développement

Démarre le serveur sur http://localhost:3000

```bash
npm run dev
```

### Générer le code de production

Génère le code de production de l’application:

```bash
npm run build
```

Regarder ensuite la [documentation de Nuxt concernant le déploiement](https://v3.nuxtjs.org/docs/deployment).

### Prévisualiser le code généré

Après `npm run build`, `npm start` sert `.output/public` sur le port 3000.
`npm run preview` utilise le même lanceur statique, sans télécharger un serveur
avec `npx` ni chercher un serveur SSR absent.

```bash
npm run build
npm start
# Autre port et écoute locale uniquement :
PORT=3100 HOST=127.0.0.1 npm start
```

Les options `--port` et `--host` sont également acceptées après `npm start --`.
Les variables `NUXT_PORT`, `NITRO_PORT`, `PORT` et `NUXT_HOST`, `NITRO_HOST`, `HOST`
sont prises en compte dans cet ordre ; l'écoute par défaut est `0.0.0.0`.
Le lanceur est inclus dans `.output/preview.mjs`, hors du répertoire public,
et fonctionne avec les seules dépendances de l'application.

Ce mode prévisualise les fichiers déjà générés, avec les routes SPA et les
règles de cache des assets et de la PWA. Les variables client sont celles du
build. Il ne change pas le déploiement Scalingo, qui reste servi par Nginx.

### Lancer les tests e2e

Regarder la documentation de [Cypress](https://www.cypress.io/)

Pour ouvrir l'interface de Cypress

```bash
npm run cy:open
```

Si l'application est lancée

```bash
npm run cy:run
```

Pour lancer l'application et les tests

```bash
npm run cy:e2e
```

## Contribution

Les Pull Requests sont les bienvenues. Pour des changements majeurs merci d'ouvrir auparavant une issue pour en discuter.

Assurez-vous de mettre à jour les tests en conséquence.

## License

[MIT](https://choosealicense.com/licenses/mit/)
