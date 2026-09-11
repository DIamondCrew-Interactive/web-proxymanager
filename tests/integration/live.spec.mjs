import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('real NPM login, dashboard, sections, proxy create/edit and SSL dialogs', async ({ page }) => {
  const credentials = JSON.parse(readFileSync('/run/smoke/credentials.json', 'utf8'));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Block optional external avatars/version websites; NEVER intercept the NPM API.
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    return u.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/');
  await expect(page).toHaveTitle('DiamondCrew Interactive | Proxy Manager');
  await expect(page.locator('.dc-wordmark')).toContainText('Interactive');
  await page.locator('input[name="email"]').fill(credentials.email);
  await page.locator('input[name="password"]').fill(credentials.password);
  const login = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tokens' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await login).status()).toBe(200);
  await expect(page.locator('.dc-dashboard')).toBeVisible();
  for (const [path, heading] of [['/access', 'Access Lists'], ['/certificates', 'Certificates'], ['/users', 'Users'], ['/settings', 'Settings'], ['/audit-log', 'Audit Logs']]) {
    await page.locator(`#navbar-menu a[href="${path}"]`).click();
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    await expect(page.locator('[role="alert"].alert-danger:visible')).toHaveCount(0);
  }
  await page.locator('#navbar-menu a[href="/nginx/proxy"]').click();
  await page.getByRole('button', { name: 'Add Proxy Host', exact: true }).click();
  let dialog = page.getByRole('dialog');
  const domains = dialog.locator('#domainNames input[role="combobox"]');
  await domains.fill('smoke.dci.test');
  await domains.press('Enter');
  await dialog.locator('input[name="forwardHost"]').fill('smoke-backend');
  await dialog.locator('input[name="forwardPort"]').fill('8080');
  await dialog.locator('input[name="allowWebsocketUpgrade"]').check();
  const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/nginx/proxy-hosts' && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  const host = await createdResponse.json();
  expect(host.allow_websocket_upgrade).toBe(true);
  await expect(dialog).toBeHidden();
  const row = page.locator('table tr').filter({ hasText: 'smoke.dci.test' });
  await row.locator('.btn-action').click();
  await page.locator('.dropdown-menu.show').getByText('Edit', { exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('input[name="forwardPort"]')).toHaveValue('8080');
  await dialog.locator('input[name="forwardPort"]').fill('8081');
  await dialog.locator('input[name="forwardPort"]').blur();
  for (const id of ['locations', 'ssl', 'advanced', 'details']) {
    const tab = dialog.locator(`a[href="#tab-${id}"]`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator(`#tab-${id}`)).toBeVisible();
  }
  const edited = page.waitForResponse(r => new URL(r.url()).pathname === `/api/nginx/proxy-hosts/${host.id}` && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const editedResponse = await edited;
  expect(editedResponse.status()).toBe(200);
  const updated = await editedResponse.json();
  expect(updated.forward_port).toBe(8081);
  expect(updated.allow_websocket_upgrade).toBe(true);
  await expect(dialog).toBeHidden();
  await page.locator('#navbar-menu a[href="/certificates"]').click();
  for (const id of ['lets-encrypt-via-http', 'lets-encrypt-via-dns', 'certificates.custom']) {
    await page.getByRole('button', { name: 'Add Certificate', exact: true }).click();
    await page.locator(`.dropdown-menu.show [data-translation-id="${id}"]`).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('[role="alert"].alert-danger:visible')).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  await page.locator('#navbar-menu a[href="/audit-log"]').click();
  await expect(page.locator('table')).toContainText('smoke.dci.test');
  expect(errors).toEqual([]);
});
