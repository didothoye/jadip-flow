# Rapport de livraison — Jadip Flow v1

Date : 30 septembre 2026, mise en production le 1er octobre 2026 · Dépôt : `didothoye/jadip-flow`, branche `claude/relaxed-newton-temyiq`.

## État en une phrase

Les quatre phases sont développées, testées et **en production depuis le 1er octobre 2026** sur https://flow.jadipservices.com, branchées sur votre vrai n8n (68 workflows), avec alertes Telegram et e-mail, sauvegardes chiffrées hors site et sondes de supervision. La démonstration est retirée.

## Où le travail a été fait

Le développement, les tests, la construction et l’exécution de la pile Docker ont eu lieu dans un conteneur cloud éphémère (Claude Code sur le web), jamais sur votre ordinateur. Rien n’a été installé sur une machine locale. Tout est poussé dans le dépôt, commit par commit.

## Ce qui est livré, par phase

### Phase 1 — Connexion à n8n et supervision
- Plusieurs instances n8n : URL + clé API chiffrée (AES-256-GCM, jamais réaffichée), test de connexion, santé, URL publique pour les liens « Ouvrir dans n8n ».
- Synchronisation toutes les 5 min (réglable par instance) et manuelle : workflows (nom, actif, étiquettes, dates), exécutions (statut, durée, dates, nœud en erreur, message tronqué), **métadonnées seulement** (test dédié). Pagination, conservation réglable, purge automatique.
- Détection des workflows nouveaux, renommés, supprimés (événements et notification) ; journal des synchronisations ; alerte si la synchronisation échoue.
- Clients : fiche, logo, rattachement par étiquette `client:<code>` et/ou manuel (le manuel prime), client « Interne ». Une instance ↔ plusieurs clients et inversement.
- Tableau de bord agence, fiche client, fiche workflow (courbes, exécutions filtrables, erreurs avec nœud fautif, lien n8n, description humaine, temps gagné par exécution).
- Erreurs classées automatiquement : authentification, limite de débit, réseau, données, logique.
- Actions : activer / désactiver (confirmation + journal), relance d’une exécution en échec si n8n le permet, « marquer comme traitée », verrou « critique ».
- Alertes configurables (échec avec regroupement anti-bruit et répétition, inactivité, taux d’échec, synchronisation, budget IA), Telegram / e-mail / application, horaires calmes, par client ou globales.

### Phase 2 — Coûts d’IA et rapports
- Connecteurs OpenAI (Costs API), Anthropic (Admin API cost_report), OpenRouter (usage par clé de provisionnement), récupération toutes les 6 h ; attribution par projet / espace de travail / clé / modèle, réattribution rétroactive ; saisie manuelle ; estimation par exécution.
- Coûts par client, workflow, modèle, jour ; budget par client avec alerte.
- Rapports mensuels PDF et Excel (fond blanc, bordures simples, Times New Roman 12, en-tête Jadip Services, capitalisation française), envoi automatique le 1er du mois aux clients qui l’ont activé ; tableau de rentabilité (facturation vs coût IA).

### Phase 3 — Espace client
- Comptes créés par vous, invitation par e-mail (lien d’activation 7 jours), double authentification optionnelle, mot de passe oublié.
- Cloisonnement côté serveur sur chaque route, testé (client A → ressources de B : refusé ; balayage automatique de toutes les routes agence).
- « Vos automatisations » : bandeau d’état, cartes (nom lisible, description, état, dernier passage, réussite 30 j, temps gagné), fiche avec historique et incidents expliqués en français simple, coûts et budget (si autorisé), rapports téléchargeables.
- Actions : activer / désactiver (sauf verrouillé), pause 1 h / 24 h / 7 jours avec reprise automatique, relance (si autorisée), demandes avec pièces jointes (notifiées sur votre Telegram), suivi des statuts, préférences de notification, résumé hebdomadaire.
- Chaque action client est journalisée et vous est notifiée. Responsive, PWA installable.
- Préparé sans l’activer : colonnes `brand_*` (marque blanche) et `billing_*` (abonnement) sur les clients.

