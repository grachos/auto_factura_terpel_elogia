import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function loginAs(page: Page, role: 'operator' | 'admin' | 'viewer' | 'facturacion'): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await page.getByTestId(`demo-user-${role}`).click();
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('whoami')).toBeVisible();
}

test('sin sesión se ve el login y la API rechaza', async ({ page, request }) => {
  const res = await request.get('/api/runs');
  expect(res.status()).toBe(401);
  await page.goto('/');
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await page.getByTestId('login-email').fill('operador@demo.local');
  await page.getByTestId('login-password').fill('incorrecta');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toBeVisible();
});

test('operador importa, ve resultados e incidencias y descarga el Excel; la 2.ª vez todo es duplicado', async ({ page }) => {
  await loginAs(page, 'operator');
  await expect(page.getByTestId('mail-source')).toContainText('simulado');
  await expect(page.getByTestId('config-panel')).toHaveCount(0);

  await page.getByTestId('import-button').click();
  await expect(page.getByTestId('run-status')).toContainText('Completada', { timeout: 30_000 });
  await expect(page.getByTestId('count-found')).toHaveText('16');
  await expect(page.getByTestId('count-imported')).toHaveText('9');
  await expect(page.getByTestId('count-review')).toHaveText('5');
  await expect(page.getByTestId('count-ignored')).toHaveText('2');
  await expect(page.getByTestId('count-duplicates')).toHaveText('0');

  const table = page.getByTestId('results-table');
  await expect(table.locator('tbody tr')).toHaveCount(10);
  await expect(table.locator('td', { hasText: /^000123$/ })).toBeVisible(); // ceros a la izquierda
  await expect(table).toContainText('9973,0000 → 9973.0000');

  await page.getByTestId('tab-issues').click();
  await expect(page.getByTestId('issues-table')).toContainText('CORRECTED_AUTHORIZATION');
  await expect(page.getByTestId('issues-table')).toContainText('SENDER_NOT_ALLOWED');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-button').click()]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

  // Segunda importación del mismo rango
  await page.getByTestId('import-button').click();
  await expect(page.getByTestId('run-status')).toContainText('Completada', { timeout: 30_000 });
  await expect(page.getByTestId('count-found')).toHaveText('16');
  await expect(page.getByTestId('count-duplicates')).toHaveText('16');
  await expect(page.getByTestId('count-imported')).toHaveText('0');
  await expect(page.getByTestId('history-row')).toHaveCount(2);

  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login-submit')).toBeVisible();
});

test('lector no puede importar y administrador ve la configuración', async ({ page }) => {
  await loginAs(page, 'viewer');
  await expect(page.getByTestId('import-button')).toBeDisabled();
  await expect(page.getByTestId('config-panel')).toHaveCount(0);
  await expect(page.getByTestId('history-row').first()).toBeVisible();
  await page.getByTestId('logout').click();

  await loginAs(page, 'admin');
  await expect(page.getByTestId('config-panel')).toBeVisible();
});

test('Fase 2: operador concilia, ve traza, elige candidato; admin edita parámetros; Excel descargable', async ({ page }) => {
  await loginAs(page, 'operator');
  await expect(page.getByTestId('nav-params')).toHaveCount(0);
  await page.getByTestId('import-button').click();
  await expect(page.getByTestId('run-status')).toContainText('Completada', { timeout: 30_000 });

  await page.getByTestId('nav-recon').click();
  await page.getByTestId('recon-from').fill('2026-01-01');
  await page.getByTestId('recon-to').fill('2026-01-31');
  await page.getByTestId('recon-button').click();
  await expect(page.getByTestId('recon-status')).toContainText('Completada', { timeout: 30_000 });
  await expect(page.getByTestId('recon-total')).toHaveText('10');
  await expect(page.getByTestId('recon-amb')).toHaveText('1');
  await expect(page.getByTestId('recon-exact')).not.toHaveText('0');

  const row = page.locator('[data-testid=recon-row][data-transport="000125"]');
  await expect(row).toContainText('Ambiguo');
  await row.click();
  await expect(page.getByTestId('trace-table')).toBeVisible();
  await page.getByTestId('pick-candidate').first().click();
  await expect(page.getByTestId('recon-notice')).toContainText('Candidato elegido');
  await expect(row).toContainText('manual');

  await page.getByTestId('recon-review').check();
  await expect(page.getByTestId('recon-table').locator('[data-testid=recon-row]').first()).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('recon-download').click()]);
  expect(download.suggestedFilename()).toMatch(/^conciliacion-.*\.xlsx$/);
  await page.getByTestId('logout').click();

  await loginAs(page, 'admin');
  await page.getByTestId('nav-params').click();
  await expect(page.getByTestId('alias-table')).toContainText('Lizama');
  await page.getByTestId('new-alias-silog').fill('Sitio Demo');
  await page.getByTestId('new-alias-terpel').fill('Lugar Demo');
  await page.getByTestId('add-alias').click();
  await expect(page.getByTestId('alias-table')).toContainText('Sitio Demo');
  await page.getByTestId('set-window').fill('7');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('params-msg')).toContainText('guardados');
  await page.getByTestId('save-filters').click();
  await expect(page.getByTestId('params-msg')).toContainText('Filtros guardados');
});

