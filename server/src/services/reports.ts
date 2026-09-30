import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { dataPath } from '../lib/files.js';
import { fmtDuration, fmtNumber, fmtUsd, monthLabel, periodBounds } from '../lib/time.js';
import { categoryLabels, type ErrorCategory } from './classify.js';
import { enqueue } from './notify.js';

export interface ReportSummary {
  client: { id: string; name: string; code: string };
  period: string;
  periodLabel: string;
  totals: { executions: number; success: number; failed: number; successRate: number | null; minutesSaved: number; costUsd: number; feeUsd: number | null };
  workflows: { name: string; executions: number; success: number; failed: number; successRate: number | null; minutesSaved: number; costUsd: number }[];
  errors: { category: string; label: string; count: number }[];
  costsByModel: { provider: string; model: string; costUsd: number }[];
}

export async function buildSummary(clientId: string, period: string): Promise<ReportSummary> {
  const c = await one<any>('SELECT id, name, code, monthly_fee_usd FROM clients WHERE id=$1', [clientId]);
  if (!c) throw new Error('Client introuvable');
  const { from, to } = periodBounds(period);
  const dayFrom = `${period}-01`;
  const [y, m] = period.split('-').map(Number);
  const dayTo = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const wfs = await q<any>(`
    SELECT COALESCE(w.display_name, w.name) name, w.minutes_saved_per_execution mps,
      count(e.id)::int executions, count(e.id) FILTER (WHERE e.status='success')::int success,
      count(e.id) FILTER (WHERE e.status IN ('error','crashed'))::int failed,
      COALESCE((SELECT sum(cost_usd) FROM llm_usage u WHERE u.workflow_id=w.id AND u.day >= $3 AND u.day < $4),0)::float cost
    FROM workflows w LEFT JOIN executions e ON e.workflow_id=w.id AND e.started_at >= $1 AND e.started_at < $2
    WHERE w.client_id=$5 AND w.client_visible AND (w.deleted_at IS NULL OR w.deleted_at >= $1)
    GROUP BY w.id ORDER BY 1`, [from, to, dayFrom, dayTo, clientId]);
  const errors = await q<any>(`SELECT COALESCE(error_category,'logic') category, count(*)::int n FROM executions
    WHERE client_id=$1 AND status IN ('error','crashed') AND started_at >= $2 AND started_at < $3 GROUP BY 1 ORDER BY 2 DESC`, [clientId, from, to]);
  const costsByModel = await q<any>(`SELECT provider, model, sum(cost_usd)::float cost FROM llm_usage WHERE client_id=$1 AND day >= $2 AND day < $3 GROUP BY 1,2 ORDER BY 3 DESC`, [clientId, dayFrom, dayTo]);
  const totalCost = (await one<any>(`SELECT COALESCE(sum(cost_usd),0)::float c FROM llm_usage WHERE client_id=$1 AND day >= $2 AND day < $3`, [clientId, dayFrom, dayTo]))!.c;
  const workflows = wfs.map((w) => {
    const fin = w.success + w.failed;
    return { name: w.name, executions: w.executions, success: w.success, failed: w.failed, successRate: fin ? w.success / fin : null, minutesSaved: w.success * Number(w.mps), costUsd: w.cost };
  });
  const sum = (k: 'executions' | 'success' | 'failed' | 'minutesSaved') => workflows.reduce((a, w) => a + w[k], 0);
  const fin = sum('success') + sum('failed');
  return {
    client: { id: c.id, name: c.name, code: c.code }, period, periodLabel: monthLabel(period),
    totals: { executions: sum('executions'), success: sum('success'), failed: sum('failed'), successRate: fin ? sum('success') / fin : null, minutesSaved: sum('minutesSaved'), costUsd: totalCost, feeUsd: c.monthly_fee_usd },
    workflows,
    errors: errors.map((e) => ({ category: e.category, label: categoryLabels[e.category as ErrorCategory] ?? e.category, count: e.n })),
    costsByModel: costsByModel.map((r) => ({ provider: r.provider, model: r.model, costUsd: r.cost })),
  };
}

const pct = (v: number | null) => (v === null ? '—' : `${fmtNumber(v * 100, 1)} %`);

// ------------------------------------------------------------------ PDF (fond blanc, bordures simples, Times 12)

