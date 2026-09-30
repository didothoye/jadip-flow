import { useState } from 'react';
import { fmtDay, fmtNum, fmtUsd } from '../lib/format';

/**
 * Barres quotidiennes empilées (réussies / échecs).
 * Palette : série 1 (bleu) pour les réussites, rouge « critique » réservé aux échecs ;
 * légende toujours présente, info-bulle au survol, vue tableau accessible.
 */
export function DailyBars({ data, height = 180 }: { data: { day: string; success: number; failed: number; total: number }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = height;
  const pad = { l: 36, r: 8, t: 8, b: 24 };
  const max = Math.max(1, ...data.map((d) => d.success + d.failed));
  const nice = niceMax(max);
  const bw = (W - pad.l - pad.r) / Math.max(data.length, 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / nice);
  const ticks = [0, nice / 2, nice];
  const labelEvery = Math.ceil(data.length / 8);
  const h = hover !== null ? data[hover] : null;
  return (
    <div>
      <div className="legend" aria-hidden="true">
        <span><span className="sw" style={{ background: 'var(--series-1)' }} />Réussies</span>
        <span><span className="sw" style={{ background: 'var(--critical)' }} />Échecs</span>
      </div>
      <div className="chart" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Exécutions par jour sur ${data.length} jours : ${fmtNum(data.reduce((s, d) => s + d.total, 0))} au total`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--axis)">{fmtNum(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.l + i * bw + Math.max(1, bw * 0.15);
            const w = Math.max(2, bw * 0.7);
            const ys = y(d.success);
            const yf = y(d.success + d.failed);
            return (
              <g key={d.day}>
                {d.success > 0 && <rect x={x} y={ys} width={w} height={y(0) - ys} rx={Math.min(3, w / 2)} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.55} />}
                {d.failed > 0 && <rect x={x} y={yf} width={w} height={Math.max(2, ys - yf - (d.success > 0 ? 2 : 0))} rx={Math.min(3, w / 2)} fill="var(--critical)" opacity={hover === null || hover === i ? 1 : 0.55} />}
                {i % labelEvery === 0 && <text x={x + w / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--axis)">{fmtDay(d.day)}</text>}
                <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
              </g>
            );
          })}
        </svg>
        {h && hover !== null && (
          <div className="tip" style={{ left: `${((pad.l + hover * bw + bw / 2) / W) * 100}%`, top: `${(y(h.success + h.failed) / H) * 100}%` }}>
            <strong>{fmtDay(h.day)}</strong><br />
            Réussies : {fmtNum(h.success)}<br />
            Échecs : {fmtNum(h.failed)}
          </div>
        )}
      </div>
      <details className="table-view">
        <summary>Voir les données</summary>
        <table className="table small">
          <thead><tr><th>Jour</th><th className="num">Réussies</th><th className="num">Échecs</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.day}><td>{fmtDay(d.day)}</td><td className="num">{fmtNum(d.success)}</td><td className="num">{fmtNum(d.failed)}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

/** Barres simples (une série) : coûts par jour. */
export function CostBars({ data, height = 160 }: { data: { day: string; cost_usd: number }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = height;
  const pad = { l: 44, r: 8, t: 8, b: 24 };
  const nice = niceMax(Math.max(0.01, ...data.map((d) => d.cost_usd)));
  const bw = (W - pad.l - pad.r) / Math.max(data.length, 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / nice);
  const labelEvery = Math.ceil(data.length / 8);
  const h = hover !== null ? data[hover] : null;
  if (!data.length) return <div className="empty small">Aucun coût sur la période.</div>;
  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Coût des modèles d’IA par jour">
        {[0, nice / 2, nice].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--axis)">{fmtNum(t, t < 10 ? 2 : 0)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * bw + bw * 0.15;
          const w = Math.max(2, bw * 0.7);
          return (
            <g key={d.day}>
              <rect x={x} y={y(d.cost_usd)} width={w} height={Math.max(1, y(0) - y(d.cost_usd))} rx={Math.min(3, w / 2)} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.55} />
              {i % labelEvery === 0 && <text x={x + w / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--axis)">{fmtDay(d.day)}</text>}
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div className="tip" style={{ left: `${((pad.l + hover * bw + bw / 2) / W) * 100}%`, top: `${(y(h.cost_usd) / H) * 100}%` }}>
          <strong>{fmtDay(h.day)}</strong><br />{fmtUsd(h.cost_usd)}
        </div>
      )}
    </div>
  );
}

/** Barre horizontale proportionnelle (répartition). */
export function ShareBar({ value, max, tone = 'var(--series-1)' }: { value: number; max: number; tone?: string }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 4, height: 8, width: '100%', minWidth: 60 }}>
      <div style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%`, background: tone, height: 8, borderRadius: 4 }} />
    </div>
  );
}

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * p;
}
