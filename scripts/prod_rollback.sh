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
cd "$APP_DIR"

if [ -n "$(git status --porcelain --untracked-files=no --ignore-submodules=untracked)" ]; then
  echo "Dépôt VPS sale : rollback refusé." >&2
  exit 1
fi

git fetch origin
git checkout --detach "$TARGET"
git submodule sync
git submodule update --init --recursive
cp .env beercall-frontend/.env 2>/dev/null || true
cp .env beercall-backend/.env 2>/dev/null || true

docker compose up -d --build --wait --wait-timeout 180
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 60 nginx_beercall
docker compose exec -T nginx_beercall nginx -t
docker compose exec -T nginx_beercall nginx -s reload
docker compose exec -T nginx_beercall wget -qO- http://127.0.0.1/api/health/ready

echo "$TARGET $(date -u +%Y-%m-%dT%H:%M:%SZ) rollback" >> "$HOME/beercall-releases.log"
echo "Rollback code terminé sur $TARGET. Les données ne sont pas restaurées."
