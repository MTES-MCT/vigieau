# Reconstruction historique distribuee

Ce pipeline reconstruit les cartes et les statistiques communales historiques
sans modifier l'artefact public actif pendant le calcul. Il est desactive par
defaut et ne remplace pas le calcul quotidien.

## Invariants

- Un run couvre une plage fermee et exactement 101 departements.
- Les workers reclament un departement par `FOR UPDATE SKIP LOCKED`; un lease
  UUID empeche un ancien worker de publier apres expiration.
- Une mutation historique locale incremente `historicComputeEpoch` et ne rejoue
  que les departements touches. Une invalidation operateur globale incremente
  aussi `historicBackfillGlobalEpoch` et termine le run afin d'en preparer un
  nouveau sur des bornes propres.
- Le calcul courant est prioritaire. Une queue courante, un snapshot courant ou
  une publication quotidienne en cours rend le lease historique sans consommer
  de tentative.
- Une publication quotidienne peut avancer les curseurs au-dela de la borne du
  run. La finalisation accepte cet etat et conserve toujours le curseur le plus
  avance; elle ne fait jamais regresser le calcul courant.
- Le staging ne cree aucun snapshot public et ne modifie aucun JSONB canonique.
- Les statistiques sont reduites dans un shadow, puis promues en une transaction.
- Les GeoJSON departementaux de staging portent le run, la revision locale du
  departement, l'epoch, la generation et le checksum. Un rebase global ne les
  invalide pas; une mutation locale ne peut pas les ecraser.
- Les GeoJSON/PMTiles nationaux portent le run, la revision source, l'epoch et
  le checksum. Un manifeste unique rend la nouvelle plage visible; aucun lot
  d'alias dates n'est copie en place.
- `historicDirtyFrom/Through` ne sont effaces et la revision statistique n'est
  avancee qu'apres les deux promotions completes. Une outbox persistante rend
  la publication du manifeste reprenable apres un incident S3.

## Preflight production

1. Deployer la migration additive avec `HISTORIC_BACKFILL_ENABLED=false` et les
   deux nouveaux processus a zero.
2. Positionner `HISTORIC_CATCHUP_ENABLED=false`, attendre la fin de l'ancien
   rattrapage et verifier qu'aucun verrou exclusif
   `vigieau:zone-compute-historic` n'est encore detenu. Les nouveaux shards
   prennent ce meme verrou en mode partage pour exclure toute collision sur la
   table de travail historique.
3. Verifier API/admin `live` et `ready`, queue courante vide, aucun calcul
   quotidien ou snapshot `running`, aucun candidat zone/statistique et aucune
   attente PostgreSQL.
4. Relever CPU, latence p95, connexions, stockage libre, WAL/temp et taille DB.
   Le staging doit disposer d'une marge disque explicite; ne jamais extrapoler
   la marge depuis la seule taille utilisee.
5. Augmenter temporairement la capacite PostgreSQL avant le pilote. Le changement
   de plan doit etre sans coupure et sa reversibilite confirmee. Ne pas commencer
   si la nouvelle capacite ou la limite de connexions n'est pas observable.
6. Conserver `DATABASE_POOL_MAX=10` pour web/clock. Les scripts workers forcent
   `HISTORIC_BACKFILL_DATABASE_POOL_MAX=3` par conteneur et
   `HISTORIC_BACKFILL_WORKER_CONCURRENCY=1`. Le code refuse une configuration
   ou `DATABASE_POOL_MAX < 2 * concurrency + 1`.
7. Activer `HISTORIC_BACKFILL_ENABLED=true` seulement apres ces gates. Le flag
   coupe les workers et tous les POST operateur; le GET de statut reste lisible.

## Clone de benchmark

Le benchmark full-range ne doit tourner ni sur la preproduction active ni sur
un PostgreSQL local sous-dimensionne. Creer une application Scalingo jetable
dans `osc-fr1`, avec PostgreSQL 17/PostGIS sur un plan au moins
`postgresql-business-8192` et 100 Go libres avant restauration. Stopper le run
si l'espace libre passe sous 25 %.

Le compte qui provisionne doit etre owner du projet. Exemple de bootstrap:

```shell
: "${PROJECT_ID:?set to the target Scalingo project id}"
APP=regleau-hist-bench-$(date +%Y%m%d)
```

Des que l'application existe, installer ce garde dans le shell local qui pilote
le benchmark. Il n'appelle aucun endpoint `POST` (ils restent bloques par
`ADMIN_WRITES_DISABLED=true`). Une sortie normale, une erreur, `Ctrl-C`, `TERM`
ou `HUP` desactive les deux opt-ins, tente de ramener chaque formation a zero et
affiche `ps`. Une formation encore visible dans la sortie de `ps` est un echec
de cleanup a traiter immediatement:

