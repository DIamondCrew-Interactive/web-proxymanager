import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Entirely synthetic fixtures; requests never leave the local test server.
const permissions = { visibility: 'all', proxy_hosts: 'manage', redirection_hosts: 'manage', dead_hosts: 'manage', streams: 'manage', certificates: 'manage', access_lists: 'manage' };
const user = { id: 1, name: 'Demo Administrator', nickname: 'Demo', email: 'admin@example.test', roles: ['admin'], permissions, avatar: '/diamondcrew/logo.png', is_disabled: false, created_on: '2026-01-01 12:00:00', modified_on: '2026-01-01 12:00:00' };
const cert = { id: 1, owner_user_id: 1, owner: user, created_on: '2026-01-01 12:00:00', modified_on: '2026-01-01 12:00:00', nice_name: 'Example certificate', domain_names: ['app.example.test'], provider: 'letsencrypt', expires_on: '2027-01-01 12:00:00', meta: {}, proxy_hosts: [], redirection_hosts: [], dead_hosts: [], streams: [] };
const host = { id: 1, owner_user_id: 1, owner: user, created_on: '2026-01-01 12:00:00', modified_on: '2026-01-01 12:00:00', domain_names: ['app.example.test'], forward_scheme: 'http', forward_host: '192.0.2.10', forward_port: 8080, certificate_id: 1, certificate: cert, access_list_id: 0, enabled: true, ssl_forced: true, caching_enabled: false, block_exploits: true, allow_websocket_upgrade: true, http2_support: true, hsts_enabled: false, hsts_subdomains: false, trust_forwarded_proto: false, advanced_config: '', locations: [], meta: { nginx_online: true } };

async function mock(page, { authenticated = true, restricted = false, twoFactor = false, setup = true } = {}) {
  const writes = [], requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace(/\/$/, '');
    requests.push(path);
    const method = route.request().method();
    if (method !== 'GET') writes.push({ path, method, body: route.request().postDataJSON() });
    let body = [];
    if (path === '/api') body = { status: 'OK', setup, version: { major: 2, minor: 15, revision: 1 } };
    else if (path === '/api/tokens' && twoFactor) body = { requires_2fa: true, challenge_token: 'synthetic-challenge' };
    else if (path.startsWith('/api/tokens')) body = { token: 'synthetic-test-session', expires: '2099-01-01T00:00:00.000Z' };
    else if (path.startsWith('/api/users/') && path.endsWith('/2fa')) body = { enabled: false, backup_codes_remaining: 0 };
    else if (path.startsWith('/api/users/')) body = restricted ? { ...user, roles: [], permissions: { ...permissions, proxy_hosts: 'hidden', certificates: 'hidden' } } : user;
    else if (path === '/api/users') body = [user];
    else if (path === '/api/reports/hosts') body = { proxy: 1, redirection: 0, stream: 0, dead: 0 };
    else if (path === '/api/nginx/proxy-hosts/1') body = method === 'PUT' ? { ...host, ...route.request().postDataJSON() } : host;
    else if (path === '/api/nginx/proxy-hosts') body = method === 'POST' ? { ...host, ...route.request().postDataJSON() } : [host];
    else if (path === '/api/nginx/certificates') body = [cert];
    else if (path === '/api/nginx/certificates/1') body = cert;
    else if (path === '/api/nginx/certificates/dns-providers') body = [];
    else if (path.startsWith('/api/settings/')) body = { id: 'default-site', name: 'Default Site', value: 'congratulations', meta: {} };
    else if (path === '/api/version') body = { current: '2.15.1', latest: '2.15.1', update_available: false };
    await route.fulfill({ json: body });
  });
  await page.addInitScript(({ authenticated }) => {
    localStorage.setItem('locale', 'en');
    if (authenticated) localStorage.setItem('authentications', JSON.stringify([{ token: 'synthetic-test-session', expires: '2099-01-01T00:00:00.000Z' }]));
  }, { authenticated });
  return { writes, requests, errors };
}

test('login submits original contract; default dark and branding', async ({ page }) => {
  const state = await mock(page, { authenticated: false });
  await page.goto('/');
  await expect(page).toHaveTitle('DiamondCrew Interactive | Proxy Manager');
  await expect(page.locator('.dc-wordmark')).toContainText('Interactive');
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  await page.locator('input[name="email"]').fill('admin@example.test');
  await page.locator('input[name="password"]').fill('synthetic-test-password');
  mkdirSync('.build/screenshots', { recursive: true });
  await page.screenshot({ path: '.build/screenshots/login.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.dc-dashboard')).toBeVisible();
  expect(state.writes[0]).toEqual({ path: '/api/tokens', method: 'POST', body: { identity: 'admin@example.test', secret: 'synthetic-test-password' } });
  expect(state.errors).toEqual([]);
});

