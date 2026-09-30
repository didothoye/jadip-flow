import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDate, fmtDateTime, fromNow, TICKET_KIND } from '../../lib/format';
import { Async, Card, ErrorBox, PageHead, useUi } from '../../components/ui';
import { cap, FilePicker, fmtSize, TicketBadge } from './shared';

interface Attachment { id: string; filename: string; size_bytes: number; mime?: string }
interface Message { id: number; author_role: 'client' | 'admin'; author_name: string | null; body: string; created_at: string; attachments: Attachment[] }
interface Ticket { id: number; kind: string; subject: string; status: string; workflow_name: string | null; created_at: string; messages: Message[] }

const STEPS = [
  { key: 'new', label: 'Envoyée' },
  { key: 'in_progress', label: 'En cours de traitement' },
  { key: 'done', label: 'Terminée' },
];

export default function TicketPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<Ticket>(`/api/portal/tickets/${id}`, [id]);
  useTitle(data ? data.subject : 'Demande');
  return (
    <div className="stack">
      <Async data={data} error={error} loading={loading}>
        {(t) => (
          <>
            <PageHead
              crumb={<Link to="/portail/demandes">← Vos demandes</Link>}
              title={t.subject}
              sub={<>{TICKET_KIND[t.kind] ?? t.kind}{t.workflow_name ? <> · <strong>{t.workflow_name}</strong></> : null} · envoyée le {fmtDate(t.created_at)}</>}
              actions={<TicketBadge status={t.status} />}
            />
            <Progress status={t.status} />
            <Card title="Échanges">
              <Thread t={t} />
            </Card>
            <Reply t={t} onSent={reload} />
          </>
        )}
      </Async>
    </div>
  );
}

function Progress({ status }: { status: string }) {
  const idx = status === 'new' ? 0 : status === 'done' || status === 'closed' ? 2 : 1;
  return (
    <div className="card">
      <ol className="p-steps" aria-label="Avancement de la demande">
        {STEPS.map((s, i) => (
          <li key={s.key} className={i < idx || (i === idx && idx === 2) ? 'done' : i === idx ? 'cur' : ''} aria-current={i === idx ? 'step' : undefined}>
            <span className="n">{i < idx || (i === idx && idx === 2) ? '✓' : i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>
      {status === 'waiting_client' && (
        <div className="alert warn" style={{ marginTop: '.9rem' }}>Nous attendons votre réponse pour avancer. Répondez simplement ci-dessous.</div>
      )}
      {status === 'closed' && (
        <div className="alert info" style={{ marginTop: '.9rem' }}>Cette demande est fermée.</div>
      )}
    </div>
  );
}

function Thread({ t }: { t: Ticket }) {
  const { brand } = useAuth();
  const { user } = useAuth();
  if (!t.messages.length) return <div className="empty small">Aucun message pour le moment.</div>;
  return (
    <div className="p-thread">
      {t.messages.map((m) => {
        const agency = m.author_role === 'admin';
        const mine = !agency && m.author_name === user?.name;
        const who = agency ? (brand?.companyName ?? 'Jadip Services') : mine ? 'Vous' : (m.author_name ?? 'Votre équipe');
        return (
          <article key={m.id} className={`msg ${agency ? 'agency' : 'mine'}`} aria-label={`Message de ${who}`}>
            <div className="meta"><span className="who">{agency ? '🛠️ ' : ''}{who}</span> · <time dateTime={m.created_at} title={fmtDateTime(m.created_at)}>{cap(fromNow(m.created_at))}</time></div>
            <div className="body">{m.body}</div>
            {m.attachments.length > 0 && (
              <div className="p-att">
                {m.attachments.map((a) => (
                  <a key={a.id} href={`/api/portal/attachments/${a.id}`} download={a.filename} title={`Télécharger ${a.filename}`}>
                    <span aria-hidden="true">📎</span><span className="fn">{a.filename}</span><span className="muted small nowrap">{fmtSize(a.size_bytes)}</span>
                  </a>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function Reply({ t, onSent }: { t: Ticket; onSent: () => void }) {
  const { toast } = useUi();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (t.status === 'closed') {
    return (
      <div className="card row between">
        <span className="muted">Cette demande est fermée : il n’est plus possible d’y répondre.</span>
        <Link className="btn primary" to="/portail/demandes/nouvelle">Nouvelle demande</Link>
      </div>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim() && !files.length) { setError('Écrivez un message ou joignez un fichier.'); return; }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('body', body.trim());
      for (const f of files) fd.append('files', f, f.name);
      await api.post(`/api/portal/tickets/${t.id}/messages`, fd);
      setBody('');
      setFiles([]);
      toast('Votre message a bien été envoyé.');
      onSent();
    } catch (err: any) {
      setError(err.message ?? 'L’envoi a échoué.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card form" onSubmit={submit}>
      <label className="field">Votre réponse
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Écrivez votre message…" disabled={busy} />
      </label>
      <FilePicker files={files} setFiles={setFiles} disabled={busy} />
      <ErrorBox error={error} />
      <div className="p-actions mob-block" style={{ justifyContent: 'flex-end' }}>
        <button type="submit" className="btn primary p-lg" disabled={busy}>{busy ? 'Envoi en cours…' : 'Envoyer'}</button>
      </div>
    </form>
  );
}
