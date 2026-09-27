import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitFor(predicate, timeout = 20_000, interval = 150) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('zaman aşımı');
}

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-api-data-'));
  const botsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-api-bots-'));
  const port = 18400 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PANEL_MASTER_KEY: randomBytes(32).toString('hex'),
      PANEL_DATA_DIR: dataDir,
      PANEL_BOTS_DIR: botsDir,
      PANEL_BOT_DRIVER: 'local',
      PANEL_TRUST_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      const res = await fetch(`${base}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  });

  return {
    base,
    dataDir,
    output: () => output,
    stop: () => {
      child.kill('SIGKILL');
    },
  };
}

function makeClient(base) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async fetch(url, { method = 'GET', body, origin } = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (origin) headers.Origin = origin;
      const res = await fetch(new URL(url, base), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const raw of res.headers.getSetCookie()) {
        const pair = raw.split(';')[0];
        const [name, value] = pair.split('=');
        if (name === 'lumo_session') cookie = value ? pair : '';
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      return { status: res.status, data };
    },
  };
}

test('panel API uçtan uca', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const client = makeClient(server.base);
  const anon = makeClient(server.base);

  await t.test('sağlık ucu ve kurulum durumu', async () => {
    const health = await anon.fetch('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    const setup = await anon.fetch('/api/setup/status');
    assert.equal(setup.data.needsSetup, true);
  });

  await t.test('yetkisiz istekler reddedilir', async () => {
    assert.equal((await anon.fetch('/api/bots')).status, 401);
    assert.equal((await anon.fetch('/api/system')).status, 401);
  });

  await t.test('kurulum yönetici hesabı oluşturur', async () => {
    const weak = await anon.fetch('/api/setup', { method: 'POST', body: { username: 'admin', password: 'kısa' } });
    assert.equal(weak.status, 400);

    const res = await client.fetch('/api/setup', { method: 'POST', body: { username: 'admin', password: 'cok-guclu-parola-1' } });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.username, 'admin');
    assert.ok(client.cookie, 'oturum çerezi verilmeli');

    const again = await anon.fetch('/api/setup', { method: 'POST', body: { username: 'admin2', password: 'cok-guclu-parola-2' } });
    assert.equal(again.status, 409);
  });

  await t.test('oturum ile /api/me çalışır, çıkış sonrası çalışmaz', async () => {
    const me = await client.fetch('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'admin');

    const bad = await makeClient(server.base).fetch('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'yanlış-parola-123' } });
    assert.equal(bad.status, 401);
  });

  await t.test('sitenin dışından gelen istek CSRF korumasına takılır', async () => {
    const evil = await client.fetch('/api/bots', { method: 'POST', body: { name: 'saldırı' }, origin: 'https://kotu-site.example' });
    assert.equal(evil.status, 403);
  });

  let botId = '';

  await t.test('bot oluşturulur', async () => {
    const res = await client.fetch('/api/bots', { method: 'POST', body: { name: 'e2e bot', runtime: 'node', entry: 'index.js' } });
    assert.equal(res.status, 201);
    botId = res.data.bot.id;
    assert.equal(res.data.bot.status.state, 'stopped');
    assert.equal(res.data.bot.env.DISCORD_TOKEN, undefined);
  });

  await t.test('dosya yazma, okuma, listeleme ve yol kaçışı', async () => {
    const write = await client.fetch(`/api/bots/${botId}/file`, {
      method: 'PUT',
      body: { path: 'index.js', content: "console.log('E2E_HAZIR');\nsetInterval(()=>{}, 1000);\n" },
    });
    assert.equal(write.status, 200);

    const read = await client.fetch(`/api/bots/${botId}/file?path=index.js`);
    assert.equal(read.data.content.includes('E2E_HAZIR'), true);

    const listing = await client.fetch(`/api/bots/${botId}/files?path=`);
    assert.deepEqual(listing.data.entries.map((e) => e.name), ['index.js']);

    const escape = await client.fetch(`/api/bots/${botId}/file?path=${encodeURIComponent('../../package.json')}`);
    assert.equal(escape.status, 400);
  });

  await t.test('bot başlatılır, canlı konsol akışı gelir, durdurulur', async () => {
    const started = await client.fetch(`/api/bots/${botId}/start`, { method: 'POST', body: {} });
    assert.equal(started.status, 200);
    assert.equal(started.data.status.state, 'running');

    const stream = await fetch(`${server.base}/api/bots/${botId}/stream`, { headers: { Cookie: client.cookie } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /"type":"status"/);
    await reader.cancel();

    await new Promise((resolve) => setTimeout(resolve, 700));
    const logs = await client.fetch(`/api/bots/${botId}/logs?since=0`);
    assert.ok(logs.data.lines.some((line) => line.text.includes('E2E_HAZIR')), `log bulunamadı: ${JSON.stringify(logs.data.lines)}`);

    const stopped = await client.fetch(`/api/bots/${botId}/stop`, { method: 'POST', body: {} });
    assert.equal(stopped.data.status.state, 'stopped');
  });

  await t.test('ayarlar güncellenir ve sırlar şifreli saklanır', async () => {
    const res = await client.fetch(`/api/bots/${botId}`, {
      method: 'PATCH',
      body: { name: 'e2e bot v2', env: { DISCORD_TOKEN: 'MTIz.E2E.Token' }, autoRestart: true },
    });
    assert.equal(res.data.bot.name, 'e2e bot v2');
    assert.equal(res.data.bot.env.DISCORD_TOKEN, 'MTIz.E2E.Token');

    const raw = fs.readFileSync(path.join(server.dataDir, 'panel.enc'), 'utf8');
    assert.ok(!raw.includes('MTIz.E2E.Token'), 'token diskte düz metin');
  });

  await t.test('bot silinir ve başka uçlar etkilenmez', async () => {
    const removed = await client.fetch(`/api/bots/${botId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const list = await client.fetch('/api/bots');
    assert.equal(list.data.bots.length, 0);
    assert.equal((await client.fetch('/api/audit')).data.entries.length > 0, true);
  });

  await t.test('statik arayüz ve güvenlik başlıkları', async () => {
    const res = await fetch(`${server.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(await res.text(), /Lumo Panel/);
  });
});
