import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { OrchestratorDeps } from './orchestrator.js';
import { audit } from './audit.js';
import { log } from './logger.js';
import { PARSER_VERSION } from './parser.js';
import { getBatchRows, getRunDto, getRunIssues } from './queries.js';
import type { BatchRow, IssueRow } from './queries.js';
import type { RunDto } from './types.js';
import { AppError } from './errors.js';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type ColType = 'text' | 'dec4' | 'date' | 'int';
interface Col {
  key: string;
  header: string;
  type: ColType;
  width: number;
  value: (r: BatchRow) => string | number | null;
}

const OUTCOME_LABEL: Record<string, string> = {
  imported: 'Importado',
  duplicate: 'Duplicado (ya existía)',
  needs_review: 'Requiere revisión',
};

/** Columnas de la hoja "Servicios". Se exportan para que las pruebas relean el .xlsx contra la BD. */
export const SERVICE_COLUMNS: Col[] = [
  { key: 'business_key', header: 'Clave de negocio', type: 'text', width: 18, value: (r) => r.business_key },
  { key: 'outcome', header: 'Resultado en la ejecución', type: 'text', width: 24, value: (r) => OUTCOME_LABEL[r.outcome] ?? r.outcome },
  { key: 'version', header: 'Versión vigente', type: 'int', width: 10, value: (r) => r.version },
  { key: 'version_count', header: 'Versiones recibidas', type: 'int', width: 10, value: (r) => r.version_count },
  { key: 'parse_status', header: 'Estado de lectura', type: 'text', width: 12, value: (r) => r.parse_status },
  { key: 'transport_number', header: 'Número de transporte', type: 'text', width: 18, value: (r) => r.transport_number },
  { key: 'remission_number', header: 'Número de remisión', type: 'text', width: 18, value: (r) => r.remission_number },
  { key: 'expense_number', header: 'Número de gasto', type: 'text', width: 16, value: (r) => r.expense_number },
  { key: 'service_date', header: 'Fecha del servicio', type: 'date', width: 14, value: (r) => r.service_date },
  { key: 'loading_plant', header: 'Planta de cargue', type: 'text', width: 24, value: (r) => r.loading_plant },
  { key: 'purchase_doc', header: 'Documento de compras o contrato', type: 'text', width: 22, value: (r) => r.purchase_doc },
  { key: 'service_entry_sheet', header: 'Hoja de entrada de servicio', type: 'text', width: 22, value: (r) => r.service_entry_sheet },
  { key: 'net_value', header: 'Valor neto', type: 'dec4', width: 18, value: (r) => r.net_value },
  { key: 'net_value_raw', header: 'Valor neto (original)', type: 'text', width: 20, value: (r) => r.net_value_raw },
  { key: 'currency', header: 'Moneda', type: 'text', width: 8, value: (r) => r.currency },
  { key: 'plate', header: 'Placa', type: 'text', width: 10, value: (r) => r.plate },
  { key: 'plate_normalized', header: 'Placa normalizada', type: 'text', width: 12, value: (r) => r.plate_normalized },
  { key: 'route', header: 'Ruta', type: 'text', width: 26, value: (r) => r.route },
  { key: 'transport_volume', header: 'Volumen del transporte', type: 'dec4', width: 18, value: (r) => r.transport_volume },
  { key: 'transport_volume_raw', header: 'Volumen (texto original)', type: 'text', width: 20, value: (r) => r.transport_volume_raw },
  { key: 'transport_volume_unit', header: 'Unidad del volumen', type: 'text', width: 14, value: (r) => r.transport_volume_unit },
  { key: 'unit_status', header: 'Estado de la unidad', type: 'text', width: 22, value: (r) => r.unit_status },
  { key: 'rate', header: 'Tarifa', type: 'dec4', width: 16, value: (r) => r.rate },
  { key: 'driver_code', header: 'Código del conductor', type: 'text', width: 16, value: (r) => r.driver_code },
  { key: 'driver_name', header: 'Nombre del conductor', type: 'text', width: 26, value: (r) => r.driver_name },
  { key: 'issue_count', header: 'Incidencias', type: 'int', width: 10, value: (r) => r.issue_count },
  { key: 'received_at', header: 'Recibido (UTC)', type: 'text', width: 22, value: (r) => new Date(r.received_at).toISOString() },
  { key: 'parser_version', header: 'Versión del parser', type: 'text', width: 12, value: (r) => r.parser_version },
];

export const ISSUE_COLUMNS = ['Clave de negocio', 'Código', 'Severidad', 'Campo', 'Detalle'] as const;

function cellValue(col: Col, raw: string | number | null): ExcelJS.CellValue {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (col.type) {
    case 'dec4':
      return Number(raw);
    case 'int':
      return Number(raw);
    case 'date':
      return new Date(`${String(raw)}T00:00:00Z`);
    default:
      return String(raw);
  }
}

