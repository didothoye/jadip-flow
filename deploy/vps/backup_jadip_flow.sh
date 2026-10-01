#!/bin/bash
# Sauvegarde quotidienne de Jadip Flow (installée en /root/backup_jadip_flow.sh, cron 03:15).
# Base PostgreSQL + volume /data, chiffrés gpg AES-256 (phrase : /root/.jadip-flow-backup.gpgpass, 600),
# 14 jours en local (/root/backups/jadip-flow), copie hors site vers b2-crypt:jadip-flow.
# Copie aussi le .env (APP_ENCRYPTION_KEY : sans elle, les clés API chiffrées d une base restaurée
# sont illisibles) et la phrase gpg vers b2-crypt:secrets/jadip-flow. Résultat signalé par le cron (kuma-signal).
set -euo pipefail
[ -f /root/.rclone-crypt-secrets ] && { set -a; . /root/.rclone-crypt-secrets; set +a; }
echo "=== [$(date +%F\ %T)] sauvegarde Jadip Flow ==="
BACKUP_DIR=/root/backups/jadip-flow BACKUP_KEEP_DAYS=14 \
BACKUP_PASSPHRASE_FILE=/root/.jadip-flow-backup.gpgpass BACKUP_REMOTE=b2-crypt:jadip-flow \
  /srv/apps/jadip-flow/deploy/scripts/backup.sh
rclone copyto /srv/apps/jadip-flow/deploy/.env "b2-crypt:secrets/jadip-flow/env-$(date +%F)" --quiet
rclone copyto /root/.jadip-flow-backup.gpgpass b2-crypt:secrets/jadip-flow/backup.gpgpass --quiet
rclone delete b2-crypt:secrets/jadip-flow --min-age 90d --exclude backup.gpgpass --quiet || true
echo "[$(date +%F\ %T)] .env et phrase gpg copiés vers b2-crypt:secrets/jadip-flow"
