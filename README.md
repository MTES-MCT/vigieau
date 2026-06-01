# VigiEau

Monorepo contenant les applications VigiEau (`frontend`, `backend`) et VigiEau Admin (`frontend-admin`, `backend-admin`).

## Pré-requis

- Node.js 20 ou supérieur
- Yarn
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
| MinIO S3 | http://127.0.0.1:9000 | API S3 |
| Console MinIO | http://localhost:9001 | UI MinIO |
| Mailpit SMTP TLS | localhost:1025 | SMTP local |
| Mailpit UI | http://localhost:8025 | UI mail |

## Installation locale

```bash
docker compose up -d
yarn install
```

## Variables d’environnement

```bash
cp apps/backend/env.example apps/backend/.env
cp apps/backend-admin/env.example apps/backend-admin/.env
cp apps/frontend/env.example apps/frontend/.env
cp apps/frontend-admin/env.example apps/frontend-admin/.env

mkdir -p apps/backend-admin/.tmp
```

## Lancer les applications

Terminal 1 :

```bash
yarn dev:admin-backend
```

Terminal 2 :

```bash
yarn dev:public-backend
```

Terminal 3 :

```bash
yarn dev:public-frontend
```

Terminal 4 :

```bash
yarn dev:admin-frontend
```

## URLs

- Frontend public : http://localhost:3000
- Backend admin : http://localhost:3001/api
- Backend public : http://localhost:3002/api
- Frontend admin : http://localhost:3003

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
