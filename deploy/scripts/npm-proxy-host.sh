#!/usr/bin/env bash
# Déclare l'hôte du portail dans Nginx Proxy Manager (API NPM) avec certificat Let's Encrypt.
# Variables : NPM_URL (ex. http://nginx-proxy-manager:81), NPM_EMAIL, NPM_PASSWORD, DNS_NAME, LE_EMAIL
#             FORWARD_HOST (défaut jadip-flow), FORWARD_PORT (défaut 3000)
set -euo pipefail
: "${NPM_URL:?}" "${NPM_EMAIL:?}" "${NPM_PASSWORD:?}" "${DNS_NAME:?}" "${LE_EMAIL:?}"
FORWARD_HOST="${FORWARD_HOST:-jadip-flow}"
FORWARD_PORT="${FORWARD_PORT:-3000}"
token=$(curl -fsS -X POST "$NPM_URL/api/tokens" -H 'Content-Type: application/json' \
  --data "$(printf '{"identity":"%s","secret":"%s"}' "$NPM_EMAIL" "$NPM_PASSWORD")" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || { echo "Connexion à NPM impossible" >&2; exit 1; }
AUTH=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')
if curl -fsS "${AUTH[@]}" "$NPM_URL/api/nginx/proxy-hosts" | grep -q "\"$DNS_NAME\""; then
  echo "L'hôte $DNS_NAME existe déjà dans NPM (aucune modification)."
  exit 0
fi
# en-têtes de sécurité complémentaires
adv='add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\nclient_max_body_size 55m;'
curl -fsS -X POST "${AUTH[@]}" "$NPM_URL/api/nginx/proxy-hosts" --data "$(cat <<JSON
{"domain_names":["$DNS_NAME"],"forward_scheme":"http","forward_host":"$FORWARD_HOST","forward_port":$FORWARD_PORT,
 "access_list_id":0,"certificate_id":"new","ssl_forced":true,"http2_support":true,"hsts_enabled":true,"hsts_subdomains":false,
 "block_exploits":true,"caching_enabled":false,"allow_websocket_upgrade":true,"advanced_config":"$adv",
 "meta":{"letsencrypt_email":"$LE_EMAIL","letsencrypt_agree":true,"dns_challenge":false},"locations":[]}
JSON
)" >/dev/null
echo "Hôte $DNS_NAME créé dans NPM → $FORWARD_HOST:$FORWARD_PORT (certificat Let's Encrypt demandé)."