test('2FA challenge, cancel and verification remain functional', async ({ page }) => {
  const state = await mock(page, { authenticated: false, twoFactor: true });
  await page.goto('/');
  await page.locator('input[name="email"]').fill('admin@example.test');
  await page.locator('input[name="password"]').fill('synthetic-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('input[name="code"]')).toBeVisible();
  // Let Formik blur validation settle before clicking a button below its error text.
  await page.locator('input[name="code"]').fill('123456');
  await page.locator('input[name="code"]').blur();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await page.locator('input[name="email"]').fill('admin@example.test');
  await page.locator('input[name="password"]').fill('synthetic-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('input[name="code"]').fill('123456');
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('.dc-dashboard')).toBeVisible();
  expect(state.writes.at(-1).body).toEqual({ challenge_token: 'synthetic-challenge', code: '123456' });
});

test('dashboard and all navigation routes render without JavaScript errors', async ({ page }) => {
  const state = await mock(page);
  await page.goto('/');
  await expect(page.locator('.dc-overview table')).toHaveCount(2);
  await expect(page.locator('#navbar-menu')).toBeVisible();
  await page.screenshot({ path: '.build/screenshots/dashboard.png', fullPage: true });
  for (const [path, heading] of [['/nginx/proxy', 'Proxy Hosts'], ['/nginx/redirection', 'Redirection Hosts'], ['/nginx/stream', 'Streams'], ['/nginx/404', '404 Hosts'], ['/certificates', 'Certificates'], ['/access', 'Access Lists'], ['/users', 'Users'], ['/audit-log', 'Audit Logs'], ['/settings', 'Settings']]) {
    await page.locator(`#navbar-menu a[href="${path}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
  }
  expect(state.errors).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('Proxy Host editor tabs, WebSockets and save contract', async ({ page }) => {
  const state = await mock(page);
  await page.goto('/nginx/proxy');
  await page.locator('table .btn-action').first().click();
  await page.getByText('Edit', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[name="forwardHost"]')).toHaveValue('192.0.2.10');
  await expect(dialog.locator('input[name="allowWebsocketUpgrade"]')).toBeChecked();
  await dialog.locator('input[name="forwardPort"]').fill('8081');
  await dialog.locator('input[name="forwardPort"]').blur();
  for (const id of ['locations', 'ssl', 'advanced', 'details']) {
    const tab = dialog.locator(`a[href="#tab-${id}"]`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator(`#tab-${id}`)).toBeVisible();
  }
  await page.screenshot({ path: '.build/screenshots/proxy-editor.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = state.writes.find(r => r.path === '/api/nginx/proxy-hosts/1');
  expect(saved.method).toBe('PUT');
  expect(saved.body.forward_port).toBe(8081);
  expect(saved.body.allow_websocket_upgrade).toBe(true);
  expect(saved.body.domain_names).toEqual(['app.example.test']);
  expect(saved.body.certificate_id).toBe(1);
  expect(state.errors).toEqual([]);
});

test('restricted user cannot see protected navigation or fetch overview data', async ({ page }) => {
  const state = await mock(page, { restricted: true });
  await page.goto('/');
  await expect(page.locator('.dc-hero')).toBeVisible();
  await expect(page.locator('#navbar-menu a[href="/users"]')).toHaveCount(0);
  await expect(page.locator('#navbar-menu a[href="/nginx/proxy"]')).toHaveCount(0);
  await expect(page.locator('.dc-overview table')).toHaveCount(0);
  expect(state.requests).not.toContain('/api/nginx/proxy-hosts');
  expect(state.requests).not.toContain('/api/nginx/certificates');
});

test('mobile menu, modal fit and close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(page.locator('#navbar-menu')).toHaveClass(/\bshow\b/);
  await page.locator('#navbar-menu a[href="/nginx/proxy"]').click();
  await expect(page.locator('#navbar-menu')).toBeHidden();
  await page.getByRole('button', { name: 'Add Proxy Host', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const box = await page.locator('.modal-content').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.build/screenshots/mobile-editor.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('create dialogs for all host types, access lists and users preserve tabs', async ({ page }) => {
  const state = await mock(page);
  for (const [path, label] of [['/nginx/proxy', 'Add Proxy Host'], ['/nginx/redirection', 'Add Redirection Host'], ['/nginx/stream', 'Add Stream'], ['/nginx/404', 'Add 404 Host'], ['/access', 'Add Access List'], ['/users', 'Add User']]) {
    await page.goto(path);
    await page.getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (const tab of await dialog.locator('.nav-tabs .nav-link').all()) {
      await tab.click();
      await expect(tab).toHaveClass(/active/);
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  expect(state.errors).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('Let’s Encrypt HTTP, DNS and custom certificate dialogs', async ({ page }) => {
  const state = await mock(page);
  await page.goto('/certificates');
  for (const id of ['lets-encrypt-via-http', 'lets-encrypt-via-dns', 'certificates.custom']) {
    await page.getByRole('button', { name: 'Add Certificate', exact: true }).click();
    await page.locator(`.dropdown-menu.show [data-translation-id="${id}"]`).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  expect(state.errors).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('create Proxy Host uses unchanged endpoint and payload', async ({ page }) => {
  const state = await mock(page);
  await page.goto('/nginx/proxy');
  await page.getByRole('button', { name: 'Add Proxy Host', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const domains = dialog.locator('#domainNames input[role="combobox"]');
  await domains.fill('new.example.test');
  await domains.press('Enter');
  await dialog.locator('input[name="forwardHost"]').fill('192.0.2.20');
  await dialog.locator('input[name="forwardPort"]').fill('3000');
  await dialog.locator('input[name="allowWebsocketUpgrade"]').check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = state.writes.find(r => r.method === 'POST' && r.path === '/api/nginx/proxy-hosts');
  expect(saved.body).toMatchObject({ domain_names: ['new.example.test'], forward_host: '192.0.2.20', forward_port: 3000, allow_websocket_upgrade: true });
});

test('light theme preference and logout remain available', async ({ page }) => {
  await mock(page);
  await page.goto('/');
  await page.locator('header.navbar .hide-theme-light').first().click();
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
  await page.getByRole('link', { name: 'Open user menu' }).click();
  await page.locator('[data-translation-id="user.logout"]').click();
  await expect(page.locator('input[name="email"]')).toBeVisible();
});

test('tablet navigation wraps without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await mock(page);
  await page.goto('/');
  await expect(page.locator('.dc-overview table')).toHaveCount(2);
  await expect(page.locator('#navbar-menu a[href="/settings"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(822);
});