### Phase 4 — Intégrations et exploitation
- API REST v1 documentée (OpenAPI sur `/api/docs`), jetons par utilisateur (lecture / actions), limitation de débit, journalisation.
- Webhooks sortants signés HMAC (erreur, workflow désactivé par un client, demande créée…), avec nouvelles tentatives.
- Serveur MCP en lecture (`/mcp`) pour Claude Code, chaque appel journalisé.
- Sauvegardes chiffrées quotidiennes (age ou gpg) avec copie hors serveur (rclone), **restauration testée** trois fois (base locale, conteneur jetable, restauration réelle dans la pile Compose).
- Journal d’audit inaltérable : chaîne SHA-256, déclencheurs, et rôle base de données restreint (l’application elle-même ne peut ni modifier ni effacer le journal — testé).
- Performances mesurées sur 100 000 exécutions : pages de liste en 2 à 5 ms, tableaux de bord entre 30 et 150 ms (voir `performances.md`).
- Documentation : guide agence, guide client (français simple), procédure instance + client, déploiement, API, sécurité.

## Captures

Dans `docs/captures/` : tableau de bord agence (bureau et mobile), fiche client, fiche workflow et « Présentation au client », coûts, erreurs, instances, workflows (mobile), connexion (mobile), et côté client : accueil des deux clients de démonstration (bureau et mobile), fiche d’automatisation, dialogue de pause, coûts, rapports, demandes, nouvelle demande, conversation.

## Jeu de démonstration

`node dist/demo.js` (ou `tools/dev-demo.sh` en développement) avec l’instance n8n de test fournie (`tools/fake-n8n`, API n8n v1 simulée, activité continue) :
- **Boulangerie Kivu (démo)** — coûts visibles, relance autorisée, budget et facturation renseignés ;
- **Cabinet Lumière (démo)** — coûts masqués, relance non autorisée, un workflow inactif ;
- comptes `demo-agence@jadipservices.com`, `aline@kivu.example`, `patrick@lumiere.example` (mot de passe `Demo2026Jadip`, modifiable via `DEMO_PASSWORD`).

En production, la démonstration a servi à la recette du 30 septembre puis a été **retirée le 1er octobre** : instance « n8n de démonstration » supprimée, clients `demo-kivu` et `demo-lumiere` archivés, les trois comptes de démonstration désactivés, conteneur `jadip-flow-demo-n8n` supprimé (sauvegarde prise juste avant).

## Choix que j’ai tranchés seul

| Sujet | Choix | Raison |
|---|---|---|
| Stack | Node.js 22 + TypeScript + Fastify, PostgreSQL 16, React + Vite | Durable, un seul langage, image unique ; conforme à « backend + PostgreSQL + interface responsive ». |
| Domaine | `flow.jadipservices.com` | Plus court et plus parlant pour les clients que `portail.` ; modifiable dans `brand.config.json` et `.env`. |
| Fuseau et devise | Africa/Kinshasa ; montants en dollars US | Fuseau des clients ; les fournisseurs d’IA facturent en USD. |
| Erreurs côté client | Explication simple par catégorie, jamais le message technique | Vocabulaire non technique, et aucune fuite de données. |
| Anti-bruit | 1re notification immédiate, regroupement des suivantes (15 min), rappel des alertes persistantes (4 h par défaut) ; résolution automatique après un succès | Réactif sans spammer ; réglable par règle. |
| Horaires calmes | 22 h – 7 h, messages différés à la fin de la plage, sauf alertes critiques | Une panne critique doit vous réveiller. |
| Relance | Via `POST /executions/{id}/retry` de l’API n8n ; si votre version ne l’expose pas, message clair et relance depuis n8n | L’API publique n’offre la relance que sur les versions récentes. |
| Première synchronisation | 20 000 exécutions récentes au plus, conservation 90 jours | Évite de surcharger n8n ; réglable. |
| Coûts OpenRouter | Delta quotidien de l’usage cumulé par clé | C’est la seule donnée fiable par clé exposée par OpenRouter. |
| Sauvegardes | age (clé publique sur le serveur, clé privée hors serveur) ; gpg possible | Une compromission du VPS ne permet pas de lire les sauvegardes. |
| Rôle base | Rôle propriétaire pour les migrations, rôle restreint pour l’application | Rend le journal d’audit réellement inaltérable pour l’application. |
| Clients « à risque » | Aucune exécution depuis N jours (3 par défaut, réglable par client), > 20 % d’échecs sur 7 jours (au moins 5 exécutions), budget IA dépassé | Seuils raisonnables ; réglables dans Paramètres. |

