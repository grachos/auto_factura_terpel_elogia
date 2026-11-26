import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { audit } from '../audit.js';
import { XLSX_CONTENT_TYPE } from '../excel.js';
import { log } from '../logger.js';
import type { InvoiceRunDetailDto } from '../types.js';
import { getInvoiceRun } from './runs.js';
import type { InvoiceDeps } from './service.js';

const RESULT_LABEL: Record<string, string> = { issued: 'Facturada', skipped: 'Omitida', halted: 'Detenida', failed: 'Falló', pending: 'Pendiente (sin tocar)' };

export const ISSUED_HEADERS = ['Transporte', 'Remesa', 'Nº de factura', 'Flete', 'Retefuente', 'Total', 'Simulada'];
export const issuedRows = (d: InvoiceRunDetailDto): string[][] =>
  d.items.filter((i) => i.result === 'issued').map((i) => [i.transportNumber ?? '', i.remesaCode ?? '', i.invoiceNumber ?? '', i.amounts?.freight ?? '', i.amounts?.withholding ?? '', i.amounts?.total ?? '', d.run.simulated ? 'SÍ' : 'No']);

export async function buildInvoiceWorkbook(d: InvoiceRunDetailDto, generatedAt: Date): Promise<Buffer> {
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
  const uncertain = d.items.filter((i) => i.result === 'halted').length;
  const lines: [string, string | number][] = [
    ['Corrida de facturación', r.id], ['Conciliación', r.reconRunId], ['Estado', r.status === 'completed' ? 'Completada' : r.status === 'halted' ? 'DETENIDA' : 'En curso'],
    ['Modo del escritor', r.simulated ? 'SIMULADO: Silogtran no se modificó' : 'EMISIÓN REAL en Silogtran'], ['Generado (UTC)', generatedAt.toISOString()],
    ['Facturas en la corrida', r.total], ['Facturadas', r.issued], ['Omitidas', r.skipped], ['Inciertas / detenidas', uncertain], ['Pendientes (sin tocar)', r.pending],
    ['Motivo de la detención', r.haltedReason ?? '—'], ['Excluidas del plan', r.excluded.length],
  ];
  lines.forEach(([k, v], i) => { const row = ws.getRow(i + 1); row.getCell(1).value = k; row.getCell(1).font = { bold: true }; row.getCell(2).value = v; });
  sheet('Facturadas', ISSUED_HEADERS, issuedRows(d), [14, 14, 18, 16, 16, 16, 10]);
  sheet('Omitidas e inciertas', ['Transporte', 'Remesa', 'Resultado', 'Motivo'], d.items.filter((i) => i.result !== 'issued').map((i) => [i.transportNumber ?? '', i.remesaCode ?? '', RESULT_LABEL[i.result] ?? i.result, i.reason ?? '']), [14, 14, 22, 100]);
  sheet('Excluidas del plan', ['Transporte', 'Remesa', 'Categoría', 'Motivo'], r.excluded.map((e) => [e.transportNumber, e.remesaCode ?? '', e.category, e.reason]), [14, 14, 22, 100]);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export async function generateInvoiceExport(deps: Pick<InvoiceDeps, 'db' | 'storage'>, runId: string, actor: string | null): Promise<string> {
  const d = await getInvoiceRun(deps.db, runId);
  const path = `invoices/${runId}/informe-${randomUUID()}.xlsx`;
  await deps.storage.put(path, await buildInvoiceWorkbook(d, new Date()), XLSX_CONTENT_TYPE);
  await deps.db.query('update invoice_runs set export_path = $2 where id = $1', [runId, path]);
  await audit(deps.db, actor, 'invoice_run.export', 'invoice_run', runId, { issued: d.run.issued });
  log('invoice_run.export', { runId });
  return path;
}
