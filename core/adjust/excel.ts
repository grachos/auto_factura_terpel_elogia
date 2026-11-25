import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { XLSX_CONTENT_TYPE } from '../excel.js';
import { getReconRun } from '../recon/service.js';
import type { ProposalDto, ProposalLineDto, ReconRunDto } from '../types.js';
import { listProposals } from './service.js';
import type { AdjustDeps } from './service.js';

export const STATUS_LABEL: Record<string, string> = {
  proposed: 'Propuesta', needs_review: 'Requiere revisión', approved: 'Aprobada', applying: 'Aplicando', applied: 'Aplicada',
  simulated_applied: 'SIMULADA (Silogtran no se modificó)', failed: 'Falló', uncertain: 'Resultado incierto', verification_failed: 'Verificación fallida',
  rejected: 'Rechazada', stale: 'Obsoleta', discarded: 'Simulación descartada',
};

export interface AdjustLineRow { p: ProposalDto; l: ProposalLineDto }

export const ADJUST_COLUMNS: { header: string; width: number; value: (r: AdjustLineRow) => string | null }[] = [
  { header: 'Transporte', width: 14, value: (r) => r.p.transportNumber },
  { header: 'Remesa', width: 14, value: (r) => r.p.remesaCode },
  { header: 'Manifiesto', width: 14, value: (r) => r.p.manifest },
  { header: 'Campo', width: 18, value: (r) => r.l.label },
  { header: 'Valor actual', width: 16, value: (r) => r.l.current ?? 'no disponible en el informe' },
  { header: 'Valor propuesto', width: 16, value: (r) => r.l.proposed },
  { header: 'Regla', width: 50, value: (r) => r.l.rule },
  { header: 'Estado', width: 30, value: (r) => STATUS_LABEL[r.p.status] ?? r.p.status },
  { header: 'Simulado', width: 10, value: (r) => (r.p.simulated ? 'SÍ' : 'No') },
  { header: 'Generó', width: 20, value: (r) => r.p.generatedBy },
  { header: 'Aprobó', width: 20, value: (r) => r.p.approvedBy },
  { header: 'Aprobó el', width: 22, value: (r) => r.p.approvedAt },
  { header: 'Aplicó', width: 20, value: (r) => r.p.appliedBy },
  { header: 'Aplicó el', width: 22, value: (r) => r.p.appliedAt },
  { header: 'Cuenta de ajustes', width: 18, value: (r) => r.p.accountUser },
  { header: 'Motivo de revisión', width: 40, value: (r) => (r.p.reviewCode ? `${r.p.reviewCode}: ${r.p.reviewDetail ?? ''}` : r.p.lastError) },
];

export const flatten = (ps: ProposalDto[]): AdjustLineRow[] => ps.flatMap((p) => p.lines.map((l) => ({ p, l })));

export async function buildAdjustWorkbook(run: ReconRunDto, ps: ProposalDto[], generatedAt: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AutoFactura Terpel';
  wb.created = generatedAt;
  const ws = wb.addWorksheet('Ajustes', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = ADJUST_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  flatten(ps).forEach((r, i) => {
    const row = ws.getRow(i + 2);
    ADJUST_COLUMNS.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      cell.value = c.value(r);
      cell.numFmt = '@';
    });
    row.commit();
  });
  const wr = wb.addWorksheet('Revisión', { views: [{ state: 'frozen', ySplit: 1 }] });
  ['Transporte', 'Estado', 'Código', 'Detalle'].forEach((h, i) => { wr.getColumn(i + 1).width = i === 3 ? 60 : 24; wr.getRow(1).getCell(i + 1).value = h; });
  wr.getRow(1).font = { bold: true };
  ps.filter((p) => ['needs_review', 'failed', 'uncertain', 'verification_failed', 'stale'].includes(p.status)).forEach((p, i) => {
    [p.transportNumber, STATUS_LABEL[p.status], p.reviewCode, p.reviewDetail ?? p.lastError].forEach((v, j) => { wr.getRow(i + 2).getCell(j + 1).value = v ?? null; });
  });
  const wm = wb.addWorksheet('Resumen');
  wm.columns = [{ width: 40 }, { width: 70 }];
  const count = (s: string): number => ps.filter((p) => p.status === s).length;
  const rows: [string, string | number][] = [
    ['Conciliación', run.id], ['Rango de servicios', `${run.dateFrom} a ${run.dateTo}`], ['Generado (UTC)', generatedAt.toISOString()],
    ['Propuestas', ps.length], ['Requieren revisión', count('needs_review')], ['Propuestas sin aprobar', count('proposed')], ['Aprobadas', count('approved')],
    ['Aplicadas (reales)', count('applied')], ['Aplicaciones SIMULADAS', count('simulated_applied')], ['Fallidas / inciertas / verificación fallida', count('failed') + count('uncertain') + count('verification_failed')],
    ['Rechazadas', count('rejected')], ['Obsoletas', count('stale')],
    ['Nota', ps.some((p) => p.simulated) ? 'Hay aplicaciones SIMULADAS: Silogtran NO fue modificado y no deben tratarse como ajustadas.' : 'Sin aplicaciones simuladas.'],
  ];
  rows.forEach(([k, v], i) => { wm.getRow(i + 1).getCell(1).value = k; wm.getRow(i + 1).getCell(1).font = { bold: true }; wm.getRow(i + 1).getCell(2).value = v; });
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export async function generateAdjustExport(deps: AdjustDeps, runId: string, actor: string): Promise<{ path: string; rows: number }> {
  const run = await getReconRun(deps.db, runId);
  const ps = await listProposals(deps.db, { runFrom: run.dateFrom, runTo: run.dateTo });
  if (ps.length === 0) throw new AppError(409, 'NO_PROPOSALS', 'No hay propuestas de ajuste para este rango');
  const buf = await buildAdjustWorkbook(run, ps, new Date());
  const path = `recon/${runId}/ajustes-${randomUUID()}.xlsx`;
  await deps.storage.put(path, buf, XLSX_CONTENT_TYPE);
  await deps.db.query(`insert into adjustment_exports (run_id, storage_path, row_count, generated_by) values ($1,$2,$3,$4)`, [runId, path, ps.length, actor]);
  await audit(deps.db, actor, 'adjustment.export', 'reconciliation_run', runId, { proposals: ps.length });
  return { path, rows: ps.length };
}

export async function compareAdjustWorkbook(file: Buffer, ps: ProposalDto[]): Promise<string[]> {
  const diffs: string[] = [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Ajustes');
  if (!ws) return ['Falta la hoja "Ajustes"'];
  for (const n of ['Revisión', 'Resumen']) if (!wb.getWorksheet(n)) diffs.push(`Falta la hoja "${n}"`);
  const rows = flatten(ps);
  if (ws.rowCount - 1 !== rows.length) diffs.push(`Filas: Excel ${ws.rowCount - 1} vs BD ${rows.length}`);
  rows.forEach((r, i) => ADJUST_COLUMNS.forEach((c, j) => {
    const exp = c.value(r);
    const act = ws.getRow(i + 2).getCell(j + 1).value;
    if ((exp ?? null) !== (act ?? null)) diffs.push(`${r.p.transportNumber}/${c.header}: Excel "${String(act)}" vs BD "${String(exp)}"`);
  }));
  return diffs;
}