test('Incremento 1: admin registra usuario de Silogtran; ingreso con ese usuario y vistas por rol', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.getByTestId('nav-users').click();
  await page.getByTestId('new-user-name').fill('Laura.Fact');
  await page.getByTestId('new-user-role').selectOption('facturacion');
  await page.getByTestId('new-user-submit').click();
  await expect(page.getByTestId('users-table')).toContainText('laura.fact');
  // cuenta de ajustes: write-only
  await page.getByTestId('svc-user').fill('cuenta.ajustes');
  await page.getByTestId('svc-pass').fill('clave-ficticia');
  await page.getByTestId('svc-save').click();
  await expect(page.getByTestId('service-adjust-status')).toContainText('Guardada: usuario cuenta.ajustes');
  await expect(page.getByTestId('service-panel')).not.toContainText('clave-ficticia');
  await page.getByTestId('logout').click();

  await page.goto('/');
  await page.getByTestId('login-mode-silog').click();
  await page.getByTestId('login-email').fill('no.registrado');
  await page.getByTestId('login-password').fill('demo');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toContainText('Usuario o contraseña incorrectos');

  await page.getByTestId('login-email').fill('laura.fact');
  await page.getByTestId('login-password').fill('demo');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('whoami')).toContainText('Facturación');
  await expect(page.getByTestId('nav-users')).toHaveCount(0);
  await expect(page.getByTestId('config-panel')).toHaveCount(0);
  await expect(page.getByTestId('import-button')).toBeEnabled();
  await page.getByTestId('nav-params').click();
  await expect(page.getByTestId('params-readonly')).toBeVisible();
  await expect(page.getByTestId('save-filters')).toHaveCount(0);
  await expect(page.getByTestId('alias-table')).toContainText('Lizama');
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login-submit')).toBeVisible();

  await loginAs(page, 'viewer');
  await expect(page.getByTestId('nav-params')).toHaveCount(0);
  await expect(page.getByTestId('nav-users')).toHaveCount(0);
  await expect(page.getByTestId('import-button')).toBeDisabled();
});