## Mise en production (30 septembre – 1er octobre 2026)

### Ce qui a été fait

| Élément | Réglage en production |
|---|---|
| Installation | `/srv/apps/jadip-flow` (dépôt cloné, clé de déploiement GitHub), `deploy/scripts/vps-install.sh` ; conteneurs `jadip-flow` et `jadip-flow-db` sur `proxy-net`, aucun port publié, limites mémoire du compose. |
| Administrateur | `contact@jadipservices.com` (activation par lien, double authentification proposée). |
| DNS | `flow.jadipservices.com` chez Cloudflare, proxifié comme les autres sous-domaines. |
| Proxy | Hôte Nginx Proxy Manager n° 42 → `jadip-flow:3000`, Let’s Encrypt, HTTPS forcé, HTTP/2, HSTS, `client_max_body_size 55m`. |
| Supervision | uptime-kuma : 32 « Jadip Flow » (HTTP `/healthz`, mot-clé `"status":"ok"`), 33 `backup_jadip_flow` (push), 34 `restauration_test_jadip_flow` (push). |
| Sauvegardes | `/root/backup_jadip_flow.sh`, chaque jour à 03:15 : base + volume chiffrés gpg (phrase `/root/.jadip-flow-backup.gpgpass`, 600), 14 jours en local, copie hors site `b2-crypt:jadip-flow` ; `.env` et phrase copiés vers `b2-crypt:secrets/jadip-flow`. Test de restauration automatique les 3 et 17 du mois à 05:30 (`/root/test_restauration_jadip_flow.sh`). Copies versionnées dans `deploy/vps/`. |
| E-mail | Zoho ZeptoMail, agent « jadip » : `smtp.zeptomail.com:465` SSL, expéditeur exact `Jadip Flow <notification@jadipservices.com>` ; alertes vers `ADMIN_NOTIFY_EMAIL` (votre Gmail). |
| Telegram | Bot existant (celui de Mosolo) et votre discussion d’administration. |
| n8n | Instance « n8n Jadip Services » (`http://root-n8n-1:5678`), clé API chiffrée dans l’application ; 68 workflows synchronisés, tous étiquetés `client:interne` (pas encore de clients réels, à votre demande). |
| Interface | Nouveau design (palette Indigo, police Inter, thème sombre). |
| Exploitation | Documenté dans `/srv/vps-ops` (synchronisation quotidienne ; seuls les fichiers compose de Jadip Flow y sont copiés, le code vit dans ce dépôt). |

### Vérifications faites

- `https://flow.jadipservices.com/healthz` : `"status":"ok"` ; conteneurs en bonne santé.
- Démonstration testée sur l’URL publique : connexion agence et clients, cloisonnement (le client A ne voit rien du client B), alerte Telegram de test.
- E-mail réel envoyé par l’application (`sendEmailNow`) et reçu en boîte de réception (SPF, DKIM, DMARC alignés).
- Sauvegarde chiffrée, copie hors site, puis **test de restauration réussi** ; sauvegarde quotidienne du 1er octobre réussie.
- Synchronisation du vrai n8n : santé « ok », dernière synchronisation en succès.

