import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { ErrorBox, PageHead, useUi } from '../../components/ui';
import { FilePicker, type WfCard } from './shared';

const KINDS: { key: string; icon: string; title: string; desc: string; subject: string; body: string }[] = [
  { key: 'change', icon: '✏️', title: 'Demander une modification', desc: 'Changer ou ajouter quelque chose à une automatisation.',
    subject: 'Ex. : Ajouter la quantité dans le tableau des commandes', body: 'Décrivez ce que vous aimeriez changer et pourquoi. Un exemple aide beaucoup.' },
  { key: 'problem', icon: '⚠️', title: 'Signaler un problème', desc: 'Quelque chose ne marche pas comme prévu.',
    subject: 'Ex. : Une commande n’est pas arrivée dans le tableau', body: 'Que s’est-il passé ? Quand ? Qu’attendiez-vous à la place ? Une capture d’écran nous aide beaucoup.' },
  { key: 'question', icon: '💬', title: 'Poser une question', desc: 'Une interrogation, une idée, un besoin de conseil.',
    subject: 'Ex. : Peut-on recevoir les commandes aussi par SMS ?', body: 'Posez votre question, nous vous répondons rapidement.' },
];

export default function NewTicketPage() {
  useTitle('Nouvelle demande');
  const [params] = useSearchParams();
  const pre = params.get('automatisation') ?? '';
  const nav = useNavigate();
  const { toast } = useUi();
  const home = useApi<{ workflows: WfCard[] }>('/api/portal/home');
  const [kind, setKind] = useState(pre ? 'problem' : '');
  const [workflowId, setWorkflowId] = useState(pre);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const k = KINDS.find((x) => x.key === kind);
  const workflows = home.data?.workflows ?? [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!kind || !subject.trim() || !body.trim()) {
      setError(!kind ? 'Choisissez le type de votre demande.' : 'Merci d’indiquer un sujet et un message.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('subject', subject.trim());
      fd.append('body', body.trim());
      if (workflowId) fd.append('workflow_id', workflowId);
      for (const f of files) fd.append('files', f, f.name);
      const r = await api.post<{ id: number }>('/api/portal/tickets', fd);
      toast('Votre demande a bien été envoyée. Nous vous répondons rapidement.');
      nav(`/portail/demandes/${r.id}`, { replace: true });
    } catch (err: any) {
      setError(err.message ?? 'L’envoi a échoué. Réessayez dans un instant.');
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageHead crumb={<Link to="/portail/demandes">← Vos demandes</Link>} title="Nouvelle demande" sub="Quelques lignes suffisent : notre équipe revient vers vous rapidement." />
      <form className="card form" onSubmit={submit} noValidate>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: '.6rem' }}>Que souhaitez-vous faire ?</legend>
          <div className="p-kinds" role="radiogroup">
            {KINDS.map((x) => (
              <label key={x.key} className={`p-choice ${kind === x.key ? 'sel' : ''}`}>
                <input type="radio" name="kind" value={x.key} checked={kind === x.key} onChange={() => { setKind(x.key); setError(null); }} />
                <span className="emo" aria-hidden="true">{x.icon}</span>
                <span><span className="ct">{x.title}</span><br /><span className="cd">{x.desc}</span></span>
              </label>
            ))}
          </div>
          {tried && !kind && <div className="small" style={{ color: 'var(--bad)', marginTop: '.4rem' }}>Choisissez une des trois possibilités.</div>}
        </fieldset>

        <label className="field">Automatisation concernée <span className="help">Facultatif</span>
          <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} disabled={home.loading && !home.data}>
            <option value="">Aucune en particulier</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>

        <label className="field">Sujet
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder={k?.subject ?? 'En quelques mots'}
            aria-invalid={tried && !subject.trim()} required />
        </label>

        <label className="field">Votre message
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder={k?.body ?? 'Expliquez-nous en quelques phrases.'}
            aria-invalid={tried && !body.trim()} required />
        </label>

        <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
          <span style={{ fontWeight: 500, fontSize: '.9rem' }}>Pièces jointes <span className="help small muted" style={{ fontWeight: 400 }}>Facultatif</span></span>
          <FilePicker files={files} setFiles={setFiles} disabled={busy} />
        </div>

        <ErrorBox error={error} />
        <div className="p-actions mob-block" style={{ justifyContent: 'flex-end' }}>
          <Link to="/portail/demandes" className="btn p-lg">Annuler</Link>
          <button type="submit" className="btn primary p-lg" disabled={busy}>{busy ? 'Envoi en cours…' : 'Envoyer la demande'}</button>
        </div>
      </form>
    </div>
  );
}
