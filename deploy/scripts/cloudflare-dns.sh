#!/usr/bin/env bash
# Crée ou met à jour l'enregistrement DNS du portail chez Cloudflare (API v4).
# Variables : CF_API_TOKEN (droit Zone.DNS:Edit), CF_ZONE_ID, DNS_NAME (ex. flow.jadipservices.com),
#             DNS_TARGET (IP du VPS pour un A, ou nom d'hôte pour un CNAME), DNS_TYPE (A|CNAME, défaut A), CF_PROXIED (true|false, défaut true)
set -euo pipefail
: "${CF_API_TOKEN:?}" "${CF_ZONE_ID:?}" "${DNS_NAME:?}" "${DNS_TARGET:?}"
DNS_TYPE="${DNS_TYPE:-A}"
CF_PROXIED="${CF_PROXIED:-true}"
case "$DNS_NAME" in *.com) ;; *) echo "Refus : seuls les domaines en .com sont autorisés ($DNS_NAME)" >&2; exit 1 ;; esac
API="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"
AUTH=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")
body=$(printf '{"type":"%s","name":"%s","content":"%s","ttl":1,"proxied":%s,"comment":"Jadip Flow"}' "$DNS_TYPE" "$DNS_NAME" "$DNS_TARGET" "$CF_PROXIED")
existing=$(curl -fsS "${AUTH[@]}" "${API}?type=${DNS_TYPE}&name=${DNS_NAME}" | sed -n 's/.*"result":\[{"id":"\([a-f0-9]*\)".*/\1/p')
if [ -n "$existing" ]; then
  curl -fsS -X PUT "${AUTH[@]}" "${API}/${existing}" --data "$body" >/dev/null && echo "Enregistrement mis à jour : $DNS_NAME → $DNS_TARGET"
else
  curl -fsS -X POST "${AUTH[@]}" "${API}" --data "$body" >/dev/null && echo "Enregistrement créé : $DNS_NAME → $DNS_TARGET"
fi
