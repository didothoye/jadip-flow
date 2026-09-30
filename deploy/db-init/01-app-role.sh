#!/bin/sh
# Crée le rôle applicatif restreint (exécuté une seule fois, à l'initialisation du volume PostgreSQL).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE jadip_flow_app LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO jadip_flow_app;
SQL
