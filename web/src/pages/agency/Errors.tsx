import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useTitle } from '../../lib/hooks';
import { CATEGORY_LABELS, fmtNum } from '../../lib/format';
import { Card, ErrorBox, Loading, PageHead } from '../../components/ui';
import { ClientSelect, ErrorTable, PillTabs, useClientList, useMarkHandled, type ErrorRow } from './shared';

const PAGE = 100;

export default function Errors() {
  useTitle('Erreurs');
  const [sp, setSp] = useSearchParams();
  const category = sp.get('categorie') ?? '';
  const client = sp.get('client') ?? '';
  const scope = sp.get('etat') === 'toutes' ? 'all' : 'unhandled';
  const set = (k: string, v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); n.delete('non_traitees'); return n; }, { replace: true });
  const { clients } = useClientList();
  const [items, setItems] = useState<ErrorRow[]>([]);
  const [cats, setCats] = useState<{ category: string; n: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const base = `/api/admin/errors${qs({ category, client_id: client, unhandled: scope === 'unhandled' || undefined, limit: PAGE })}`;
  const load = async (before?: number) => {
    setLoading(true);
    try {
      const r = await api.get<{ items: ErrorRow[]; categories: { category: string; n: number }[] }>(before ? `${base}&before=${before}` : base);
      setItems((prev) => (before ? [...prev, ...r.items.filter((x) => !prev.some((y) => y.id === x.id))] : r.items));
      setCats(r.categories);
      setHasMore(r.items.length === PAGE);
      setError(null);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  const reload = () => { setSelected(new Set()); load(); };
  useEffect(() => { reload(); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  const { mark, busy } = useMarkHandled(reload);
  const total = cats.reduce((s, c) => s + c.n, 0);
  return (
    <div className="stack">
      <PageHead title="Erreurs" sub="Exécutions en échec, classées par catégorie. Traitez-les pour garder une vue nette." />
      <Card>
        <div className="stack" style={{ gap: '.75rem' }}>
          <div>
            <div className="small muted" style={{ marginBottom: '.4rem' }}>Catégories (échecs des 7 derniers jours)</div>
            <div className="ag-chips">
              <button className={`ag-chip ${!category ? 'active' : ''}`} onClick={() => set('categorie', '')}>Toutes <span className="n">{fmtNum(total)}</span></button>
              {Object.entries(CATEGORY_LABELS).map(([k, l]) => (
                <button key={k} className={`ag-chip ${category === k ? 'active' : ''}`} onClick={() => set('categorie', category === k ? '' : k)}>
                  {l} <span className="n">{fmtNum(cats.find((c) => c.category === k)?.n ?? 0)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="filters" style={{ marginBottom: 0 }}>
            <PillTabs label="État" value={scope} onChange={(v) => set('etat', v === 'all' ? 'toutes' : '')} options={[['unhandled', 'Non traitées'], ['all', 'Toutes']]} />
            <ClientSelect value={client} onChange={(v) => set('client', v)} clients={clients} />
          </div>
          {selected.size > 0 && (
            <div className="ag-sticky-actions">
              <strong>{selected.size} sélectionnée(s)</strong>
              <button className="btn small primary" disabled={busy} onClick={() => mark([...selected])}>Marquer comme traitées</button>
              <button className="btn small ghost" onClick={() => setSelected(new Set())}>Annuler la sélection</button>
            </div>
          )}
          <ErrorBox error={error} />
          {loading && !items.length ? <Loading /> : (
            <ErrorTable rows={items} onChanged={reload} selectable selected={selected} setSelected={setSelected}
              empty={scope === 'unhandled' ? 'Aucune erreur à traiter. Tout est en ordre.' : 'Aucune erreur pour ces critères.'} />
          )}
          {hasMore && (
            <div className="ag-more"><button className="btn" disabled={loading} onClick={() => load(items[items.length - 1]?.id)}>{loading ? 'Chargement…' : 'Charger plus'}</button></div>
          )}
        </div>
      </Card>
    </div>
  );
}
