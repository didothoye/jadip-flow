# Prompt — finaliser le déploiement de Jadip Flow depuis Claude Code (terminal local)

Tu reprends le déploiement en production de **Jadip Flow**, le portail de supervision des workflows n8n de Jadip Services. Le produit est entièrement développé et testé. Il reste à le **mettre en production sur mon VPS** et à le **brancher sur mes vraies données**, jusqu'à la livraison finale.

## Accès et règles de travail

- Le VPS est accessible par **`ssh jadip`** (Ubuntu 24.04, utilisateur root). **Tout le travail se fait sur le VPS, via ssh** : n'installe rien, ne clone rien et ne stocke aucun secret sur mon ordinateur.
- Dépôt GitHub privé : `didothoye/jadip-flow`, branche **`claude/relaxed-newton-temyiq`**. Le VPS y a un accès **en lecture seule** par clé de déploiement, avec l'alias SSH `github-jadip-flow` (URL `git@github-jadip-flow:didothoye/jadip-flow.git`).
- Si une correction de code est nécessaire, demande-moi d'abord d'activer « Allow write access » sur la clé de déploiement « VPS Jadip ». Fais ensuite la correction dans `/srv/apps/jadip-flow`, relance les tests (`cd server && npm test` dans un conteneur `node:22`, avec une base PostgreSQL de test jetable), puis commite et pousse sur la même branche. Messages de commit clairs, en français.
- **Jamais de secret affiché** : pas de `cat .env`, pas d'`env`, pas de jeton dans tes réponses ni dans le dépôt. Pour vérifier une variable, teste seulement si elle est renseignée : `grep -c '^SMTP_PASS=.\+' deploy/.env`.
- **Ne touche à aucune autre application** du VPS : n8n, NPM, mbongo, siga, jadipconnect, typebot, evolution, etc. Pour NPM et Cloudflare, tu ne fais qu'**ajouter** un hôte et un enregistrement.
- Mémoire limitée : 2 CPU, environ 3 Go de RAM libre. Les limites mémoire sont déjà dans `deploy/docker-compose.yml`. Surveille `free -h` pendant la construction de l'image.
- Formats français, domaines en `.com` uniquement.
- Tu ne me rends la main que pour une décision métier, un accès ou une clé manquants, ou à la livraison.

## Ce que je sais déjà du VPS

- Applications dans **`/srv/apps/<nom>`**, avec un modèle dans `/srv/apps/_modele` et des conventions dans `/srv/apps/README.md`. **Lis-les d'abord et respecte-les.** Documentation d'exploitation dans `/srv/vps-ops`, synchronisée chaque jour par `/root/vps-ops-sync.sh` : ajoute-y Jadip Flow selon la convention en place.
- Réseau Docker **`proxy-net`**. Nginx Proxy Manager : conteneur `root-nginx-proxy-manager-1`, interface d'administration sur `127.0.0.1:81`.
- **n8n en mode queue** : `root-n8n-1` (version 2.41.3) plus `n8n-worker-1` et `n8n-worker-2`, Redis `n8n-redis`, base `n8n-postgres`. Depuis Jadip Flow, l'API n8n est joignable à **`http://root-n8n-1:5678`**.
- Outils existants à **réutiliser** : `/root/cf-api.sh` (API Cloudflare), `/root/npm-api.sh` (API NPM), `/usr/local/bin/kuma-signal` (signal « push » vers uptime-kuma), uptime-kuma dans le conteneur `uptime-kuma`.
- Sauvegardes existantes : `rclone` avec les distants `b2:` et `b2-crypt:`, `gpg` présent (`age` absent), scripts `/root/backup_all.sh`, `/root/backup-offsite.sh` et `/root/test_restauration_*.sh`, tâches cron avec `kuma-signal`.

## État du projet

- Le code, la documentation (`README.md`, `docs/`) et le rapport de livraison (`docs/livraison-v1.md`) sont dans le dépôt. Lis `docs/deploiement.md`, `docs/procedure-instance-client.md` et `docs/securite.md`.
- Le script d'installation idempotent **`deploy/scripts/vps-install.sh`** fait le travail suivant :
  - il récupère le code dans `/srv/apps/jadip-flow` ;
  - il génère les secrets sur place, dans `deploy/.env` en chmod 600 ;
  - il construit l'image et démarre les conteneurs `jadip-flow` et `jadip-flow-db` sur `proxy-net`, sans port publié ;
  - il vérifie la santé de l'application ;
  - il crée l'administrateur (`ADMIN_EMAIL`) et charge la démonstration si `DEMO=1`.
- La base utilise deux rôles : un rôle propriétaire pour les migrations et un rôle restreint `jadip_flow_app` pour l'application (journal d'audit inaltérable).

## Étapes à réaliser, dans l'ordre

1. **Conventions** : lis `/srv/apps/README.md` et `/srv/apps/_modele`, puis adapte si nécessaire (emplacement du fichier compose, étiquettes, nommage, documentation dans `/srv/vps-ops`).
2. **Installation** :
   ```bash
   ssh jadip 'test -d /srv/apps/jadip-flow/.git || git clone -q -b claude/relaxed-newton-temyiq git@github-jadip-flow:didothoye/jadip-flow.git /srv/apps/jadip-flow; ADMIN_EMAIL=<mon e-mail> ADMIN_NAME="Jadip Services" DEMO=1 bash /srv/apps/jadip-flow/deploy/scripts/vps-install.sh'
   ```
   Demande-moi l'adresse e-mail de l'administrateur si tu ne la connais pas. Conserve le lien d'activation affiché et donne-le-moi à la fin.