```shell
set -Eeuo pipefail

assert_benchmark_app() {
  : "${APP:?set to the disposable benchmark app name}"
  case "$APP" in
    *hist-bench*) ;;
    *) printf '%s\n' 'Refus: APP ne contient pas hist-bench' >&2; return 1 ;;
  esac
  case "$APP" in
    *prod*|*production*)
      printf '%s\n' 'Refus: APP ressemble a la production' >&2
      return 1
      ;;
  esac
}

assert_benchmark_app
readonly APP

stop_benchmark_compute() {
  local failed=0 formation ps_output

  assert_benchmark_app || return 1
  scalingo --region osc-fr1 --app "$APP" env-set \
    HISTORIC_BACKFILL_ENABLED=false \
    HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY=false || failed=1
  for formation in \
    historicbackfillworker historicartifactworker \
    web clock currentzoneworker
  do
    scalingo --region osc-fr1 --app "$APP" scale --synchronous \
      "${formation}:0:M" || failed=1
  done
  scalingo --region osc-fr1 --app "$APP" scale || failed=1
  ps_output="$(scalingo --region osc-fr1 --app "$APP" ps)" || failed=1
  printf '%s\n' "$ps_output"
  if printf '%s\n' "$ps_output" | grep -Eq \
    '(web|clock|currentzoneworker|historicbackfillworker|historicartifactworker)-[0-9]'
  then
    printf '%s\n' 'ERREUR: un conteneur benchmark tourne encore' >&2
    failed=1
  fi
  return "$failed"
}

stop_benchmark_tunnel() {
  if test -n "${BENCHMARK_TUNNEL_PID:-}"; then
    kill "$BENCHMARK_TUNNEL_PID" 2>/dev/null || true
    wait "$BENCHMARK_TUNNEL_PID" 2>/dev/null || true
    unset BENCHMARK_TUNNEL_PID
  fi
}

cleanup_benchmark_s3_smoke() {
  if command -v aws >/dev/null && \
    test -n "${BENCHMARK_S3_ENDPOINT:-}" && \
    test -n "${BENCHMARK_S3_REGION:-}" && \
    test -n "${BENCHMARK_BUCKET:-}" && \
    test -n "${S3_SMOKE_KEY:-}"
  then
    aws --region "$BENCHMARK_S3_REGION" \
      --endpoint-url "$BENCHMARK_S3_ENDPOINT" \
      s3api delete-object --bucket "$BENCHMARK_BUCKET" \
      --key "$S3_SMOKE_KEY" >/dev/null 2>&1 || true
    unset S3_SMOKE_KEY
  fi
}

benchmark_exit_cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT
  cleanup_benchmark_s3_smoke
  stop_benchmark_tunnel
  if test "${BENCHMARK_APP_CREATED:-false}" = true; then
    stop_benchmark_compute || cleanup_status=1
  fi
  if test "$cleanup_status" -ne 0; then
    printf '%s\n' 'ERREUR: cleanup Scalingo incomplet' >&2
    if test "$status" -eq 0; then
      status=1
    fi
  fi
  exit "$status"
}

trap benchmark_exit_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

scalingo --region osc-fr1 create --project-id "$PROJECT_ID" "$APP"
BENCHMARK_APP_CREATED=true
scalingo --region osc-fr1 --app "$APP" \
  addons-add postgresql postgresql-business-8192
```

Toutes les formations restent a zero pendant la restauration. Neutraliser les
sorties avant le premier demarrage: `ADMIN_WRITES_DISABLED=true`,
`DISABLE_SCHEDULED_JOBS=true`, `HISTORIC_CATCHUP_ENABLED=false`, workers courant
et publication versionnee desactives, credentials data.gouv/mail/Sentry absents.
Utiliser un bucket S3 prive reserve au benchmark avec des credentials limites a
ce seul bucket et un prefixe propre au run; ne jamais recopier les credentials
S3 de production. Positionner `HISTORIC_BACKFILL_ARTIFACT_ACL=private`: seules
les valeurs `private` et `public-read` sont acceptees, et le defaut compatible
reste `public-read`. Le manifeste final reste toujours explicitement public.

Utiliser le dernier backup automatique de production deja `done`, sans creer de
backup manuel. Le telecharger sur un runner chiffre disposant d'au moins 20 Go
temporaires, verifier son SHA-256 et sa liste, puis restaurer avec `pg_restore`
17 via un tunnel vers la base jetable:

```shell
umask 077
RESTORE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vigieau-hist-bench-XXXXXXXX")"
chmod 700 "$RESTORE_DIR"
BACKUP_ARCHIVE="$RESTORE_DIR/prod.tar.gz"
scalingo --region osc-fr1 --app regleau-back-prod \
  --addon "$PROD_POSTGRES_ADDON" backups-download \
  --backup "$PROD_BACKUP_ID" --output "$BACKUP_ARCHIVE"
sha256sum "$BACKUP_ARCHIVE" > "$BACKUP_ARCHIVE.sha256"
tar -tzf "$BACKUP_ARCHIVE"
tar -xzf "$BACKUP_ARCHIVE" -C "$RESTORE_DIR"

# Renseigner exactement le dump affiche par tar -tzf, toujours sous RESTORE_DIR.
DUMP_FILE="$RESTORE_DIR/<fichier-pg_dump>"
test -f "$DUMP_FILE"
case "$DUMP_FILE" in
  "$RESTORE_DIR"/*) ;;
  *) printf '%s\n' 'Refus: dump hors RESTORE_DIR' >&2; exit 1 ;;
esac

: "${APP:?set to the disposable clone app name}"
case "$APP" in
  *hist-bench*) ;;
  *) printf '%s\n' 'Refus: APP ne contient pas hist-bench' >&2; exit 1 ;;
esac
export BENCHMARK_DATABASE_URL="$(
  scalingo --region osc-fr1 --app "$APP" \
    env-get SCALINGO_POSTGRESQL_URL
)"
: "${BENCHMARK_DATABASE_URL:?clone addon internal URL is empty}"
export DATABASE_NAME="$(node <<'NODE'
const url = new URL(process.env.BENCHMARK_DATABASE_URL);
process.stdout.write(decodeURIComponent(url.pathname.replace(/^\//, '')));
NODE
)"
: "${DATABASE_NAME:?clone database name is empty}"
case "$DATABASE_NAME" in
  *prod*|*production*)
    printf '%s\n' 'Refus: le nom de base ressemble a la production' >&2
    exit 1
    ;;
esac
export TUNNELED_BENCHMARK_DATABASE_URL="$(node <<'NODE'
const url = new URL(process.env.BENCHMARK_DATABASE_URL);
url.hostname = '127.0.0.1';
url.port = '15432';
process.stdout.write(url.toString());
NODE
)"

TUNNEL_LOG="$RESTORE_DIR/db-tunnel.log"
scalingo --region osc-fr1 --app "$APP" \
  db-tunnel --bind 127.0.0.1 --port 15432 SCALINGO_POSTGRESQL_URL \
  >"$TUNNEL_LOG" 2>&1 &
BENCHMARK_TUNNEL_PID=$!
TUNNEL_READY=false
for _ in $(seq 1 60); do
  if psql "$TUNNELED_BENCHMARK_DATABASE_URL" \
    --no-psqlrc --tuples-only --no-align --command 'SELECT 1' \
    >/dev/null 2>&1
  then
    TUNNEL_READY=true
    break
  fi
  if ! kill -0 "$BENCHMARK_TUNNEL_PID" 2>/dev/null; then
    cat "$TUNNEL_LOG" >&2
    printf '%s\n' 'Refus: le tunnel PostgreSQL s est arrete' >&2
    exit 1
  fi
  sleep 1
done
test "$TUNNEL_READY" = true || {
  cat "$TUNNEL_LOG" >&2
  printf '%s\n' 'Refus: tunnel PostgreSQL indisponible apres 60 s' >&2
  exit 1
}

node <<'NODE'
const url = new URL(process.env.TUNNELED_BENCHMARK_DATABASE_URL);
if (
  !['postgres:', 'postgresql:'].includes(url.protocol) ||
  url.hostname !== '127.0.0.1' ||
  url.port !== '15432'
) {
  throw new Error('Refus: URL du tunnel PostgreSQL inattendue');
}
NODE
CONNECTED_DATABASE="$(
  psql "$TUNNELED_BENCHMARK_DATABASE_URL" \
    --no-psqlrc --tuples-only --no-align \
    --command 'SELECT current_database()'
)"
test "$CONNECTED_DATABASE" = "$DATABASE_NAME" || {
  printf 'Refus: base cible inattendue (%s != %s)\n' \
    "$CONNECTED_DATABASE" "$DATABASE_NAME" >&2
  exit 1
}
unset CONNECTED_DATABASE

pg_restore --clean --if-exists --no-owner --no-privileges --no-comments \
  --dbname "$TUNNELED_BENCHMARK_DATABASE_URL" "$DUMP_FILE"
```

