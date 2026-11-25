import type { MailMessage } from '../core/mail/types.js';
import {
  ALLOWED_SENDER, SUBJECT, baseFields, forwardedBody, htmlParagraphBody, htmlTableBody, textBody,
} from './templates.js';

let seq = 0;

function msg(over: Partial<MailMessage> & { receivedDateTime: string; bodyContent: string }): MailMessage {
  seq += 1;
  const n = String(seq).padStart(3, '0');
  return {
    id: `AAMkImmutable${n}`,
    internetMessageId: `<fixture-${n}@informacion.terpel.com>`,
    conversationId: `conv-${n}`,
    subject: SUBJECT,
    from: ALLOWED_SENDER,
    sender: ALLOWED_SENDER,
    bodyContentType: 'html',
    authenticationResults: 'spf=pass smtp.mailfrom=informacion.terpel.com; dkim=pass; dmarc=pass action=none',
    ...over,
  };
}

export interface FixtureSet {
  /** Todos los mensajes (algunos fuera del rango de enero de 2026 en Bogotá). */
  all: MailMessage[];
  byName: Record<string, MailMessage>;
}

/**
 * Conjunto sintético para enero de 2026 (America/Bogota, UTC-5). Conductores ficticios.
 * Rango "2026-01-01" a "2026-01-31" → [2026-01-01T05:00Z, 2026-02-01T05:00Z).
 */
export function buildFixtures(): FixtureSet {
  seq = 0;
  const byName: Record<string, MailMessage> = {};
  const add = (name: string, m: MailMessage): void => {
    byName[name] = m;
  };

  add('valid', msg({ receivedDateTime: '2026-01-05T14:00:00Z', bodyContent: htmlTableBody(baseFields()) }));
  add('plant9P', msg({
    receivedDateTime: '2026-01-06T14:00:00Z',
    bodyContent: htmlTableBody(baseFields({
      transport: '000124', plant: '9P - Planta Ficticia Cliente', netValue: '2.493.250,00 COP', plate: 'XYZ-987',
      driverCode: 'D-0002', driverName: 'Conductor Ficticio Dos',
    })),
  }));
  add('zeros', msg({
    receivedDateTime: '2026-01-07T14:00:00Z',
    bodyContent: htmlTableBody(baseFields({
      transport: '007890', volume: '0', netValue: '350000 COP', rate: '0', driverCode: 'D-0003', driverName: 'Conductor Ficticio Tres',
    })),
  }));
  // Reenvío idéntico del servicio 000124 (RV:)
  add('forwardIdentical', msg({
    receivedDateTime: '2026-01-08T14:00:00Z',
    subject: `RV: ${SUBJECT}`,
    bodyContent: forwardedBody(htmlTableBody(baseFields({
      transport: '000124', plant: '9P - Planta Ficticia Cliente', netValue: '2.493.250,00 COP', plate: 'XYZ-987',
      driverCode: 'D-0002', driverName: 'Conductor Ficticio Dos',
    }))),
  }));
  // Servicio 000125 original y corrección con valor distinto
  add('originalToCorrect', msg({
    receivedDateTime: '2026-01-09T14:00:00Z',
    bodyContent: htmlTableBody(baseFields({ transport: '000125', netValue: '800.000,00 COP', driverCode: 'D-0004', driverName: 'Conductor Ficticio Cuatro' })),
  }));
  add('corrected', msg({
    receivedDateTime: '2026-01-12T14:00:00Z',
    subject: `RE: ${SUBJECT}`,
    bodyContent: htmlTableBody(baseFields({ transport: '000125', netValue: '850.000,00 COP', driverCode: 'D-0004', driverName: 'Conductor Ficticio Cuatro' })),
  }));
  add('emptyFields', msg({
    receivedDateTime: '2026-01-13T14:00:00Z',
    bodyContent: htmlTableBody(baseFields({ transport: '000126', volume: '', route: '', rate: null, driverCode: 'D-0005', driverName: 'Conductor Ficticio Cinco' })),
  }));
  add('altFormat', msg({
    receivedDateTime: '2026-01-14T14:00:00Z',
    subject: 'Autorización Pago Terpel - Facturación de servicio',
    bodyContent: htmlParagraphBody(baseFields({ transport: '000127', netValue: '1234567.5 COP', volume: '120,5', driverCode: 'D-0006', driverName: 'Conductor Ficticio Seis' })),
  }));
  add('textOnly', msg({
    receivedDateTime: '2026-01-15T14:00:00Z',
    bodyContentType: 'text',
    bodyContent: textBody(baseFields({ transport: '000128', driverCode: 'D-0007', driverName: 'Conductor Ficticio Siete' })),
  }));
  add('fakeSender', msg({
    receivedDateTime: '2026-01-16T14:00:00Z',
    from: 'flota@informacion-terpel.example',
    sender: 'flota@informacion-terpel.example',
    bodyContent: htmlTableBody(baseFields({ transport: '000999', driverName: 'Conductor Falso' })),
  }));
  add('otherSubject', msg({
    receivedDateTime: '2026-01-17T14:00:00Z',
    subject: 'Boletín informativo de la semana',
    bodyContent: '<html><body>Sin relación</body></html>',
  }));
  add('internalForward', msg({
    receivedDateTime: '2026-01-18T14:00:00Z',
    subject: `FW: ${SUBJECT}`,
    from: 'coordinador.interno@empresa.example',
    sender: 'coordinador.interno@empresa.example',
    bodyContent: forwardedBody(htmlTableBody(baseFields({ transport: '000130', driverName: 'Conductor Ficticio Ocho' }))),
  }));
  add('ambiguousDecimal', msg({
    receivedDateTime: '2026-01-19T14:00:00Z',
    bodyContent: htmlTableBody(baseFields({ transport: '000131', volume: '1.234', driverCode: 'D-0009', driverName: 'Conductor Ficticio Nueve' })),
  }));
  add('noBlock', msg({
    receivedDateTime: '2026-01-20T14:00:00Z',
    bodyContent: '<html><body><p>Hola, sin la plantilla esperada.</p></body></html>',
  }));
  // Límites del rango en Bogotá
  add('beforeRange', msg({ receivedDateTime: '2026-01-01T04:59:59Z', bodyContent: htmlTableBody(baseFields({ transport: '000200' })) }));
  add('startOfRange', msg({ receivedDateTime: '2026-01-01T05:00:00Z', bodyContent: htmlTableBody(baseFields({ transport: '000201', driverCode: 'D-0010', driverName: 'Conductor Ficticio Diez' })) }));
  add('endOfRange', msg({ receivedDateTime: '2026-02-01T04:59:59Z', bodyContent: htmlTableBody(baseFields({ transport: '000202', driverCode: 'D-0011', driverName: 'Conductor Ficticio Once' })) }));
  add('afterRange', msg({ receivedDateTime: '2026-02-01T05:00:00Z', bodyContent: htmlTableBody(baseFields({ transport: '000203' })) }));

  return { all: Object.values(byName), byName };
}
