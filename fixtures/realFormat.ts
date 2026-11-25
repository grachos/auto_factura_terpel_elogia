import type { MailMessage } from '../core/mail/types.js';
import { ALLOWED_SENDER, SUBJECT } from './templates.js';

export const INTERNAL_FORWARDER = 'facturacion.interna@empresa.example';

/**
 * Cuerpo SINTÉTICO que reproduce el formato observado en reenvíos reales: texto plano, encabezado del
 * reenvío interno + "De:" citado, etiquetas abreviadas ("Doc. Compras (Contrato)", "Hoja de Entrada de Serv"),
 * "Valor neto: $NNN COP" y, a veces, "Volumen del transporte" pegado a la línea de la ruta. Datos ficticios.
 */
export function realFormatBody(o: { transport: string; volumeInline?: boolean; volume?: string; net?: string }): string {
  const volume = o.volume ?? '10000,0000';
  const route = 'C00000-CIUDAD UNO - CIUDAD DOS';
  return [
    '',
    '-----Original Message-----',
    'From: PERSONA INTERNA <persona.interna@empresa.example>',
    'Sent: miércoles, 25 de noviembre de 2026 4:55 a. m.',
    `To: FACTURACION <${INTERNAL_FORWARDER}>`,
    `Subject: RV: ${SUBJECT}`,
    '',
    '________________________________________',
    `De: ${ALLOWED_SENDER.toUpperCase()} <${ALLOWED_SENDER.toUpperCase()}>`,
    'Enviados: miércoles, 25 de noviembre de 2026 4:54:47 (UTC-05:00) Bogota, Lima, Quito, Rio Branco',
    'Para: Facturación',
    `Asunto: ${SUBJECT}`,
    '',
    'Buen día Estimado Proveedor,',
    '',
    'Esta es la información del servicio:',
    '',
    `Numero de transporte: ${o.transport}`,
    'Numero de remisión:',
    'Numero de gasto: 0001234567',
    'Fecha del servicio: 21.11.2026',
    'Planta de cargue:',
    'Doc. Compras (Contrato): 4700000001',
    'Hoja de Entrada de Serv: 1000000001',
    `Valor neto: $${o.net ?? '4453353'} COP`,
    'Placa del vehículo: AAA111',
    o.volumeInline ? `Ruta: ${route} Volumen del transporte: ${volume}` : `Ruta: ${route}`,
    ...(o.volumeInline ? [] : [`Volumen del transporte: ${volume}`]),
    'Tarifa: 0',
    'Código del conductor: 0001112223',
    'Nombre del conductor: CONDUCTOR FICTICIO',
    '',
    'Para reportar novedad, tenga en cuenta que los servicios con planta de cargue 9P corresponde a Terpel Exportaciones.',
  ].join('\n');
}

export function internalForward(
  id: string,
  transport: string,
  over: Partial<MailMessage> = {},
  bodyOpts: { volumeInline?: boolean; volume?: string } = {},
): MailMessage {
  return {
    id: `AAMkReal${id}`,
    internetMessageId: `<real-${id}@empresa.example>`,
    conversationId: `conv-real-${id}`,
    subject: `RE: ${SUBJECT}`,
    from: INTERNAL_FORWARDER,
    sender: INTERNAL_FORWARDER,
    bodyContentType: 'text',
    bodyContent: realFormatBody({ transport, ...bodyOpts }),
    authenticationResults: null,
    receivedDateTime: '2026-01-15T14:00:00Z',
    ...over,
  };
}
