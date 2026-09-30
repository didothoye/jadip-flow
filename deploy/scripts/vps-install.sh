#!/usr/bin/env bash
# Installation / mise à jour de Jadip Flow sur le VPS (idempotent).
# Usage (depuis votre ordinateur) :
#   ssh jadip 'bash -s' < deploy/scripts/vps-install.sh                       # installe ou met à jour
#   ssh jadip 'ADMIN_EMAIL=vous@jadipservices.com bash -s' < deploy/scripts/vps-install.sh   # + crée votre compte administrateur
# Variables : APP_DIR (défaut /opt/apps/jadip-flow), GIT_REF (branche), PUBLIC_URL, ADMIN_EMAIL, ADMIN_NAME, DEMO=1 (charger la démo)
# Les secrets sont générés SUR le VPS, dans deploy/.env (chmod 600), et ne sont jamais affichés.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/apps/jadip-flow}"
GIT_REF="${GIT_REF:-claude/relaxed-newton-temyiq}"
REPO="${REPO:-git@github.com:didothoye/jadip-flow.git}"
PUBLIC_URL="${PUBLIC_URL:-https://flow.jadipservices.com}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "▶ Code source ($GIT_REF) dans $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$GIT_REF" && git -C "$APP_DIR" checkout -q "$GIT_REF" && git -C "$APP_DIR" reset -q --hard "origin/$GIT_REF"
else
  $SUDO mkdir -p "$(dirname "$APP_DIR")" && $SUDO chown "$(id -un)" "$(dirname "$APP_DIR")"
  git clone -q --branch "$GIT_REF" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR/deploy"

if [ ! -f .env ]; then
  echo "▶ Création de deploy/.env (secrets générés sur place)"
  umask 077
  sed -e "s#^PUBLIC_URL=.*#PUBLIC_URL=$PUBLIC_URL#" \
      -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$(openssl rand -hex 24)#" \
      -e "s#^APP_DB_PASSWORD=.*#APP_DB_PASSWORD=$(openssl rand -hex 24)#" \
      -e "s#^APP_ENCRYPTION_KEY=.*#APP_ENCRYPTION_KEY=$(openssl rand -base64 32)#" \
      -e "s#^DEMO_N8N_KEY=.*#DEMO_N8N_KEY=$(openssl rand -hex 16)#" .env.example > .env
  echo "  ⚠ Sauvegardez APP_ENCRYPTION_KEY (dans $APP_DIR/deploy/.env) dans votre gestionnaire de mots de passe."
  echo "  ⚠ Complétez ensuite SMTP_*, TELEGRAM_* et ADMIN_NOTIFY_EMAIL dans ce fichier."
else
  echo "▶ deploy/.env existant conservé"
fi

docker network inspect proxy-net >/dev/null 2>&1 || { echo "▶ Création du réseau proxy-net"; docker network create proxy-net >/dev/null; }

FILES=(-f docker-compose.yml); [ "${DEMO:-0}" = "1" ] && FILES+=(-f docker-compose.demo.yml)
echo "▶ Construction de l'image (quelques minutes la première fois)"
docker compose "${FILES[@]}" build --pull -q
echo "▶ Démarrage"
docker compose "${FILES[@]}" up -d
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' jadip-flow 2>/dev/null)" = "healthy" ] && break; sleep 2
done
docker compose "${FILES[@]}" ps --format '{{.Name}} : {{.Status}}'
[ "$(docker inspect -f '{{.State.Health.Status}}' jadip-flow)" = "healthy" ] || { echo "✖ jadip-flow n'est pas en bonne santé :"; docker logs --tail 40 jadip-flow; exit 1; }

if [ -n "${ADMIN_EMAIL:-}" ]; then
  echo "▶ Compte administrateur"
  docker exec jadip-flow node dist/cli.js create-admin "$ADMIN_EMAIL" "${ADMIN_NAME:-Administrateur}"
fi
if [ "${DEMO:-0}" = "1" ]; then
  echo "▶ Jeu de démonstration"
  key=$(grep '^DEMO_N8N_KEY=' .env | cut -d= -f2)
  docker exec -e DEMO_N8N_URL=http://jadip-flow-demo-n8n:5678 -e DEMO_N8N_KEY="$key" jadip-flow node dist/demo.js | tail -5
fi
echo "✔ Jadip Flow tourne (réseau proxy-net, aucun port publié). Étapes suivantes : DNS Cloudflare, hôte NPM, uptime-kuma, sauvegardes (docs/deploiement.md)."
