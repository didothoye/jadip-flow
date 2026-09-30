import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { config } from '../../config.js';
import { one, q } from '../../db.js';
import { audit } from '../../audit.js';
import { createUserToken, requireAdmin, requireUser } from '../../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ALLOWED_LOGO, dataPath, saveUpload } from '../../lib/files.js';
import { idParam, parse, z } from '../../lib/validate.js';
import { clientsSummary, dailySeries, errorCategoryCounts, recentErrors, workflowsWithStats } from '../../services/metrics.js';
import { enqueue } from '../../services/notify.js';

const clientBody = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'minuscules, chiffres et tirets'),
  name: z.string().min(1).max(200),
  contact_name: z.string().max(200).nullable().optional(),
  contact_email: z.string().email().nullable().optional().or(z.literal('').transform(() => null)),
  contact_phone: z.string().max(50).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  is_internal: z.boolean().optional(),
  can_toggle: z.boolean().optional(), can_retry: z.boolean().optional(),
  show_costs: z.boolean().optional(), show_reports: z.boolean().optional(),
  report_email_enabled: z.boolean().optional(), report_emails: z.array(z.string().email()).optional(),
  monthly_budget_usd: z.number().nonnegative().nullable().optional(),
  monthly_fee_usd: z.number().nonnegative().nullable().optional(),
  inactivity_days: z.number().int().min(1).max(365).optional(),
});
const EDITABLE = Object.keys(clientBody.shape) as (keyof z.infer<typeof clientBody>)[];

export async function inviteUser(userId: string) {
  const u = await one<any>('SELECT u.email, u.name, c.name client_name FROM users u LEFT JOIN clients c ON c.id=u.client_id WHERE u.id=$1', [userId]);
  const token = await createUserToken(userId, 'invite', 24 * 7);
  const link = `${config.publicUrl}/activer/${token}`;
  await enqueue({
    channel: 'email', recipient: u.email, bypassQuiet: true,
    subject: `Votre accès à ${config.brand.productName}`,
    body: `Bonjour ${u.name},\n\n${config.brand.companyName} vous invite à suivre ${u.client_name ? `les automatisations de ${u.client_name}` : 'la plateforme'} sur ${config.brand.productName}.\n\nPour activer votre compte et choisir votre mot de passe, ouvrez ce lien (valable 7 jours) :\n${link}\n\nÀ bientôt,\n${config.brand.companyName}`,
  });
  return link;
}