Une fois le tunnel vers `$APP` jetable revalide, creer une sentinelle propre a
cette restauration. Cette table reste volontairement hors migrations et hors
dump. La supprimer/recreer apres chaque restauration empeche de reutiliser le
nonce d'un clone precedent:

```shell
BENCHMARK_SENTINEL_NONCE="$(
  node -p "require('node:crypto').randomUUID()"
)"
psql "$TUNNELED_BENCHMARK_DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=sentinel="$BENCHMARK_SENTINEL_NONCE" <<'SQL'
BEGIN;
DROP TABLE IF EXISTS public.historic_backfill_benchmark_guard;
CREATE TABLE public.historic_backfill_benchmark_guard (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  nonce uuid NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.historic_backfill_benchmark_guard (singleton, nonce)
VALUES (true, :'sentinel'::uuid);
COMMIT;
SQL
```

Ne jamais creer cette sentinelle sur la base source. Le harness exige que la
table existe, contienne exactement une ligne et que son nonce soit strictement
egal a `HISTORIC_BACKFILL_BENCHMARK_SENTINEL`; toute anomalie echoue avant un
import Nest ou `AppModule`. Le harness utilise pour ce preflight un client
PostgreSQL minimal qu'il ferme systematiquement, puis reverifie la base et la
sentinelle apres le bootstrap avant tout appel aux finalizers.

L'application exige cinq variables PostgreSQL discretes, y compris pour le
harness. Les deriver de l'URL de l'addon clone sans jamais afficher cette URL,
puis les enregistrer uniquement sur l'application jetable:

