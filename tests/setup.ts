import { setLogSink } from '../core/logger.js';

// Las pruebas no imprimen logs estructurados (se verifican por separado en logger.test.ts).
setLogSink(() => undefined);
