import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createApp } from '../server/index.js';

const BOT_SCRIPT = `const readline = require('node:readline');
console.log('bot hazır');
console.log('master:', process.env.PANEL_MASTER_KEY ? 'SIZDI' : 'YOK');
console.log('secret:', process.env.CUSTOM_SECRET || 'yok');
readline.createInterface({ input: process.stdin }).on('line', (line) => console.log('gelen:', line));
setInterval(() => {}, 1000);`;

const silentLogger = { log() {}, warn() {}, error() {} };

async function waitFor(fn, { timeout = 15_000, interval = 100, label = 'koşul' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Zaman aşımı: ${label}`);
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumo-api-'));
  const app = await createApp({
    cwd: dir,
    logger: silentLogger,
    env: {
      PANEL_MASTER_KEY: 'ab'.repeat(32),
      PANEL_BOT_DRIVER: 'local',
      PANEL_INSECURE_COOKIES: '1',
      PANEL_STARTUP_TIMEOUT_MS: '8000',
      PANEL_CRASH_LIMIT: '3',
      PANEL_LOGIN_MAX_ATTEMPTS: '50',
    },
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dir, app, server, base };
}

function client(base, cookie = null) {
  const state = { cookie, origin: base };
  const call = async (method, route, body, options = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const origin = options.origin === undefined ? state.origin : options.origin;
    if (origin) headers.Origin = origin;
    if (state.cookie) headers.Cookie = state.cookie;
    const res = await fetch(`${base}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) state.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { call, state };
}

