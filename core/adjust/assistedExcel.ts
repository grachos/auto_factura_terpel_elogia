import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { audit } from '../audit.js';
import { XLSX_CONTENT_TYPE } from '../excel.js';
import { log } from '../logger.js';
import type { AssistedItemDto, AssistedRunDetailDto, AssistedCategory } from '../types.js';
import { getAssistedRun } from './assisted.js';
import type { AdjustDeps } from './service.js';

export const CATEGORY_LABEL: Record<AssistedCategory, string> = {
  terpel_pending: 'Pendiente de Terpel (volumen 0)', ambiguous: 'Ambiguo', no_match: 'Sin coincidencia en Silogtran', insufficient: 'Datos insuficientes',
  already_adjusted: 'Ya ajustado', needs_review: 'Requiere revisión', not_allowed: 'Fuera de la lista de remesas permitidas', applied: 'Ya aplicada',
  attention: 'Requiere atención', not_eligible: 'No elegible para el modo asistido',
};
const RESULT_LABEL: Record<string, string> = { applied: 'Aplicada', skipped: 'Omitida', halted: 'Detenida', failed: 'Falló', pending: 'Pendiente (sin tocar)' };
const fmt = (v: { peso: string; cantidad: string; tarifa: string } | null): string => (v ? `peso ${v.peso}, cantidad ${v.cantidad}, tarifa ${v.tarifa}` : '');

export const APPLIED_HEADERS = ['Transporte', 'Remesa', 'Antes', 'Después', 'Reversa', 'Resultado', 'Simulada'];

export function appliedRows(d: AssistedRunDetailDto): string[][] {
  return d.items.filter((i) => i.result === 'applied').map((i) => [i.transportNumber ?? '', i.remesaCode ?? '', fmt(i.before), fmt(i.after), fmt(i.reversal), i.reason ?? '', d.run.simulated ? 'SÍ' : 'No']);
}

export async function buildAssistedWorkbook(d: AssistedRunDetailDto, generatedAt: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AutoFactura Terpel';
  wb.created = generatedAt;
  const sheet = (name: string, headers: string[], rows: string[][], widths: number[]): void => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = headers.map((h, i) => ({ header: h, width: widths[i] ?? 24 }));
    ws.getRow(1).font = { bold: true };
    rows.forEach((r, i) => r.forEach((v, j) => { const c = ws.getRow(i + 2).getCell(j + 1); c.value = v === '' ? null : v; c.numFmt = '@'; }));
  };
  const r = d.run;
  const ws = wb.addWorksheet('Resumen');
  ws.columns = [{ width: 46 }, { width: 80 }];
  const byCat = (c: AssistedCategory): number => r.excluded.filter((e) => e.category === c).length;
  const lines: [string, string | number][] = [
    ['Corrida asistida', r.id], ['Conciliación', r.reconRunId], ['Estado', r.status === 'completed' ? 'Completada' : r.status === 'halted' ? 'DETENIDA' : 'En curso'],
    ['Modo del escritor', r.simulated ? 'SIMULADO: Silogtran no se modificó' : 'ESCRITURA REAL en Silogtran'], ['Generado (UTC)', generatedAt.toISOString()],
    ['Propuestas en la corrida', r.total], ['Aplicadas', r.applied], ['Omitidas', r.skipped], ['Pendientes (sin tocar)', r.pending],
    ['Motivo de la detención', r.haltedReason ?? '—'],
    ['Pendiente de Terpel (volumen 0)', byCat('terpel_pending')], ['Ambiguos', byCat('ambiguous')], ['Sin coincidencia', byCat('no_match')], ['Ya ajustado', byCat('already_adjusted')],
    ['Otras excluidas (revisión, lista, atención)', r.excluded.length - byCat('terpel_pending') - byCat('ambiguous') - byCat('no_match') - byCat('already_adjusted')],
    ['Facturación', 'Pendiente (fase 4, no implementada)'],
  ];
  lines.forEach(([k, v], i) => { const row = ws.getRow(i + 1); row.getCell(1).value = k; row.getCell(1).font = { bold: true }; row.getCell(2).value = v; });
  sheet('Aplicadas', APPLIED_HEADERS, appliedRows(d), [14, 14, 40, 40, 40, 50, 10]);
  const notDone = d.items.filter((i: AssistedItemDto) => i.result !== 'applied');
  sheet('Omitidas y detenidas', ['Transporte', 'Remesa', 'Resultado', 'Motivo'], notDone.map((i) => [i.transportNumber ?? '', i.remesaCode ?? '', RESULT_LABEL[i.result] ?? i.result, i.reason ?? '']), [14, 14, 22, 100]);
  sheet('Excluidas del plan', ['Transporte', 'Remesa', 'Categoría', 'Motivo'], r.excluded.map((e) => [e.transportNumber, e.remesaCode ?? '', CATEGORY_LABEL[e.category] ?? e.category, e.reason]), [14, 14, 40, 100]);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export async function generateAssistedExport(deps: Pick<AdjustDeps, 'db' | 'storage'>, runId: string, actor: string | null): Promise<string> {
  const d = await getAssistedRun(deps.db, runId);
  const buf = await buildAssistedWorkbook(d, new Date());
  const path = `assisted/${runId}/informe-${randomUUID()}.xlsx`;
  await deps.storage.put(path, buf, XLSX_CONTENT_TYPE);
  await deps.db.query('update assisted_runs set export_path = $2 where id = $1', [runId, path]);
  await audit(deps.db, actor, 'assisted.export', 'assisted_run', runId, { applied: d.run.applied });
  log('assisted.export', { runId });
  return path;
}
