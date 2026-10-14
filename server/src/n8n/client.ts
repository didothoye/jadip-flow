/**
 * Client minimal de l'API publique n8n (v1).
 * Seules des métadonnées sont conservées : les données traitées par les workflows ne quittent jamais cette couche.
 *
 * Robustesse : une erreur transitoire (n8n qui redémarre, délai dépassé, passerelle indisponible) sur une lecture
 * est réessayée une fois après `retryDelayMs` avant d'être remontée ; le message indique toujours l'opération concernée.
 */
export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
  isArchived?: boolean;
  tags?: { id?: string; name: string }[];
}

export interface N8nExecution {
  id: string | number;
  finished?: boolean;
  mode?: string;
  retryOf?: string | number | null;
  retrySuccessId?: string | number | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
  workflowId: string | number;
  status?: string;
}

export interface N8nErrorSummary {
  node: string | null;
  message: string | null;
}

export class N8nError extends Error {
  /** Vrai si l'erreur a toutes les chances d'être passagère (redémarrage, réseau). */
  constructor(message: string, public status?: number, public transient = false) {
    super(message);
  }
}

interface ReqOptions {
  /** Opération en français, reprise dans les messages d'erreur (« liste des workflows »). */
  label: string;
  /** Réessayer une fois sur erreur transitoire (lectures seulement). */
  retry?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class N8nClient {
  private base: string;
  constructor(baseUrl: string, private apiKey: string, private timeoutMs = 20000, private retryDelayMs = 20000) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async once<T>(method: string, path: string, body: unknown, label: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { 'X-N8N-API-KEY': this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e: any) {
      const detail = e?.name === 'AbortError' ? `délai dépassé (${this.timeoutMs} ms)` : `réseau : ${e?.cause?.code ?? e?.message ?? e}`;
      throw new N8nError(`n8n injoignable : ${label} → ${detail}`, undefined, true);
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      let detail: string | null = null;
      try {
        const j: any = await res.json();
        if (j?.message) detail = String(j.message);
      } catch { /* corps non JSON */ }
      const status = `${res.status} ${res.statusText}`.trim();
      // 404 sans message JSON : l'API n'est pas encore en place (n8n démarre) ; 502/503/504 : passerelle ou service indisponible
      const transient = (res.status === 404 && detail === null) || [502, 503, 504].includes(res.status);
      if (transient) throw new N8nError(`n8n indisponible (redémarrage probable) : ${label} → ${status}`, res.status, true);
      throw new N8nError(`${label} → ${status}${detail ? ` — ${detail}` : ''}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async req<T>(method: string, path: string, body: unknown, opts: ReqOptions): Promise<T> {
    try {
      return await this.once<T>(method, path, body, opts.label);
    } catch (e) {
      if (!(e instanceof N8nError && e.transient && opts.retry !== false && method === 'GET')) throw e;
      await sleep(this.retryDelayMs);
      return this.once<T>(method, path, body, opts.label);
    }
  }

  /** Sonde de connexion : pas de réessai, la réponse doit être immédiate pour l'interface. */
  async health(): Promise<{ reachable: boolean; authOk: boolean; message: string }> {
    try {
      await this.req('GET', '/api/v1/workflows?limit=1', undefined, { label: 'test de connexion', retry: false });
      return { reachable: true, authOk: true, message: 'Connexion réussie' };
    } catch (e: any) {
      if (e instanceof N8nError && (e.status === 401 || e.status === 403)) {
        return { reachable: true, authOk: false, message: 'Clé API refusée par n8n' };
      }
      return { reachable: false, authOk: false, message: e.message };
    }
  }

  async *workflows(): AsyncGenerator<N8nWorkflow> {
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: '250', excludePinnedData: 'true' });
      if (cursor) qs.set('cursor', cursor);
      const page = await this.req<{ data: any[]; nextCursor?: string | null }>('GET', `/api/v1/workflows?${qs}`, undefined, { label: 'liste des workflows' });
      for (const w of page.data) {
        // on ne garde volontairement ni les nœuds, ni les connexions, ni les données épinglées
        yield {
          id: String(w.id), name: w.name, active: !!w.active, createdAt: w.createdAt, updatedAt: w.updatedAt,
          isArchived: !!w.isArchived, tags: (w.tags ?? []).map((t: any) => ({ id: t.id, name: t.name })),
        };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** Exécutions, de la plus récente à la plus ancienne (métadonnées seulement). */
  async *executions(opts: { workflowId?: string } = {}): AsyncGenerator<N8nExecution> {
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: '250', includeData: 'false' });
      if (opts.workflowId) qs.set('workflowId', opts.workflowId);
      if (cursor) qs.set('cursor', cursor);
      const page = await this.req<{ data: any[]; nextCursor?: string | null }>('GET', `/api/v1/executions?${qs}`, undefined, { label: 'liste des exécutions' });
      for (const e of page.data) {
        yield {
          id: e.id, finished: e.finished, mode: e.mode, retryOf: e.retryOf ?? null, retrySuccessId: e.retrySuccessId ?? null,
          startedAt: e.startedAt ?? null, stoppedAt: e.stoppedAt ?? null, workflowId: e.workflowId, status: e.status,
        };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** Résumé de l'erreur d'une exécution : nom du nœud et message, rien d'autre. */
  async errorSummary(executionId: string): Promise<N8nErrorSummary> {
    const e: any = await this.req('GET', `/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`, undefined, { label: `détail de l’exécution ${executionId}` });
    const rd = e?.data?.resultData ?? {};
    const err = rd.error ?? {};
    let node: string | null = err?.node?.name ?? rd.lastNodeExecuted ?? null;
    let message: string | null = err?.message ?? null;
    if (!message && rd.runData && node && Array.isArray(rd.runData[node])) {
      const last = rd.runData[node][rd.runData[node].length - 1];
      message = last?.error?.message ?? null;
    }
    if (err?.description && message && !message.includes(err.description)) message = `${message} — ${err.description}`;
    return { node: node ? String(node).slice(0, 200) : null, message: message ? String(message).slice(0, 1000) : null };
  }

  activate(workflowId: string) {
    return this.req('POST', `/api/v1/workflows/${encodeURIComponent(workflowId)}/activate`, undefined, { label: 'activation du workflow' });
  }

  deactivate(workflowId: string) {
    return this.req('POST', `/api/v1/workflows/${encodeURIComponent(workflowId)}/deactivate`, undefined, { label: 'désactivation du workflow' });
  }

  /** Relance : disponible seulement sur les versions récentes de n8n. */
  async retry(executionId: string): Promise<{ supported: boolean; newExecutionId?: string }> {
    try {
      const r: any = await this.req('POST', `/api/v1/executions/${encodeURIComponent(executionId)}/retry`, { loadWorkflow: true }, { label: 'relance de l’exécution' });
      return { supported: true, newExecutionId: r?.id != null ? String(r.id) : undefined };
    } catch (e) {
      if (e instanceof N8nError && (e.status === 404 || e.status === 405) && /not found|cannot post|405/i.test(e.message)) {
        return { supported: false };
      }
      throw e;
    }
  }
}
