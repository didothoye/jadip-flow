import { one, q, tx } from '../../db.js';
import { decrypt } from '../../lib/crypto.js';
import { fetchAnthropic, fetchOpenAI, fetchOpenRouter, type UsageRecord } from './providers.js';

interface Rule { dimension: string; match_value: string; client_id: string; workflow_id: string | null }

/** Applique les règles d'attribution (clé API > projet > espace de travail > modèle). */
export function attribute(r: UsageRecord, rules: Rule[]): { clientId: string | null; workflowId: string | null } {
  const order: [string, string | null | undefined][] = [['api_key', r.apiKeyRef], ['project', r.project], ['workspace', r.workspace], ['model', r.model]];
  for (const [dim, val] of order) {
    if (!val) continue;
    const rule = rules.find((x) => x.dimension === dim && x.match_value === val);
    if (rule) return { clientId: rule.client_id, workflowId: rule.workflow_id };
  }
  return { clientId: null, workflowId: null };
}

export async function fetchAccount(accountId: string, days = 3, fetchImpl?: typeof fetch) {
  const acc = await one<any>('SELECT * FROM llm_accounts WHERE id=$1', [accountId]);
  if (!acc || acc.provider === 'manual') return { imported: 0 };
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to.getTime() - days * 86400000);
  const apiKey = decrypt(acc.api_key_enc);
  try {
    let records: UsageRecord[] = [];
    if (acc.provider === 'openai') records = await fetchOpenAI({ apiKey, from, to, fetchImpl });
    else if (acc.provider === 'anthropic') records = await fetchAnthropic({ apiKey, from, to, fetchImpl });
    else if (acc.provider === 'openrouter') {
      const prevRows = await q<{ key_ref: string; cumulative_usd: number }>(`
        SELECT DISTINCT ON (key_ref) key_ref, cumulative_usd FROM llm_key_snapshots WHERE account_id=$1 ORDER BY key_ref, day DESC`, [accountId]);
      const r = await fetchOpenRouter({ apiKey, from, to, fetchImpl, previousSnapshots: new Map(prevRows.map((p) => [p.key_ref, p.cumulative_usd])) });
      records = r.records;
      for (const [ref, usd] of r.snapshots) {
        await q(`INSERT INTO llm_key_snapshots(account_id, key_ref, day, cumulative_usd) VALUES ($1,$2,current_date,$3)
                 ON CONFLICT (account_id, key_ref, day) DO UPDATE SET cumulative_usd=EXCLUDED.cumulative_usd`, [accountId, ref, usd]);
      }
    }
    const imported = await ingest(accountId, acc.provider, records);
    await q(`UPDATE llm_accounts SET last_fetch_at=now(), last_fetch_status='success', last_fetch_message=$2 WHERE id=$1`, [accountId, `${imported} ligne(s)`]);
    return { imported };
  } catch (e: any) {
    await q(`UPDATE llm_accounts SET last_fetch_at=now(), last_fetch_status='error', last_fetch_message=$2 WHERE id=$1`, [accountId, String(e.message).slice(0, 500)]);
    throw e;
  }
}

export async function ingest(accountId: string, provider: string, records: UsageRecord[]) {
  const rules = await q<Rule>('SELECT dimension, match_value, client_id, workflow_id FROM llm_attribution_rules WHERE account_id=$1', [accountId]);
  let n = 0;
  await tx(async (c) => {
    for (const r of records) {
      if (!r.costUsd && !r.inputTokens && !r.outputTokens) continue;
      const a = attribute(r, rules);
      await c.query(`
        INSERT INTO llm_usage(account_id, source, day, provider, model, project, api_key_ref, workspace, input_tokens, output_tokens, cost_usd, client_id, workflow_id, external_key)
        VALUES ($1,'api',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (account_id, external_key) WHERE external_key IS NOT NULL DO UPDATE SET
          cost_usd=EXCLUDED.cost_usd, input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens,
          client_id=COALESCE(llm_usage.client_id, EXCLUDED.client_id), workflow_id=COALESCE(llm_usage.workflow_id, EXCLUDED.workflow_id)`,
        [accountId, r.day, provider, r.model, r.project ?? null, r.apiKeyRef ?? null, r.workspace ?? null, r.inputTokens ?? 0, r.outputTokens ?? 0, r.costUsd, a.clientId, a.workflowId, r.externalKey]);
      n++;
    }
  });
  return n;
}

