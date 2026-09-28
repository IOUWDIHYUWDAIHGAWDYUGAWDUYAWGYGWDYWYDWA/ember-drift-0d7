import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { STATUS, Servers } from '../server/lib/servers.js';
import { Store } from '../server/lib/store.js';

const READY_SCRIPT = `
const readline = require('node:readline');
console.log('bot hazır');
console.log('master:', process.env.PANEL_MASTER_KEY ? 'SIZDI' : 'YOK');
console.log('token:', process.env.DISCORD_TOKEN || 'yok');
console.log('port:', process.env.PORT || 'yok');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  console.log('gelen:', line);
  if (line === 'dur') process.exit(0);
});
setInterval(() => {}, 1000);
`;

const CRASH_SCRIPT = `
console.log('hazır ama çöküyorum');
process.exit(3);
`;

const SILENT_SCRIPT = 'setInterval(() => {}, 1000);';

/** Windows'ta öldürülen süreç dizini bir süre kilitli tutabilir. */
async function cleanup(dir) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function waitFor(fn, { timeout = 12_000, interval = 100, label = 'koşul' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Zaman aşımı: ${label}`);
}

const logsOf = (servers, id) => servers.logs(id).entries.map((entry) => entry.line).join('\n');

async function harness({ script = READY_SCRIPT, eggOverrides = {}, serverOverrides = {}, crashLimit = 3 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumo-srv-'));
  const store = new Store({ file: path.join(dir, 'panel.enc'), key: Buffer.alloc(32, 5) });
  await store.load();

  const customEgg = {
    id: 'test-egg',
    nest: 'runtime',
    name: 'Test egg',
    description: 'test',
    docker: { image: 'node:20-alpine', workdir: '/home/container' },
    install: null,
    startup: 'node index.js',
    startupDetection: String.raw`\b(hazır|ready)\b`,
    startupTimeoutMs: 8000,
    stopSignal: 'SIGTERM',
    stopTimeoutSeconds: 5,
    restartPolicy: 'always',
    features: { memoryMb: 256, cpu: 1, diskMb: 512, pids: 128 },
    allocations: [],
    variables: [],
    builtin: false,
    ...eggOverrides,
  };

  const server = {
    id: 'srv-test',
    name: 'Test bot',
    egg: customEgg.id,
    variables: { DISCORD_TOKEN: 'tok-123' },
    environment: {},
    limits: { memoryMb: 256, cpu: 1, diskMb: 512, pids: 128 },
    autoStart: false,
    restartPolicy: 'always',
    startupOverride: null,
    allocation: { name: 'PORT', port: 30050, bind: '127.0.0.1' },
    suspended: false,
    suspendReason: null,
    createdAt: new Date().toISOString(),
    restartCount: 0,
    lastExit: null,
    ...serverOverrides,
  };

  await store.update((state) => {
    state.eggs.push(customEgg);
    state.servers.push(server);
  });

  const servers = new Servers({
    store,
    config: {
      driver: 'local',
      serversDir: path.join(dir, 'servers'),
      startupTimeoutMs: 8000,
      crashLimit,
      crashWindowMs: 60_000,
      portRange: { min: 30000, max: 30009 },
      portBind: '127.0.0.1',
      defaults: { memoryMb: 256, cpu: 1, diskMb: 512, pids: 128 },
    },
  });

  await servers.jail(server.id).ensureRoot();
  await fs.writeFile(path.join(servers.serverDir(server.id), 'index.js'), script);
  return { dir, store, servers, server };
}

test('başlatma: startup detection, değişkenler ve master key sızmaz', async () => {
  const { servers, server, store, dir } = await harness();

  const started = await servers.start(server.id, { actor: 'test' });
  assert.equal(started.status, STATUS.STARTING);

  await waitFor(() => servers.status(server.id) === STATUS.RUNNING, { label: 'running durumuna geçiş' });
  const summary = servers.summary(store.state.servers[0]);
  assert.equal(summary.status, STATUS.RUNNING);
  assert.ok(summary.uptimeMs >= 0);

  const logs = logsOf(servers, server.id);
  assert.match(logs, /master: YOK/, 'PANEL_MASTER_KEY bota sızmamalı');
  assert.match(logs, /token: tok-123/, 'egg değişkeni bota aktarılmalı');
  assert.match(logs, /port: 30050/, 'tahsis edilen port ortama yazılmalı');
  assert.match(logs, /başlangıç tespit edildi/);

  servers.input(server.id, 'selam');
  await waitFor(() => logsOf(servers, server.id).includes('gelen: selam'), { label: 'stdin yankısı' });
  assert.match(logsOf(servers, server.id), /> selam/);

  await servers.stop(server.id, { actor: 'test' });
  await waitFor(() => servers.status(server.id) === STATUS.OFFLINE, { label: 'offline durumu' });
  await servers.shutdown();
  await cleanup(dir);
});

test('tahsis edilen port ve sır kasası: sunucu özeti sırları maskelemez', async () => {
  const { servers, store, dir } = await harness();
  const server = store.state.servers[0];
  const env = servers.buildEnv(server, servers.eggFor(server));
  assert.equal(env.PORT, '30050');
  assert.equal(env.DISCORD_TOKEN, 'tok-123');
  assert.equal(env.PANEL_MASTER_KEY, undefined);
  assert.equal(env.SECRET_CANDY, undefined);
  await servers.shutdown();
  await cleanup(dir);
});

test('çöken süreç artan beklemeyle yeniden başlatılır', async () => {
  const { servers, server, dir } = await harness({ script: CRASH_SCRIPT, crashLimit: 5 });
  await servers.start(server.id, { actor: 'test' });

  const record = await waitFor(() => (servers.runtime(server.id).restarts >= 1 ? servers.runtime(server.id) : null), {
    label: 'ilk otomatik yeniden başlatma',
    timeout: 15_000,
  });
  assert.ok(record.crashTimes.length >= 1);
  assert.match(logsOf(servers, server.id), /otomatik yeniden başlatma/);
  await servers.shutdown();
  await cleanup(dir);
});

test('çökme koruması: limit aşılırsa otomatik başlatma durur ve kayda geçer', async () => {
  const { servers, server, store, dir } = await harness({ script: CRASH_SCRIPT, crashLimit: 2 });

  await servers.start(server.id, { actor: 'test' });
  await waitFor(() => servers.status(server.id) === STATUS.CRASHED, { label: 'koruma durumu', timeout: 20_000 });

  const record = servers.runtime(server.id);
  assert.equal(record.restartTimer, null, 'koruma sonrası bekleyen yeniden başlatma olmamalı');
  assert.match(record.lastError ?? '', /çökme koruması/);
  assert.ok(
    store.state.audit.some((entry) => entry.action === 'server.crashloop'),
    'çökme döngüsü denetim kaydına yazılmalı',
  );
  await servers.shutdown();
  await cleanup(dir);
});

test('başlangıç tespiti zaman aşımı çökme olarak sayılır', async () => {
  const { servers, server, dir } = await harness({
    script: SILENT_SCRIPT,
    crashLimit: 1,
    eggOverrides: { startupDetection: '(?!)', startupTimeoutMs: 1200 },
  });

  await servers.start(server.id, { actor: 'test' });
  await waitFor(() => servers.status(server.id) === STATUS.CRASHED, { label: 'zaman aşımı sonrası koruma', timeout: 15_000 });
  assert.match(logsOf(servers, server.id), /başlangıç tespiti/i);
  await servers.shutdown();
  await cleanup(dir);
});

test('disk limiti aşılınca sunucu askıya alınır ve başlatılamaz', async () => {
  const { servers, server, store, dir } = await harness({ serverOverrides: { limits: { memoryMb: 128, cpu: 0.5, diskMb: 1, pids: 64 } } });
  await fs.writeFile(path.join(servers.serverDir(server.id), 'şişkin.bin'), Buffer.alloc(2 * 1024 * 1024));

  await assert.rejects(() => servers.start(server.id, { actor: 'test' }), /Disk limiti aşıldı/);
  assert.equal(servers.status(server.id), STATUS.SUSPENDED);
  assert.equal(store.state.servers[0].suspended, true);

  await servers.resume(server.id, { actor: 'test' });
  assert.equal(servers.status(server.id), STATUS.OFFLINE);
  await assert.rejects(() => servers.start(server.id, { actor: 'test' }), /Disk limiti/);

  await fs.rm(path.join(servers.serverDir(server.id), 'şişkin.bin'), { force: true });
  await servers.resume(server.id, { actor: 'test' });
  await servers.start(server.id, { actor: 'test' });
  await waitFor(() => servers.status(server.id) === STATUS.RUNNING, { label: 'askıdan sonra çalışma' });
  await servers.shutdown();
  await cleanup(dir);
});
