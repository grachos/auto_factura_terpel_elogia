// Evidencia de idempotencia: importa dos veces el mismo rango (datos ficticios, PGlite en memoria)
// y verifica que haya un registro por mensaje y que el Excel concuerde con la BD.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareWorkbookWithRows } from '../core/excel.js';
import { createContext } from '../core/context.js';
import { setLogSink } from '../core/logger.js';
import { createRun, runToCompletion } from '../core/orchestrator.js';
import { getBatchRows } from '../core/queries.js';

setLogSink(() => undefined);

async function scalar(sql: string, ctx: Awaited<ReturnType<typeof createContext>>): Promise<number> {
  const r = await ctx.db.query<{ n: number }>(sql);
  return r.rows[0]?.n ?? 0;
}

async function main(): Promise<void> {
  const ctx = await createContext({
    AUTH_MODE: 'demo',
    PGLITE_MEMORY: '1',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'autofactura-demo-')),
    MAIL_SOURCE: 'mock',
  });
  const deps = { db: ctx.db, mail: ctx.mail, storage: ctx.storage };
  const from = '2026-01-01';
  const to = '2026-01-31';
  let failed = false;
  const check = (label: string, cond: boolean, detail = ''): void => {
    console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${label}${detail ? ` (${detail})` : ''}`);
    if (!cond) failed = true;
  };

  console.log(`Rango ${from} a ${to} (America/Bogota) con MockMailSource (páginas de 4, un 429 simulado)\n`);
  const runIds: string[] = [];
  for (const n of [1, 2]) {
    const run = await createRun(deps, { actor: 'demo-twice', dateFrom: from, dateTo: to });
    const done = await runToCompletion(deps, run.id, 'demo-twice', (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))));
    runIds.push(run.id);
    console.log(`Ejecución ${n} (${run.id.slice(0, 8)}): estado=${done.status} páginas=${done.pagesProcessed} encontrados=${done.found} importados=${done.imported} duplicados=${done.duplicates} por revisar=${done.needsReview} ignorados=${done.ignored} excel=${done.exportStatus}`);
    check('encontrados = importados + duplicados + por revisar + ignorados', done.found === done.imported + done.duplicates + done.needsReview + done.ignored);
    if (n === 1) check('primera ejecución sin duplicados', done.duplicates === 0 && done.imported > 0);
    if (n === 2) check('segunda ejecución: todos duplicados', done.duplicates === done.found && done.imported === 0 && done.needsReview === 0 && done.ignored === 0);
  }

  console.log('\nRegistros en la base de datos tras las dos ejecuciones:');
  const msgs = await scalar('select count(*)::int n from source_messages', ctx);
  const distinct = await scalar('select count(distinct (mailbox, internet_message_id))::int n from source_messages', ctx);
  const perRun1 = await scalar(`select count(*)::int n from run_messages where run_id = '${runIds[0]}'`, ctx);
  const perRun2 = await scalar(`select count(*)::int n from run_messages where run_id = '${runIds[1]}'`, ctx);
  const services = await scalar('select count(*)::int n from services', ctx);
  const dupKeys = await scalar('select count(*)::int n from (select business_key from services group by 1 having count(*) > 1) t', ctx);
  check('un source_messages por mensaje', msgs === distinct, `${msgs} filas, ${distinct} mensajes distintos`);
  check('ambas ejecuciones vieron los mismos mensajes', perRun1 === perRun2 && perRun1 === msgs, `${perRun1} / ${perRun2}`);
  check('un solo servicio por clave de negocio', dupKeys === 0, `${services} servicios`);

  console.log('\nExcel vs base de datos:');
  for (const [i, id] of runIds.entries()) {
    const rows = await getBatchRows(ctx.db, id);
    const exp = await ctx.db.query<{ storage_path: string; row_count: number; sha256: string }>(
      `select storage_path, row_count, sha256 from export_files where run_id = $1 and status = 'ready' order by generated_at desc limit 1`,
      [id],
    );
    const file = exp.rows[0];
    if (!file) {
      check(`Excel de la ejecución ${i + 1} existe`, false);
      continue;
    }
    const diffs = await compareWorkbookWithRows(await ctx.storage.get(file.storage_path), rows);
    check(`Excel de la ejecución ${i + 1}: ${rows.length} servicios, campo a campo igual a la BD`, diffs.length === 0 && file.row_count === rows.length, diffs.slice(0, 3).join('; '));
  }
  await ctx.db.close();
  console.log(failed ? '\nRESULTADO: FALLA' : '\nRESULTADO: OK - idempotencia y concordancia Excel/BD verificadas');
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('Error en demo:twice:', e instanceof Error ? e.message : e);
  process.exit(1);
});
