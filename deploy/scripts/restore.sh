#!/usr/bin/env bash
# Restaure une sauvegarde chiffrée dans une base cible.
# Usage : restore.sh <fichier.tgz.age|.tgz.gpg> [--data-dir <dossier>]
# Variables : BACKUP_AGE_IDENTITY (clé privée age) ou BACKUP_PASSPHRASE_FILE (gpg)
#             PG_RESTORE (défaut : restauration dans le conteneur jadip-flow-db, base jadip_flow — ÉCRASE les données)
set -euo pipefail
file="${1:?fichier de sauvegarde requis}"
data_dir=""
[ "${2:-}" = "--data-dir" ] && data_dir="${3:?}"
PG_RESTORE="${PG_RESTORE:-docker exec -i jadip-flow-db pg_restore -U jadip_flow -d jadip_flow --clean --if-exists --no-owner}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -f "$file.sha256" ]; then (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" >/dev/null) || { echo "Somme de contrôle invalide" >&2; exit 1; }; fi
case "$file" in
  *.age) age -d -i "${BACKUP_AGE_IDENTITY:?}" -o "$work/bundle.tgz" "$file" ;;
  *.gpg) gpg --batch --quiet --pinentry-mode loopback --passphrase-file "${BACKUP_PASSPHRASE_FILE:?}" -d -o "$work/bundle.tgz" "$file" ;;
  *) echo "Extension inconnue" >&2; exit 1 ;;
esac
tar -C "$work" -xzf "$work/bundle.tgz"
$PG_RESTORE < "$work/db.dump"
if [ -n "$data_dir" ]; then mkdir -p "$data_dir" && tar -C "$data_dir" -xf "$work/data.tar"; fi
echo "Restauration terminée ($(cat "$work/manifest.json"))."
