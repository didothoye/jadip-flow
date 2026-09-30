# Jadip Flow

Portail de supervision et de gestion des workflows n8n de **Jadip Services** — à la manière d’administrate.dev, auto-hébergé.

Deux faces d’un même produit :

- **Côté agence** : toute la flotte au même endroit — instances n8n, clients, workflows, exécutions, erreurs classées, coûts des modèles d’IA, alertes, rapports, rentabilité, demandes des clients, journal d’audit.
- **Côté client** : un portail sobre, à la marque de Jadip Services, qui ne montre à chaque client que ses automatisations, avec des actions simples et sûres (activer, désactiver, mettre en pause, relancer, faire une demande).

> Règle permanente : **seules les métadonnées** des exécutions sont stockées (statut, dates, durée, nœud en erreur, message d’erreur tronqué). Les données traitées par les workflows ne quittent jamais n8n.

## Architecture

| Élément | Choix |
|---|---|
| Serveur | Node.js 22, TypeScript, Fastify 5 (`server/`) |
| Base de données | PostgreSQL 16 (migrations SQL versionnées dans `server/migrations/`) |
| Interface | React 19 + Vite, responsive, PWA installable (`web/`) |
| Tâches planifiées | Intégrées au serveur, verrous consultatifs PostgreSQL (une seule exécution même avec plusieurs conteneurs) |
| Rapports | PDF (pdfkit, police Times) et Excel (exceljs, Times New Roman 12) |
| Intégrations | API REST v1 documentée (OpenAPI, `/api/docs`), webhooks sortants signés HMAC, serveur MCP (`/mcp`) |
| Déploiement | Docker Compose, réseau `proxy-net`, aucun port publié, Nginx Proxy Manager, DNS Cloudflare, sonde uptime-kuma, sauvegardes chiffrées hors serveur |

```
n8n (API publique v1) ──► synchronisation (5 min, réglable) ──► PostgreSQL (métadonnées)
                                                               │
      Agence (/agence) ◄── API Fastify ──► Portail client (/portail)
                               │
            API REST v1 · MCP · webhooks · Telegram · e-mail (Zoho)
```

## Démarrage rapide (développement)

Prérequis : Node.js 22, PostgreSQL 16.

```bash
cd server && npm ci && cd ../web && npm ci && npm run build && cd ..
bash tools/dev-demo.sh          # faux n8n + base de démonstration + serveur sur http://localhost:3000
```

Comptes de démonstration (mot de passe `Demo2026Jadip`) : `demo-agence@jadipservices.com` (agence), `aline@kivu.example` (client A), `patrick@lumiere.example` (client B).

## Commandes utiles

| Commande | Rôle |
|---|---|
| `cd server && npm test` | Tests (phases 1 à 4, cloisonnement, performances sur 100 000 exécutions) |
| `node dist/cli.js migrate` | Applique les migrations |
| `node dist/cli.js create-admin <email> <nom>` | Crée un administrateur (lien d’activation affiché) |
| `node dist/cli.js run-job <sync\|alerts\|llm-usage\|monthly-reports\|…>` | Lance une tâche planifiée à la main |
| `node dist/cli.js verify-audit` | Vérifie l’intégrité du journal d’audit |
| `node dist/demo.js` | Charge le jeu de démonstration |

## Documentation

- [Guide agence](docs/guide-agence.md)
- [Guide client](docs/guide-client.md) (français simple, à transmettre aux clients)
- [Ajouter une instance n8n et un client](docs/procedure-instance-client.md)
- [Déploiement sur le VPS, sauvegardes et restauration](docs/deploiement.md)
- [API REST, webhooks et serveur MCP](docs/api.md)
- [Sécurité et cloisonnement](docs/securite.md)
- [Performances mesurées](docs/performances.md)
- [Rapport de livraison v1](docs/livraison-v1.md)

## Marque

Nom, logo et couleurs sont centralisés dans `brand.config.json` (voir `brand.config.example.json`) et `web/public/brand/`. Les colonnes `brand_*` et `billing_*` de la table `clients` préparent la marque blanche et la facturation par client (non activées en v1).
