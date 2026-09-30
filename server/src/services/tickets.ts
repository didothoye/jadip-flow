import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { audit } from '../audit.js';
import type { Actor } from '../lib/actor.js';
import { badRequest } from '../lib/errors.js';
import { ALLOWED_ATTACHMENT, saveUpload } from '../lib/files.js';
import { notifyAdmins, notifyClientUsers } from './notify.js';
import { emitEvent } from './webhooks.js';

export const TICKET_KINDS = { change: 'Demande de modification', problem: 'Signalement de problème', question: 'Question' } as const;
export const TICKET_STATUS = { new: 'Nouveau', in_progress: 'En cours', waiting_client: 'En attente de votre réponse', done: 'Terminé', closed: 'Fermé' } as const;

interface Parsed { fields: Record<string, string>; files: { path: string; size: number; filename: string; mime: string }[] }

/** Lit un formulaire multipart (champs + pièces jointes, 5 fichiers de 10 Mo maximum). */
export async function readTicketForm(req: FastifyRequest, folder: string): Promise<Parsed> {
  const out: Parsed = { fields: {}, files: [] };
  if (!req.isMultipart()) {
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(b)) if (typeof v === 'string') out.fields[k] = v;
    return out;
  }
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (!part.filename) { await part.toBuffer(); continue; }
      out.files.push(await saveUpload(part, folder, ALLOWED_ATTACHMENT));
    } else {
      out.fields[part.fieldname] = String(part.value ?? '').slice(0, 20000);
    }
  }
  return out;
}

export async function addAttachments(ticketId: number, messageId: number, files: Parsed['files']) {
  for (const f of files) {
    await q(`INSERT INTO ticket_attachments(ticket_id, message_id, filename, mime, size_bytes, storage_path) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ticketId, messageId, f.filename, f.mime, f.size, f.path]);
  }
}

export async function createTicket(actor: Actor & { clientId: string }, input: { kind: string; subject: string; body: string; workflowId?: string | null }, files: Parsed['files']) {
  if (!(input.kind in TICKET_KINDS)) throw badRequest('Type de demande invalide.');
  if (!input.subject?.trim() || !input.body?.trim()) throw badRequest('Le sujet et le message sont obligatoires.');
  if (input.workflowId) {
    const ok = await one('SELECT 1 FROM workflows WHERE id=$1 AND client_id=$2 AND client_visible', [input.workflowId, actor.clientId]);
    if (!ok) throw badRequest('Automatisation inconnue.');
  }
  const t = await one<any>(`INSERT INTO tickets(client_id, workflow_id, created_by, kind, subject) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [actor.clientId, input.workflowId || null, actor.userId, input.kind, input.subject.trim().slice(0, 200)]);
  const m = await one<any>(`INSERT INTO ticket_messages(ticket_id, author_id, author_role, body) VALUES ($1,$2,'client',$3) RETURNING id`, [t.id, actor.userId, input.body.trim()]);
  await addAttachments(t.id, m.id, files);
  const client = await one<any>('SELECT name FROM clients WHERE id=$1', [actor.clientId]);
  await audit({ actorUserId: actor.userId, actorLabel: actor.label, source: actor.source, action: 'ticket.created', targetType: 'ticket', targetId: t.id, clientId: actor.clientId, ip: actor.ip, detail: { kind: input.kind, attachments: files.length } });
  await q(`INSERT INTO action_log(actor_user_id, actor_role, client_id, workflow_id, action, result, message) VALUES ($1,'client',$2,$3,'ticket','ok',$4)`,
    [actor.userId, actor.clientId, input.workflowId || null, `Demande n° ${t.id} : ${t.subject}`]);
  await notifyAdmins({
    title: `Nouvelle demande — ${client?.name}`, clientId: actor.clientId, link: `/agence/demandes/${t.id}`, channels: ['app', 'telegram', 'email'],
    body: `${TICKET_KINDS[input.kind as keyof typeof TICKET_KINDS]} n° ${t.id} par ${actor.label}\n« ${t.subject} »${files.length ? `\n${files.length} pièce(s) jointe(s)` : ''}`,
  });
  await emitEvent('ticket.created', { ticketId: t.id, kind: t.kind, subject: t.subject, workflowId: t.workflow_id, by: actor.label }, actor.clientId);
  return t;
}

export async function addMessage(actor: Actor, ticket: any, body: string, files: Parsed['files'], status?: string) {
  if (!body?.trim() && !files.length && !status) throw badRequest('Message vide.');
  let messageId: number | null = null;
  if (body?.trim() || files.length) {
    const m = await one<any>(`INSERT INTO ticket_messages(ticket_id, author_id, author_role, body) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ticket.id, actor.userId || null, actor.role, body?.trim() || '(pièce jointe)']);
    messageId = m.id;
    await addAttachments(ticket.id, m.id, files);
  }
  let newStatus = status ?? ticket.status;
  if (!status && actor.role === 'client' && ['waiting_client', 'done'].includes(ticket.status)) newStatus = 'in_progress';
  await q('UPDATE tickets SET status=$2, updated_at=now() WHERE id=$1', [ticket.id, newStatus]);
  await audit({ actorUserId: actor.userId || null, actorLabel: actor.label, source: actor.source, action: 'ticket.updated', targetType: 'ticket', targetId: ticket.id, clientId: ticket.client_id, ip: actor.ip, detail: { status: newStatus, message: !!messageId, attachments: files.length } });
  if (actor.role === 'client') {
    await notifyAdmins({ title: `Réponse client — demande n° ${ticket.id}`, body: `${actor.label} : ${(body ?? '').slice(0, 300)}`, link: `/agence/demandes/${ticket.id}`, clientId: ticket.client_id });
  } else {
    await notifyClientUsers(ticket.client_id, {
      kind: 'info', title: `Votre demande n° ${ticket.id} : ${TICKET_STATUS[newStatus as keyof typeof TICKET_STATUS]}`,
      body: body?.trim() ? `${config.brand.companyName} vous a répondu : ${body.trim().slice(0, 500)}` : `Le statut de votre demande « ${ticket.subject} » a changé.`,
      link: `/portail/demandes/${ticket.id}`,
    });
  }
  await emitEvent('ticket.updated', { ticketId: ticket.id, status: newStatus, by: actor.label, role: actor.role }, ticket.client_id);
  return { status: newStatus, messageId };
}


export async function ticketDetail(id: number) {
  const t = await one<any>(`SELECT t.*, c.name client_name, COALESCE(w.display_name, w.name) workflow_name, u.name created_by_name
    FROM tickets t JOIN clients c ON c.id=t.client_id LEFT JOIN workflows w ON w.id=t.workflow_id LEFT JOIN users u ON u.id=t.created_by WHERE t.id=$1`, [id]);
  if (!t) return null;
  const messages = await q<any>(`SELECT m.id, m.author_role, m.body, m.created_at, u.name author_name FROM ticket_messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.ticket_id=$1 ORDER BY m.id`, [id]);
  const attachments = await q<any>(`SELECT id, message_id, filename, mime, size_bytes, created_at FROM ticket_attachments WHERE ticket_id=$1 ORDER BY created_at`, [id]);
  return { ...t, messages: messages.map((m) => ({ ...m, attachments: attachments.filter((a) => a.message_id === m.id) })) };
}
