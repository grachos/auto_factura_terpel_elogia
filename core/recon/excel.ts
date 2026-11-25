import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { log } from '../logger.js';
import type { DifferenceDto, ReconResultDto, ReconRunDto, TraceStepDto } from '../types.js';
import { XLSX_CONTENT_TYPE } from '../excel.js';
import { getReconRun, listResults } from './service.js';
import type { ReconDeps } from './service.js';

export const STATUS_LABEL: Record<string, string> = {
  EXACT: 'Exacto',
  MATCH_WITH_DIFFERENCES: 'Coincide con diferencias',
  AMBIGUOUS: 'Ambiguo (revisar)',
  NO_MATCH: 'Sin registro en Silogtran',
  INSUFFICIENT_DATA: 'Datos insuficientes',
};
const FILTER_LABEL: Record<string, string> = { driver: 'conductor', plate: 'placa', route: 'ruta', date: 'fecha' };
const FIELD_LABEL: Record<string, string> = { volume: 'volumen', value: 'valor', plate: 'placa', driver: 'conductor', route: 'ruta', date: 'fecha' };

export function traceText(trace: TraceStepDto[]): string {
  return trace
    .map((t) => {
      const base = `${FILTER_LABEL[t.filter] ?? t.filter}: ${t.before}→${t.after}${t.mode === 'preferred' ? ' (preferente)' : ''}`;
      if (!t.skipped) return base;
      const why = t.reason === 'inactive' ? 'inactivo' : t.reason === 'would_empty' ? 'ignorado: dejaría 0' : 'sin dato de Terpel';
      return `${base} [${why}]`;
    })
    .join(' | ');
}

export function diffText(diffs: DifferenceDto[]): string {
  return diffs
    .map((d) => (d.note ? d.note : `${FIELD_LABEL[d.field] ?? d.field}: Terpel ${d.terpel ?? '—'} vs Silogtran ${d.silogtran ?? '—'} (${d.severity === 'adjustable' ? 'ajustable' : 'informativa'})`))
    .join(' | ');
}

type V = string | number | null;
interface Col {
  header: string;
  type: 'text' | 'dec4' | 'date';
  width: number;
  value: (r: ReconResultDto) => V;
}

const num = (v: string | null | undefined): V => (v === null || v === undefined ? null : Number(v));

export const RECON_COLUMNS: Col[] = [
  { header: 'Transporte', type: 'text', width: 14, value: (r) => r.transportNumber },
  { header: 'Fecha descargue (Terpel)', type: 'date', width: 14, value: (r) => r.serviceDate },
  { header: 'Ruta (Terpel)', type: 'text', width: 30, value: (r) => r.terpel.route },
  { header: 'Placa (Terpel)', type: 'text', width: 10, value: (r) => r.terpel.plate },
  { header: 'Cédula/código conductor (Terpel)', type: 'text', width: 16, value: (r) => r.terpel.driverCode },
  { header: 'Volumen galones (Terpel)', type: 'dec4', width: 16, value: (r) => num(r.terpel.volume) },
  { header: 'Valor neto (Terpel)', type: 'dec4', width: 16, value: (r) => num(r.terpel.netValue) },
  { header: 'Estado', type: 'text', width: 24, value: (r) => STATUS_LABEL[r.status] ?? r.status },
  { header: 'Manifiesto (Silogtran)', type: 'text', width: 14, value: (r) => r.silog?.manifest ?? null },
  { header: 'Remesa (Silogtran)', type: 'text', width: 12, value: (r) => r.silog?.remesaCode ?? null },
  { header: 'Fecha despacho (Silogtran)', type: 'date', width: 14, value: (r) => r.silog?.dispatchDate ?? null },
  { header: 'Placa (Silogtran)', type: 'text', width: 10, value: (r) => r.silog?.plate ?? null },
  { header: 'Origen (Silogtran)', type: 'text', width: 18, value: (r) => r.silog?.origin ?? null },
  { header: 'Destino (Silogtran)', type: 'text', width: 18, value: (r) => r.silog?.destination ?? null },
  { header: 'Peso remesa (Silogtran)', type: 'dec4', width: 16, value: (r) => num(r.silog?.remesaWeight) },
  { header: 'Peso neto cargue (Silogtran)', type: 'dec4', width: 16, value: (r) => num(r.silog?.netLoadWeight) },
  { header: 'Tarifa remesa (Silogtran)', type: 'dec4', width: 16, value: (r) => num(r.silog?.rate) },
  { header: 'Total remesa (Silogtran)', type: 'dec4', width: 16, value: (r) => num(r.silog?.totalRemesa) },
  { header: 'Estado Silogtran', type: 'text', width: 12, value: (r) => r.silog?.status ?? null },
  { header: 'Estado remesa', type: 'text', width: 14, value: (r) => r.silog?.remesaStatus ?? null },
  { header: 'Factura', type: 'text', width: 14, value: (r) => r.silog?.invoice ?? null },
  { header: 'Diferencias', type: 'text', width: 60, value: (r) => diffText(r.differences) || null },
  { header: 'Traza de filtros', type: 'text', width: 60, value: (r) => traceText(r.trace) || null },
  { header: 'Motivo', type: 'text', width: 40, value: (r) => r.reason },
  { header: 'Elegido manualmente por', type: 'text', width: 24, value: (r) => (r.manual ? (r.resolvedBy ?? 'sí') : null) },
];