export default async function clientRoutes(app: FastifyInstance) {
  app.get('/api/admin/clients', async (req) => {
    requireAdmin(req);
    return clientsSummary();
  });

  app.get('/api/admin/clients/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const c = await one<any>('SELECT * FROM clients WHERE id=$1', [id]);
    if (!c) throw notFound('Client');
    const [summary] = await clientsSummary(id);
    const [workflows, series, errors, categories, users, alerts, actions, costs] = await Promise.all([
      workflowsWithStats({ clientId: id }),
      dailySeries({ clientId: id, days: 30 }),
      recentErrors({ clientId: id, limit: 20 }),
      errorCategoryCounts(30, id),
      q(`SELECT id, email, name, totp_enabled, last_login_at, disabled_at, created_at, (password_hash IS NOT NULL) activated FROM users WHERE client_id=$1 ORDER BY name`, [id]),
      q(`SELECT * FROM alerts WHERE client_id=$1 ORDER BY last_seen_at DESC LIMIT 20`, [id]),
      q(`SELECT l.*, u.email actor_email, w.name workflow_name FROM action_log l LEFT JOIN users u ON u.id=l.actor_user_id LEFT JOIN workflows w ON w.id=l.workflow_id
         WHERE l.client_id=$1 ORDER BY l.created_at DESC LIMIT 50`, [id]),
      q(`SELECT day, provider, model, sum(cost_usd) cost_usd FROM llm_usage WHERE client_id=$1 AND day >= (now() - interval '90 days')::date GROUP BY 1,2,3 ORDER BY 1`, [id]),
    ]);
    return { client: c, summary, workflows, series, errors, categories, users, alerts, actions, costs };
  });

  app.post('/api/admin/clients', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(clientBody, req.body);
    if (await one('SELECT 1 FROM clients WHERE code=$1', [b.code])) throw conflict('Ce code client existe déjà.');
    const keys = EDITABLE.filter((k) => b[k] !== undefined);
    const c = await one<any>(`INSERT INTO clients(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, keys.map((k) => b[k]));
    // rattache automatiquement les workflows déjà étiquetés « client:<code> »
    await q(`UPDATE workflows SET client_id=$1, client_assignment='tag' WHERE client_assignment <> 'manual' AND deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE lower(regexp_replace(t, '\\s', '', 'g')) = 'client:' || $2)`, [c.id, c.code]);
    await q(`UPDATE executions e SET client_id=w.client_id FROM workflows w WHERE w.id=e.workflow_id AND w.client_id=$1`, [c.id]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'client.created', targetType: 'client', targetId: c.id, clientId: c.id, ip: req.ip, detail: { code: b.code, name: b.name } });
    reply.code(201);
    return c;
  });

  app.patch('/api/admin/clients/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(clientBody.partial().extend({ archived: z.boolean().optional() }), req.body);
    const keys = EDITABLE.filter((k) => b[k] !== undefined);
    const sets = keys.map((k, i) => `${k}=$${i + 2}`);
    if (b.archived !== undefined) sets.push(`archived_at = ${b.archived ? 'now()' : 'NULL'}`);
    if (!sets.length) throw badRequest('Aucune modification');
    const c = await one<any>(`UPDATE clients SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => b[k])]);
    if (!c) throw notFound('Client');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'client.updated', targetType: 'client', targetId: id, clientId: id, ip: req.ip, detail: b });
    return c;
  });

  app.post('/api/admin/clients/:id/logo', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const file = await req.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!file) throw badRequest('Fichier manquant');
    const saved = await saveUpload(file, 'logos', ALLOWED_LOGO);
    const c = await one<any>('UPDATE clients SET logo_path=$2, updated_at=now() WHERE id=$1 RETURNING id, logo_path', [id, saved.path]);
    if (!c) throw notFound('Client');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'client.logo_updated', targetType: 'client', targetId: id, clientId: id, ip: req.ip });
    return c;
  });

  // logo visible par l'agence et par les utilisateurs du client concerné uniquement
  app.get('/api/clients/:id/logo', async (req, reply) => {
    const a = requireUser(req);
    const { id } = parse(idParam, req.params);
    if (a.role === 'client' && a.clientId !== id) throw notFound('Logo');
    const c = await one<any>('SELECT logo_path FROM clients WHERE id=$1', [id]);
    if (!c?.logo_path) throw notFound('Logo');
    const p = dataPath(c.logo_path);
    if (!existsSync(p)) throw notFound('Logo');
    const ext = c.logo_path.split('.').pop();
    reply.type(ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    reply.header('cache-control', 'private, max-age=300');
    return reply.send(createReadStream(p));
  });

  // --- comptes utilisateurs du client
  app.post('/api/admin/clients/:id/users', async (req, reply) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ email: z.string().email(), name: z.string().min(1).max(120), send_invite: z.boolean().default(true) }), req.body);
    if (!(await one('SELECT 1 FROM clients WHERE id=$1', [id]))) throw notFound('Client');
    if (await one('SELECT 1 FROM users WHERE email=$1', [b.email])) throw conflict('Un compte existe déjà avec cet e-mail.');
    const u = await one<any>(`INSERT INTO users(email, name, role, client_id) VALUES ($1,$2,'client',$3) RETURNING id, email, name`, [b.email, b.name, id]);
    const link = b.send_invite ? await inviteUser(u.id) : null;
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'user.invited', targetType: 'user', targetId: u.id, clientId: id, ip: req.ip, detail: { email: b.email } });
    reply.code(201);
    return { ...u, invite_link: link };
  });

  app.post('/api/admin/users/:id/invite', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const u = await one<any>('SELECT id, client_id FROM users WHERE id=$1', [id]);
    if (!u) throw notFound('Utilisateur');
    const link = await inviteUser(id);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'user.invite_resent', targetType: 'user', targetId: id, clientId: u.client_id, ip: req.ip });
    return { invite_link: link };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ disabled: z.boolean().optional(), name: z.string().min(1).max(120).optional(), reset_totp: z.boolean().optional() }), req.body);
    if (id === a.userId && b.disabled) throw forbidden('Vous ne pouvez pas désactiver votre propre compte.');
    const u = await one<any>(`UPDATE users SET
        disabled_at = CASE WHEN $2::boolean IS NULL THEN disabled_at WHEN $2 THEN now() ELSE NULL END,
        name = COALESCE($3, name),
        totp_enabled = CASE WHEN $4 THEN false ELSE totp_enabled END,
        totp_secret_enc = CASE WHEN $4 THEN NULL ELSE totp_secret_enc END
      WHERE id=$1 RETURNING id, client_id`, [id, b.disabled ?? null, b.name ?? null, !!b.reset_totp]);
    if (!u) throw notFound('Utilisateur');
    if (b.disabled) await q('DELETE FROM sessions WHERE user_id=$1', [id]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'user.updated', targetType: 'user', targetId: id, clientId: u.client_id, ip: req.ip, detail: b });
    return { ok: true };
  });

  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    return q(`SELECT u.id, u.email, u.name, u.role, u.client_id, c.name client_name, u.totp_enabled, u.last_login_at, u.disabled_at, (u.password_hash IS NOT NULL) activated
              FROM users u LEFT JOIN clients c ON c.id=u.client_id ORDER BY u.role, c.name NULLS FIRST, u.name`);
  });

  app.post('/api/admin/users', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(z.object({ email: z.string().email(), name: z.string().min(1).max(120) }), req.body);
    if (await one('SELECT 1 FROM users WHERE email=$1', [b.email])) throw conflict('Un compte existe déjà avec cet e-mail.');
    const u = await one<any>(`INSERT INTO users(email, name, role) VALUES ($1,$2,'admin') RETURNING id, email, name`, [b.email, b.name]);
    const link = await inviteUser(u.id);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'user.admin_invited', targetType: 'user', targetId: u.id, ip: req.ip, detail: { email: b.email } });
    reply.code(201);
    return { ...u, invite_link: link };
  });
}
