#!/usr/bin/env bash
# Sauvegarde chiffrée quotidienne de Jadip Flow (base PostgreSQL + fichiers : rapports, pièces jointes, logos).
#  - chiffrement : age (clé publique BACKUP_AGE_RECIPIENT ; la clé privée reste HORS du serveur)
#                  ou, à défaut, gpg symétrique AES-256 (BACKUP_PASSPHRASE_FILE)
#  - copie hors serveur : rclone vers BACKUP_REMOTE (ex. « b2:jadip-backups/jadip-flow »)
#  - rétention locale : BACKUP_KEEP_DAYS (défaut 14) ; la rétention distante se règle côté stockage (cycle de vie)
# Cron conseillé : 30 2 * * * /opt/apps/jadip-flow/deploy/scripts/backup.sh >> /var/log/jadip-flow-backup.log 2>&1
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/var/backups/jadip-flow}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
PG_DUMP="${PG_DUMP:-docker exec jadip-flow-db pg_dump -U jadip_flow -d jadip_flow -Fc}"
DATA_TAR="${DATA_TAR:-docker run --rm --volumes-from jadip-flow alpine tar -C /data -cf - .}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

$PG_DUMP > "$work/db.dump"
$DATA_TAR > "$work/data.tar"
printf '{"created_at":"%s","app":"jadip-flow"}\n' "$stamp" > "$work/manifest.json"
tar -C "$work" -czf "$work/bundle.tgz" db.dump data.tar manifest.json

out="$BACKUP_DIR/jadip-flow-$stamp.tgz"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$out.age" "$work/bundle.tgz"; out="$out.age"
elif [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 -o "$out.gpg" "$work/bundle.tgz"; out="$out.gpg"
else
  echo "Refus : aucune méthode de chiffrement configurée (BACKUP_AGE_RECIPIENT ou BACKUP_PASSPHRASE_FILE)." >&2; exit 1
fi
chmod 600 "$out"
sha256sum "$out" > "$out.sha256"
echo "$(date -Is) sauvegarde locale : $out ($(du -h "$out" | cut -f1))"

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$out" "$BACKUP_REMOTE/" && rclone copy "$out.sha256" "$BACKUP_REMOTE/"
  echo "$(date -Is) copie hors serveur : $BACKUP_REMOTE"
else
  echo "ATTENTION : BACKUP_REMOTE non défini, la sauvegarde n'est pas copiée hors du serveur." >&2
fi
find "$BACKUP_DIR" -name 'jadip-flow-*' -mtime +"$BACKUP_KEEP_DAYS" -delete
# signal de vie pour uptime-kuma (moniteur « push »), facultatif
[ -n "${BACKUP_PUSH_URL:-}" ] && curl -fsS "$BACKUP_PUSH_URL?status=up&msg=OK" >/dev/null || true
