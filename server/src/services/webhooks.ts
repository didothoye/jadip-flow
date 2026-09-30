import { q } from '../db.js';
import { decrypt, hmacSha256 } from '../lib/crypto.js';

export const WEBHOOK_EVENTS = [
  'execution.failed',
  'workflow.activated',
  'workflow.deactivated',
  'workflow.deactivated_by_client',
  'ticket.created',
  'ticket.updated',
  'alert.opened',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Crée une livraison pour chaque webhook abonné à l'événement. */
export async function emitEvent(event: WebhookEvent, data: Record<string, unknown>, clientId?: string | null) {
  const hooks = await q<{ id: string }>(
    `SELECT id FROM webhooks WHERE enabled AND $1 = ANY(events) AND (client_id IS NULL OR client_id = $2)`, [event, clientId ?? null]);
  if (!hooks.length) return;
  const payload = { event, occurredAt: new Date().toISOString(), clientId: clientId ?? null, data };
  for (const h of hooks) {
    await q('INSERT INTO webhook_deliveries(webhook_id, event, payload) VALUES ($1,$2,$3)', [h.id, event, JSON.stringify(payload)]);
  }
}

const BACKOFF_MIN = [1, 5, 15, 60, 180, 720];

export async function deliverWebhooks(limit = 50): Promise<number> {
  const rows = await q<any>(`
    SELECT d.*, w.url, w.secret_enc FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
    WHERE d.status='pending' AND d.next_attempt_at <= now() AND w.enabled ORDER BY d.id LIMIT $1`, [limit]);
  let ok = 0;
  for (const d of rows) {
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    let code: number | null = null;
    let err: string | null = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(d.url, {
        method: 'POST', signal: ctrl.signal,
        headers: {
          'content-type': 'application/json', 'user-agent': 'JadipFlow-Webhooks/1.0',
          'x-jadip-event': d.event, 'x-jadip-delivery': String(d.id), 'x-jadip-timestamp': ts,
          'x-jadip-signature': `sha256=${hmacSha256(decrypt(d.secret_enc), `${ts}.${body}`)}`,
        },
        body,
      }).finally(() => clearTimeout(t));
      code = res.status;
      if (!res.ok) err = `HTTP ${res.status}`;
    } catch (e: any) {
      err = String(e?.message ?? e).slice(0, 300);
    }
    const attempts = d.attempts + 1;
    if (!err) {
      await q(`UPDATE webhook_deliveries SET status='delivered', attempts=$2, response_code=$3, delivered_at=now(), last_error=NULL WHERE id=$1`, [d.id, attempts, code]);
      ok++;
    } else {
      const delay = BACKOFF_MIN[attempts - 1];
      await q(`UPDATE webhook_deliveries SET attempts=$2, response_code=$3, last_error=$4,
               status = CASE WHEN $5::int IS NULL THEN 'failed' ELSE 'pending' END,
               next_attempt_at = now() + (COALESCE($5::int,0) * interval '1 minute') WHERE id=$1`,
        [d.id, attempts, code, err, delay ?? null]);
    }
  }
  return ok;
}
