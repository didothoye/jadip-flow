# Déploiement sur le VPS

Conventions appliquées : conteneurs Docker, réseau externe `proxy-net`, **aucun port publié**, Nginx Proxy Manager (NPM) en frontal, DNS Cloudflare par l’API, sonde uptime-kuma, sauvegardes chiffrées hors serveur. Domaine : **flow.jadipservices.com** (.com uniquement — le script DNS refuse tout autre suffixe).

> Les chemins ci-dessous (`/opt/apps/jadip-flow`) sont indicatifs : adaptez-les à l’emplacement habituel de vos applications sur le VPS.

## 1. Récupérer le code

```bash
sudo mkdir -p /opt/apps && cd /opt/apps
git clone git@github.com:didothoye/jadip-flow.git
cd jadip-flow
```

## 2. Configurer les secrets

```bash
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# Générer les deux secrets :
openssl rand -hex 24      # → POSTGRES_PASSWORD (rôle propriétaire, migrations)
openssl rand -hex 24      # → APP_DB_PASSWORD (rôle applicatif restreint)
openssl rand -base64 32   # → APP_ENCRYPTION_KEY
```

Renseignez aussi SMTP (Zoho), `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID` (bot existant) et `ADMIN_NOTIFY_EMAIL`.

**Important** : conservez `APP_ENCRYPTION_KEY` dans votre gestionnaire de mots de passe. Sans elle, les clés API chiffrées (n8n, fournisseurs d’IA) sont illisibles, même avec une sauvegarde.

## 3. Construire et démarrer

```bash
cd deploy
docker network inspect proxy-net >/dev/null 2>&1 || docker network create proxy-net
docker compose build
docker compose up -d
docker compose ps                      # jadip-flow et jadip-flow-db « healthy »
docker exec jadip-flow node dist/cli.js create-admin vous@jadipservices.com "Votre nom"
```

La commande affiche un lien d’activation (valable 72 h) pour choisir votre mot de passe. Activez ensuite la double authentification dans « Mon compte ».

## 4. DNS Cloudflare

```bash
CF_API_TOKEN=… CF_ZONE_ID=… DNS_NAME=flow.jadipservices.com DNS_TARGET=<IP du VPS> \
  deploy/scripts/cloudflare-dns.sh
```

Le jeton Cloudflare doit avoir le droit `Zone → DNS → Edit` sur la zone jadipservices.com. L’enregistrement est créé en mode proxifié (orange) ; mettez `CF_PROXIED=false` si NPM doit obtenir le certificat par HTTP et que votre configuration l’exige.

## 5. Nginx Proxy Manager

```bash
NPM_URL=http://<nginx-proxy-manager>:81 NPM_EMAIL=… NPM_PASSWORD=… \
DNS_NAME=flow.jadipservices.com LE_EMAIL=… deploy/scripts/npm-proxy-host.sh
```

Le script crée l’hôte `flow.jadipservices.com → jadip-flow:3000` (réseau `proxy-net`), force HTTPS, active HTTP/2, HSTS et un certificat Let’s Encrypt. Il ne modifie jamais un hôte existant.

## 6. Sonde uptime-kuma

Ajoutez deux moniteurs :

1. **HTTP(s)** — `https://flow.jadipservices.com/healthz`, intervalle 60 s, mot-clé `"status":"ok"` (vérifie aussi la base).
2. **Push** — pour les sauvegardes : copiez l’URL fournie par uptime-kuma dans `BACKUP_PUSH_URL` (voir § 7), intervalle 26 h.

## 7. Sauvegardes chiffrées quotidiennes

Méthode recommandée : **age**, clé publique sur le serveur, clé privée hors serveur (gestionnaire de mots de passe).

```bash
age-keygen -o jadip-flow-backup.key      # sur VOTRE poste ou coffre : garder ce fichier hors du VPS
# copier la ligne « public key: age1… » dans la configuration de la tâche :
sudo tee /etc/jadip-flow-backup.env >/dev/null <<'CONF'
BACKUP_AGE_RECIPIENT=age1…
BACKUP_REMOTE=<remote rclone>:jadip-backups/jadip-flow
BACKUP_KEEP_DAYS=14
BACKUP_PUSH_URL=https://<uptime-kuma>/api/push/<jeton>
CONF
sudo chmod 600 /etc/jadip-flow-backup.env
# cron quotidien à 2 h 30
echo '30 2 * * * root set -a; . /etc/jadip-flow-backup.env; /opt/apps/jadip-flow/deploy/scripts/backup.sh >> /var/log/jadip-flow-backup.log 2>&1' | sudo tee /etc/cron.d/jadip-flow-backup
```

Contenu d’une sauvegarde : export PostgreSQL complet (`pg_dump -Fc`) + dossier `/data` (rapports, pièces jointes, logos) + manifeste, compressés puis chiffrés, avec somme SHA-256. Copie hors serveur par `rclone` (Backblaze B2, Google Drive, S3… selon votre configuration rclone existante). Le script refuse de produire une sauvegarde non chiffrée.

## 8. Restauration (testée)

Test sans risque (base jetable, la production n’est pas touchée) :

```bash
BACKUP_AGE_IDENTITY=/chemin/vers/jadip-flow-backup.key deploy/scripts/restore-test.sh
# → « Restauration testée … clients=… workflows=… exécutions=… chaîne d'audit intacte=t — SUCCÈS »
```

Restauration réelle (écrase la base de production) :

```bash
docker compose -f deploy/docker-compose.yml stop jadip-flow
BACKUP_AGE_IDENTITY=… deploy/scripts/restore.sh /var/backups/jadip-flow/jadip-flow-<date>.tgz.age --data-dir /tmp/jf-restore
docker run --rm --volumes-from jadip-flow -v /tmp/jf-restore:/restore alpine sh -c 'cp -a /restore/. /data/'
docker compose -f deploy/docker-compose.yml start jadip-flow
```

Cette procédure a été exécutée avec succès pendant le développement (age et gpg), voir `docs/livraison-v1.md`.

## 9. Mise à jour

```bash
cd /opt/apps/jadip-flow && git pull
cd deploy && docker compose build && docker compose up -d   # les migrations s’appliquent au démarrage
```

## 10. Démonstration (facultatif)

```bash
cd deploy && docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d
docker exec -e DEMO_N8N_URL=http://jadip-flow-demo-n8n:5678 -e DEMO_N8N_KEY=<DEMO_N8N_KEY> jadip-flow node dist/demo.js
```

Crée deux clients fictifs (« Boulangerie Kivu (démo) », « Cabinet Lumière (démo) »), une instance n8n de test, des comptes de démonstration (mot de passe `Demo2026Jadip`, à changer via `DEMO_PASSWORD`), des demandes, des coûts et des rapports. À ne pas charger sur la base de production réelle si vous ne souhaitez pas de données fictives ; supprimez ensuite les clients `demo-*` depuis l’interface (archivage) ou la base.
