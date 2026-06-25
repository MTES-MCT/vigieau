# VigiEau

Monorepo contenant les applications VigiEau (`frontend`, `backend`) et VigiEau Admin (`frontend-admin`, `backend-admin`).

## Pré-requis

- Node.js 24.x
- npm 11.x
- Docker avec Docker Compose

Node n’est pas dockerisé : les applications Node/Nuxt/Nest se lancent en local. Docker ne sert ici qu’à lancer les dépendances nécessaires au développement local.

## Branche de travail

```bash
git switch develop
```

## Services locaux Docker

Le fichier `compose.yaml` à la racine lance :

| Service | URL / port local | Rôle |
|---|---:|---|
| PostgreSQL + PostGIS | localhost:5432 | Base regleau |
| MinIO S3 | http://127.0.0.1:9000 | API S3 locale |
| Console MinIO | http://localhost:9001 | UI MinIO |
| Mailpit SMTP TLS | localhost:1025 | SMTP local |
| Mailpit UI | http://localhost:8025 | UI mail |

## Installation locale

```bash
docker compose up -d
npm install
```

Le monorepo utilise npm workspaces. `package-lock.json` est le lockfile de référence ; ne recréez pas de `yarn.lock`.

Les applications Scalingo sont construites depuis leur `PROJECT_DIR` (`apps/backend`, `apps/backend-admin`, `apps/frontend`, `apps/frontend-admin`). Une dépendance utilisée au runtime par une app doit donc être déclarée dans le `package.json` de cette app, pas seulement à la racine du monorepo. Le `package.json` racine sert au pilotage des workspaces et ne doit pas compenser une dépendance manquante côté app.

## Variables d’environnement

```bash
cp apps/backend/env.example apps/backend/.env
cp apps/backend-admin/env.example apps/backend-admin/.env
cp apps/frontend/env.example apps/frontend/.env
cp apps/frontend-admin/env.example apps/frontend-admin/.env

mkdir -p apps/backend-admin/.tmp
```

## Sentry

Sentry est désactivé en local tant que `SENTRY_DSN` est vide.

Les 4 applications utilisent les mêmes variables :

```dotenv
SENTRY_DSN=
SENTRY_ENV=local
```

Quand `SENTRY_DSN` est renseigné :

- les backends Nest initialisent Sentry avant le bootstrap applicatif ;
- `backend` et `backend-admin` utilisent `SentryModule.forRoot()` et `SentryGlobalFilter` ;
- les frontends Nuxt initialisent Sentry côté client avec `@sentry/vue`.

## S3 local avec MinIO

MinIO est initialisé automatiquement au démarrage par le service `minio-init` :

- bucket : `vigieau`
- identifiant : `minioadmin`
- mot de passe : `minioadmin`
- accès lecture public activé sur le bucket
- CORS local configuré depuis `docker/minio/cors.json`

La configuration locale du backend admin est :

```dotenv
S3_REGION=eu-west-3
S3_ENDPOINT=http://127.0.0.1:9000
S3_FORCE_PATH_STYLE=true
S3_PREFIX=local/
S3_BUCKET=vigieau
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_VHOST=http://127.0.0.1:9000/vigieau/
```

`S3_VHOST` côté backend admin ne contient pas `local/`, car les clés S3 contiennent déjà le préfixe via `S3_PREFIX=local/`.

## PMTiles en local

Le frontend peut utiliser directement le PMTiles public :

```dotenv
PMTILES_URL=https://regleau.s3.gra.perf.cloud.ovh.net/pmtiles/zones_arretes_en_vigueur.pmtiles
S3_VHOST=https://regleau.s3.gra.perf.cloud.ovh.net/
```

Avec cette configuration, il n’y a aucun accès S3 à demander pour afficher la carte courante.

Pour tester le PMTiles depuis MinIO local, télécharge le fichier public et place-le ici :

```bash
mkdir -p docker/minio
curl -L   https://regleau.s3.gra.perf.cloud.ovh.net/pmtiles/zones_arretes_en_vigueur.pmtiles   -o docker/minio/zones_arretes_en_vigueur.pmtiles

docker compose up -d minio minio-init
```

Le service `minio-init` le copie automatiquement vers :

```text
vigieau/local/pmtiles/zones_arretes_en_vigueur.pmtiles
```

Dans ce cas, côté `apps/frontend/.env`, utilise :

```dotenv
PMTILES_URL=http://127.0.0.1:9000/vigieau/local/pmtiles/zones_arretes_en_vigueur.pmtiles
S3_VHOST=http://127.0.0.1:9000/vigieau/local/
```

Vérification :

```bash
curl -I http://127.0.0.1:9000/vigieau/local/pmtiles/zones_arretes_en_vigueur.pmtiles
```

## Faut-il demander des données ou des accès ?

Pour démarrer en local et afficher la carte courante : non. Le PMTiles courant est public et utilisable directement via `PMTILES_URL`.

Pour tester la génération PMTiles complète depuis `backend-admin` : oui, il faut une base locale cohérente avec les données métier nécessaires à la génération des zones, arrêtés, restrictions et référentiels. Il ne faut pas d’accès S3 externe pour ça, car l’upload se fait dans MinIO local.

Pour les cartes historiques : il faut les fichiers historiques correspondants ou les générer localement. Le fichier public `zones_arretes_en_vigueur.pmtiles` ne couvre que la carte courante.

## Lancer les applications

Terminal 1 :

```bash
npm run dev:admin-backend
```

Terminal 2 :

```bash
npm run dev:public-backend
```

Terminal 3 :

```bash
npm run dev:public-frontend
```

Terminal 4 :

```bash
npm run dev:admin-frontend
```

## URLs

- Frontend public : http://localhost:3000
- Backend admin : http://localhost:3001/api
- Backend public : http://localhost:3002/api
- Frontend admin : http://localhost:3003
- MinIO console : http://localhost:9001
- Mailpit : http://localhost:8025

## Swagger

- http://localhost:3001/swagger
- http://localhost:3002/swagger

## Commandes utiles

Logs :

```bash
docker compose logs -f
```

Stop :

```bash
docker compose down
```

Reset :

```bash
docker compose down -v
```
