import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function loginAs(page: Page, role: 'operator' | 'admin' | 'viewer'): Promise<void> {
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