test('Fase 3: facturación genera, simula, aprueba y aplica (simulado); banner y línea de tiempo', async ({ page }) => {
  await loginAs(page, 'facturacion');
  await expect(page.getByTestId('sim-banner')).toContainText('MODO SIMULADO');
  await page.getByTestId('nav-recon').click();
  await page.getByTestId('recon-from').fill('2026-01-01');
  await page.getByTestId('recon-to').fill('2026-01-31');
  await expect(page.getByTestId('recon-informe-note')).toContainText('no refleja');
  await page.getByTestId('recon-button').click();
  await expect(page.getByTestId('recon-status')).toContainText('Completada', { timeout: 30_000 });

  await page.getByTestId('nav-adjust').click();
  await page.getByTestId('adj-generate').click();
  const row = page.locator('[data-testid=adj-row][data-transport="000124"]');
  await expect(row).toContainText('Propuesta');
  await row.click();
  await expect(page.getByTestId('adj-detail')).toContainText('Nueva Tarifa');
  await expect(page.getByTestId('adj-detail')).toContainText('Cantidad Remesa');
  await page.getByTestId('adj-simulate').click();
  await expect(page.getByTestId('adj-preview')).toContainText('"nuevaTarifa": "250"');
  await page.getByTestId('adj-approve').click();
  await expect(row.getByTestId('adj-status')).toContainText('Aprobada');
  await page.getByTestId('adj-apply').click();
  await expect(page.getByTestId('adj-confirm')).toContainText('MODO SIMULADO');
  await page.getByTestId('adj-confirm-ok').click();
  await expect(row.getByTestId('adj-status')).toContainText('SIMULADA');
  await expect(page.getByTestId('adj-simulated')).toBeVisible();
  await expect(page.getByTestId('adj-timeline')).toContainText('SIMULADO');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('adj-export').click()]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  await page.getByTestId('logout').click();

  await loginAs(page, 'viewer');
  await page.getByTestId('nav-adjust').click();
  await expect(page.getByTestId('adj-generate')).toHaveCount(0);
  await page.locator('[data-testid=adj-row][data-transport="000124"]').click();
  await expect(page.getByTestId('adj-approve')).toHaveCount(0);
  await expect(page.getByTestId('adj-apply')).toHaveCount(0);
});

test('Incremento 3b: el banner refleja el modo del escritor (simulado / escritura real) y solo admin lo cambia', async ({ page }) => {
  await loginAs(page, 'facturacion');
  await expect(page.getByTestId('sim-banner')).toBeVisible();
  await page.getByTestId('nav-adjust').click();
  await expect(page.getByTestId('adj-save-settings')).toHaveCount(0); // facturación no edita el escritor
  await expect(page.getByTestId('adj-writer-mode')).toBeDisabled();
  await page.getByTestId('logout').click();

  await loginAs(page, 'admin');
  page.on('dialog', (d) => void d.accept());
  await page.getByTestId('nav-adjust').click();
  await page.getByTestId('adj-writer-mode').selectOption('web');
  await page.getByTestId('adj-allowlist').fill('0101228393, 555');
  await page.getByTestId('adj-save-settings').click();
  await expect(page.getByTestId('real-banner')).toContainText('ESCRITURA REAL ACTIVA');
  await expect(page.getByTestId('real-banner')).toContainText('101228393, 555');
  await expect(page.getByTestId('sim-banner')).toHaveCount(0);
  await page.getByTestId('adj-writer-mode').selectOption('mock');
  await page.getByTestId('adj-save-settings').click();
  await expect(page.getByTestId('sim-banner')).toBeVisible();
  await expect(page.getByTestId('real-banner')).toHaveCount(0);
});

test('Modo asistido: plan, confirmación explícita, corrida con progreso y reporte (escritor simulado)', async ({ page }) => {
  await loginAs(page, 'operator');
  await page.getByTestId('nav-adjust').click();
  await expect(page.getByTestId('assisted-panel')).toHaveCount(0); // el operador no ejecuta el modo asistido
  await page.getByTestId('logout').click();

  await loginAs(page, 'admin');
  await page.getByTestId('nav-adjust').click();
  await page.getByTestId('adj-discard').click(); // descarta las simulaciones previas para volver a proponerlas
  await page.getByTestId('assisted-plan-button').click();
  await expect(page.getByTestId('assisted-sim-banner')).toContainText('MODO SIMULADO');
  await expect(page.getByTestId('assisted-eligible-count')).not.toHaveText('0');
  await expect(page.getByTestId('assisted-start')).toBeDisabled(); // sin confirmar no se puede iniciar
  await page.getByTestId('assisted-confirm').check();
  await page.getByTestId('assisted-start').click();
  await expect(page.getByTestId('assisted-status')).toHaveText('Completada', { timeout: 30_000 });
  await expect(page.getByTestId('assisted-item').first()).toContainText('Aplicada');
  await expect(page.getByTestId('assisted-report-note')).toContainText('Facturación: pendiente');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('assisted-download').click()]);
  expect(download.suggestedFilename()).toMatch(/^asistido-.*\.xlsx$/);
});