/** Réapplique les règles aux lignes non attribuées (après ajout d'une règle). */
export async function reattribute(accountId: string) {
  const rules = await q<Rule>('SELECT dimension, match_value, client_id, workflow_id FROM llm_attribution_rules WHERE account_id=$1', [accountId]);
  const rows = await q<any>(`SELECT id, model, project, api_key_ref, workspace FROM llm_usage WHERE account_id=$1 AND source='api'`, [accountId]);
  let n = 0;
  for (const r of rows) {
    const a = attribute({ day: '', model: r.model, project: r.project, apiKeyRef: r.api_key_ref, workspace: r.workspace, costUsd: 0, externalKey: '' }, rules);
    await q('UPDATE llm_usage SET client_id=$2, workflow_id=$3 WHERE id=$1', [r.id, a.clientId, a.workflowId]);
    if (a.clientId) n++;
  }
  return n;
}

/** Estimation par exécution pour les workflows sans usage exposé (coût unitaire × exécutions). */
export async function computeEstimates(days = 35) {
  await tx(async (c) => {
    await c.query(`DELETE FROM llm_usage WHERE source='estimate' AND day >= current_date - $1::int`, [days]);
    await c.query(`
      INSERT INTO llm_usage(source, day, provider, model, cost_usd, client_id, workflow_id, note)
      SELECT 'estimate', (e.started_at AT TIME ZONE 'UTC')::date, 'estimation', 'par exécution', count(*) * w.cost_per_execution_usd, w.client_id, w.id,
             count(*) || ' exécution(s) × ' || w.cost_per_execution_usd || ' $US'
      FROM executions e JOIN workflows w ON w.id=e.workflow_id
      WHERE w.cost_per_execution_usd > 0 AND e.status IN ('success','error','crashed') AND e.started_at >= current_date - $1::int
      GROUP BY 2, w.id`, [days]);
  });
}

export async function fetchAllAccounts() {
  const accs = await q<{ id: string }>(`SELECT id FROM llm_accounts WHERE enabled AND provider <> 'manual'`);
  const res: Record<string, unknown> = {};
  for (const a of accs) {
    try { res[a.id] = await fetchAccount(a.id); } catch (e: any) { res[a.id] = e.message; }
  }
  await computeEstimates();
  return res;
}

/** Coûts agrégés (par client / workflow / modèle / jour). */
export async function costBreakdown(opts: { clientId?: string | null; from: string; to: string }) {
  const p = [opts.from, opts.to, opts.clientId ?? null];
  const where = `u.day >= $1 AND u.day < $2 AND ($3::uuid IS NULL OR u.client_id=$3)`;
  const [byClient, byWorkflow, byModel, byDay, total] = await Promise.all([
    q(`SELECT u.client_id, c.name client_name, sum(u.cost_usd)::float cost_usd FROM llm_usage u LEFT JOIN clients c ON c.id=u.client_id WHERE ${where} GROUP BY 1,2 ORDER BY 3 DESC`, p),
    q(`SELECT u.workflow_id, COALESCE(w.display_name, w.name) workflow_name, u.client_id, sum(u.cost_usd)::float cost_usd FROM llm_usage u LEFT JOIN workflows w ON w.id=u.workflow_id WHERE ${where} GROUP BY 1,2,3 ORDER BY 4 DESC`, p),
    q(`SELECT u.provider, u.model, sum(u.cost_usd)::float cost_usd, sum(u.input_tokens)::bigint input_tokens, sum(u.output_tokens)::bigint output_tokens FROM llm_usage u WHERE ${where} GROUP BY 1,2 ORDER BY 3 DESC`, p),
    q(`SELECT to_char(u.day,'YYYY-MM-DD') AS day, sum(u.cost_usd)::float cost_usd FROM llm_usage u WHERE ${where} GROUP BY 1 ORDER BY 1`, p),
    one<{ cost_usd: number; unattributed: number }>(`SELECT COALESCE(sum(u.cost_usd),0)::float cost_usd, COALESCE(sum(u.cost_usd) FILTER (WHERE u.client_id IS NULL),0)::float unattributed FROM llm_usage u WHERE ${where}`, p),
  ]);
  return { byClient, byWorkflow, byModel, byDay, total };
}
