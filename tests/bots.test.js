import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { Store } from '../server/lib/store.js';
import { BotManager } from '../server/lib/bots.js';

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-bots-'));
  const store = new Store({ file: path.join(dir, 'panel.enc'), key: randomBytes(32) });
  const manager = new BotManager({ store, root: path.join(dir, 'bots'), driver: 'local' });
  return { store, manager, dir };
}

async function waitFor(predicate, timeout = 10_000, interval = 80) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('beklenen durum zaman aşımına uğradı');
}

test('dosya yolları bot dizininin dışına çıkamaz', () => {
  const { manager } = makeManager();
  const bot = manager.create({ name: 'test bot' });
  for (const attack of ['../gizli.txt', '../../package.json', 'a/../../b', '..\\..\\windows\\system32']) {
    assert.throws(() => manager.readFile(bot.id, attack), /Geçersiz yol/, `geçti: ${attack}`);
    assert.throws(() => manager.writeFile(bot.id, attack, 'x'), /Geçersiz yol|Geçersiz göreli/, `geçti: ${attack}`);
  }
});

test('dosya yazma, okuma ve listeleme çalışır', () => {
  const { manager } = makeManager();
  const bot = manager.create({ name: 'crud bot' });
  manager.writeFile(bot.id, 'commands/ping.js', 'module.exports = 1;');
  assert.equal(manager.readFile(bot.id, 'commands/ping.js').content, 'module.exports = 1;');

  const root = manager.listFiles(bot.id, '');
  assert.deepEqual(root.entries.map((e) => e.name), ['commands']);
  const nested = manager.listFiles(bot.id, 'commands');
  assert.deepEqual(nested.entries.map((e) => e.path), ['commands/ping.js']);

  manager.deletePath(bot.id, 'commands/ping.js');
  assert.equal(manager.listFiles(bot.id, 'commands').entries.length, 0);
});

test('base64 yükleme ve boyut sınırı', () => {
  const { manager } = makeManager();
  const bot = manager.create({ name: 'upload bot' });
  const written = manager.uploadFiles(bot.id, [
    { path: 'index.js', contentBase64: Buffer.from('console.log(1)').toString('base64') },
    { path: 'kaynaklar/veri.json', contentBase64: Buffer.from('{"a":1}').toString('base64') },
  ]);
  assert.equal(written.length, 2);
  assert.equal(manager.readFile(bot.id, 'kaynaklar/veri.json').content, '{"a":1}');
  assert.throws(() => manager.uploadFiles(bot.id, [{ path: '../kaçış.js', contentBase64: '' }]), /Geçersiz göreli yol/);
});

test('sembolik bağlantı ile dışarı çıkılamaz', (t) => {
  const { manager, dir } = makeManager();
  const bot = manager.create({ name: 'symlink bot' });
  const outsider = path.join(dir, 'gizli.txt');
  fs.writeFileSync(outsider, 'gizli içerik');
  try {
    fs.symlinkSync(outsider, path.join(manager.botDir(bot.id), 'kısayol.txt'));
  } catch {
    t.skip('bu platformda sembolik bağlantı oluşturulamıyor');
    return;
  }
  assert.throws(() => manager.readFile(bot.id, 'kısayol.txt'), /Sembolik|dışına/);
  assert.equal(manager.listFiles(bot.id, '').entries[0].type, 'link');
});

test('bot süreci başlar, log üretir ve durur', async () => {
  const { manager } = makeManager();
  const bot = manager.create({ name: 'çalışan bot', autoRestart: false });
  manager.writeFile(bot.id, 'index.js', "console.log('HAZIR');\nsetInterval(() => {}, 1000);\n");

  const logs = [];
  const unsubscribe = manager.subscribe(bot.id, (event) => {
    if (event.type === 'log') logs.push(event.line.text);
  });

  await manager.start(bot.id);
  assert.equal(manager.status(bot.id).state, 'running');
  await waitFor(() => logs.some((line) => line.includes('HAZIR')), 10_000);

  await manager.stop(bot.id);
  unsubscribe();
  assert.equal(manager.status(bot.id).state, 'stopped');
});

test('çöken bot otomatik yeniden başlatılır', async () => {
  const { manager } = makeManager();
  const bot = manager.create({ name: 'çöken bot', autoRestart: true });
  manager.writeFile(bot.id, 'index.js', "console.log('başladı');\nprocess.exit(1);\n");

  await manager.start(bot.id);
  await waitFor(() => manager.status(bot.id).restarts >= 1, 12_000);
  assert.ok(manager.status(bot.id).restarts >= 1);

  await manager.stop(bot.id);
  assert.equal(manager.status(bot.id).state, 'stopped');
});

test('bota panelin kendi ortam değişkenleri sızmaz', async () => {
  const { manager } = makeManager();
  const bot = manager.create({ name: 'sızıntı testi', autoRestart: false, env: { DISCORD_TOKEN: 'bot-token' } });
  manager.writeFile(
    bot.id,
    'index.js',
    "console.log('TOKEN=' + (process.env.DISCORD_TOKEN ?? 'yok'));\nconsole.log('MASTER=' + (process.env.PANEL_MASTER_KEY ?? 'yok'));\nsetInterval(()=>{},1000);\n",
  );

  const logs = [];
  const unsubscribe = manager.subscribe(bot.id, (event) => {
    if (event.type === 'log') logs.push(event.line.text);
  });

  await manager.start(bot.id);
  await waitFor(() => logs.some((line) => line.includes('MASTER=')), 10_000);
  await manager.stop(bot.id);
  unsubscribe();

  assert.ok(logs.some((line) => line.includes('TOKEN=bot-token')), 'bot kendi sırrını görmeli');
  assert.ok(logs.some((line) => line.includes('MASTER=yok')), 'PANEL_MASTER_KEY bota sızmamalı');
});
