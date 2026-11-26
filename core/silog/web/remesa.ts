// Lectura (solo GET) de la página de CONSULTA de la remesa: Despacho.Remesa_003.Home_111.
// Es la fuente de verdad de lo que Silogtran guarda tras un cambio de tarifa (el informe NO refleja estos campos).
import * as cheerio from 'cheerio';
import type { SilogWebClient } from './client.js';
import { SilogWebError } from './errors.js';

export const HOME_URL = 'index.php?page=Despacho.Remesa_003.Home_111&remesa_codigo=';

export interface RemesaState {
  /** Columna «Peso» de la tabla de ítems. */
  peso: string;
  /** Columna «Peso Bruto» (el cambio de tarifa deja aquí el mismo valor que en Peso). */
  pesoBruto: string;
  /** Columna «Cantidad»: cantidad ORIGINAL de la solicitud; el cambio de tarifa no la modifica. */
  cantidadSolicitada: string;
  volumen: string | null;
  /** `ctl0_MainModule_tarifa_cliente`. */
  tarifa: string;
  /** `ctl0$MainModule$remesa_flete` (total de la remesa; Silogtran lo muestra con comas de miles). */
  flete: string;
}

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** "2,464,445" -> "2464445"; "235" -> "235"; "10487.50" -> "10487.5". null si no es numérico. */
export function homeNumber(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\u00a0/g, ' ').trim();
  if (s === '') return null;
  let t = s;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) t = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  const frac = f.replace(/0+$/, '');
  return `${(i as string).replace(/^0+(?=\d)/, '')}${frac ? `.${frac}` : ''}`;
}

const bad = (m: string): SilogWebError => new SilogWebError('WEB_BAD_PAGE', m);

/** Parsea la tabla por NOMBRE de columna (no por posición) y los campos tarifa_cliente y remesa_flete. */
export function parseRemesaHome(html: string): RemesaState {
  const $ = cheerio.load(html);
  if (html.includes('ctl0$MainModule$BtnIngresar')) throw bad('Silogtran devolvió el login en lugar de la consulta de la remesa');
  const table = $('table').toArray().find((t) => /ItemsRemesa/i.test($(t).attr('id') ?? ''));
  if (!table) throw bad('La consulta de la remesa no tiene la tabla de ítems');
  const headers = $(table).find('th').toArray().map((h) => norm($(h).text()));
  const idx = (name: string): number => headers.indexOf(name);
  const iPeso = idx('peso');
  const iBruto = idx('peso bruto');
  const iCant = idx('cantidad');
  const iVol = idx('volumen');
  if (iPeso < 0 || iBruto < 0 || iCant < 0) throw bad('La tabla de ítems no tiene las columnas Peso, Peso Bruto y Cantidad');
  const rows = $(table).find('tr').toArray().map((r) => $(r).find('td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim())).filter((r) => r.length === headers.length);
  if (rows.length !== 1) throw bad(`La remesa tiene ${rows.length} ítems; se esperaba exactamente 1`);
  const row = rows[0] as string[];
  const peso = homeNumber(row[iPeso]);
  const bruto = homeNumber(row[iBruto]);
  const cant = homeNumber(row[iCant]);
  if (!peso || !bruto || !cant) throw bad('Los valores de Peso, Peso Bruto o Cantidad no son numéricos');
  const tarEl = $('#ctl0_MainModule_tarifa_cliente');
  const tarifa = homeNumber(tarEl.is('input') ? tarEl.attr('value') : tarEl.text());
  const fleteEl = $('#ctl0_MainModule_remesa_flete');
  const flete = homeNumber(fleteEl.length ? (fleteEl.is('input') ? fleteEl.attr('value') : fleteEl.text()) : $('[name="ctl0$MainModule$remesa_flete"]').attr('value'));
  if (!tarifa) throw bad('No se pudo leer la tarifa del cliente (tarifa_cliente)');
  if (!flete) throw bad('No se pudo leer el flete de la remesa (remesa_flete)');
  return { peso, pesoBruto: bruto, cantidadSolicitada: cant, volumen: iVol >= 0 ? homeNumber(row[iVol]) : null, tarifa, flete };
}

/** `inQueue`: el llamador ya está dentro de client.enqueue() (no se encola de nuevo para no bloquearse a sí mismo). */
export async function readRemesaHome(client: SilogWebClient, remesaCode: string, inQueue = false): Promise<RemesaState> {
  const code = remesaCode.replace(/\D/g, '').padStart(10, '0');
  const res = inQueue ? await client.request(`${HOME_URL}${code}`) : await client.enqueue(() => client.request(`${HOME_URL}${code}`));
  return parseRemesaHome(res.text);
}
