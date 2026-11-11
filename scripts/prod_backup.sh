#!/usr/bin/env bash
# Must be invoked from a reviewed checkout. Destination is approved explicitly.
set -euo pipefail
: "${BEERCALL_BACKUP_REMOTE:?Destination SSH hors site obligatoire}"
umask 077
exec 9>"$HOME/.beercall-release.lock"
flock -n 9 || { echo "Une opération de release est déjà en cours" >&2; exit 1; }
python3 "$(dirname "${BASH_SOURCE[0]}")/prod_safety.py" backup
