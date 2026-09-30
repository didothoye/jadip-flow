#!/usr/bin/env bash
# Test de restauration : restaure la dernière sauvegarde dans une base TEMPORAIRE et vérifie son contenu,
# sans toucher à la production. À lancer chaque semaine (cron) ou après chaque changement de procédure.
# Variables : comme restore.sh ; TEST_PG (commande psql vers un serveur de test, défaut : conteneur postgres jetable)
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/var/backups/jadip-flow}"
latest="${1:-$(ls -1t "$BACKUP_DIR"/jadip-flow-*.tgz.* 2>/dev/null | grep -v sha256 | head -1)}"
[ -n "$latest" ] || { echo "Aucune sauvegarde trouvée" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
cleanup() { [ -n "${cid:-}" ] && docker rm -f "$cid" >/dev/null 2>&1 || true; rm -rf "${tmpdata:-}"; }
trap cleanup EXIT
if [ -z "${TEST_PSQL:-}" ]; then
  cid=$(docker run -d --rm -e POSTGRES_PASSWORD=restoretest -e POSTGRES_DB=restore_test postgres:16-alpine)
  for _ in $(seq 1 30); do docker exec "$cid" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  TEST_PSQL="docker exec -i $cid psql -U postgres -d restore_test -tA"
  export PG_RESTORE="docker exec -i $cid pg_restore -U postgres -d restore_test --no-owner"
fi
tmpdata=$(mktemp -d)
"$here/restore.sh" "$latest" --data-dir "$tmpdata"
check() { echo "$1" | $TEST_PSQL; }
clients=$(check "SELECT count(*) FROM clients")
workflows=$(check "SELECT count(*) FROM workflows")
executions=$(check "SELECT count(*) FROM executions")
audit_ok=$(check "SELECT count(*) = 0 FROM (SELECT id, prev_hash, lag(hash) OVER (ORDER BY id) AS expected FROM audit_log) t WHERE id > (SELECT min(id) FROM audit_log) AND prev_hash <> expected")
files=$(find "$tmpdata" -type f | wc -l)
echo "Restauration testée depuis $(basename "$latest") : clients=$clients workflows=$workflows exécutions=$executions fichiers=$files chaîne d'audit intacte=$audit_ok"
[ "$clients" -ge 1 ] && [ "$audit_ok" = "t" ] || { echo "ÉCHEC du test de restauration" >&2; exit 1; }
echo "SUCCÈS"
