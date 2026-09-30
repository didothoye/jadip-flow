import { Link } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks';
import { fromNow, TICKET_KIND } from '../../lib/format';
import { Async, Empty, PageHead } from '../../components/ui';
import { KIND_ICON, TicketBadge } from './shared';

interface Ticket { id: number; kind: string; subject: string; status: string; created_at: string; updated_at: string; workflow_name: string | null; messages: number }

export default function TicketsPage() {
  useTitle('Vos demandes');
  const { data, error, loading } = useApi<Ticket[]>('/api/portal/tickets');
  const newBtn = <Link to="/portail/demandes/nouvelle" className="btn primary p-lg">＋ Nouvelle demande</Link>;
  return (
    <div className="stack">
      <PageHead title="Vos demandes" sub="Une modification, un problème, une question : écrivez-nous, nous vous répondons ici." actions={newBtn} />
      <Async data={data} error={error} loading={loading}>
        {(list) => list.length === 0 ? (
          <div className="card">
            <Empty>
              <div style={{ fontSize: '2rem' }} aria-hidden="true">✉️</div>
              <strong style={{ color: 'var(--text)' }}>Aucune demande pour le moment</strong>
              <div style={{ margin: '.3rem 0 1rem' }}>Besoin d’un changement ou d’un coup de main ? Nous sommes là.</div>
              {newBtn}
            </Empty>
          </div>
        ) : (
          <div className="card flush">
            <ul className="p-rows" style={{ margin: 0 }}>
              {list.map((t) => (
                <li key={t.id} style={{ padding: 0 }}>
                  <Link to={`/portail/demandes/${t.id}`} className="p-ticket">
                    <span className="ic" aria-hidden="true">{KIND_ICON[t.kind] ?? '✉️'}</span>
                    <span className="tmain">
                      <span className="subj">{t.subject}</span>
                      <span className="tmeta">
                        <TicketBadge status={t.status} />
                        <span className="small muted">{TICKET_KIND[t.kind] ?? t.kind}{t.workflow_name ? ` · ${t.workflow_name}` : ''} · mise à jour {fromNow(t.updated_at)}</span>
                      </span>
                    </span>
                    <span className="chev" aria-hidden="true">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Async>
    </div>
  );
}