3. **Secrets fonctionnels** dans `/srv/apps/jadip-flow/deploy/.env` :
   - SMTP Zoho (`SMTP_USER`, `SMTP_PASS`) ;
   - `TELEGRAM_BOT_TOKEN` et `TELEGRAM_ADMIN_CHAT_ID` (mon bot existant) ;
   - `ADMIN_NOTIFY_EMAIL`.

   Si ces valeurs existent déjà dans la configuration d'une autre de mes applications, **demande-moi l'autorisation** avant de les reprendre, puis copie-les sans les afficher. Sinon, dis-moi quoi saisir et où. Redémarre ensuite avec `docker compose up -d` dans `deploy/`.
4. **DNS** : ajoute `flow.jadipservices.com` chez Cloudflare vers l'IP du VPS, avec `/root/cf-api.sh` ou `deploy/scripts/cloudflare-dns.sh`. Suis le même mode (proxifié ou non) que mes autres sous-domaines.
5. **Nginx Proxy Manager** : crée l'hôte `flow.jadipservices.com → jadip-flow:3000` avec certificat Let's Encrypt, HTTPS forcé, HTTP/2, HSTS et `client_max_body_size 55m`. Utilise `/root/npm-api.sh` ou `deploy/scripts/npm-proxy-host.sh`, en suivant les réglages de mes autres hôtes. Vérifie ensuite `https://flow.jadipservices.com/healthz`.
6. **uptime-kuma** :
   - un moniteur HTTP sur `https://flow.jadipservices.com/healthz` (mot-clé `"status":"ok"`) ;
   - un moniteur push `backup_jadip_flow` pour la sauvegarde ;
   - un moniteur push `restauration_test_jadip_flow` pour le test de restauration.

   Fais comme pour mes autres moniteurs. Si c'est impossible par script, donne-moi les réglages exacts à saisir.
7. **Sauvegardes** : intègre Jadip Flow à mon dispositif existant.
   - Chiffrement gpg avec une phrase secrète générée dans un fichier root en chmod 600. Demande-moi de la copier dans mon gestionnaire de mots de passe, sans jamais l'afficher.
   - Copie vers `b2-crypt:`, dans un dossier cohérent avec mes autres sauvegardes.
   - Cron quotidien avec `kuma-signal`, et test de restauration automatique (`deploy/scripts/restore-test.sh`) deux fois par mois, sur le modèle de mes `test_restauration_*.sh`.
   - Lance une sauvegarde puis un test de restauration immédiatement, et vérifie le **SUCCÈS**.
8. **Test de la démonstration**, avec Playwright dans un conteneur sur le VPS ou avec `curl`, sur l'URL publique :
   - connexion agence (`demo-agence@jadipservices.com`) ;
   - connexion client A (`aline@kivu.example`) et client B (`patrick@lumiere.example`), mot de passe `Demo2026Jadip` ;
   - vérifie le cloisonnement : A ne voit rien de B ;
   - envoie une alerte de test sur Telegram (Paramètres → Envoyer un test, ou l'API) ;
   - envoie un e-mail de test.

   Puis **mets en pause pour que je teste moi-même** : donne-moi le lien d'activation administrateur, les comptes de démonstration et une liste de 10 points à vérifier. **Attends ma validation** avant l'étape 9.
9. **Branchement réel**, après ma validation :
   - demande-moi une clé API n8n (Settings → n8n API), ajoute l'instance `http://root-n8n-1:5678` avec l'URL publique de mon n8n, puis lance la synchronisation ;
   - crée les clients réels **Amani, Mosolo, PABEA, Grace** et le client « Interne ». Propose-moi les codes (par exemple `amani`, `mosolo`, `pabea`, `grace`) et le rattachement de chaque workflow existant. Après mon accord, pose les étiquettes `client:<code>` avec l'API n8n (`PUT /api/v1/workflows/{id}/tags`), sans modifier autre chose dans les workflows ;
   - rédige un brouillon de description simple pour chaque workflow de client, à partir de son nom et de ses nœuds, que je relirai ;
   - archive ou supprime les clients `demo-*` et arrête le conteneur `jadip-flow-demo-n8n`, **seulement si je le confirme**.
10. **Coûts IA** : demande-moi les clés d'administration OpenAI, Anthropic et OpenRouter. Je les saisirai moi-même dans l'interface (Coûts IA → Comptes fournisseurs). Aide-moi ensuite à attribuer les coûts aux clients.
11. **Livraison finale** : mets à jour `docs/livraison-v1.md` (section « Mise en production ») avec ce qui a été fait, les vérifications, les réglages choisis et ce qui reste de mon côté. Commite, puis donne-moi un récapitulatif court.

En cas d'échec, diagnostique avec `docker logs --tail 100 jadip-flow` et `docker compose ps`, corrige, puis réessaie. Ne contourne jamais une vérification de sécurité.
