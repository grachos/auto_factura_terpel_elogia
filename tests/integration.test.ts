import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildFixtures } from '../fixtures/messages.js';
import { MockMailSource } from '../core/mail/mock.js';
import { createRun, runToCompletion, stepRun } from '../core/orchestrator.js';
import { generateExport, SERVICE_COLUMNS, contentFingerprint } from '../core/excel.js';
import { getBatchRows, getRunDetail } from '../core/queries.js';
import { AppError } from '../core/errors.js';
import type { Db } from '../core/db/types.js';
import { MemoryStorage, count, deps, newDb, noSleep } from './helpers.js';

const fx = buildFixtures();
const JAN = { dateFrom: '2026-01-01', dateTo: '2026-01-31', actor: 'tester' };
let db: Db;
const storage = new MemoryStorage();

async function outcomeOf(name: string, runId: string): Promise<string | undefined> {
  const m = fx.byName[name];
  const r = await db.query<{ outcome: string }>(
    `select rm.outcome from run_messages rm join source_messages s on s.id = rm.message_id
      where rm.run_id = $1 and s.graph_immutable_id = $2`,
    [runId, m?.id],
  );
  return r.rows[0]?.outcome;
}

describe('importación de punta a punta (PGlite + migraciones SQL reales)', () => {
  let run1Id = '';

  beforeAll(async () => {
    db = await newDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('criterios 6 y 10: pagina, tolera 429 y clasifica cada mensaje', async () => {
    const mail = new MockMailSource(fx.all, { pageSize: 4, throttleOncePages: [1], throttleRetryAfterMs: 5 });
    const d = deps(db, mail, storage);
    const run = await createRun(d, JAN);
    run1Id = run.id;
    expect(run.utcStart).toBe('2026-01-01T05:00:00.000Z');
    expect(run.utcEndExclusive).toBe('2026-02-01T05:00:00.000Z');

    const throttledSeen: (number | null)[] = [];
    let r;
    for (let i = 0; i < 50; i += 1) {
      r = await stepRun(d, run.id, 'tester');
      throttledSeen.push(r.retryAfterMs);
      if (r.done) break;
    }
    expect(throttledSeen).toContain(5); // hubo una pausa por 429 simulado
    const done = r!.run;
    expect(done.status).toBe('completed');
    expect(done.pagesProcessed).toBe(4); // 16 mensajes / 4 por página
    expect(done.found).toBe(16);
    expect(done.found).toBe(done.imported + done.duplicates + done.needsReview + done.ignored);
    expect(done).toMatchObject({ imported: 9, duplicates: 0, needsReview: 5, ignored: 2 });

    const expected: Record<string, string> = {
      valid: 'imported', plant9P: 'imported', zeros: 'imported', forwardIdentical: 'imported',
      originalToCorrect: 'imported', corrected: 'needs_review', emptyFields: 'needs_review', altFormat: 'imported',
      textOnly: 'imported', fakeSender: 'ignored_sender', otherSubject: 'ignored_subject',
      internalForward: 'needs_review', ambiguousDecimal: 'needs_review', noBlock: 'parse_error',
      startOfRange: 'imported', endOfRange: 'imported',
    };
    for (const [name, outcome] of Object.entries(expected)) expect(await outcomeOf(name, run1Id), name).toBe(outcome);
    // fuera del rango (límites exactos en Bogotá): no se importan
    expect(await count(db, 'source_messages', `graph_immutable_id = '${fx.byName.beforeRange?.id}'`)).toBe(0);
    expect(await count(db, 'source_messages', `graph_immutable_id = '${fx.byName.afterRange?.id}'`)).toBe(0);
    expect(await count(db, 'source_messages')).toBe(16);
  });

  it('criterio 3: corregida/reenviada → nueva versión del MISMO servicio con incidencia visible', async () => {
    expect(await count(db, 'services', `business_key = '000125'`)).toBe(1);
    const svc = (await db.query<{ version_count: number }>(`select version_count from services where business_key = '000125'`)).rows[0];
    expect(svc?.version_count).toBe(2);
    const cur = (await db.query<{ net_value: string; version: number }>(
      `select a.net_value::text, a.version from services s join authorizations a on a.id = s.current_authorization_id where s.business_key = '000125'`,
    )).rows[0];
    expect(cur).toEqual({ net_value: '850000.0000', version: 2 }); // vigente: la recibida más reciente
    const detail = await getRunDetail(db, run1Id);
    const corr = detail.issues.find((i) => i.code === 'CORRECTED_AUTHORIZATION');
    expect(corr?.businessKey).toBe('000125');
    expect(corr?.detail).toContain('net_value');
    expect(corr?.detail).not.toMatch(/Conductor/);
    // reenvío idéntico: versión nueva + info, sin pedir revisión
    expect((await db.query<{ version_count: number }>(`select version_count from services where business_key = '000124'`)).rows[0]?.version_count).toBe(2);
    expect(detail.issues.some((i) => i.code === 'RESENT_AUTHORIZATION' && i.severity === 'info' && i.businessKey === '000124')).toBe(true);
    // reenvío de remitente interno: revisión, sin crear servicio
    expect(detail.issues.some((i) => i.code === 'SENDER_NOT_ALLOWED')).toBe(true);
    expect(await count(db, 'services', `business_key = '000130'`)).toBe(0);
    expect(await count(db, 'services')).toBe(10);
  });

  it('criterios 4 y 5: ceros a la izquierda, volumen crudo/numérico, unidad pendiente, vacío ≠ 0', async () => {
    const a = (await db.query<Record<string, string | null>>(
      `select a.transport_number, transport_volume_raw, transport_volume::text as v, transport_volume_unit, unit_status, loading_plant_flag
         from authorizations a join services s on s.id = a.service_id where s.business_key = '000124' and a.version = 1`,
    )).rows[0];
    expect(a).toMatchObject({ transport_number: '000124', transport_volume_raw: '9973,0000', v: '9973.0000', transport_volume_unit: null, unit_status: 'pending_confirmation', loading_plant_flag: '9P' });
    const zero = (await db.query<Record<string, string | null>>(
      `select transport_volume_raw, transport_volume::text as v from authorizations a join services s on s.id = a.service_id where s.business_key = '007890'`,
    )).rows[0];
    expect(zero).toEqual({ transport_volume_raw: '0', v: '0.0000' });
    const empty = (await db.query<Record<string, string | null>>(
      `select transport_volume_raw, transport_volume::text as v from authorizations a join services s on s.id = a.service_id where s.business_key = '000126'`,
    )).rows[0];
    expect(empty).toEqual({ transport_volume_raw: '', v: null });
    const amb = (await db.query<Record<string, string | null>>(
      `select transport_volume_raw, transport_volume::text as v from authorizations a join services s on s.id = a.service_id where s.business_key = '000131'`,
    )).rows[0];
    expect(amb).toEqual({ transport_volume_raw: '1.234', v: null });
  });

  it('criterio 2: segunda ejecución del mismo rango y una solapada → duplicados, sin registros nuevos', async () => {
    const mail = new MockMailSource(fx.all, { pageSize: 7 });
    const d = deps(db, mail, storage);
    const run2 = await createRun(d, JAN);
    const done2 = await runToCompletion(d, run2.id, 'tester', noSleep);
    expect(done2).toMatchObject({ status: 'completed', found: 16, duplicates: 16, imported: 0, needsReview: 0, ignored: 0 });
    expect(await count(db, 'source_messages')).toBe(16);
    expect(await count(db, 'authorizations')).toBe(13);

    const run3 = await createRun(d, { ...JAN, dateFrom: '2026-01-10', dateTo: '2026-01-20' });
    const done3 = await runToCompletion(d, run3.id, 'tester', noSleep);
    expect(done3.found).toBe(done3.duplicates);
    expect(done3.imported + done3.needsReview + done3.ignored).toBe(0);
    expect(await count(db, 'source_messages')).toBe(16);
    // El Excel del lote repetido concuerda con el primero
    const a = await getBatchRows(db, run1Id);
    const b = await getBatchRows(db, run2.id);
    expect(b.map((r) => r.business_key)).toEqual(a.map((r) => r.business_key));
  });

  it('criterio 8: Excel con una fila por servicio + Incidencias + Resumen, concordante campo a campo con la BD', async () => {
    const exp = await db.query<{ storage_path: string; sha256: string; row_count: number; issue_count: number }>(
      `select storage_path, sha256, row_count, issue_count from export_files where run_id = $1 and status = 'ready'`, [run1Id],
    );
    expect(exp.rows).toHaveLength(1);
    const file = await storage.get(exp.rows[0]!.storage_path);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Servicios', 'Incidencias', 'Resumen']);

    const rows = await getBatchRows(db, run1Id);
    const ws = wb.getWorksheet('Servicios')!;
    expect(ws.rowCount - 1).toBe(rows.length);
    expect(rows.length).toBe(10);
    expect(exp.rows[0]!.row_count).toBe(10);

    const colIndex = (key: string) => SERVICE_COLUMNS.findIndex((c) => c.key === key) + 1;
    rows.forEach((db_row, i) => {
      const xl = ws.getRow(i + 2);
      for (const [j, col] of SERVICE_COLUMNS.entries()) {
        const cell = xl.getCell(j + 1);
        const expected = col.value(db_row);
        if (expected === null || expected === '') {
          expect(cell.value, `${col.key} fila ${i + 2}`).toBeNull();
        } else if (col.type === 'dec4') {
          expect(Number(cell.value).toFixed(4), col.key).toBe(Number(expected).toFixed(4));
          expect(cell.numFmt).toBe('0.0000');
        } else if (col.type === 'int') {
          expect(Number(cell.value), col.key).toBe(Number(expected));
        } else if (col.type === 'date') {
          expect((cell.value as Date).toISOString().slice(0, 10), col.key).toBe(expected);
        } else {
          expect(typeof cell.value, col.key).toBe('string');
          expect(cell.value, col.key).toBe(String(expected));
          expect(cell.numFmt, col.key).toBe('@');
        }
      }
    });
    // criterio 4: 000123 idéntico en PostgreSQL y en la celda de texto
    const idx = rows.findIndex((r) => r.business_key === '000123');
    const cell = ws.getRow(idx + 2).getCell(colIndex('transport_number'));
    expect(cell.value).toBe('000123');
    expect(cell.numFmt).toBe('@');
    // volumen: número + texto original
    const vi = rows.findIndex((r) => r.business_key === '000124');
    expect(ws.getRow(vi + 2).getCell(colIndex('transport_volume_raw')).value).toBe('9973,0000');
    expect(Number(ws.getRow(vi + 2).getCell(colIndex('transport_volume')).value)).toBe(9973);

    // Verificación independiente (SQL directo, sin getBatchRows): mismas filas y valores vigentes
    const distinctSvc = await count(
      db,
      '(select distinct a.service_id from run_messages rm join authorizations a on a.message_id = rm.message_id' +
        ` where rm.run_id = '${run1Id}' and a.service_id is not null) t`,
    );
    expect(ws.rowCount - 1).toBe(distinctSvc);
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const key = String(ws.getRow(r).getCell(colIndex('business_key')).value);
      const direct = (await db.query<{ transport_number: string; net_value: string; transport_volume_raw: string | null }>(
        `select a.transport_number, a.net_value::text as net_value, a.transport_volume_raw
           from services s join authorizations a on a.id = s.current_authorization_id where s.business_key = $1`,
        [key],
      )).rows[0]!;
      expect(ws.getRow(r).getCell(colIndex('transport_number')).value).toBe(direct.transport_number);
      expect(Number(ws.getRow(r).getCell(colIndex('net_value')).value).toFixed(4)).toBe(Number(direct.net_value).toFixed(4));
      const rawCell = ws.getRow(r).getCell(colIndex('transport_volume_raw')).value;
      expect(rawCell ?? null).toBe(direct.transport_volume_raw === '' ? null : direct.transport_volume_raw);
    }

    const wi = wb.getWorksheet('Incidencias')!;
    expect(wi.rowCount - 1).toBe(exp.rows[0]!.issue_count);
    const wr = wb.getWorksheet('Resumen')!;
    const summary = new Map<string, unknown>();
    wr.eachRow((r) => summary.set(String(r.getCell(1).value), r.getCell(2).value));
    expect(summary.get('Mensajes encontrados')).toBe(16);
    expect(summary.get('Servicios en el archivo')).toBe(10);
    expect(summary.get('Huella sha256 del contenido (hoja Servicios)')).toBe(contentFingerprint(rows));
  });

  it('criterio 11 (BD): RLS — operador lee, no lee cuerpos ni configuración, sin rol no ve nada', async () => {
    const op = '11111111-1111-1111-1111-111111111111';
    const adm = '22222222-2222-2222-2222-222222222222';
    const nobody = '33333333-3333-3333-3333-333333333333';
    await db.exec(`insert into auth.users (id, email) values ('${op}','op@x'),('${adm}','adm@x'),('${nobody}','n@x')`);
    await db.exec(`insert into user_roles values ('${op}','operator'),('${adm}','admin')`);
    const asUser = async <T>(uid: string, fn: () => Promise<T>): Promise<T> => {
      await db.exec(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${uid}"}', false);`);
      try {
        return await fn();
      } finally {
        await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
      }
    };
    await asUser(op, async () => {
      expect(await count(db, 'import_runs')).toBeGreaterThan(0);
      expect(await count(db, 'authorizations')).toBeGreaterThan(0);
      await expect(db.query('select body_raw from source_message_bodies')).rejects.toThrow(/permission denied/);
      expect(await count(db, 'mail_configs')).toBe(0);
      await expect(db.query(`update mail_configs set mailbox = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`insert into import_runs (mail_config_id, requested_by, date_from_local, date_to_local, utc_start, utc_end_exclusive) values (gen_random_uuid(),'x','2026-01-01','2026-01-01',now(),now()+interval '1 day')`)).rejects.toThrow(/permission denied/);
    });
    await asUser(adm, async () => {
      expect(await count(db, 'mail_configs')).toBe(1);
      await expect(db.query('select body_raw from source_message_bodies')).rejects.toThrow(/permission denied/);
    });
    await asUser(nobody, async () => {
      expect(await count(db, 'import_runs')).toBe(0);
      expect(await count(db, 'authorizations')).toBe(0);
    });
    // el bucket privado existe
    const b = await db.query<{ public: boolean }>(`select public from storage.buckets where id = 'exports'`);
    expect(b.rows[0]?.public).toBe(false);
  });

  it('una sola ejecución activa por buzón (índice único parcial) y lease', async () => {
    const mail = new MockMailSource(fx.all, { pageSize: 5 });
    const d = deps(db, mail, storage);
    const a = await createRun(d, JAN);
    await expect(createRun(d, JAN)).rejects.toMatchObject({ code: 'ACTIVE_RUN_EXISTS', details: { runId: a.id } });
    // lease vigente (otro proceso la tiene) → 409
    await db.query(`update import_runs set lease_until = now() + interval '5 minutes', status = 'running' where id = $1`, [a.id]);
    await expect(stepRun(d, a.id, 'tester')).rejects.toBeInstanceOf(AppError);
    await expect(stepRun(d, a.id, 'tester')).rejects.toMatchObject({ code: 'RUN_LEASED' });
    // lease vencido (proceso caído) → se retoma
    await db.query(`update import_runs set lease_until = now() - interval '1 second' where id = $1`, [a.id]);
    const done = await runToCompletion(d, a.id, 'tester', noSleep);
    expect(done.status).toBe('completed');
    await expect(stepRun(d, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'tester')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('rango inválido → 400', async () => {
    const d = deps(db, new MockMailSource([]), storage);
    await expect(createRun(d, { ...JAN, dateFrom: '2026-02-01', dateTo: '2026-01-01' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('reanudación y exportación (criterios 7 y 9)', () => {
  let db2: Db;
  const st = new MemoryStorage();
  beforeAll(async () => {
    db2 = await newDb();
  });
  afterAll(async () => {
    await db2.close();
  });

  it('criterio 7: interrupción a mitad de página → reanuda sin duplicados y respeta el invariante', async () => {
    const mail = new MockMailSource(fx.all, { pageSize: 6, failOncePages: [2] });
    let calls = 0;
    const d = deps(db2, mail, st, {
      afterMessage: (i) => {
        calls += 1;
        if (calls === 9 && i === 2) throw new Error('caída simulada a mitad de página'); // 2.ª página, 3.er mensaje
      },
    });
    const run = await createRun(d, JAN);
    const seen: string[] = [];
    let last;
    for (let i = 0; i < 20; i += 1) {
      last = await stepRun(d, run.id, 'tester');
      seen.push(`${last.run.status}:${last.run.errorCode ?? '-'}`);
      if (last.done) break;
    }
    expect(seen.some((s) => s === 'paused:STEP_ERROR')).toBe(true); // interrupción a mitad de página
    expect(seen.some((s) => s === 'paused:SOURCE_ERROR')).toBe(true); // caída de red al pedir página
    const run1 = last!.run;
    expect(run1.status).toBe('completed');
    expect(run1.found).toBe(16);
    expect(run1.found).toBe(run1.imported + run1.duplicates + run1.needsReview + run1.ignored);
    expect(run1).toMatchObject({ imported: 9, needsReview: 5, ignored: 2, duplicates: 0 });
    expect(await count(db2, 'source_messages')).toBe(16);
    expect(await count(db2, 'run_messages', `run_id = '${run.id}'`)).toBe(16);
    expect(await count(db2, 'authorizations')).toBe(13);
    expect(await count(db2, 'services')).toBe(10);
    expect(await count(db2, 'source_message_bodies')).toBe(14); // ignorados no guardan cuerpo
  });

  it('cursor expirado → reinicia el rango de forma idempotente', async () => {
    const mail = new MockMailSource(fx.all, { pageSize: 6 });
    const d = deps(db2, mail, st);
    const run = await createRun(d, { ...JAN, dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    // finalizada la anterior: esta es nueva y solo ve duplicados; se corrompe el cursor tras la 1.ª página
    await stepRun(d, run.id, 'tester');
    await db2.query(`update import_runs set cursor_next_link = 'mock:corrupto' where id = $1`, [run.id]);
    const done = await runToCompletion(d, run.id, 'tester', noSleep);
    expect(done).toMatchObject({ status: 'completed', found: 16, duplicates: 16 });
  });

  it('criterio 9: fallo forzado del Excel → export_status failed → Regenerar lo produce desde el lote', async () => {
    const db3 = await newDb();
    const st3 = new MemoryStorage();
    st3.failNextPut = 1;
    const d = deps(db3, new MockMailSource(fx.all, { pageSize: 8 }), st3);
    const run = await createRun(d, JAN);
    const done = await runToCompletion(d, run.id, 'tester', noSleep);
    expect(done.status).toBe('completed');
    expect(done.exportStatus).toBe('failed');
    expect(await count(db3, 'export_files', `run_id = '${run.id}' and status = 'failed'`)).toBe(1);
    expect(st3.files.size).toBe(0);

    const regen = await generateExport(d, run.id, 'tester');
    expect(regen.status).toBe('ready');
    const detail = await getRunDetail(db3, run.id);
    expect(detail.run.exportStatus).toBe('ready');
    expect(detail.exports.map((e) => e.status)).toEqual(expect.arrayContaining(['ready', 'failed']));
    const ready = (await db3.query<{ storage_path: string; row_count: number }>(`select storage_path, row_count from export_files where run_id = $1 and status = 'ready'`, [run.id])).rows[0]!;
    expect(ready.row_count).toBe(10);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await st3.get(ready.storage_path)) as unknown as ArrayBuffer);
    expect(wb.getWorksheet('Servicios')!.rowCount).toBe(11);
    // no se puede exportar una ejecución sin terminar
    const pending = await createRun(d, { ...JAN, dateFrom: '2026-02-01', dateTo: '2026-02-02' });
    await expect(generateExport(d, pending.id, 'tester')).rejects.toMatchObject({ code: 'RUN_NOT_COMPLETED' });
    await db3.close();
  });

  it('DMARC exigido: sin dmarc=pass → revisión, sin crear servicio', async () => {
    const db4 = await newDb({ requireDmarc: true });
    const msgs = [
      { ...fx.byName.valid!, authenticationResults: 'dmarc=fail' },
      { ...fx.byName.plant9P! },
    ];
    const d = deps(db4, new MockMailSource(msgs), new MemoryStorage());
    const run = await createRun(d, JAN);
    const done = await runToCompletion(d, run.id, 'tester', noSleep);
    expect(done).toMatchObject({ found: 2, imported: 1, needsReview: 1 });
    expect(await count(db4, 'services')).toBe(1);
    expect(await count(db4, 'import_issues', `code = 'DMARC_NOT_PASS'`)).toBe(1);
    await db4.close();
  });

  it('segunda clave de identidad: mismo Message-ID con otro id inmutable → duplicado', async () => {
    const db6 = await newDb();
    const original = fx.byName.valid!;
    const d1 = deps(db6, new MockMailSource([original]), new MemoryStorage());
    const r1 = await runToCompletion(d1, (await createRun(d1, JAN)).id, 'tester', noSleep);
    expect(r1).toMatchObject({ found: 1, imported: 1, duplicates: 0 });
    const moved = { ...original, id: 'AAMkOtroIdInmutable-movido-de-carpeta' };
    const d2 = deps(db6, new MockMailSource([moved]), new MemoryStorage());
    const r2 = await runToCompletion(d2, (await createRun(d2, JAN)).id, 'tester', noSleep);
    expect(r2).toMatchObject({ found: 1, imported: 0, duplicates: 1 });
    expect(await count(db6, 'source_messages')).toBe(1);
    expect(await count(db6, 'authorizations')).toBe(1);
    await db6.close();
  });

  it('estrategia de clave transporte+gasto', async () => {
    const db5 = await newDb({ strategy: 'transport_expense' });
    const d = deps(db5, new MockMailSource([fx.byName.valid!]), new MemoryStorage());
    const run = await createRun(d, JAN);
    await runToCompletion(d, run.id, 'tester', noSleep);
    expect((await db5.query<{ business_key: string }>('select business_key from services')).rows[0]?.business_key).toBe('000123|4500098765');
    await db5.close();
  });
});

describe('DbStorage (Excel guardado en PostgreSQL)', () => {
  it('guarda, lee y firma URLs que vencen', async () => {
    const { DbStorage } = await import('../core/storage/db.js');
    const db = await newDb();
    const st = new DbStorage(db, 'secreto-de-prueba');
    const data = Buffer.from([0, 1, 2, 255]);
    await st.put('lote/a.xlsx', data, 'application/octet-stream');
    expect(Buffer.compare(await st.get('lote/a.xlsx'), data)).toBe(0);
    const url = new URL(await st.signedUrl('lote/a.xlsx', 60), 'http://x');
    const p = url.searchParams.get('p') ?? '';
    expect(st.verify(p, Number(url.searchParams.get('exp')), url.searchParams.get('sig') ?? '')).toBe(true);
    expect(st.verify(p, Math.floor(Date.now() / 1000) - 1, url.searchParams.get('sig') ?? '')).toBe(false);
    await expect(st.get('no-existe.xlsx')).rejects.toThrow();
  });
});
