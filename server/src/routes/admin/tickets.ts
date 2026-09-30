import type { FastifyInstance } from 'fastify';
import { one, q } from '../../db.js';
import { requireAdmin } from '../../auth.js';
import { notFound } from '../../lib/errors.js';
import { idParam, numIdParam, parse, z } from '../../lib/validate.js';
import { addMessage, readTicketForm, ticketDetail } from '../../services/tickets.js';
import { sendAttachment } from '../client/portal.js';

export default async function adminTicketRoutes(app: FastifyInstance) {
  app.get('/api/admin/tickets', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({ status: z.string().max(20).optional(), client_id: z.string().uuid().optional() }), req.query);
    return q(`SELECT t.*, c.name client_name, COALESCE(w.display_name, w.name) workflow_name, u.name created_by_name,
      (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id=t.id) messages
      FROM tickets t JOIN clients c ON c.id=t.client_id LEFT JOIN workflows w ON w.id=t.workflow_id LEFT JOIN users u ON u.id=t.created_by
      WHERE ($1::text IS NULL OR ($1='open' AND t.status IN ('new','in_progress','waiting_client')) OR t.status=$1) AND ($2::uuid IS NULL OR t.client_id=$2)
      ORDER BY (t.status='new') DESC, t.updated_at DESC LIMIT 300`, [f.status ?? null, f.client_id ?? null]);
  });

  app.get('/api/admin/tickets/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(numIdParam, req.params);
    const t = await ticketDetail(id);
    if (!t) throw notFound('Demande');
    return t;
  });

  app.post('/api/admin/tickets/:id/messages', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(numIdParam, req.params);
    const t = await one<any>('SELECT * FROM tickets WHERE id=$1', [id]);
    if (!t) throw notFound('Demande');
    const form = await readTicketForm(req, `tickets/${t.client_id}`);
    const status = form.fields.status ? parse(z.enum(['new', 'in_progress', 'waiting_client', 'done', 'closed']), form.fields.status) : undefined;
    return addMessage(a, t, form.fields.body ?? '', form.files, status);
  });

  app.get('/api/admin/attachments/:id', async (req, reply) => {
    requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const f = await one<any>('SELECT * FROM ticket_attachments WHERE id=$1', [id]);
    if (!f) throw notFound('Pièce jointe');
    return sendAttachment(reply, f);
  });
}