test('uçtan uca: kurulum, roller, yaşam döngüsü, yedek, görev ve yol kaçışı', async (t) => {
  const { dir, app, server, base } = await setup();
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
    // Windows'ta öldürülen alt süreç dizini bir süre kilitli tutabilir.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  const admin = client(base);

  // 1. Herkese açık uçlar
  assert.equal((await admin.call('GET', '/api/health')).status, 200);
  assert.equal((await admin.call('GET', '/api/me')).status, 401);
  assert.equal((await admin.call('GET', '/api/setup/status')).body.needsSetup, true);

  // 2. Kurulum
  const setupRes = await admin.call('POST', '/api/setup', { username: 'patron', password: 'cok-gizli-parola' });
  assert.equal(setupRes.status, 201);
  assert.equal(setupRes.body.user.role, 'admin');
  assert.equal((await admin.call('POST', '/api/setup', { username: 'x', password: 'y'.repeat(12) })).status, 409);
  assert.equal((await admin.call('GET', '/api/me')).body.user.username, 'patron');

  // 3. CSRF: Origin uyuşmazlığı reddedilir
  const badOrigin = await admin.call('POST', '/api/servers', { name: 'x', egg: 'node-service' }, { origin: 'https://kotu-site.example' });
  assert.equal(badOrigin.status, 403);

  // 4. Egg listesi
  const eggs = await admin.call('GET', '/api/eggs');
  assert.ok(eggs.body.eggs.some((item) => item.id === 'discord-js'));
  assert.ok(eggs.body.eggs.some((item) => item.id === 'node-service'));

  // 5. Sunucu oluştur (port tahsisi ile)
  const created = await admin.call('POST', '/api/servers', {
    name: 'Deneme botu',
    egg: 'node-service',
    variables: { CUSTOM_SECRET: 'gizli-123' },
    autoStart: true,
  });
  assert.equal(created.status, 201);
  const serverId = created.body.server.id;
  assert.ok(created.body.server.allocation.port >= 30000, 'port tahsis edilmeli');
  assert.equal(created.body.server.variables.CUSTOM_SECRET, '••••••••');

  // 6. Dosya yükle + yol kaçışı denemesi
  const written = await admin.call('PUT', `/api/servers/${serverId}/file`, { path: 'index.js', content: BOT_SCRIPT });
  assert.equal(written.status, 200);
  assert.equal((await admin.call('GET', `/api/servers/${serverId}/file?path=../../etc/passwd`)).status, 400);
  assert.equal((await admin.call('GET', `/api/servers/${serverId}/file?path=/etc/passwd`)).status, 400);
  const listing = await admin.call('GET', `/api/servers/${serverId}/files`);
  assert.deepEqual(listing.body.items.map((item) => item.name), ['index.js']);

  // 7. Başlat → running, loglar ve sır sızmaz
  const started = await admin.call('POST', `/api/servers/${serverId}/power`, { action: 'start' });
  assert.equal(started.status, 200);
  const logs = (await waitFor(async () => {
    const res = await admin.call('GET', `/api/servers/${serverId}/logs`);
    const text = res.body.entries.map((entry) => entry.line).join('\n');
    return text.includes('başlangıç tespit edildi') ? text : null;
  }, { label: 'başlangıç tespiti' }));
  assert.match(logs, /master: YOK/);
  assert.match(logs, /secret: gizli-123/);
  const running = await waitFor(async () => {
    const res = await admin.call('GET', `/api/servers/${serverId}`);
    return res.body.server.status === 'running' ? res.body.server : null;
  }, { label: 'running durumu' });
  assert.equal(running.status, 'running');
  assert.ok(running.stats.diskLimitBytes >= 1024 * 1024);

  // 8. Konsola girdi
  await admin.call('POST', `/api/servers/${serverId}/input`, { command: 'merhaba' });
  await waitFor(async () => {
    const res = await admin.call('GET', `/api/servers/${serverId}/logs`);
    return res.body.entries.some((entry) => entry.line === 'gelen: merhaba');
  }, { label: 'konsol yankısı' });

  // 9. Yedek al ve geri yükle
  const backup = await admin.call('POST', `/api/servers/${serverId}/backups`, { name: 'ilk yedek', keep: 3 });
  assert.equal(backup.status, 201);
  assert.ok(backup.body.backup.sizeBytes > 0);
  const backupId = backup.body.backup.id;
  assert.equal((await admin.call('POST', `/api/backups/${backupId}/restore`)).status, 200);
  const backups = await admin.call('GET', `/api/servers/${serverId}/backups`);
  assert.equal(backups.body.backups.length, 1);
  assert.equal((await admin.call('GET', `/api/backups/${backupId}/download`)).status, 200);

  // 10. Zamanlanmış görevler
  assert.equal(
    (await admin.call('POST', '/api/schedules', { serverId, name: 'bozuk', cron: 'her gün', tasks: [{ action: 'power', power: 'restart' }] })).status,
    400,
  );
  const schedule = await admin.call('POST', '/api/schedules', {
    serverId,
    name: 'Günlük yedek',
    description: 'her gece 04:00',
    cron: '0 4 * * *',
    tasks: [{ action: 'backup', keep: 5 }],
  });
  assert.equal(schedule.status, 201);
  assert.ok(schedule.body.schedule.nextRun);
  const run = await admin.call('POST', `/api/schedules/${schedule.body.schedule.id}/run`);
  assert.equal(run.status, 200);
  assert.equal(run.body.run.ok, true);
  assert.equal((await admin.call('GET', `/api/schedules?serverId=${serverId}`)).body.schedules.length, 1);

  // 11. Roller: viewer okuyabilir, güç kullanamaz
  assert.equal((await admin.call('POST', '/api/users', { username: 'izleyici', password: 'okuma-parolasi', role: 'viewer' })).status, 201);
  const viewer = client(base);
  assert.equal((await viewer.call('POST', '/api/auth/login', { username: 'izleyici', password: 'okuma-parolasi' })).status, 200);
  assert.equal((await viewer.call('GET', '/api/servers')).status, 200);
  assert.equal((await viewer.call('POST', `/api/servers/${serverId}/power`, { action: 'stop' })).status, 403);
  assert.equal((await viewer.call('GET', '/api/users')).status, 403);
  assert.equal((await viewer.call('GET', '/api/audit')).status, 403);

  // 12. Yanlış parola denemesi
  const attacker = client(base);
  assert.equal((await attacker.call('POST', '/api/auth/login', { username: 'patron', password: 'yanlış' })).status, 401);

  // 13. Parola değişince eski oturum düşer
  const changed = await admin.call('POST', '/api/auth/password', { currentPassword: 'cok-gizli-parola', newPassword: 'yeni-gizli-parola' });
  assert.equal(changed.status, 200);
  assert.equal((await admin.call('GET', '/api/me')).status, 401);
  assert.equal((await admin.call('POST', '/api/auth/login', { username: 'patron', password: 'yeni-gizli-parola' })).status, 200);

  // 14. Denetim kaydı sır içermez
  const audit = await admin.call('GET', '/api/audit?limit=200');
  assert.equal(audit.status, 200);
  const auditText = JSON.stringify(audit.body.entries);
  assert.match(auditText, /server\.create/);
  assert.ok(!auditText.includes('gizli-123'), 'denetim kaydına sır yazılmamalı');

  // 15. Sistem özeti
  const system = await admin.call('GET', '/api/system');
  assert.equal(system.body.counts.servers, 1);
  assert.equal(system.body.driver, 'local');
  assert.ok(system.body.allocations.used >= 1);

  // 16. Sunucuyu durdur, kill ile geri gelmemesini doğrula ve sil
  assert.equal((await admin.call('POST', `/api/servers/${serverId}/power`, { action: 'stop' })).status, 200);
  await waitFor(async () => {
    const res = await admin.call('GET', `/api/servers/${serverId}`);
    return res.body.server.status === 'offline';
  }, { label: 'offline durumu' });

  assert.equal((await admin.call('DELETE', `/api/servers/${serverId}?files=1`)).status, 200);
  assert.equal((await admin.call('GET', '/api/servers')).body.servers.length, 0);
  assert.equal((await admin.call('GET', '/api/allocations')).body.usage.used, 0, 'silinen sunucunun portu havuza dönmeli');
  assert.equal((await admin.call('GET', `/api/schedules?serverId=${serverId}`)).body.schedules.length, 0);
});
