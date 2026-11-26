// Asignación UNO A UNO (recon-1.4.0): un registro de Silogtran no puede quedar elegido por dos servicios de Terpel.
// Gana el servicio que mejor lo justifica: 1) elección manual, 2) coincidencia de placa, 3) total idéntico al valor de Terpel,
// 4) fecha más cercana. Un empate real deja a TODOS los empatados como AMBIGUOUS. Los demás pasan a NO_MATCH sin ajuste ni factura.
import type { Queryable } from '../db/types.js';
import { daysBetween, sameNumber, toNumber } from './normalize.js';

interface Row {
  id: string; chosen: string; transport: string; service_date: string; plate: string | null; net_value: string | null; manual: boolean;
  rec_plate: string | null; rec_total: string | null; rec_date: string | null; remesa: string;
}

export interface AssignOutcome { demoted: number; ties: number }

export async function enforceOneToOne(q: Queryable): Promise<AssignOutcome> {
  const r = await q.query<Row>(
    `select r.id, r.chosen_record_id as chosen, r.transport_number as transport, to_char(r.service_date,'YYYY-MM-DD') as service_date, a.plate_normalized as plate, a.net_value::text as net_value,
            (r.resolved_record_id is not null and r.resolved_record_id = r.chosen_record_id) as manual,
            s.plate_normalized as rec_plate, s.total_remesa::text as rec_total, to_char(s.dispatch_date,'YYYY-MM-DD') as rec_date, s.remesa_code as remesa
       from reconciliation_results r join authorizations a on a.id = r.authorization_id join silogtran_records s on s.id = r.chosen_record_id
      where r.status in ('EXACT','MATCH_WITH_DIFFERENCES') and r.chosen_record_id in (
        select chosen_record_id from reconciliation_results where status in ('EXACT','MATCH_WITH_DIFFERENCES') and chosen_record_id is not null group by 1 having count(*) > 1)`,
  );
  const groups = new Map<string, Row[]>();
  for (const x of r.rows) groups.set(x.chosen, [...(groups.get(x.chosen) ?? []), x]);
  let demoted = 0;
  let ties = 0;
  const score = (x: Row): [number, number, number, number] => {
    const val = toNumber(x.net_value);
    const tot = toNumber(x.rec_total);
    const dist = x.rec_date ? Math.abs(daysBetween(x.rec_date, x.service_date)) : 999;
    return [x.manual ? 1 : 0, x.plate && x.rec_plate && x.plate === x.rec_plate ? 1 : 0, val !== null && tot !== null && sameNumber(val, tot) ? 1 : 0, -dist];
  };
  const cmp = (a: [number, number, number, number], b: [number, number, number, number]): number => {
    for (let i = 0; i < 4; i += 1) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    return 0;
  };
  for (const rows of groups.values()) {
    const ranked = rows.map((x) => ({ x, s: score(x) })).sort((a, b) => cmp(b.s, a.s));
    const top = ranked.filter((y) => cmp(y.s, (ranked[0] as { s: [number, number, number, number] }).s) === 0);
    const winner = top.length === 1 ? (top[0] as { x: Row }).x : null;
    const why = (w: Row): string => (w.manual ? 'elección manual' : w.plate && w.rec_plate === w.plate ? 'coincide la placa' : score(w)[2] ? 'coincide el valor' : 'fecha más cercana');
    for (const { x } of ranked) {
      if (winner && x.id === winner.id) continue;
      const tied = !winner && top.some((y) => y.x.id === x.id);
      if (tied) {
        ties += 1;
        await q.query(
          `update reconciliation_results set status='AMBIGUOUS', chosen_record_id=null, candidate_ids=array[$2]::uuid[], reason=$3, reason_code='RECORD_CONTESTED', weight_source=null, differences='[]'::jsonb where id=$1`,
          [x.id, x.chosen, `Varios servicios de Terpel disputan el registro de la remesa ${x.remesa} sin criterio que desempate (placa/valor/fecha); requiere elección manual`],
        );
      } else {
        demoted += 1;
        await q.query(
          `update reconciliation_results set status='NO_MATCH', chosen_record_id=null, candidate_ids=array[$2]::uuid[], reason=$3, reason_code='RECORD_TAKEN', weight_source=null, differences='[]'::jsonb where id=$1`,
          [x.id, x.chosen, `El registro de la remesa ${x.remesa} (placa ${x.rec_plate ?? '—'}) ya corresponde a otro servicio de Terpel${winner ? ` (transporte ${winner.transport}: ${why(winner)})` : ''}; no se ajusta ni se factura`],
        );
      }
    }
  }
  return { demoted, ties };
}
