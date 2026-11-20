import { DateTime } from 'luxon';

export const BOGOTA_ZONE = 'America/Bogota';
export const MAX_RANGE_DAYS = 366;

export interface UtcRange {
  dateFromLocal: string;
  dateToLocal: string;
  /** Inicio del día inicial en Bogotá, expresado en UTC (inclusivo). */
  utcStart: Date;
  /** Inicio del día siguiente al final en Bogotá, expresado en UTC (exclusivo). */
  utcEndExclusive: Date;
}

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateRangeError';
  }
}

function parseLocalDate(value: string, label: string): DateTime {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DateRangeError(`${label} debe tener formato AAAA-MM-DD`);
  const dt = DateTime.fromISO(value, { zone: BOGOTA_ZONE });
  if (!dt.isValid) throw new DateRangeError(`${label} no es una fecha válida`);
  return dt.startOf('day');
}

/** Rango [inicio del día inicial, inicio del día siguiente al final) de Bogotá convertido a UTC. */
export function utcRangeForLocalDates(dateFromLocal: string, dateToLocal: string): UtcRange {
  const from = parseLocalDate(dateFromLocal, 'La fecha inicial');
  const to = parseLocalDate(dateToLocal, 'La fecha final');
  if (to < from) throw new DateRangeError('La fecha final no puede ser anterior a la inicial');
  const endExclusive = to.plus({ days: 1 }).startOf('day');
  if (endExclusive.diff(from, 'days').days > MAX_RANGE_DAYS) {
    throw new DateRangeError(`El rango no puede superar ${MAX_RANGE_DAYS} días`);
  }
  return {
    dateFromLocal,
    dateToLocal,
    utcStart: from.toUTC().toJSDate(),
    utcEndExclusive: endExclusive.toUTC().toJSDate(),
  };
}

/** Parsea la fecha del servicio en formato DD.MM.AAAA → AAAA-MM-DD (o null si no es válida). */
export function parseServiceDate(raw: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const dt = DateTime.fromObject({ day: Number(m[1]), month: Number(m[2]), year: Number(m[3]) }, { zone: 'utc' });
  return dt.isValid ? dt.toISODate() : null;
}