function cell(col: Col, raw: V): ExcelJS.CellValue {
  if (raw === null || raw === '') return null;
  if (col.type === 'dec4') return Number(raw);
  if (col.type === 'date') return new Date(`${String(raw)}T00:00:00Z`);
  return String(raw);
}

export async function buildReconWorkbook(run: ReconRunDto, results: ReconResultDto[], generatedAt: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AutoFactura Terpel';
  wb.created = generatedAt;
  const ws = wb.addWorksheet('Conciliación', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = RECON_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  results.forEach((r, i) => {
    const row = ws.getRow(i + 2);
    RECON_COLUMNS.forEach((c, j) => {
      const x = row.getCell(j + 1);
      x.value = cell(c, c.value(r));
      if (c.type === 'text') x.numFmt = '@';
      if (c.type === 'dec4') x.numFmt = '0.0000';
      if (c.type === 'date') x.numFmt = 'yyyy-mm-dd';
    });
    row.commit();
  });

  const wi = wb.addWorksheet('Incidencias', { views: [{ state: 'frozen', ySplit: 1 }] });
  const review = results.filter((r) => r.status === 'AMBIGUOUS' || r.status === 'NO_MATCH' || r.status === 'INSUFFICIENT_DATA');
  ['Transporte', 'Estado', 'Motivo', 'Candidatos', 'Traza de filtros'].forEach((h, i) => {
    wi.getColumn(i + 1).width = i === 0 ? 14 : i === 1 ? 24 : 50;
    wi.getRow(1).getCell(i + 1).value = h;
  });
  wi.getRow(1).font = { bold: true };
  review.forEach((r, i) => {
    const row = wi.getRow(i + 2);
    const cands = r.candidates.map((c) => `${c.manifest}/${c.remesaCode} (${c.dispatchDate ?? '—'}, ${c.plate ?? '—'})`).join('; ');
    [r.transportNumber, STATUS_LABEL[r.status], r.reason, cands, traceText(r.trace)].forEach((v, j) => {
      const x = row.getCell(j + 1);
      x.value = v || null;
      x.numFmt = '@';
    });
    row.commit();
  });

  const wr = wb.addWorksheet('Resumen');
  wr.columns = [{ width: 38 }, { width: 70 }];
  const counts = (s: string): number => results.filter((r) => r.status === s).length;
  const summary: [string, string | number][] = [
    ['Conciliación', run.id],
    ['Rango de servicios (fecha de descargue)', `${run.dateFrom} a ${run.dateTo}`],
    ['Ventana despacho→descargue (días)', run.windowDays],
    ['Silogtran consultado desde (días antes)', run.lookbackDays],
    ['Versión de reglas', run.rulesVersion],
    ['Generado (UTC)', generatedAt.toISOString()],
    ['Servicios', results.length],
    ['Exactos', counts('EXACT')],
    ['Coinciden con diferencias', counts('MATCH_WITH_DIFFERENCES')],
    ['Ambiguos', counts('AMBIGUOUS')],
    ['Sin registro en Silogtran', counts('NO_MATCH')],
    ['Datos insuficientes', counts('INSUFFICIENT_DATA')],
    ['Huella sha256 del contenido (hoja Conciliación)', contentFingerprint(results)],
  ];
  summary.forEach(([k, v], i) => {
    const row = wr.getRow(i + 1);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = typeof v === 'number' ? v : String(v);
  });
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export function contentFingerprint(results: ReconResultDto[]): string {
  return createHash('sha256').update(JSON.stringify(results.map((r) => RECON_COLUMNS.map((c) => c.value(r))))).digest('hex');
}

export async function generateReconExport(deps: Pick<ReconDeps, 'db' | 'storage'>, runId: string, actor: string | null): Promise<{ status: 'ready' | 'failed' }> {
  const run = await getReconRun(deps.db, runId);
  if (run.status !== 'completed') throw new AppError(409, 'RUN_NOT_COMPLETED', 'La conciliación aún no termina; no se puede generar el Excel');
  try {
    const results = await listResults(deps.db, runId, null, 100_000);
    const buf = await buildReconWorkbook(run, results, new Date());
    const path = `recon/${runId}/${randomUUID()}.xlsx`;
    await deps.storage.put(path, buf, XLSX_CONTENT_TYPE);
    await deps.db.query(`update reconciliation_runs set export_status='ready', export_path=$2 where id=$1`, [runId, path]);
    await audit(deps.db, actor, 'recon_export.generate', 'reconciliation_run', runId, { rows: results.length });
    log('recon.export_ready', { runId, rows: results.length });
    return { status: 'ready' };
  } catch {
    await deps.db.query(`update reconciliation_runs set export_status='failed' where id=$1`, [runId]);
    log('recon.export_failed', { runId });
    return { status: 'failed' };
  }
}

/** Relee el .xlsx y lo compara con los resultados de la BD. Vacío = concuerda. */
export async function compareReconWorkbook(file: Buffer, results: ReconResultDto[]): Promise<string[]> {
  const diffs: string[] = [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Conciliación');
  if (!ws) return ['Falta la hoja "Conciliación"'];
  for (const n of ['Incidencias', 'Resumen']) if (!wb.getWorksheet(n)) diffs.push(`Falta la hoja "${n}"`);
  if (ws.rowCount - 1 !== results.length) diffs.push(`Filas: Excel ${ws.rowCount - 1} vs BD ${results.length}`);
  results.forEach((r, i) => {
    RECON_COLUMNS.forEach((col, j) => {
      const c = ws.getRow(i + 2).getCell(j + 1);
      const exp = col.value(r);
      const where = `${r.transportNumber}/${col.header}`;
      if (exp === null || exp === '') {
        if (c.value !== null && c.value !== undefined) diffs.push(`${where}: se esperaba vacío`);
        return;
      }
      const actual = col.type === 'dec4' ? Number(c.value).toFixed(4) : col.type === 'date' ? (c.value instanceof Date ? c.value.toISOString().slice(0, 10) : String(c.value)) : String(c.value);
      const want = col.type === 'dec4' ? Number(exp).toFixed(4) : String(exp);
      if (actual !== want) diffs.push(`${where}: Excel "${actual}" vs BD "${want}"`);
    });
  });
  return diffs;
}
