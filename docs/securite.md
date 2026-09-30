# Sécurité et cloisonnement

## Cloisonnement des clients (côté serveur)

- L’identifiant du client d’un utilisateur provient **toujours de sa session** (ou de son jeton), jamais de la requête.
- Chaque route du portail vérifie l’appartenance de la ressource (workflow, exécution, rapport, demande, pièce jointe, logo) au client connecté ; une ressource d’un autre client répond « introuvable » (404), sans révéler son existence.
- Les routes agence exigent le rôle administrateur. Un test balaie **automatiquement toutes les routes `/api/admin/*`** avec un compte client et exige un refus (403).
- Tests dédiés « client A tente d’atteindre B » : consultation, activation, pause, relance, rapports, demandes, pièces jointes, logo, notifications — tous refusés (`server/test/phase3.test.ts`, `phase4.test.ts` pour l’API et le MCP).
- Les workflows marqués « non visibles » n’apparaissent nulle part côté client.

## Données

- Seules les métadonnées d’exécution sont importées ; la liste des workflows est lue sans les nœuds ni les données épinglées ; le détail d’une exécution en échec n’est lu que pour en extraire le nom du nœud et le message (tronqué à 1 000 caractères). Un test vérifie qu’aucune donnée traitée ni configuration de nœud n’est stockée.
- Le client ne voit jamais le message technique d’une erreur, seulement une explication simple.

## Secrets

- Clés API n8n et fournisseurs d’IA, secrets de webhooks, secrets 2FA : chiffrés **AES-256-GCM** avec la clé maîtresse `APP_ENCRYPTION_KEY` (variable d’environnement, jamais dans le dépôt). Jamais renvoyés par l’API (seulement « ••••1234 »).
- Mots de passe : **Argon2id**. Jetons d’API, de session, d’invitation et de réinitialisation : stockés hachés (SHA-256).
- Journaux du serveur : en-têtes `Authorization`, `Cookie` et `X-N8N-API-KEY` masqués.

## Authentification

- Sessions par cookie `HttpOnly`, `Secure`, `SameSite=Lax`, 14 jours ; en-tête anti-CSRF obligatoire sur toute requête modifiante.
- Double authentification TOTP optionnelle ; invitation par lien à usage unique (7 jours) ; réinitialisation (2 heures) sans révéler l’existence d’un compte.
- Limitation de débit : connexion (10 essais / 5 min / IP), API (120 / min / jeton), global (600 / min / IP).
- En-têtes de sécurité (Helmet) : CSP stricte, `frame-ancestors 'none'`, HSTS côté NPM.

## Journal d’audit inaltérable

Table `audit_log` : chaque ligne contient l’empreinte SHA-256 de son contenu et de l’empreinte précédente (chaîne). Des déclencheurs PostgreSQL interdisent `UPDATE`, `DELETE` et `TRUNCATE`. Vérification : interface (Journal d’audit → Vérifier l’intégrité), CLI `verify-audit`, et test de restauration des sauvegardes.

En production, l’application se connecte avec un **rôle restreint** (`jadip_flow_app`, ni super-utilisateur ni propriétaire des tables) : il peut insérer dans le journal mais ni le modifier, ni l’effacer, ni désactiver ses déclencheurs (test `server/test/roles.test.ts`). Le rôle propriétaire ne sert qu’aux migrations au démarrage. Seul un accès administrateur direct au serveur de base de données permettrait d’altérer le journal ; la copie quotidienne chiffrée hors serveur en conserve de plus l’historique.

## Fichiers téléversés

Types autorisés : images, PDF, texte/CSV, Word, Excel ; 10 Mo par fichier, 5 fichiers ; noms aléatoires sur disque ; téléchargement en pièce jointe avec `nosniff`.
