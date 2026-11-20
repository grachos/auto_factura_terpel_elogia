// Plantillas sintéticas (ficticias) del correo de autorización. La muestra real anonimizada
// está pendiente: el parser se valida contra estas variantes hasta recibirla.

export interface TemplateFields {
  transport: string | null;
  remission: string | null;
  expense: string | null;
  serviceDate: string | null;
  plant: string | null;
  purchaseDoc: string | null;
  entrySheet: string | null;
  netValue: string | null;
  plate: string | null;
  route: string | null;
  volume: string | null;
  rate: string | null;
  driverCode: string | null;
  driverName: string | null;
}

export const SUBJECT = 'AUTORIZACION PAGO TERPEL – Facturacion de servicio';
export const ALLOWED_SENDER = 'flota@informacion.terpel.com';
export const MAILBOX = 'autorizaciones-terpel@empresa.example';
export const SUBJECT_PATTERN = 'AUTORIZACION PAGO TERPEL - Facturacion de servicio';

const LABELS: [keyof TemplateFields, string][] = [
  ['transport', 'Número de transporte'],
  ['remission', 'Número de remisión'],
  ['expense', 'Número de gasto'],
  ['serviceDate', 'Fecha del servicio'],
  ['plant', 'Planta de cargue'],
  ['purchaseDoc', 'Documento de compras o contrato'],
  ['entrySheet', 'Hoja de entrada de servicio'],
  ['netValue', 'Valor neto y moneda'],
  ['plate', 'Placa del vehículo'],
  ['route', 'Ruta'],
  ['volume', 'Volumen del transporte'],
  ['rate', 'Tarifa'],
  ['driverCode', 'Código del conductor'],
  ['driverName', 'Nombre del conductor'],
];

export function baseFields(overrides: Partial<TemplateFields> = {}): TemplateFields {
  return {
    transport: '000123',
    remission: '0080012345',
    expense: '4500098765',
    serviceDate: '15.01.2026',
    plant: '1P - Planta Ficticia Norte',
    purchaseDoc: '4600001234',
    entrySheet: '1000456789',
    netValue: '1.234.567,89 COP',
    plate: 'ABC123',
    route: 'Ficticia Norte - Ficticia Sur',
    volume: '9973,0000',
    rate: '123,4500',
    driverCode: 'D-0001',
    driverName: 'Conductor Ficticio Uno',
    ...overrides,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PREAMBLE = 'Cordial saludo. Por medio del presente se autoriza el pago del servicio de transporte.';

/** Tabla HTML: etiqueta y valor en celdas separadas (una etiqueta con valor null se omite = ausente). */
export function htmlTableBody(f: TemplateFields): string {
  const rows = LABELS.filter(([k]) => f[k] !== null)
    .map(([k, label]) => `<tr><td><b>${esc(label)}:</b></td><td>${esc(f[k] ?? '')}</td></tr>`)
    .join('\n');
  return `<html><body><p>${PREAMBLE}</p><p>Esta es la información del servicio</p><table>\n${rows}\n</table><p>Mensaje automático.</p></body></html>`;
}

/** Variante con otro formato de etiquetas: mayúsculas, sin tildes, sin dos puntos, párrafos. */
export function htmlParagraphBody(f: TemplateFields): string {
  const lines = LABELS.filter(([k]) => f[k] !== null)
    .map(([k, label]) => {
      const bare = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
      return `<p><strong>${esc(bare)}</strong>&nbsp;&nbsp;${esc(f[k] ?? '')}</p>`;
    })
    .join('\n');
  return `<div><p>${PREAMBLE}</p><p>ESTA ES LA INFORMACION DEL SERVICIO</p>${lines}</div>`;
}

export function textBody(f: TemplateFields): string {
  const lines = LABELS.filter(([k]) => f[k] !== null).map(([k, label]) => `${label}: ${f[k] ?? ''}`);
  return `${PREAMBLE}\r\n\r\nEsta es la información del servicio\r\n${lines.join('\r\n')}\r\n`;
}

/** Cuerpo de un reenvío (RV:) con el encabezado típico de Outlook antes del original. */
export function forwardedBody(inner: string): string {
  return `<html><body><p>Adjunto para su revisión.</p><hr><p><b>De:</b> flota@informacion.terpel.com<br><b>Enviado:</b> jueves<br><b>Asunto:</b> ${esc(SUBJECT)}</p>${inner}</body></html>`;
}
