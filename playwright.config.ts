import { defineConfig } from '@playwright/test';

// Smoke de UI contra el servidor local en modo demo (datos ficticios, PGlite en memoria).
// Usa el Chromium preinstalado (no se ejecuta `playwright install`).
const PORT = 4310;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  webServer: {
    command: 'npm run build && npx tsx server/index.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      AUTH_MODE: 'demo',
      PGLITE_MEMORY: '1',
      DATA_DIR: '.data/e2e',
      PORT: String(PORT),
      MAIL_SOURCE: 'mock',
      DEMO_JWT_SECRET: 'secreto-e2e-solo-local',
    },
  },
});
