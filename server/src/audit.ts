import { pool, q, type Queryable } from './db.js';

export interface AuditEntry {
  actorUserId?: string | null;
  actorLabel?: string | null;
  source: 'web' | 'api' | 'mcp' | 'system';
  action: string;
  targetType?: string;
  targetId?: string | number | null;
  clientId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

/** Journal d'audit chaîné (hash SHA-256) — l'UPDATE / DELETE est interdit par déclencheur. */
export async function audit(e: AuditEntry, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO audit_log(actor_user_id, actor_label, source, action, target_type, target_id, client_id, ip, detail, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'','')`,
    [e.actorUserId ?? null, e.actorLabel ?? null, e.source, e.action, e.targetType ?? null,
     e.targetId == null ? null : String(e.targetId), e.clientId ?? null, e.ip ?? null, JSON.stringify(e.detail ?? {})],
  );
}

/** Vérifie l'intégrité de la chaîne. Retourne l'identifiant de la première entrée altérée, ou null. */
export async function verifyAuditChain(): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
  const rows = await q<{ id: number; prev_hash: string; hash: string; ok: boolean }>(`
    SELECT id, prev_hash, hash,
      hash = encode(digest(prev_hash || '|' || (extract(epoch from at))::text || '|' || COALESCE(actor_user_id::text,'') || '|' ||
        COALESCE(actor_label,'') || '|' || source || '|' || action || '|' || COALESCE(target_type,'') || '|' ||
        COALESCE(target_id,'') || '|' || COALESCE(client_id::text,'') || '|' || COALESCE(ip,'') || '|' || detail::text,
        'sha256'),'hex') AS ok
    FROM audit_log ORDER BY id`);
  let prev = 'genesis';
  for (const r of rows) {
    if (!r.ok || r.prev_hash !== prev) return { ok: false, checked: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}
