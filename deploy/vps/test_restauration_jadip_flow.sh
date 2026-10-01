#!/bin/bash
# Test de restauration de Jadip Flow (installé en /root/test_restauration_jadip_flow.sh, cron les 3 et 17 à 05:30).
# La dernière sauvegarde chiffrée est déchiffrée et restaurée dans un PostgreSQL jetable
# (deploy/scripts/restore-test.sh) : comptages et intégrité de la chaîne du journal d audit.
# Vérifie aussi l âge de la sauvegarde et la copie hors site. Résultat signalé à uptime-kuma.
set -o pipefail
signal(){ /usr/local/bin/kuma-signal restauration_test_jadip_flow "$1" "$2" 2>/dev/null || true; }
[ -f /root/.rclone-crypt-secrets ] && { set -a; . /root/.rclone-crypt-secrets; set +a; }
echo "=== [$(date +%F\ %H:%M)] test de restauration Jadip Flow ==="
pb=()
F=$(ls -1t /root/backups/jadip-flow/jadip-flow-*.tgz.gpg 2>/dev/null | head -1)
[ -n "$F" ] || { echo "aucune sauvegarde trouvée"; signal 1 "aucune sauvegarde jadip-flow trouvée"; exit 1; }
[ $(( ($(date +%s) - $(stat -c %Y "$F")) / 3600 )) -le 30 ] || pb+=("sauvegarde de plus de 30 h")
BACKUP_DIR=/root/backups/jadip-flow BACKUP_PASSPHRASE_FILE=/root/.jadip-flow-backup.gpgpass \
  /srv/apps/jadip-flow/deploy/scripts/restore-test.sh "$F" | tee /tmp/jf-resto.$$ || true
grep -q "^SUCCÈS" /tmp/jf-resto.$$ || pb+=("restauration en échec")
rm -f /tmp/jf-resto.$$
rclone lsf b2-crypt:jadip-flow --include "$(basename "$F")" 2>/dev/null | grep -q . && echo "copie hors site de $(basename "$F") : OK" || pb+=("copie hors site absente")
[ -n "$(rclone lsf b2-crypt:secrets/jadip-flow --max-age 48h 2>/dev/null)" ] && echo "copie hors site du .env de moins de 48 h : OK" || pb+=("aucune copie hors site du .env de moins de 48 h")
if [ ${#pb[@]} -eq 0 ]; then echo "=== TEST DE RESTAURATION RÉUSSI ==="; signal 0 "Restauration Jadip Flow testée le $(date +%F)"; exit 0
else echo "=== ÉCHEC : ${pb[*]} ==="; signal 1 "${pb[*]}"; exit 1; fi
