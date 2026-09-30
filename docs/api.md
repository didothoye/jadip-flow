# API REST, webhooks et serveur MCP

## Authentification

Jeton personnel créé dans « Mon compte → Jetons d’API » : `Authorization: Bearer jf_…`. Portées : `read` (lecture) et `write` (activer / désactiver). Un jeton appartenant à un compte **client** ne voit que ce client (et ses workflows visibles). Jetons stockés hachés (SHA-256), révocables, expiration facultative. Chaque appel est inscrit au journal d’audit (source `api`).

Limitation de débit : 120 requêtes par minute et par jeton (réponse `429` avec délai).

Documentation interactive OpenAPI : **`/api/docs`** (JSON : `/api/docs/json`).

## Points d’accès

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/v1/overview` | Vue d’ensemble, alertes ouvertes, clients à risque |
| GET | `/api/v1/clients` | Clients et indicateurs |
| GET | `/api/v1/workflows?client_id&search` | Workflows |
| GET | `/api/v1/workflows/{id}` | Détail + dernières erreurs |
| POST | `/api/v1/workflows/{id}/activate` | Activer (portée `write`) |
| POST | `/api/v1/workflows/{id}/deactivate` | Désactiver (portée `write`, refusé si critique) |
| GET | `/api/v1/executions?client_id&workflow_id&status&from&to&cursor&limit` | Exécutions (métadonnées), pagination par curseur (`nextCursor`) |
| GET | `/api/v1/errors?client_id&workflow_id&category&unhandled&limit` | Erreurs classées |
| GET | `/api/v1/costs?client_id&from&to` | Coûts IA par client, workflow, modèle, jour |

Exemple :

```bash
curl -H "Authorization: Bearer $JF_TOKEN" "https://flow.jadipservices.com/api/v1/errors?category=auth&unhandled=true"
```

## Webhooks sortants

Paramètres → Webhooks. Événements : `execution.failed`, `workflow.activated`, `workflow.deactivated`, `workflow.deactivated_by_client`, `ticket.created`, `ticket.updated`, `alert.opened`. URL en `https://` obligatoire, filtrage facultatif par client.

Chaque livraison est un `POST` JSON `{ event, occurredAt, clientId, data }` avec les en-têtes :

- `X-Jadip-Event`, `X-Jadip-Delivery`, `X-Jadip-Timestamp`
- `X-Jadip-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<corps>")>`

Vérification (Node.js) :

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${req.headers['x-jadip-timestamp']}.${rawBody}`).digest('hex');
```

Nouvelles tentatives : 1, 5, 15, 60, 180 et 720 minutes, puis échec définitif (visible dans l’historique des livraisons). Un workflow n8n peut recevoir ces webhooks (nœud Webhook) pour, par exemple, relayer vers WhatsApp.

## Serveur MCP (lecture seule)

Point d’accès : `POST /mcp` (transport HTTP « streamable », sans session), authentifié par jeton. Outils :

| Outil | Rôle |
|---|---|
| `fleet_overview` | Vue d’ensemble, alertes, clients à risque |
| `list_clients` | Clients et indicateurs |
| `list_workflows` | Workflows (filtre client / texte) |
| `get_workflow` | Détail d’un workflow et ses erreurs |
| `recent_errors` | Erreurs récentes, par catégorie, non traitées… |
| `llm_costs` | Coûts IA sur une période |

Installation dans Claude Code :

```bash
claude mcp add --transport http jadip-flow https://flow.jadipservices.com/mcp --header "Authorization: Bearer jf_…"
```

Chaque appel d’outil est journalisé (source `mcp`, nom de l’outil, arguments).