### Ce qui reste de votre côté

1. **Coûts IA** : saisir vous-même les clés d’administration OpenAI, Anthropic et OpenRouter (Coûts IA → Comptes fournisseurs), puis attribuer les coûts aux clients.
2. **Clients réels** (Amani, Mosolo, PABEA, Grace) quand vous serez prêt : créer les fiches, poser les étiquettes `client:<code>` sur les workflows, inviter les contacts, rédiger les descriptions.
3. **Alertes ouvertes** au 1er octobre : 27 workflows sans exécution récente et des échecs répétés d’« AGS Agent RAG » ; à trier (désactiver dans n8n ce qui ne sert plus, ou ajuster les seuils).
4. Conserver la phrase de sauvegarde gpg et `APP_ENCRYPTION_KEY` dans votre gestionnaire de mots de passe (elles sont aussi copiées chiffrées hors site).
5. Supprimer dans ZeptoMail l’agent « Jadip_flow », inutilisé ; envisager un bot Telegram dédié à Jadip Flow.

## Ce qui restait à faire de votre côté (avant la mise en production)

1. **Donner le GO de mise en production** et un moyen d’accès au VPS (ou lancer vous-même la procédure `docs/deploiement.md`, environ 15 minutes).
2. Renseigner `deploy/.env` : secrets générés, SMTP Zoho, bot Telegram (jeton + votre identifiant de discussion), e-mail d’alerte.
3. Jeton Cloudflare (Zone DNS : Edit) et identifiants Nginx Proxy Manager pour les deux scripts ; moniteurs uptime-kuma (HTTP + push sauvegarde).
4. Générer la clé age de sauvegarde **hors du VPS**, configurer le remote rclone et la tâche cron ; conserver `APP_ENCRYPTION_KEY` dans votre gestionnaire de mots de passe.
5. Créer une clé API dans votre n8n (mode queue), ajouter l’instance, puis étiqueter vos workflows : `client:amani`, `client:mosolo`, `client:pabea`, `client:grace`, `client:interne` (codes à confirmer), et rédiger les descriptions « client ».
6. Clés d’administration des fournisseurs d’IA : OpenAI (*Admin key*), Anthropic (*Admin API key*), OpenRouter (*provisioning key*). Idéalement un projet / espace de travail / clé par client.
7. Comptes clients réels : invitations depuis chaque fiche client, facturation mensuelle et budgets pour la rentabilité.
8. Vérifier sur votre n8n que la relance via l’API est disponible (sinon le portail l’indique proprement).

## Ce que vous devez vérifier

- Connexion avec la double authentification, puis le parcours d’un client de démonstration (5 secondes pour comprendre l’état).
- Les rapports PDF et Excel générés correspondent à vos règles de mise en forme (exemples dans la démo, menu Rapports).
- La liste de vos codes clients et les seuils d’alerte par défaut.
- Après la mise en production : un test de restauration (`restore-test.sh`), et la réception d’une alerte Telegram (bouton « Envoyer un test » dans Paramètres).

## Limites connues

- Le titre des alertes « Aucune exécution depuis — jour(s) » n’affiche pas le nombre de jours (valeur manquante dans le libellé) : à corriger.

- Le journal d’audit peut toujours être altéré par un accès administrateur direct au serveur PostgreSQL (hors application) ; la copie chiffrée hors serveur en garde la trace.
- La marque blanche et la facturation par client sont préparées en base, mais pas activées.
- La construction de l’image Docker n’a pas pu télécharger les paquets npm depuis le conteneur de développement (réseau restreint) : l’image a été assemblée à partir des mêmes fichiers compilés localement et la pile complète a tourné. Sur votre VPS, `docker compose build` télécharge normalement.
