import { describe, expect, it } from 'vitest';
import { DateRangeError, parseServiceDate, utcRangeForLocalDates } from '../core/dates.js';
import { normalizeDecimal } from '../core/decimal.js';
import { buildBusinessKey } from '../core/businessKey.js';
import { dmarcStatus, normalizeSubject, senderAllowed, subjectMatches } from '../core/subject.js';
import { parseAuthorization, htmlToText } from '../core/parser.js';
import { baseFields, forwardedBody, htmlParagraphBody, htmlTableBody, textBody, SUBJECT_PATTERN } from '../fixtures/templates.js';
import { buildFixtures } from '../fixtures/messages.js';

describe('rango de fechas (America/Bogota)', () => {
  it('01-31 de enero → [01T05:00Z, 02-01T05:00Z)', () => {
    const r = utcRangeForLocalDates('2026-01-01', '2026-01-31');
    expect(r.utcStart.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(r.utcEndExclusive.toISOString()).toBe('2026-02-01T05:00:00.000Z');
  });
  it('23:59:59 y 00:00:00 de Bogotá caen en el lado correcto', () => {
    const r = utcRangeForLocalDates('2026-01-01', '2026-01-31');
    const inside = (iso: string) => new Date(iso) >= r.utcStart && new Date(iso) < r.utcEndExclusive;
    expect(inside('2026-01-01T04:59:59Z')).toBe(false); // 31/dic 23:59:59 Bogotá
    expect(inside('2026-01-01T05:00:00Z')).toBe(true); // 01/ene 00:00:00 Bogotá
    expect(inside('2026-02-01T04:59:59Z')).toBe(true); // 31/ene 23:59:59 Bogotá
    expect(inside('2026-02-01T05:00:00Z')).toBe(false); // 01/feb 00:00:00 Bogotá
  });
  it('un solo día y validaciones', () => {
    const r = utcRangeForLocalDates('2026-03-10', '2026-03-10');
    expect(r.utcEndExclusive.getTime() - r.utcStart.getTime()).toBe(24 * 3600 * 1000);
    expect(() => utcRangeForLocalDates('2026-03-10', '2026-03-09')).toThrow(DateRangeError);
    expect(() => utcRangeForLocalDates('2026-13-01', '2026-13-02')).toThrow(DateRangeError);
    expect(() => utcRangeForLocalDates('10/03/2026', '2026-03-10')).toThrow(DateRangeError);
    expect(() => utcRangeForLocalDates('2024-01-01', '2026-01-01')).toThrow(DateRangeError);
  });
  it('fecha del servicio DD.MM.AAAA', () => {
    expect(parseServiceDate('15.01.2026')).toBe('2026-01-15');
    expect(parseServiceDate('31.02.2026')).toBeNull();
    expect(parseServiceDate('2026-01-15')).toBeNull();
  });
});

describe('normalizador de decimales', () => {
  const cases: [string, string | null, string][] = [
    ['9973,0000', '9973.0000', 'ok'],
    ['1.234.567,89', '1234567.89', 'ok'],
    ['1,234,567.89', '1234567.89', 'ok'],
    ['1,234.5', '1234.5', 'ok'],
    ['1234567.50', '1234567.50', 'ok'],
    ['12,5', '12.5', 'ok'],
    ['0', '0', 'ok'],
    ['0,5', '0.5', 'ok'],
    ['0.500', '0.500', 'ok'],
    ['1.234.567', '1234567', 'ok'],
    ['-45,5', '-45.5', 'ok'],
    ['1.234', null, 'ambiguous'],
    ['1,234,567', null, 'ambiguous'],
    ['12a', null, 'invalid'],
    ['1.23.4', null, 'invalid'],
    ['', null, 'empty'],
    ['   ', null, 'empty'],
  ];
  for (const [input, value, status] of cases) {
    it(`"${input}" → ${status}`, () => {
      const r = normalizeDecimal(input);
      expect(r.status).toBe(status);
      expect(r.value).toBe(value);
    });
  }
  it('vacío es distinto de cero', () => {
    expect(normalizeDecimal('').value).toBeNull();
    expect(normalizeDecimal('0').value).toBe('0');
    expect(normalizeDecimal(null).status).toBe('empty');
  });
});

describe('asunto y remitente', () => {
  it('acepta variantes de guión, tildes, mayúsculas y prefijos', () => {
    const variants = [
      'AUTORIZACION PAGO TERPEL – Facturacion de servicio',
      'Autorización Pago Terpel - Facturación de servicio',
      'autorizacion pago terpel — facturacion de   servicio',
      'RV: AUTORIZACION PAGO TERPEL – Facturacion de servicio',
      'Re: RV: Autorización Pago Terpel-Facturación de servicio',
      'FWD:AUTORIZACION PAGO TERPEL - Facturacion de servicio',
    ];
    for (const v of variants) expect(subjectMatches(v, SUBJECT_PATTERN).matches, v).toBe(true);
    expect(normalizeSubject('RV: x').isForward).toBe(true);
    expect(normalizeSubject('x').isForward).toBe(false);
    expect(subjectMatches('Otro asunto', SUBJECT_PATTERN).matches).toBe(false);
  });
  it('remitente: from y sender deben coincidir exactamente', () => {
    const a = 'flota@informacion.terpel.com';
    expect(senderAllowed('FLOTA@Informacion.Terpel.com', a, a)).toBe(true);
    expect(senderAllowed(a, 'otro@x.com', a)).toBe(false);
    expect(senderAllowed('flota@informacion-terpel.com', 'flota@informacion-terpel.com', a)).toBe(false);
    expect(senderAllowed('', '', a)).toBe(false);
  });
  it('DMARC', () => {
    expect(dmarcStatus('spf=pass; dmarc=pass action=none')).toBe('pass');
    expect(dmarcStatus('dmarc=fail')).toBe('fail');
    expect(dmarcStatus(null)).toBe('unknown');
  });
});

describe('clave de negocio', () => {
  it('conserva ceros a la izquierda y es configurable', () => {
    expect(buildBusinessKey('transport_number', { transportNumber: '000123', expenseNumber: null })).toBe('000123');
    expect(buildBusinessKey('transport_number', { transportNumber: '', expenseNumber: null })).toBeNull();
    expect(buildBusinessKey('transport_expense', { transportNumber: '000123', expenseNumber: '45' })).toBe('000123|45');
    expect(buildBusinessKey('transport_expense', { transportNumber: '000123', expenseNumber: null })).toBeNull();
  });
});

describe('parser de la plantilla', () => {
  it('lee todos los campos de la variante en tabla', () => {
    const p = parseAuthorization({ contentType: 'html', content: htmlTableBody(baseFields()) });
    expect(p.parseStatus).toBe('ok');
    expect(p.templateVariant).toBe('html-table');
    expect(p.transportNumber).toBe('000123'); // ceros a la izquierda
    expect(p.remissionNumber).toBe('0080012345');
    expect(p.serviceDate).toBe('2026-01-15');
    expect(p.netValue).toBe('1234567.89');
    expect(p.currency).toBe('COP');
    expect(p.plateNormalized).toBe('ABC123');
    expect(p.transportVolumeRaw).toBe('9973,0000');
    expect(p.transportVolume).toBe('9973.0000');
    expect(p.transportVolumeUnit).toBeNull();
    expect(p.unitStatus).toBe('pending_confirmation');
    expect(p.rate).toBe('123.4500');
    expect(p.driverCode).toBe('D-0001');
    expect(p.parserVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.issues).toEqual([]);
  });
  it('etiquetas con otro formato (mayúsculas, sin tildes, sin ":")', () => {
    const p = parseAuthorization({ contentType: 'html', content: htmlParagraphBody(baseFields({ transport: '000127' })) });
    expect(p.parseStatus).toBe('ok');
    expect(p.templateVariant).toBe('html-text');
    expect(p.transportNumber).toBe('000127');
    expect(p.route).toBe('Ficticia Norte - Ficticia Sur');
  });
  it('solo texto', () => {
    const p = parseAuthorization({ contentType: 'text', content: textBody(baseFields({ transport: '000128' })) });
    expect(p.parseStatus).toBe('ok');
    expect(p.templateVariant).toBe('plain-text');
    expect(p.transportNumber).toBe('000128');
  });
  it('reenvío RV: con encabezado previo', () => {
    const p = parseAuthorization({ contentType: 'html', content: forwardedBody(htmlTableBody(baseFields())) });
    expect(p.parseStatus).toBe('ok');
    expect(p.transportNumber).toBe('000123');
  });
  it('vacío ≠ cero y etiqueta ausente ≠ vacía', () => {
    const p = parseAuthorization({
      contentType: 'html',
      content: htmlTableBody(baseFields({ volume: '', route: '', rate: null })),
    });
    expect(p.rawFields.transport_volume).toBe('');
    expect(p.transportVolume).toBeNull();
    expect(p.rawFields.route).toBe('');
    expect(p.rawFields.rate).toBeNull();
    const codes = p.issues.map((i) => `${i.code}:${i.field}`);
    expect(codes).toContain('EMPTY_REQUIRED_FIELD:transport_volume');
    expect(codes).toContain('MISSING_FIELD:rate');
    expect(codes).not.toContain('EMPTY_REQUIRED_FIELD:route'); // ruta es opcional
    expect(p.parseStatus).toBe('incomplete');
    const zero = parseAuthorization({ contentType: 'html', content: htmlTableBody(baseFields({ volume: '0' })) });
    expect(zero.transportVolume).toBe('0');
    expect(zero.parseStatus).toBe('ok');
  });
  it('decimal ambiguo no se adivina', () => {
    const p = parseAuthorization({ contentType: 'html', content: htmlTableBody(baseFields({ volume: '1.234' })) });
    expect(p.transportVolume).toBeNull();
    expect(p.transportVolumeRaw).toBe('1.234');
    expect(p.issues.some((i) => i.code === 'AMBIGUOUS_DECIMAL')).toBe(true);
    expect(p.parseStatus).toBe('incomplete');
  });
  it('planta 9P solo marca', () => {
    const p = parseAuthorization({ contentType: 'html', content: htmlTableBody(baseFields({ plant: '9P - Planta X' })) });
    expect(p.loadingPlantFlag).toBe('9P');
    const q = parseAuthorization({ contentType: 'html', content: htmlTableBody(baseFields({ plant: '19P2' })) });
    expect(q.loadingPlantFlag).toBeNull();
  });
  it('sin bloque de plantilla → error', () => {
    const p = parseAuthorization({ contentType: 'html', content: '<p>hola</p>' });
    expect(p.parseStatus).toBe('error');
    expect(p.issues[0]?.code).toBe('TEMPLATE_BLOCK_NOT_FOUND');
  });
  it('fecha inválida', () => {
    const p = parseAuthorization({ contentType: 'html', content: htmlTableBody(baseFields({ serviceDate: '2026-01-15' })) });
    expect(p.issues.some((i) => i.code === 'INVALID_DATE')).toBe(true);
  });
  it('htmlToText separa celdas y filas', () => {
    expect(htmlToText('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>')).toMatch(/A\s+B\s*\n+\s*C/);
  });
  it('todos los fixtures de enero se leen sin excepciones', () => {
    for (const m of buildFixtures().all) {
      expect(() => parseAuthorization({ contentType: m.bodyContentType, content: m.bodyContent })).not.toThrow();
    }
  });
});
