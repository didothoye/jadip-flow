import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { audit } from '../audit.js';
import type { Actor } from '../lib/actor.js';
import { HttpError } from '../lib/errors.js';
import { currentPeriod } from '../lib/time.js';
import { apiClients, apiCosts, apiErrors, apiOverview, apiWorkflow, apiWorkflows } from '../services/readapi.js';

/**
 * Serveur MCP (lecture seule) : Claude Code peut interroger Jadip Flow.
 *   claude mcp add --transport http jadip-flow https://flow.jadipservices.com/mcp --header "Authorization: Bearer jf_…"
 * Chaque appel d'outil est inscrit au journal d'audit (source « mcp »).
 */
function buildServer(actor: Actor) {
  const server = new McpServer({ name: 'jadip-flow', version: '1.0.0' }, {
    instructions: `Données de supervision n8n de ${config.brand.companyName} (métadonnées seulement, en lecture). Montants en dollars US, dates en UTC.`,
  });
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: true } } as any, (async (args: any) => {
      await audit({ actorUserId: actor.userId, actorLabel: actor.label, source: 'mcp', action: 'mcp.tool', targetType: 'tool', targetId: name, clientId: actor.clientId, detail: { args } });
      try {
        const data = await fn(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: e.message }] };
      }
    }) as any);
  };
  tool('fleet_overview', 'Vue d’ensemble : instances, workflows actifs, exécutions du jour et de la semaine, taux de réussite, alertes ouvertes, clients à risque.', {}, () => apiOverview(actor));
  tool('list_clients', 'Liste des clients avec leurs indicateurs (exécutions 30 j, réussite, temps gagné, coût IA du mois, risques).', {}, () => apiClients(actor));
  tool('list_workflows', 'Liste des workflows, éventuellement filtrés par client ou par texte.', { client_id: z.string().uuid().optional(), search: z.string().optional() },
    (a) => apiWorkflows(actor, { clientId: a.client_id, search: a.search }));
  tool('get_workflow', 'Détail d’un workflow et ses dernières erreurs.', { workflow_id: z.string().uuid() }, (a) => apiWorkflow(actor, a.workflow_id));
  tool('recent_errors', 'Erreurs récentes (nœud fautif, catégorie : auth, rate_limit, network, data, logic).', {
    client_id: z.string().uuid().optional(), workflow_id: z.string().uuid().optional(),
    category: z.enum(['auth', 'rate_limit', 'network', 'data', 'logic']).optional(), unhandled_only: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional(),
  }, (a) => apiErrors(actor, { clientId: a.client_id, workflowId: a.workflow_id, category: a.category, unhandled: a.unhandled_only, limit: a.limit ?? 30 }));
  tool('llm_costs', 'Coûts des modèles d’IA sur une période (par client, workflow, modèle, jour).', {
    client_id: z.string().uuid().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }, (a) => apiCosts(actor, { clientId: a.client_id, from: a.from ?? `${currentPeriod()}-01`, to: a.to ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10) }));
  return server;
}

export default async function mcpRoutes(app: FastifyInstance) {
  const handler = async (req: any, reply: any) => {
    const actor = req.actor as Actor | null;
    if (!actor || actor.source === 'web') throw new HttpError(401, 'Jeton d’API requis (Authorization: Bearer …)', 'unauthorized');
    const server = buildServer(actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, handler);
  app.get('/mcp', async (_req, reply) => reply.code(405).send({ error: 'Utilisez POST (transport HTTP « streamable », mode sans session).' }));
}
