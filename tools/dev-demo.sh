#!/bin/bash
# Lancement local : faux n8n + base démo + serveur (sert aussi web/dist)
cd /home/user/jadip-flow
pkill -f fake-n8n.mjs 2>/dev/null; pkill -f "tsx src/index.ts" 2>/dev/null
PGPASSWORD=jadip psql -h localhost -U jadip jadip_flow -qc 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' 2>/dev/null
(cd tools/fake-n8n && PORT=5678 API_KEY=demo-key nohup node fake-n8n.mjs > /tmp/fake-n8n.log 2>&1 &)
sleep 1
export DATABASE_URL=postgres://jadip:jadip@localhost:5432/jadip_flow APP_ENCRYPTION_KEY=$(echo -n 0123456789abcdef0123456789abcdef | base64) DATA_DIR=/tmp/jf-data WEB_DIR=/home/user/jadip-flow/web/dist PUBLIC_URL=http://localhost:3000
cd server && npx tsx src/demo.ts && (nohup npx tsx src/index.ts > /tmp/jf-server.log 2>&1 &)
sleep 4; curl -s localhost:3000/healthz