```shell
: "${APP:?set to the disposable clone app name}"
export BENCHMARK_DATABASE_URL="$(
  scalingo --region osc-fr1 --app "$APP" \
    env-get SCALINGO_POSTGRESQL_URL
)"
: "${BENCHMARK_DATABASE_URL:?clone addon internal URL is empty}"
database_url_part() {
  node - "$1" <<'NODE'
const url = new URL(process.env.BENCHMARK_DATABASE_URL);
const values = {
  host: url.hostname,
  port: url.port || '5432',
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.replace(/^\//, '')),
};
process.stdout.write(values[process.argv[2]] || '');
NODE
}
export DATABASE_HOST="$(database_url_part host)"
export DATABASE_PORT="$(database_url_part port)"
export DATABASE_USER="$(database_url_part user)"
export DATABASE_PASSWORD="$(database_url_part password)"
export DATABASE_NAME="$(database_url_part database)"

scalingo --region osc-fr1 --app "$APP" env-set \
  DATABASE_HOST="$DATABASE_HOST" DATABASE_PORT="$DATABASE_PORT" \
  DATABASE_USER="$DATABASE_USER" DATABASE_PASSWORD="$DATABASE_PASSWORD" \
  DATABASE_NAME="$DATABASE_NAME"

: "${BENCHMARK_S3_ENDPOINT:?set the dedicated benchmark S3 endpoint}"
: "${BENCHMARK_S3_REGION:?set the dedicated benchmark S3 region}"
: "${BENCHMARK_S3_FORCE_PATH_STYLE:?set true or false}"
: "${BENCHMARK_BUCKET:?set the dedicated benchmark bucket}"
: "${AWS_ACCESS_KEY_ID:?set the bucket-scoped access key}"
: "${AWS_SECRET_ACCESS_KEY:?set the bucket-scoped secret key}"
case "$BENCHMARK_BUCKET" in
  *hist-bench*) ;;
  *) printf '%s\n' 'Refus: le bucket ne contient pas hist-bench' >&2; exit 1 ;;
esac
case "$BENCHMARK_S3_FORCE_PATH_STYLE" in
  true|false) ;;
  *) printf '%s\n' 'Refus: S3 force-path-style doit etre true ou false' >&2; exit 1 ;;
esac
BENCHMARK_S3_PREFIX="historic-backfill-benchmark/$APP/"
scalingo --region osc-fr1 --app "$APP" env-set \
  S3_ENDPOINT="$BENCHMARK_S3_ENDPOINT" S3_REGION="$BENCHMARK_S3_REGION" \
  S3_FORCE_PATH_STYLE="$BENCHMARK_S3_FORCE_PATH_STYLE" \
  S3_PREFIX="$BENCHMARK_S3_PREFIX" S3_BUCKET="$BENCHMARK_BUCKET" \
  S3_ACCESS_KEY="$AWS_ACCESS_KEY_ID" S3_SECRET_KEY="$AWS_SECRET_ACCESS_KEY"

: "${BENCHMARK_OIDC_ISSUER:?set the clone-only OIDC issuer}"
: "${BENCHMARK_OIDC_CLIENT_ID:?set the clone-only OIDC client id}"
: "${BENCHMARK_OIDC_CLIENT_SECRET:?set the clone-only OIDC client secret}"
: "${BENCHMARK_OIDC_REDIRECT_URI:?set the clone-only OIDC redirect URI}"
BENCHMARK_SESSION_SECRET="$(
  node -p "require('node:crypto').randomBytes(48).toString('base64url')"
)"
scalingo --region osc-fr1 --app "$APP" env-set \
  OAUTH2_CLIENT_PROVIDER_OIDC_ISSUER="$BENCHMARK_OIDC_ISSUER" \
  OAUTH2_CLIENT_REGISTRATION_LOGIN_CLIENT_ID="$BENCHMARK_OIDC_CLIENT_ID" \
  OAUTH2_CLIENT_REGISTRATION_LOGIN_CLIENT_SECRET="$BENCHMARK_OIDC_CLIENT_SECRET" \
  OAUTH2_CLIENT_REGISTRATION_LOGIN_REDIRECT_URI="$BENCHMARK_OIDC_REDIRECT_URI" \
  OAUTH2_CLIENT_REGISTRATION_LOGIN_SCOPE='openid profile email' \
  SESSION_SECRET="$BENCHMARK_SESSION_SECRET"
unset BENCHMARK_SESSION_SECRET

test "$(
  aws --region "$BENCHMARK_S3_REGION" \
    --endpoint-url "$BENCHMARK_S3_ENDPOINT" \
    s3api list-objects-v2 --bucket "$BENCHMARK_BUCKET" \
    --query KeyCount --output text
)" = 0
S3_SMOKE_KEY="${BENCHMARK_S3_PREFIX}preflight-${BENCHMARK_SENTINEL_NONCE}.txt"
S3_SMOKE_SOURCE="$RESTORE_DIR/s3-smoke-source.txt"
S3_SMOKE_DOWNLOAD="$RESTORE_DIR/s3-smoke-download.txt"
printf '%s\n' "$BENCHMARK_SENTINEL_NONCE" >"$S3_SMOKE_SOURCE"
aws --region "$BENCHMARK_S3_REGION" \
  --endpoint-url "$BENCHMARK_S3_ENDPOINT" \
  s3api put-object --bucket "$BENCHMARK_BUCKET" --key "$S3_SMOKE_KEY" \
  --body "$S3_SMOKE_SOURCE" --acl private >/dev/null
aws --region "$BENCHMARK_S3_REGION" \
  --endpoint-url "$BENCHMARK_S3_ENDPOINT" \
  s3api head-object --bucket "$BENCHMARK_BUCKET" --key "$S3_SMOKE_KEY" \
  >/dev/null
aws --region "$BENCHMARK_S3_REGION" \
  --endpoint-url "$BENCHMARK_S3_ENDPOINT" \
  s3api get-object --bucket "$BENCHMARK_BUCKET" --key "$S3_SMOKE_KEY" \
  "$S3_SMOKE_DOWNLOAD" >/dev/null
cmp "$S3_SMOKE_SOURCE" "$S3_SMOKE_DOWNLOAD"
cleanup_benchmark_s3_smoke
test "$(
  aws --region "$BENCHMARK_S3_REGION" \
    --endpoint-url "$BENCHMARK_S3_ENDPOINT" \
    s3api list-objects-v2 --bucket "$BENCHMARK_BUCKET" \
    --prefix "$BENCHMARK_S3_PREFIX" --query KeyCount --output text
)" = 0
```

Le slug doit contenir le build Nest, les templates mail et les trois binaires
Tippecanoe. Valider localement le build TypeScript. Ne pas rendre le build natif
Tippecanoe local bloquant si le runner ne dispose pas de `libsqlite3-dev`; le
build Scalingo execute `scalingo-postbuild` avec l'`Aptfile`, puis le one-off
ci-dessous controle les trois executables dans le slug:

```shell
cd apps/backend-admin
npm ci
npm run build
```

Configurer ensuite les gardes clone avant le premier deploiement et conserver le
backfill desactive pendant la migration. Deployer un commit propre et explicite:
un fichier seulement local ne sera pas present dans le slug. Le push Git attend
le build Scalingo; ne continuer que s'il sort avec le statut zero, que le dernier
deploiement est `success` pour `$BENCHMARK_COMMIT` et que le one-off de verification
reussit. `PROJECT_DIR=apps/backend-admin` est obligatoire pour ce monorepo.

Le mode `migrate-clone` fait ensuite un preflight PostgreSQL minimal avant de
charger TypeORM, reverifie base et sentinelle avant et apres `runMigrations()`,
et n'instancie ni `AppModule`, ni web, ni scheduler:

