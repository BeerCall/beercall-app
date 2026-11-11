#!/usr/bin/env bash
# Sauvegarde de production BeerCall : DB logique + uploads + configuration.
# Exige explicitement une destination hors site ; aucun emplacement par défaut
# n'est choisi pour éviter de stocker des secrets à un endroit non approuvé.
set -euo pipefail

: "${BEERCALL_BACKUP_REMOTE:?Définir BEERCALL_BACKUP_REMOTE (destination hors site)}"
APP_DIR="${BEERCALL_APP_DIR:-$HOME/beercall-app}"
BACKUP_ROOT="${BEERCALL_BACKUP_DIR:-$HOME/beercall_backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$BACKUP_ROOT/.tmp-$STAMP"
REMOTE="${BEERCALL_BACKUP_REMOTE%/}/$STAMP"
RELEASE="$(git -C "$APP_DIR" rev-parse HEAD)"

umask 077
mkdir -p "$BACKUP_ROOT" "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

cd "$APP_DIR"

echo "Dump PostgreSQL vers $WORK/db.dump"
docker compose exec -T db_beercall sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$WORK/db.dump"
docker compose exec -T db_beercall pg_restore --list < "$WORK/db.dump" > /dev/null

echo "Archive des uploads et de la configuration"
tar -C "$APP_DIR" -czf "$WORK/uploads.tgz" beercall-backend/uploads
tar -C "$APP_DIR" -czf "$WORK/config.tgz" .env .gitmodules nginx secrets

(
  cd "$WORK"
  sha256sum db.dump uploads.tgz config.tgz > SHA256SUMS
)

echo "Copie hors site vers $REMOTE"
mkdir -p "$REMOTE"
rsync -a "$WORK/" "$REMOTE/"

cat > "$WORK/LATEST.tmp" <<EOF
{"stamp":"$STAMP","release":"$RELEASE","remote":"$REMOTE","created_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
mv "$WORK/LATEST.tmp" "$BACKUP_ROOT/LATEST"
chmod 600 "$BACKUP_ROOT/LATEST"
echo "Sauvegarde vérifiée : $REMOTE"