export async function renderPdf(s: ReportSummary, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 }, info: { Title: `Rapport mensuel — ${s.client.name} — ${s.periodLabel}`, Author: config.brand.companyName } });
  const out = createWriteStream(path);
  doc.pipe(out);
  const W = doc.page.width - 100;
  const header = () => {
    doc.font('Times-Bold').fontSize(12).fillColor('black').text(config.brand.companyName, 50, 30, { width: W, align: 'left' });
    doc.font('Times-Roman').fontSize(12).text(config.brand.productName, 50, 30, { width: W, align: 'right' });
    doc.moveTo(50, 46).lineTo(50 + W, 46).lineWidth(0.5).strokeColor('black').stroke();
    doc.y = 60;
  };
  header();
  doc.on('pageAdded', header);

  doc.font('Times-Bold').fontSize(12).text(`Rapport mensuel des automatisations — ${s.periodLabel}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Times-Roman').text(`Client : ${s.client.name}`, { align: 'center' });
  doc.moveDown(1);

  const table = (headers: string[], rows: string[][], widths: number[]) => {
    const rowH = 20;
    const draw = (cells: string[], bold: boolean) => {
      if (doc.y + rowH > doc.page.height - 60) doc.addPage();
      const y = doc.y;
      let x = 50;
      cells.forEach((cell, i) => {
        doc.rect(x, y, widths[i], rowH).lineWidth(0.5).strokeColor('black').stroke();
        doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(12).fillColor('black')
          .text(cell, x + 4, y + 5, { width: widths[i] - 8, height: rowH - 4, align: i === 0 ? 'left' : 'right', ellipsis: true, lineBreak: false });
        x += widths[i];
      });
      doc.y = y + rowH;
      doc.x = 50;
    };
    draw(headers, true);
    rows.forEach((r) => draw(r, false));
    doc.moveDown(1);
  };
  const section = (t: string) => {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.font('Times-Bold').fontSize(12).text(t, 50);
    doc.moveDown(0.4);
  };

  section('Synthèse');
  const t = s.totals;
  table(['Indicateur', 'Valeur'], [
    ['Exécutions', fmtNumber(t.executions)],
    ['Exécutions réussies', fmtNumber(t.success)],
    ['Exécutions en échec', fmtNumber(t.failed)],
    ['Taux de réussite', pct(t.successRate)],
    ['Temps gagné estimé', fmtDuration(t.minutesSaved)],
    ['Coût des modèles d’IA', fmtUsd(t.costUsd)],
  ], [W * 0.6, W * 0.4]);

  section('Détail par automatisation');
  table(['Automatisation', 'Exécutions', 'Réussite', 'Temps gagné', 'Coût IA'],
    s.workflows.map((w) => [w.name, fmtNumber(w.executions), pct(w.successRate), fmtDuration(w.minutesSaved), fmtUsd(w.costUsd)]),
    [W * 0.4, W * 0.14, W * 0.14, W * 0.16, W * 0.16]);

  if (s.errors.length) {
    section('Incidents par nature');
    table(['Nature', 'Nombre'], s.errors.map((e) => [e.label, fmtNumber(e.count)]), [W * 0.6, W * 0.4]);
  }
  if (s.costsByModel.length) {
    section('Coûts par modèle d’IA');
    table(['Fournisseur et modèle', 'Coût'], s.costsByModel.map((c) => [`${c.provider} — ${c.model}`, fmtUsd(c.costUsd)]), [W * 0.6, W * 0.4]);
  }
  doc.font('Times-Roman').fontSize(12).text(`Document généré le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: config.timezone }).format(new Date())} par ${config.brand.productName}.`, 50);
  doc.end();
  await new Promise<void>((res, rej) => { out.on('finish', () => res()); out.on('error', rej); });
}

// ------------------------------------------------------------------ Excel (Times New Roman 12, bordures fines)

export async function renderXlsx(s: ReportSummary, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const wb = new ExcelJS.Workbook();
  wb.creator = config.brand.companyName;
  const font = { name: 'Times New Roman', size: 12 };
  const border = { top: { style: 'thin' as const }, left: { style: 'thin' as const }, bottom: { style: 'thin' as const }, right: { style: 'thin' as const } };
  const sheet = (name: string, title: string, headers: string[], rows: (string | number | null)[][], formats: (string | null)[], widths: number[]) => {
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });
    ws.getCell('A1').value = config.brand.companyName;
    ws.getCell('A1').font = { ...font, bold: true };
    ws.getCell('A2').value = title;
    ws.getCell('A2').font = { ...font, bold: true };
    ws.getCell('A3').value = `Client : ${s.client.name} — période : ${s.periodLabel}`;
    ws.getCell('A3').font = font;
    const hr = ws.getRow(5);
    headers.forEach((h, i) => {
      const c = hr.getCell(i + 1);
      c.value = h; c.font = { ...font, bold: true }; c.border = border; c.alignment = { vertical: 'middle', horizontal: i ? 'right' : 'left' };
    });
    rows.forEach((r, ri) => {
      const row = ws.getRow(6 + ri);
      r.forEach((v, i) => {
        const c = row.getCell(i + 1);
        c.value = v as any; c.font = font; c.border = border;
        if (formats[i]) c.numFmt = formats[i]!;
        c.alignment = { horizontal: i ? 'right' : 'left' };
      });
    });
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    return ws;
  };
  const t = s.totals;
  sheet('Synthèse', 'Rapport mensuel des automatisations', ['Indicateur', 'Valeur'], [
    ['Exécutions', t.executions], ['Exécutions réussies', t.success], ['Exécutions en échec', t.failed],
    ['Taux de réussite', t.successRate], ['Temps gagné estimé (heures)', Math.round((t.minutesSaved / 60) * 100) / 100], ['Coût des modèles d’IA ($US)', t.costUsd],
  ], [null, null], [40, 20]).getColumn(2).eachCell((c, r) => {
    if (r === 9) c.numFmt = '0.0%';
    else if (r === 11) c.numFmt = '#,##0.00 "$US"';
    else if (r === 10) c.numFmt = '#,##0.00';
    else if (r > 5) c.numFmt = '#,##0';
  });
  sheet('Automatisations', 'Détail par automatisation', ['Automatisation', 'Exécutions', 'Réussies', 'Échecs', 'Taux de réussite', 'Temps gagné (heures)', 'Coût IA ($US)'],
    s.workflows.map((w) => [w.name, w.executions, w.success, w.failed, w.successRate, Math.round((w.minutesSaved / 60) * 100) / 100, w.costUsd]),
    [null, '#,##0', '#,##0', '#,##0', '0.0%', '#,##0.00', '#,##0.00'], [48, 14, 14, 12, 18, 22, 16]);
  sheet('Incidents', 'Incidents par nature', ['Nature', 'Nombre'], s.errors.map((e) => [e.label, e.count]), [null, '#,##0'], [30, 14]);
  sheet('Coûts IA', 'Coûts par modèle d’IA', ['Fournisseur', 'Modèle', 'Coût ($US)'], s.costsByModel.map((c) => [c.provider, c.model, c.costUsd]), [null, null, '#,##0.00'], [20, 36, 16]);
  await wb.xlsx.writeFile(path);
}

export async function generateReport(clientId: string, period: string) {
  const s = await buildSummary(clientId, period);
  const base = `reports/${s.client.code}/${period}`;
  await renderPdf(s, dataPath(`${base}.pdf`));
  await renderXlsx(s, dataPath(`${base}.xlsx`));
  const r = await one<any>(`INSERT INTO reports(client_id, period, pdf_path, xlsx_path, summary) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (client_id, period) DO UPDATE SET pdf_path=EXCLUDED.pdf_path, xlsx_path=EXCLUDED.xlsx_path, summary=EXCLUDED.summary, created_at=now()
    RETURNING *`, [clientId, period, `${base}.pdf`, `${base}.xlsx`, JSON.stringify(s)]);
  return r;
}

export async function emailReport(reportId: string) {
  const r = await one<any>(`SELECT r.*, c.name client_name, c.report_emails, c.contact_email FROM reports r JOIN clients c ON c.id=r.client_id WHERE r.id=$1`, [reportId]);
  if (!r) throw new Error('Rapport introuvable');
  const to: string[] = r.report_emails?.length ? r.report_emails : r.contact_email ? [r.contact_email] : [];
  if (!to.length) throw new Error('Aucun destinataire configuré pour ce client');
  const label = monthLabel(r.period);
  for (const addr of to) {
    await enqueue({
      channel: 'email', recipient: addr, bypassQuiet: true,
      subject: `Rapport mensuel de vos automatisations — ${label}`,
      body: `Bonjour,\n\nVeuillez trouver ci-joint le rapport mensuel de vos automatisations pour ${label} (PDF et Excel).\n\nVous pouvez aussi le consulter à tout moment dans votre espace : ${config.publicUrl}/portail/rapports\n\nCordialement,\n${config.brand.companyName}`,
      attachments: [
        { filename: `Rapport-${r.period}.pdf`, path: dataPath(r.pdf_path) },
        { filename: `Rapport-${r.period}.xlsx`, path: dataPath(r.xlsx_path) },
      ],
    });
  }
  await q('UPDATE reports SET emailed_at=now() WHERE id=$1', [reportId]);
  return to.length;
}

/** Génération mensuelle pour tous les clients (et envoi si activé). */
export async function monthlyReports(period: string, send = true) {
  const clients = await q<any>(`SELECT id, report_email_enabled FROM clients WHERE archived_at IS NULL`);
  let generated = 0;
  let sent = 0;
  for (const c of clients) {
    const existing = await one<any>('SELECT id, emailed_at FROM reports WHERE client_id=$1 AND period=$2', [c.id, period]);
    const r = existing ?? (await generateReport(c.id, period));
    if (!existing) generated++;
    if (send && c.report_email_enabled && !r.emailed_at) {
      try { await emailReport(r.id); sent++; } catch { /* destinataire manquant : visible dans l'interface */ }
    }
  }
  return { generated, sent };
}

export async function profitability(period: string) {
  const [y, m] = period.split('-').map(Number);
  const dayFrom = `${period}-01`;
  const dayTo = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const rows = await q<any>(`
    SELECT c.id, c.name, c.is_internal, c.monthly_fee_usd::float fee,
      COALESCE((SELECT sum(cost_usd) FROM llm_usage u WHERE u.client_id=c.id AND u.day >= $1 AND u.day < $2),0)::float llm_cost,
      (SELECT count(*)::int FROM workflows w WHERE w.client_id=c.id AND w.deleted_at IS NULL AND w.active) workflows_active
    FROM clients c WHERE c.archived_at IS NULL ORDER BY c.is_internal, c.name`, [dayFrom, dayTo]);
  return rows.map((r) => ({ ...r, margin: r.fee != null ? r.fee - r.llm_cost : null, margin_rate: r.fee ? (r.fee - r.llm_cost) / r.fee : null }));
}

export const reportFileExists = (p: string | null) => !!p && existsSync(dataPath(p));