```shell
set -o pipefail
: "${RESTORE_DIR:?set to the encrypted temporary restore directory}"
REPORT_DIR="$RESTORE_DIR/reports-$BENCHMARK_SENTINEL_NONCE"
mkdir -p "$REPORT_DIR"
chmod 700 "$REPORT_DIR"
assert_benchmark_complete() {
  jq -e -s '
    map(select(
      .type == "historic_backfill_benchmark_complete" and
      .deadlineExceeded == false
    )) | length == 1
  ' "$1" >/dev/null
}
assert_migrations_complete() {
  jq -e -s '
    map(select(.type == "historic_backfill_benchmark_migrations_complete")) |
    length == 1
  ' "$1" >/dev/null
}
REPO_ROOT="$(git rev-parse --show-toplevel)"
BENCHMARK_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
test -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)"

scalingo --region osc-fr1 --app "$APP" env-set \
  PROJECT_DIR=apps/backend-admin \
  HISTORIC_BACKFILL_BENCHMARK_CLONE=I_CONFIRM_DISPOSABLE_CLONE \
  HISTORIC_BACKFILL_BENCHMARK_ALLOWED_DATABASE_NAME="$DATABASE_NAME" \
  HISTORIC_BACKFILL_BENCHMARK_SENTINEL="$BENCHMARK_SENTINEL_NONCE" \
  HISTORIC_BACKFILL_ENABLED=false DISABLE_SCHEDULED_JOBS=true \
  RUN_BUSINESS_SCHEDULED_JOBS=false HISTORIC_CATCHUP_ENABLED=false \
  CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED=false \
  ZONE_PUBLICATION_ENABLED=false ADMIN_WRITES_DISABLED=true \
  HISTORIC_BACKFILL_DATABASE_POOL_MAX=3 \
  HISTORIC_BACKFILL_WORKER_CONCURRENCY=1 \
  HISTORIC_BACKFILL_ARTIFACT_CONCURRENCY=1 \
  HISTORIC_BACKFILL_ARTIFACT_ACL=private \
  PATH_TO_WRITE_FILE=/tmp \
  TIPPECANOE_BIN_DIRECTORY=tippecanoe_program/bin

cd "$REPO_ROOT"
scalingo --region osc-fr1 --app "$APP" git-setup \
  --remote scalingo-hist-bench

# Une app neuve demarre sinon son web au premier deploiement. Le neutraliser
# avant tout push, puis verifier qu'aucun conteneur ne tourne.
scalingo --region osc-fr1 --app "$APP" scale --synchronous web:0:M
scalingo --region osc-fr1 --app "$APP" scale
scalingo --region osc-fr1 --app "$APP" ps

git push scalingo-hist-bench \
  "$BENCHMARK_COMMIT:refs/heads/master"
DEPLOYMENT_OUTPUT="$(
  scalingo --region osc-fr1 --app "$APP" deployments --per-page 1
)"
printf '%s\n' "$DEPLOYMENT_OUTPUT"
printf '%s\n' "$DEPLOYMENT_OUTPUT" | \
  awk -v ref="${BENCHMARK_COMMIT:0:7}" \
    'index($0, ref) && /success/ { found=1 } END { exit !found }'

# Le Procfile est maintenant connu. Fixer et verifier explicitement toutes les
# formations a zero avant le seul one-off de migration.
scalingo --region osc-fr1 --app "$APP" scale --synchronous \
  web:0:M clock:0:M currentzoneworker:0:M \
  historicbackfillworker:0:M historicartifactworker:0:M
scalingo --region osc-fr1 --app "$APP" scale
scalingo --region osc-fr1 --app "$APP" ps

scalingo --region osc-fr1 --app "$APP" run --silent --size XL \
  sh -eu -c 'test -f dist/apps/backend-admin/src/scripts/benchmark-historic-backfill.js
test -x "$TIPPECANOE_BIN_DIRECTORY/tippecanoe"
test -x "$TIPPECANOE_BIN_DIRECTORY/tippecanoe-decode"
test -x "$TIPPECANOE_BIN_DIRECTORY/tile-join"'

scalingo --region osc-fr1 --app "$APP" run --silent --size XL \
  npm run benchmark:historic-backfill -- --mode migrate-clone \
  | tee "$REPORT_DIR/00-migrate-clone.jsonl"
assert_migrations_complete "$REPORT_DIR/00-migrate-clone.jsonl"
```

Avant le push, `scale` doit afficher `web` a zero et `ps` aucun conteneur.
Apres le push, `scale` doit afficher les cinq formations a zero et `ps` doit
encore etre vide. Stopper immediatement si l'une de ces postconditions manque.

Le bootstrap des workers et des autres modes du harness charge `AppModule` et
donc `AuthModule`: fournir une configuration OIDC reservee au clone (issuer,
client, secret et callback), jamais les identifiants de production. Les sorties
mail/data.gouv/Sentry restent, elles, sans credentials et les jobs restent
desactives.

Apres restauration, verifier PostgreSQL/PostGIS, une taille proche de la source,
34 943 communes, 101 departements, aucune erreur `pg_restore`, aucun processus
planifie et un bucket encore vide. Deployer ensuite le code avec le backfill
desactive, appliquer la migration additive avec `migrate-clone`, puis activer
uniquement le backfill.
La preuve d'isolation finale exige zero appel data.gouv/mail/SANDRE, uniquement
des objets sous le prefixe benchmark et aucun identifiant de production dans
l'environnement. Detruire application, addon et bucket apres conservation du
rapport JSONL valide.

## Pilote et montee en charge

1. Le pipeline ne supporte pas un pilote limite a cinq departements: un run a
   toujours exactement 101 taches. Sur un clone recent de production, commencer
   par les 101 departements sur une plage courte, par exemple 30 jours. Ce pilote
   calibre les workers et valide les invariants, mais ne dimensionne pas la
   reduction finale.
2. Le gate obligatoire de dimensionnement couvre ensuite les 101 departements
   sur la plage complete du clone, la construction du shadow, le dry-run puis
   la transaction d'application des statistiques sur ce clone. Seul ce gate
   mesure les ~194 millions de points quotidiens, les JSONB finaux, le WAL, le
   temporaire et la duree de la grosse transaction. Il ne publie aucune carte.
3. En production, preparer un run qui couvre toute la plage sale, puis demarrer
   deux processus `historicbackfillworker` 2XL avec une concurrence interne de
   1. Les 101 taches sont revendiquees par `FOR UPDATE SKIP LOCKED`.
4. Mesurer pendant au moins 15 minutes. Stopper la montee si API p95 depasse
   deux fois sa baseline, si une attente de lock courant depasse 5 secondes, si
   les connexions depassent 70 % de la limite, ou si CPU/IO DB depassent 75 %.
5. Monter 2 -> 4 -> 8 -> 10 workers. Attendre un palier stable avant chaque
   augmentation. Scalingo limite par defaut un type de processus a 10
   conteneurs; ne passer a 12 ou 16 qu'apres hausse de quota obtenue et verifiee
   par le owner. Ajouter des conteneurs au-dela de la saturation PostgreSQL ne
   reduit pas la duree. Le parallelisme est horizontal: ne pas augmenter la
   concurrence interne des conteneurs.
6. Les workers peuvent etre tues/recrees: les leases expirent et le staging est
   idempotent. Une tache `failed` doit etre comprise avant reprise.
