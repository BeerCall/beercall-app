#!/usr/bin/env bash
# Retour arrière explicite vers un SHA déjà publié. Ne restaure jamais la DB.
# La base peut avoir reçu des migrations plus récentes : le script s'arrête si
# l'application ne redevient pas saine, sans tenter de dump/restauration auto.
set -euo pipefail

TARGET="${1:-}"
CONFIRM="${2:-}"
if [ -z "$TARGET" ] || [ "$CONFIRM" != "--confirm" ]; then
  echo "Usage: $0 <sha-complet> --confirm" >&2
  exit 2
fi
if ! printf '%s' "$TARGET" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "SHA invalide : $TARGET" >&2
  exit 2
fi

APP_DIR="${BEERCALL_APP_DIR:-$HOME/beercall-app}"
umask 077
exec 9>"$HOME/.beercall-release.lock"
flock -n 9 || { echo "Une opération de release est déjà en cours" >&2; exit 1; }
SAFETY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prod_safety.py"
cd "$APP_DIR"

if [ -n "$(git status --porcelain --untracked-files=no --ignore-submodules=untracked)" ]; then
  echo "Dépôt VPS sale : rollback refusé." >&2
  exit 1
fi

git fetch origin
git merge-base --is-ancestor "$TARGET" origin/main
# Refuse an old image/schema BEFORE checkout or replacement of containers.
CURRENT_SCHEMA=$(docker compose exec -T db_beercall sh -lc \
  'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT version_num FROM alembic_version"')
TARGET_BACKEND=$(git rev-parse "$TARGET:beercall-backend")
git -C beercall-backend fetch origin
python3 "$SAFETY" check-schema "$APP_DIR/beercall-backend" "$TARGET_BACKEND" "$CURRENT_SCHEMA"
git checkout --detach "$TARGET"
git submodule sync
git submodule update --init --recursive
cp .env beercall-frontend/.env
cp .env beercall-backend/.env

docker compose up -d --build --remove-orphans --wait --wait-timeout 180
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 60 nginx_beercall
docker compose exec -T nginx_beercall nginx -t
docker compose exec -T nginx_beercall nginx -s reload
docker compose exec -T nginx_beercall wget -qO- http://127.0.0.1/api/health/ready

echo "$TARGET $(date -u +%Y-%m-%dT%H:%M:%SZ) rollback" >> "$HOME/beercall-releases.log"
echo "Rollback code terminé sur $TARGET. Les données ne sont pas restaurées."
