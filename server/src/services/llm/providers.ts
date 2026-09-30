/**
 * Récupération des coûts quotidiens chez les fournisseurs d'IA.
 * Chaque connecteur renvoie des lignes normalisées ; l'attribution aux clients est faite ensuite.
 */
export interface UsageRecord {
  day: string;            // AAAA-MM-JJ (UTC)
  model: string;
  project?: string | null;
  workspace?: string | null;
  apiKeyRef?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
  externalKey: string;    // clé de déduplication stable
}

export interface FetchContext {
  apiKey: string;
  from: Date;             // inclus
  to: Date;               // exclu
  fetchImpl?: typeof fetch;
  previousSnapshots?: Map<string, number>; // OpenRouter : cumul par clé la veille
}

const day = (d: Date | string | number) => new Date(typeof d === 'number' ? d * 1000 : d).toISOString().slice(0, 10);

async function getJson(f: typeof fetch, url: string, headers: Record<string, string>) {
  const res = await f(url, { headers });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status} : ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

/** OpenAI — API Costs de l'organisation (clé d'administration requise), regroupée par projet et ligne. */
export async function fetchOpenAI(ctx: FetchContext): Promise<UsageRecord[]> {
  const f = ctx.fetchImpl ?? fetch;
  const out: UsageRecord[] = [];
  let page: string | undefined;
  do {
    const qs = new URLSearchParams({
      start_time: String(Math.floor(ctx.from.getTime() / 1000)), end_time: String(Math.floor(ctx.to.getTime() / 1000)),
      bucket_width: '1d', limit: '31',
    });
    qs.append('group_by', 'project_id');
    qs.append('group_by', 'line_item');
    if (page) qs.set('page', page);
    const j = await getJson(f, `https://api.openai.com/v1/organization/costs?${qs}`, { authorization: `Bearer ${ctx.apiKey}` });
    for (const b of j.data ?? []) {
      for (const r of b.results ?? []) {
        const line = String(r.line_item ?? 'inconnu');
        const d = day(b.start_time);
        out.push({
          day: d, model: line.split(',')[0].trim() || 'inconnu', project: r.project_id ?? null,
          costUsd: Number(r.amount?.value ?? 0), externalKey: `${d}|${r.project_id ?? ''}|${line}`,
        });
      }
    }
    page = j.has_more ? j.next_page : undefined;
  } while (page);
  return out;
}

/** Anthropic — Admin API cost_report (montants en cents, chaînes décimales), par espace de travail et description. */
export async function fetchAnthropic(ctx: FetchContext): Promise<UsageRecord[]> {
  const f = ctx.fetchImpl ?? fetch;
  const out: UsageRecord[] = [];
  let page: string | undefined;
  do {
    const qs = new URLSearchParams({ starting_at: ctx.from.toISOString(), ending_at: ctx.to.toISOString(), bucket_width: '1d', limit: '31' });
    qs.append('group_by[]', 'workspace_id');
    qs.append('group_by[]', 'description');
    if (page) qs.set('page', page);
    const j = await getJson(f, `https://api.anthropic.com/v1/organizations/cost_report?${qs}`, { 'x-api-key': ctx.apiKey, 'anthropic-version': '2023-06-01' });
    for (const b of j.data ?? []) {
      for (const r of b.results ?? []) {
        const d = day(b.starting_at);
        const desc = String(r.description ?? r.cost_type ?? 'inconnu');
        out.push({
          day: d, model: r.model ?? desc, workspace: r.workspace_id ?? 'default',
          costUsd: Number(r.amount ?? 0) / 100, externalKey: `${d}|${r.workspace_id ?? ''}|${desc}|${r.token_type ?? ''}|${r.service_tier ?? ''}`,
        });
      }
    }
    page = j.has_more ? j.next_page : undefined;
  } while (page);
  return out;
}

/**
 * OpenRouter — clé de provisionnement : liste des clés avec leur usage cumulé.
 * Le coût du jour est la différence avec l'instantané précédent (par clé).
 */
export async function fetchOpenRouter(ctx: FetchContext): Promise<{ records: UsageRecord[]; snapshots: Map<string, number> }> {
  const f = ctx.fetchImpl ?? fetch;
  const snapshots = new Map<string, number>();
  const records: UsageRecord[] = [];
  const today = day(new Date());
  let offset = 0;
  for (;;) {
    const j = await getJson(f, `https://openrouter.ai/api/v1/keys?offset=${offset}`, { authorization: `Bearer ${ctx.apiKey}` });
    const keys = j.data ?? [];
    for (const k of keys) {
      const ref = String(k.label ?? k.name ?? k.hash);
      const usage = Number(k.usage ?? 0);
      snapshots.set(ref, usage);
      const prev = ctx.previousSnapshots?.get(ref);
      if (prev !== undefined && usage > prev) {
        records.push({ day: today, model: 'openrouter', apiKeyRef: ref, costUsd: usage - prev, externalKey: `${today}|${ref}|${prev}` });
      }
    }
    if (keys.length < 100) break;
    offset += keys.length;
  }
  return { records, snapshots };
}