7. Attendre 101/101 departements `completed`, generations courantes et aucune
   erreur. Construire ensuite le shadow statistique et executer le dry-run de
   promotion.

La preparation ou la prise d'une tache artefact reconcilie aussi les mutations
historiques survenues apres l'arret des workers departementaux. Si un departement
est redevenu `pending`, l'etape artefact refuse de continuer: relancer au moins
un `historicbackfillworker`, revenir a 101/101, puis reprendre les artefacts.

La reduction du shadow utilise `HISTORIC_BACKFILL_SHADOW_CONCURRENCY=4` par
defaut, bornee de 1 a 8. Ce parallelisme ne doit etre augmente qu'apres mesure
sur le clone full-range; il ne change pas la concurrence interne des workers.

L'objectif de duree doit etre recalcule depuis le debit observe du benchmark et
du premier palier. Aucune promesse inferieure a 12 heures ne doit etre faite
avant d'avoir mesure la reduction full-range, les octets de shadow, le WAL et la
transaction de promotion sur un clone de production.

## Harness de benchmark sur clone

Le harness refuse tout identifiant d'application ou de base contenant `prod` ou
`production`, exige le nom renvoye par `current_database()` et reverifie la
sentinelle avant chaque mutation. `prepare-run` et `prepare-artifacts` appellent
directement les services de queue: aucun web, cookie ou compte MTE n'est requis,
et `ADMIN_WRITES_DISABLED=true` reste en place. Ces deux modes refusent toutefois
de demarrer sans `HISTORIC_BACKFILL_ENABLED=true`.

Determiner les bornes depuis le clone restaure, jamais depuis une date supposee.
La requete ci-dessous ne rend aucune ligne si les revisions ne sont pas separees,
si la queue courante n'est pas vide, si un calcul courant tourne, si un ancien
run est inacheve ou si la plage sale depasse la veille de la publication
courante:

```shell
BOUNDS="$({
  psql "$TUNNELED_BENCHMARK_DATABASE_URL" --set=ON_ERROR_STOP=1 \
    --tuples-only --no-align --field-separator='|' <<'SQL'
WITH source_dates AS (
  SELECT ar."dateDebut" AS value
  FROM "arrete_restriction" ar
  WHERE ar."statut" IN ('publie', 'abroge')
    AND ar."dateDebut" IS NOT NULL
  UNION ALL
  SELECT p."dateDebut" FROM "parametres" p WHERE p."dateDebut" IS NOT NULL
), source_bound AS (
  SELECT min(value)::date AS "dateFrom" FROM source_dates
), gates AS (
  SELECT
    source_bound."dateFrom",
    config."computeMapDate",
    config."computeStatsDate",
    statistic_state."currentPublishedDate",
    statistic_state."historicDirtyFrom",
    statistic_state."historicDirtyThrough",
    source_state."legacyDualWrite",
    (SELECT count(*) FROM "commune") AS commune_count,
    (SELECT count(*) FROM "departement") AS department_count,
    (SELECT count(*) FROM "current_zone_recompute_request") AS queue_count,
    (SELECT count(*) FROM "statistic_commune_snapshot"
      WHERE "status" = 'running') AS snapshot_count,
    (SELECT count(*) FROM "external_publication_run"
      WHERE "jobKey" = 'compute:national-daily' AND "status" = 'running')
      AS daily_count,
    (SELECT count(*) FROM "historic_backfill_run"
      WHERE "status" IN ('preparing', 'running', 'paused')) AS run_count
  FROM source_bound
  CROSS JOIN "config" config
  CROSS JOIN "statistic_publication_state" statistic_state
  CROSS JOIN "zone_publication_source_state" source_state
  WHERE config."id" = 1 AND statistic_state."id" = 1
    AND source_state."id" = 1
)
SELECT
  LEAST("dateFrom", "computeMapDate", "computeStatsDate", "historicDirtyFrom"),
  LEAST("dateFrom", "computeStatsDate", "historicDirtyFrom"),
  "currentPublishedDate" - 1
FROM gates
WHERE "dateFrom" IS NOT NULL
  AND "currentPublishedDate" IS NOT NULL
  AND NOT "legacyDualWrite"
  AND commune_count = 34943
  AND department_count = 101
  AND queue_count = 0 AND snapshot_count = 0 AND daily_count = 0
  AND run_count = 0
  AND (
    "historicDirtyThrough" IS NULL
    OR "historicDirtyThrough" <= "currentPublishedDate" - 1
  );
SQL
} | tr -d '[:space:]')"
test -n "$BOUNDS"
IFS='|' read -r MAP_DATE_FROM STATISTIC_DATE_FROM DATE_THROUGH <<< "$BOUNDS"
printf 'map=%s statistics=%s through=%s\n' \
  "$MAP_DATE_FROM" "$STATISTIC_DATE_FROM" "$DATE_THROUGH"
```

Faire valider ces trois dates comme plage full-range, puis activer le seul
pipeline historique et preparer le run. Chaque sortie est conservee par `tee` et
immediatement validee comme JSONL:

```shell
scalingo --region osc-fr1 --app "$APP" env-set \
  HISTORIC_BACKFILL_ENABLED=true

scalingo --region osc-fr1 --app "$APP" run --silent --size XL \
  npm run benchmark:historic-backfill -- \
  --mode prepare-run \
  --map-date-from "$MAP_DATE_FROM" \
  --statistic-date-from "$STATISTIC_DATE_FROM" \
  --date-through "$DATE_THROUGH" \
  | tee "$REPORT_DIR/01-prepare-run.jsonl"
assert_benchmark_complete "$REPORT_DIR/01-prepare-run.jsonl"
RUN_ID="$(jq -r \
  'select(.type == "historic_backfill_benchmark_complete") | .runId' \
  "$REPORT_DIR/01-prepare-run.jsonl" | tail -n 1)"
test -n "$RUN_ID" && test "$RUN_ID" != null

scalingo --region osc-fr1 --app "$APP" scale --synchronous \
  historicbackfillworker:2:2XL
scalingo --region osc-fr1 --app "$APP" run --silent --size XL \
  npm run benchmark:historic-backfill -- \
  --mode wait-staging --run-id "$RUN_ID" \
  --poll-ms 15000 --timeout-ms 259200000 \
  | tee "$REPORT_DIR/02-wait-staging.jsonl"
assert_benchmark_complete "$REPORT_DIR/02-wait-staging.jsonl"
scalingo --region osc-fr1 --app "$APP" scale --synchronous \
  historicbackfillworker:0:M
scalingo --region osc-fr1 --app "$APP" ps

scalingo --region osc-fr1 --app "$APP" run --silent --size 2XL \
  npm run benchmark:historic-backfill -- \
  --mode build-shadow --run-id "$RUN_ID" \
  --poll-ms 15000 --timeout-ms 86400000 \
  | tee "$REPORT_DIR/03-build-shadow.jsonl"
assert_benchmark_complete "$REPORT_DIR/03-build-shadow.jsonl"
scalingo --region osc-fr1 --app "$APP" run --silent --size 2XL \
  npm run benchmark:historic-backfill -- \
  --mode dry-run-stats --run-id "$RUN_ID" \
  --poll-ms 15000 --timeout-ms 86400000 \
  | tee "$REPORT_DIR/04-dry-run-stats.jsonl"
assert_benchmark_complete "$REPORT_DIR/04-dry-run-stats.jsonl"
```

Pour mesurer les artefacts sans endpoint HTTP, les preparer apres le staging,
puis demarrer les workers dedies:

```shell
scalingo --region osc-fr1 --app "$APP" run --silent --size XL \
  npm run benchmark:historic-backfill -- \
  --mode prepare-artifacts --run-id "$RUN_ID" \
  | tee "$REPORT_DIR/05-prepare-artifacts.jsonl"
assert_benchmark_complete "$REPORT_DIR/05-prepare-artifacts.jsonl"
scalingo --region osc-fr1 --app "$APP" scale --synchronous \
  historicartifactworker:2:2XL
scalingo --region osc-fr1 --app "$APP" run --silent --size XL \
  npm run benchmark:historic-backfill -- \
  --mode wait-artifacts --run-id "$RUN_ID" \
  --poll-ms 15000 --timeout-ms 259200000 \
  | tee "$REPORT_DIR/06-wait-artifacts.jsonl"
assert_benchmark_complete "$REPORT_DIR/06-wait-artifacts.jsonl"
scalingo --region osc-fr1 --app "$APP" scale --synchronous \
  historicartifactworker:0:M
scalingo --region osc-fr1 --app "$APP" ps
```

`wait-artifacts` refuse de demarrer si aucune tache artefact n'a ete preparee et
s'arrete en erreur des la presence d'une tache `failed`. Il reussit seulement
quand toutes les taches preparees sont `completed`.

L'application des statistiques est refusee par defaut. Sur le clone jetable
uniquement, elle exige deux opt-ins independants, l'option CLI et la variable
d'environnement. Le dry-run est toujours execute avant l'application:

```shell
scalingo --region osc-fr1 --app "$APP" env-set \
  HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY=true
scalingo --region osc-fr1 --app "$APP" run --silent --size 2XL \
  npm run benchmark:historic-backfill -- \
  --mode dry-run-stats --apply-statistics --run-id "$RUN_ID" \
  --poll-ms 15000 --timeout-ms 86400000 \
  | tee "$REPORT_DIR/07-apply-statistics.jsonl"
assert_benchmark_complete "$REPORT_DIR/07-apply-statistics.jsonl"
scalingo --region osc-fr1 --app "$APP" env-set \
  HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY=false
```

Le harness n'expose aucun apply des cartes. Il emet uniquement du
JSONL avec les compteurs du run, les durees par departement, les durees artefacts
p50/p95/max, WAL/temp, connexions, attentes PostgreSQL et tailles des huit tables
de controle/staging. Le contexte Nest est ferme a chaque sortie, y compris en
erreur. `--poll-ms` est borne entre 1 seconde et 5 minutes; `--timeout-ms` entre
10 secondes et 72 heures. Une application statistique ne demarre pas apres son
echeance; si sa transaction a deja commence, le CLI attend son commit/rollback,
puis emet `deadlineExceeded=true` au lieu de la detacher.

Le JSONL ne mesure pas le CPU/IO du service PostgreSQL, son stockage libre, la
latence API p95 ni les appels externes. Conserver en parallele les graphes
Scalingo et les preuves reseau/bucket horodatees; les seuils de montee en charge
ne peuvent pas etre valides par le seul harness.

### Arret et destruction du clone

Apres validation et conservation chiffree du rapport JSONL, couper d'abord le
calcul avec le garde. Supprimer ensuite les secrets de l'application, le dump
local et le bucket dedie. Le test sur le nom du bucket empeche de viser par
erreur un bucket qui ne porte pas explicitement le marqueur `bench`:

```shell
stop_benchmark_compute
stop_benchmark_tunnel

scalingo --region osc-fr1 --app "$APP" env-unset \
  DATABASE_HOST DATABASE_PORT DATABASE_USER DATABASE_PASSWORD DATABASE_NAME \
  HISTORIC_BACKFILL_BENCHMARK_SENTINEL \
  HISTORIC_BACKFILL_BENCHMARK_ALLOWED_DATABASE_NAME \
  HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY \
  S3_ENDPOINT S3_REGION S3_FORCE_PATH_STYLE S3_PREFIX S3_BUCKET \
  S3_ACCESS_KEY S3_SECRET_KEY \
  OAUTH2_CLIENT_PROVIDER_OIDC_ISSUER \
  OAUTH2_CLIENT_REGISTRATION_LOGIN_CLIENT_ID \
  OAUTH2_CLIENT_REGISTRATION_LOGIN_CLIENT_SECRET \
  OAUTH2_CLIENT_REGISTRATION_LOGIN_REDIRECT_URI \
  OAUTH2_CLIENT_REGISTRATION_LOGIN_SCOPE SESSION_SECRET

case "${RESTORE_DIR:-}" in
  "${TMPDIR:-/tmp}"/vigieau-hist-bench-*)
    command -v shred >/dev/null
    find "$RESTORE_DIR" -type f -exec \
      shred --force --iterations=1 --zero --remove=unlink -- {} +
    rm -rf -- "$RESTORE_DIR"
    ;;
  *) printf '%s\n' 'Refus: RESTORE_DIR non sur' >&2; exit 1 ;;
esac
unset BENCHMARK_DATABASE_URL TUNNELED_BENCHMARK_DATABASE_URL \
  DATABASE_HOST DATABASE_PORT DATABASE_USER DATABASE_PASSWORD DATABASE_NAME \
  BENCHMARK_SENTINEL_NONCE PROD_POSTGRES_ADDON PROD_BACKUP_ID \
  RESTORE_DIR BACKUP_ARCHIVE DUMP_FILE

: "${BENCHMARK_BUCKET:?set to the dedicated benchmark bucket}"
: "${BENCHMARK_S3_ENDPOINT:?set to the benchmark S3 endpoint}"
case "$BENCHMARK_BUCKET" in
  *hist-bench*) ;;
  *) printf '%s\n' 'Refus: le bucket ne contient pas hist-bench' >&2; exit 1 ;;
esac
aws --region "$BENCHMARK_S3_REGION" \
  --endpoint-url "$BENCHMARK_S3_ENDPOINT" \
  s3 rm "s3://$BENCHMARK_BUCKET" --recursive
aws --region "$BENCHMARK_S3_REGION" \
  --endpoint-url "$BENCHMARK_S3_ENDPOINT" \
  s3api delete-bucket --bucket "$BENCHMARK_BUCKET"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  BENCHMARK_BUCKET BENCHMARK_S3_ENDPOINT BENCHMARK_S3_REGION \
  BENCHMARK_S3_FORCE_PATH_STYLE BENCHMARK_S3_PREFIX \
  BENCHMARK_OIDC_ISSUER BENCHMARK_OIDC_CLIENT_ID \
  BENCHMARK_OIDC_CLIENT_SECRET BENCHMARK_OIDC_REDIRECT_URI
```

Le `destroy` final doit etre execute par le **owner du projet Scalingo**. Un
collaborateur s'arrete apres le scale a zero et transmet l'action au owner; il
ne doit pas declarer le clone detruit. Dans le shell du owner, apres verification
du nom exact de `$APP`, cette commande supprime l'application et son addon:

```shell
: "${APP:?set to the disposable benchmark app}"
case "$APP" in
  *hist-bench*) ;;
  *) printf '%s\n' 'Refus: APP ne contient pas hist-bench' >&2; exit 1 ;;
esac
trap - EXIT INT TERM HUP
scalingo --region osc-fr1 --app "$APP" destroy --force
```

## Artefacts et promotion

1. Utiliser les modes `build-shadow`, puis `dry-run-stats` du harness (ou les
   endpoints MTE equivalents hors clone). Le shadow est idempotent et peut etre
   reconstruit par departement via
   `/shadow/department/build` pour diagnostic.
2. Utiliser `prepare-artifacts` (ou l'endpoint MTE equivalent hors clone). Les taches
   nationales correspondent a l'union des bornes de segments et sont fences par
   revision source et epoch.
3. Demarrer `historicartifactworker`. Commencer a 2 conteneurs, puis monter a 4
   ou 8 selon CPU local, debit S3 et latence PostgreSQL. Chaque tache assemble
   101 GeoJSON departementaux et valide les identifiants PMTiles.
4. Suivre les taches avec le mode `wait-artifacts` du harness. Exiger toutes les
   taches artefacts `completed`, une couverture contigue de la plage et des
   checksums valides.
   `HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES` borne le cache local des fragments
   (256 Mio par defaut, 1 Gio maximum), et
   `HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY` borne les controles S3 (16 par
   defaut, 32 maximum). L'upload du manifeste expire apres
   `HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS=60000`.
5. Reexecuter le dry-run statistiques, puis envoyer `{ "apply": true }`. Le
   cache public courant reste inchange tant que la promotion finale n'est pas
   terminee.
6. Executer `POST /historic-backfill/:runId/maps/finalize` en dry-run, puis avec
   `{ "apply": true }`. La transaction avance les curseurs et cree l'outbox;
   le manifeste public unique n'est remplace qu'apres ce commit. Un nouvel apply
   reprend une outbox `pending` sans rejouer la reduction.
7. Laisser le worker statcache construire le candidat complet, attendre le
   quorum de tous les webs puis l'activation. Verifier `historicComplete=true`.

Sur le clone avec `HISTORIC_BACKFILL_ARTIFACT_ACL=private`, ne jamais appeler
`maps/finalize`, meme en dry-run, sauf test de publication explicitement autorise
avec un bucket dedie a cet effet. Le manifeste final est toujours uploade en
`public-read`, independamment de l'ACL des artefacts de travail. Le benchmark de
dimensionnement s'arrete donc apres les mesures statistiques et artefacts.

## Gates finaux

- Run `completed`, 101 taches departementales et toutes les taches artefacts
  terminees; aucun lease expire ou `lastError`.
- Curseurs map/statistique et `historicPublishedThrough` a `dateThrough`.
- Aucun trou ni doublon date/commune, snapshots nationaux `completed` et
  couverture 34 943 communes / 101 departements.
- Smoke cartes sur plusieurs dates anciennes, transition du 29/04/2024 et jour
  precedent; smoke statistiques sur 7, 31 et 365 jours.
- API/front/CORS/D49/D77/D79 inchanges et statcache complet acquitte par toutes
  les instances.
- Ressources revenues sous les seuils avant de ramener les processus a zero et
  de reduire la capacite PostgreSQL.

## Arret et rollback

Appeler `POST /historic-backfill/:runId/pause`, puis ramener les deux types de
workers a zero. La pause revoque les baux departementaux et artefacts. Les
staging/shadows peuvent rester pour diagnostic: aucun lecteur public ne les
consomme. Avant la transaction finale, le rollback consiste uniquement a ne pas
promouvoir. Apres promotion, conserver les anciens artefacts/statcache pendant
48 heures et utiliser le rollback de publication existant; ne supprimer aucune
table additive pendant l'incident.
