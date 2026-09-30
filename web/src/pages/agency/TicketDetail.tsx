import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDateTime, fmtNum, TICKET_KIND, TICKET_STATUS } from '../../lib/format';
import { Async, Badge, Card, Empty, PageHead, useUi } from '../../components/ui';
import { TicketStatusBadge } from './shared';

interface Attachment { id: string; filename: string; mime: string; size_bytes: number }
interface Message { id: number; author_role: string; author_name: string | null; body: string; created_at: string; attachments: Attachment[] }
interface Ticket {
  id: number; client_id: string; client_name: string; workflow_id: string | null; workflow_name: string | null; kind: string; subject: string; status: string;
  created_at: string; updated_at: string; created_by_name: string | null; messages: Message[];
}

const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.xlsx,.xls,.docx,.doc';
const size = (b: number) => (b < 1024 ? `${b} o` : b < 1048576 ? `${fmtNum(b / 1024)} Ko` : `${fmtNum(b / 1048576, 1)} Mo`);

export default function TicketDetail() {
  const { id } = useParams();
  const r = useApi<Ticket>(`/api/admin/tickets/${id}`);
  useTitle(r.data ? `Demande n° ${r.data.id}` : 'Demande');
  return (
    <div className="stack">
      <Async {...r}>
        {(t) => (
          <>
            <PageHead crumb={<Link to="/agence/demandes">Demandes</Link>} title={t.subject}
              sub={<span className="row" style={{ gap: '.4rem' }}>
                <span>N° {t.id}</span>·<Link to={`/agence/clients/${t.client_id}`}>{t.client_name}</Link>
                {t.workflow_id && <>·<Link to={`/agence/workflows/${t.workflow_id}`}>{t.workflow_name}</Link></>}
                <Badge tone={t.kind === 'problem' ? 'warn' : undefined}>{TICKET_KIND[t.kind] ?? t.kind}</Badge>
                <TicketStatusBadge status={t.status} />
              </span>} />
            <div className="ag-2-1">
              <Card title="Conversation">
                {t.messages.length ? (
                  <div className="ag-thread">
                    {t.messages.map((m) => (
                      <div key={m.id} className={`msg ${m.author_role === 'admin' ? 'agency' : ''}`}>
                        <div className="meta">{m.author_role === 'admin' ? (m.author_name ? `${m.author_name} (agence)` : 'Agence') : `${m.author_name ?? 'Client'} (${t.client_name})`} · {fmtDateTime(m.created_at)}</div>
                        <div className="body">{m.body}</div>
                        {m.attachments.length > 0 && (
                          <div className="ag-attach">
                            {m.attachments.map((a) => <a key={a.id} href={`/api/admin/attachments/${a.id}`} download={a.filename}>📎 {a.filename} <span className="muted">({size(a.size_bytes)})</span></a>)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : <Empty>Aucun message.</Empty>}
              </Card>
              <Reply t={t} onSent={r.reload} />
            </div>
          </>
        )}
      </Async>
    </div>
  );
}

function Reply({ t, onSent }: { t: Ticket; onSent: () => void }) {
  const { toast } = useUi();
  const [body, setBody] = useState('');
  const [status, setStatus] = useState(t.status === 'new' ? 'in_progress' : t.status);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const tooBig = files.some((f) => f.size > 10 * 1024 * 1024);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('body', body);
    if (status !== t.status) fd.append('status', status);
    for (const f of files) fd.append('files', f, f.name);
    setBusy(true);
    try {
      await api.post(`/api/admin/tickets/${t.id}/messages`, fd);
      toast(body.trim() || files.length ? 'Réponse envoyée au client.' : 'Statut mis à jour.');
      setBody(''); setFiles([]); if (fileRef.current) fileRef.current.value = '';
      onSent();
    } catch (err: any) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const empty = !body.trim() && !files.length && status === t.status;
  return (
    <Card title="Répondre">
      <form className="form" onSubmit={submit}>
        <label className="field">Message<span className="help">Le client est prévenu par e-mail.</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="Votre réponse…" />
        </label>
        <label className="field">Pièces jointes<span className="help">5 fichiers maximum, 10 Mo chacun (images, PDF, texte, Excel, Word).</span>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 5))} />
        </label>
        {files.length > 0 && <div className="small muted">{files.map((f) => `${f.name} (${size(f.size)})`).join(' · ')}</div>}
        {tooBig && <div className="alert error small">Un fichier dépasse 10 Mo.</div>}
        <label className="field">Statut de la demande
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(TICKET_STATUS).map(([k, l]) => <option key={k} value={k}>{l}{k === t.status ? ' (actuel)' : ''}</option>)}
          </select>
        </label>
        <div className="ag-form-foot"><button className="btn primary" disabled={busy || empty || tooBig}>{busy ? 'Envoi…' : !body.trim() && !files.length && status !== t.status ? 'Mettre à jour le statut' : 'Envoyer la réponse'}</button></div>
      </form>
    </Card>
  );
}