/** Huella sha256 del contenido canónico de la hoja Servicios (el archivo no puede contener su propio hash). */
export function contentFingerprint(rows: BatchRow[]): string {
  const canonical = rows.map((r) => SERVICE_COLUMNS.map((c) => c.value(r)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function buildWorkbook(run: RunDto, rows: BatchRow[], issues: IssueRow[], generatedAt: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AutoFactura Terpel';
  wb.created = generatedAt;

  const ws = wb.addWorksheet('Servicios', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = SERVICE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  rows.forEach((r, i) => {
    const row = ws.getRow(i + 2);
    SERVICE_COLUMNS.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      cell.value = cellValue(c, c.value(r));
      if (c.type === 'text') cell.numFmt = '@'; // identificadores como texto: conserva ceros a la izquierda
      if (c.type === 'dec4') cell.numFmt = '0.0000';
      if (c.type === 'date') cell.numFmt = 'yyyy-mm-dd';
    });
    row.commit();
  });

  const wi = wb.addWorksheet('Incidencias', { views: [{ state: 'frozen', ySplit: 1 }] });
  wi.columns = ISSUE_COLUMNS.map((h, i) => ({ header: h, key: `c${i}`, width: i === 4 ? 70 : 20 }));
  wi.getRow(1).font = { bold: true };
  issues.forEach((it, i) => {
    const row = wi.getRow(i + 2);
    [it.business_key, it.code, it.severity, it.field, it.detail].forEach((v, j) => {
      const cell = row.getCell(j + 1);
      cell.value = v ?? null;
      cell.numFmt = '@';
    });
    row.commit();
  });

  const wr = wb.addWorksheet('Resumen');
  wr.columns = [{ width: 38 }, { width: 70 }];
  const summary: [string, string | number][] = [
    ['Ejecución', run.id],
    ['Buzón', run.mailbox],
    ['Rango (hora de Bogotá)', `${run.dateFromLocal} a ${run.dateToLocal}`],
    ['Rango UTC [inicio, fin)', `${run.utcStart} / ${run.utcEndExclusive}`],
    ['Generado (UTC)', generatedAt.toISOString()],
    ['Mensajes encontrados', run.found],
    ['Importados', run.imported],
    ['Duplicados', run.duplicates],
    ['Requieren revisión', run.needsReview],
    ['Ignorados', run.ignored],
    ['Servicios en el archivo', rows.length],
    ['Incidencias', issues.length],
    ['Versión del parser', PARSER_VERSION],
    ['Huella sha256 del contenido (hoja Servicios)', contentFingerprint(rows)],
    ['Nota', 'La huella del archivo completo se registra en la base de datos (export_files.sha256).'],
  ];
  summary.forEach(([k, v], i) => {
    const row = wr.getRow(i + 1);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = typeof v === 'number' ? v : String(v);
    row.getCell(2).numFmt = typeof v === 'number' ? '0' : '@';
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** Genera el Excel DESDE la BD, lo sube a Storage y lo registra. Si falla deja export_status = failed. */
export async function generateExport(
  deps: Pick<OrchestratorDeps, 'db' | 'storage'>,
  runId: string,
  actor: string | null,
): Promise<{ status: 'ready' | 'failed'; exportId: string | null }> {
  const run = await getRunDto(deps.db, runId);
  if (run.status !== 'completed') {
    throw new AppError(409, 'RUN_NOT_COMPLETED', 'La ejecución aún no termina; no se puede generar el Excel');
  }
  try {
    const rows = await getBatchRows(deps.db, runId);
    const issues = await getRunIssues(deps.db, runId);
    const buf = await buildWorkbook(run, rows, issues, new Date());
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const exportId = randomUUID();
    const path = `${runId}/${exportId}.xlsx`;
    await deps.storage.put(path, buf, XLSX_CONTENT_TYPE);
    await deps.db.transaction(async (tx) => {
      await tx.query(
        `insert into export_files (id, run_id, storage_path, sha256, row_count, issue_count, status)
         values ($1,$2,$3,$4,$5,$6,'ready')`,
        [exportId, runId, path, sha256, rows.length, issues.length],
      );
      await tx.query(`update import_runs set export_status = 'ready' where id = $1`, [runId]);
    });
    await audit(deps.db, actor, 'export.generate', 'import_run', runId, { rows: rows.length, issues: issues.length });
    log('export.ready', { runId, rows: rows.length });
    return { status: 'ready', exportId };
  } catch {
    await deps.db.transaction(async (tx) => {
      await tx.query(`insert into export_files (run_id, status) values ($1, 'failed')`, [runId]);
      await tx.query(`update import_runs set export_status = 'failed' where id = $1`, [runId]);
    });
    log('export.failed', { runId });
    return { status: 'failed', exportId: null };
  }
}

/** Relee un .xlsx y lo compara campo a campo con las filas de la BD. Devuelve las diferencias (vacío = concuerda). */
export async function compareWorkbookWithRows(file: Buffer, rows: BatchRow[]): Promise<string[]> {
  const diffs: string[] = [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Servicios');
  if (!ws) return ['Falta la hoja "Servicios"'];
  if (!wb.getWorksheet('Incidencias')) diffs.push('Falta la hoja "Incidencias"');
  if (!wb.getWorksheet('Resumen')) diffs.push('Falta la hoja "Resumen"');
  if (ws.rowCount - 1 !== rows.length) diffs.push(`Filas: Excel ${ws.rowCount - 1} vs BD ${rows.length}`);
  rows.forEach((r, i) => {
    SERVICE_COLUMNS.forEach((col, j) => {
      const cell = ws.getRow(i + 2).getCell(j + 1);
      const expected = col.value(r);
      const where = `${r.business_key}/${col.key}`;
      if (expected === null || expected === '') {
        if (cell.value !== null && cell.value !== undefined) diffs.push(`${where}: se esperaba vacío`);
        return;
      }
      let actual: string;
      if (col.type === 'dec4') actual = Number(cell.value).toFixed(4);
      else if (col.type === 'int') actual = String(Number(cell.value));
      else if (col.type === 'date') actual = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : String(cell.value);
      else actual = typeof cell.value === 'string' ? cell.value : `<${typeof cell.value}>`;
      const exp = col.type === 'dec4' ? Number(expected).toFixed(4) : col.type === 'int' ? String(Number(expected)) : String(expected);
      if (actual !== exp) diffs.push(`${where}: Excel "${actual}" vs BD "${exp}"`);
      if (col.type === 'text' && cell.numFmt !== '@') diffs.push(`${where}: la celda no es de tipo texto`);
    });
  });
  return diffs;
}
