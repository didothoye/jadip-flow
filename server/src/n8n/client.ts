/**
 * Client minimal de l'API publique n8n (v1).
 * Seules des métadonnées sont conservées : les données traitées par les workflows ne quittent jamais cette couche.
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
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export class N8nClient {
  private base: string;
  constructor(baseUrl: string, private apiKey: string, private timeoutMs = 20000) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
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
      throw new N8nError(e?.name === 'AbortError' ? `Délai dépassé (${this.timeoutMs} ms)` : `Réseau : ${e?.cause?.code ?? e?.message ?? e}`);
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j: any = await res.json();
        if (j?.message) msg += ` — ${j.message}`;
      } catch { /* corps non JSON */ }
      throw new N8nError(msg, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async health(): Promise<{ reachable: boolean; authOk: boolean; message: string }> {
    try {
      await this.req('GET', '/api/v1/workflows?limit=1');
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
      const page = await this.req<{ data: any[]; nextCursor?: string | null }>('GET', `/api/v1/workflows?${qs}`);
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
      const page = await this.req<{ data: any[]; nextCursor?: string | null }>('GET', `/api/v1/executions?${qs}`);
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
    const e: any = await this.req('GET', `/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`);
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
    return this.req('POST', `/api/v1/workflows/${encodeURIComponent(workflowId)}/activate`);
  }

  deactivate(workflowId: string) {
    return this.req('POST', `/api/v1/workflows/${encodeURIComponent(workflowId)}/deactivate`);
  }

  /** Relance : disponible seulement sur les versions récentes de n8n. */
  async retry(executionId: string): Promise<{ supported: boolean; newExecutionId?: string }> {
    try {
      const r: any = await this.req('POST', `/api/v1/executions/${encodeURIComponent(executionId)}/retry`, { loadWorkflow: true });
      return { supported: true, newExecutionId: r?.id != null ? String(r.id) : undefined };
    } catch (e) {
      if (e instanceof N8nError && (e.status === 404 || e.status === 405) && /not found|cannot post|405/i.test(e.message)) {
        return { supported: false };
      }
      throw e;
    }
  }
}
