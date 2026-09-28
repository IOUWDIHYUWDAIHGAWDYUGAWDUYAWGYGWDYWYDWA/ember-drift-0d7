import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { allocatePort, freePorts, poolUsage, releasePort } from '../server/lib/allocations.js';
import { describeCron, nextRun, parseCron } from '../server/lib/cron.js';
import {
  BUILTIN_EGGS,
  NESTS,
  maskVariables,
  missingRequired,
  renderTemplate,
  sanitizeVariables,
  validateEggShape,
} from '../server/lib/eggs.js';
import { FileJail } from '../server/lib/files.js';
import { createTarGz, extractTarGz, safeEntryName } from '../server/lib/tar.js';
import { emptyState } from '../server/lib/store.js';

async function tmpdir(prefix = 'lumo-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('tar: dosya, dizin ve uzun yollar gidiş-dönüş sağlar', () => {
  const longPath = `${'derin/'.repeat(30)}dosya.txt`;
  assert.ok(longPath.length > 100, 'uzun yol senaryosu kurulmalı');
  const archive = createTarGz([
    { name: 'index.js', data: Buffer.from('console.log(1)'), mode: 0o644 },
    { name: 'komutlar', type: '5' },
    { name: 'komutlar/ping.js', data: Buffer.from('module.exports = 1') },
    { name: longPath, data: Buffer.from('derin') },
    { name: 'ikili.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
  ]);
  const entries = extractTarGz(archive);
  const files = entries.filter((entry) => entry.type === 'file');
  const byName = new Map(files.map((entry) => [entry.name, entry.data]));
  assert.equal(byName.get('index.js').toString(), 'console.log(1)');
  assert.equal(byName.get('komutlar/ping.js').toString(), 'module.exports = 1');
  assert.equal(byName.get(longPath).toString(), 'derin');
  assert.deepEqual([...byName.get('ikili.bin')], [0, 1, 2, 3, 255]);
  assert.ok(entries.some((entry) => entry.type === 'dir' && entry.name === 'komutlar'));
});

test('tar: şüpheli giriş adları reddedilir', () => {
  assert.equal(safeEntryName('../etc/passwd'), null);
  assert.equal(safeEntryName('/etc/passwd'), null);
  assert.equal(safeEntryName('C:\\Windows\\system32'), null);
  assert.equal(safeEntryName('./bots/index.js'), 'bots/index.js');
  assert.equal(safeEntryName('a/../b'), null);

  // Kurcalanmış arşiv: `..` içeren giriş çıkarılamaz.
  const evil = createTarGz([{ name: 'iyi.txt', data: Buffer.from('x') }]);
  const entries = extractTarGz(evil).map((entry) => ({ ...entry, name: safeEntryName(entry.name) }));
  assert.deepEqual(entries.map((entry) => entry.name), ['iyi.txt']);
});

test('cron: ayrıştırma, eşleştirme ve sıradaki çalışma', () => {
  const nightly = parseCron('0 4 * * *');
  assert.equal(nightly.matches(new Date(2026, 0, 5, 4, 0)), true);
  assert.equal(nightly.matches(new Date(2026, 0, 5, 4, 1)), false);

  assert.equal(parseCron('*/15 * * * *').matches(new Date(2026, 0, 5, 9, 30)), true);
  assert.equal(parseCron('*/15 * * * *').matches(new Date(2026, 0, 5, 9, 31)), false);
  assert.equal(parseCron('0 0 1 jan *').matches(new Date(2026, 0, 1, 0, 0)), true);
  assert.equal(parseCron('0 12 * * mon-fri').matches(new Date(2026, 8, 28, 12, 0)), true); // pazartesi

  const next = nextRun('30 3 * * *', new Date(2026, 0, 5, 4, 0));
  assert.deepEqual([next.getHours(), next.getMinutes()], [3, 30]);

  assert.equal(describeCron('0 4 * * *'), 'her gün 04:00');
  assert.throws(() => parseCron('* * *'), /5 alan/);
  assert.throws(() => parseCron('99 * * * *'), /aralık dışında/);
  assert.throws(() => parseCron('*/0 * * * *'), /adım/);
});

test('dosya hapsi: dizin dışına çıkan yollar reddedilir', async (t) => {
  const root = await tmpdir();
  const outside = await tmpdir();
  await fs.writeFile(path.join(outside, 'gizli.txt'), 'sır');
  const jail = new FileJail(root);
  await jail.ensureRoot();
  await fs.writeFile(path.join(root, 'index.js'), 'console.log(1)');

  const listed = await jail.list('');
  assert.deepEqual(listed.items.map((item) => item.name), ['index.js']);

  await assert.rejects(() => jail.read('../gizli.txt'), /dışına/);
  await assert.rejects(() => jail.read(path.join(outside, 'gizli.txt')), /Mutlak yollar/);
  await assert.rejects(() => jail.resolve('a\0b'), /geçersiz karakter/);
  await assert.rejects(() => jail.resolve('..') , /dışına/);

  await jail.write('alt/dizin/yeni.txt', Buffer.from('tamam'));
  assert.equal((await jail.read('alt/dizin/yeni.txt')).content, 'tamam');
  await jail.rename('alt/dizin/yeni.txt', 'alt/dizin/taşındı.txt');
  await jail.remove('alt');
  await assert.rejects(() => jail.list('alt'), /Bulunamadı/);

  const usage = await jail.usage();
  assert.ok(usage.bytes > 0);

  if (process.platform !== 'win32') {
    try {
      await fs.symlink(path.join(outside, 'gizli.txt'), path.join(root, 'kaçış'));
      await assert.rejects(() => jail.read('kaçış'), /sembolik bağ|dışına/i);
    } catch (err) {
      if (err.code !== 'EPERM') throw err;
    }
  }
  t.diagnostic(`hap testi tamam: ${root}`);
});

test('egg: değişken doğrulama, şablon doldurma ve maskeleme', () => {
  const egg = BUILTIN_EGGS.find((item) => item.id === 'discord-js');
  const clean = sanitizeVariables(egg, { DISCORD_TOKEN: 'A'.repeat(60) });
  assert.deepEqual(clean.errors, []);
  assert.equal(clean.values.COMMAND_PREFIX, '!');

  const bad = sanitizeVariables(egg, { DISCORD_TOKEN: 'kısa' });
  assert.ok(bad.errors.length >= 1);
  assert.deepEqual(missingRequired(egg, {}), ['DISCORD_TOKEN']);

  const custom = sanitizeVariables(egg, { DISCORD_TOKEN: 'B'.repeat(60), ekstra: 'değer' });
  assert.deepEqual(custom.custom, { EKSTRA: 'değer' });

  assert.equal(renderTemplate('npm start --port {{PORT}}', { PORT: 30001 }), 'npm start --port 30001');
  assert.equal(renderTemplate('{{YOK}}-x', {}), '-x');

  const masked = maskVariables(egg, { DISCORD_TOKEN: 'gizli', COMMAND_PREFIX: '!' });
  assert.equal(masked.DISCORD_TOKEN, '••••••••');
  assert.equal(masked.COMMAND_PREFIX, '!');
});

test('egg: özel egg doğrulaması yerleşik kimlikleri reddeder', () => {
  const ok = validateEggShape({
    id: 'kendi-egg',
    name: 'Kendi egg',
    nest: NESTS[1].id,
    docker: { image: 'node:20-alpine' },
    startup: 'node bot.js',
    variables: [{ key: 'token', secret: true }],
  });
  assert.equal(ok.variables[0].key, 'TOKEN');
  assert.equal(ok.builtin, false);

  assert.throws(() => validateEggShape({ id: 'discord-js', name: 'x', docker: { image: 'node' }, startup: 'a' }), /yerleşik/);
  assert.throws(() => validateEggShape({ id: 'x', name: 'x', docker: { image: 'node' }, startup: 'a' }), /kimliği/);
  assert.throws(() => validateEggShape({ id: 'xx', name: 'x', nest: 'yok', docker: { image: 'node' }, startup: 'a' }), /nest/);
  assert.throws(() => validateEggShape({ id: 'xx', name: 'x', docker: { image: 'node' }, startup: '' }), /Başlangıç/);
  assert.throws(
    () => validateEggShape({ id: 'xx', name: 'x', docker: { image: 'node' }, startup: 'a', startupDetection: '(' }),
    /düzenli ifade/,
  );
});

test('port havuzu: aynı port iki kez verilmez, bırakılınca havuza döner', () => {
  const state = emptyState();
  const range = { min: 30000, max: 30002 };
  const first = allocatePort(state, range, 'srv-a');
  const second = allocatePort(state, range, 'srv-b');
  const third = allocatePort(state, range, 'srv-c');
  assert.equal(new Set([first, second, third]).size, 3);
  assert.deepEqual(poolUsage(state, range), { total: 3, used: 3, free: 0 });
  assert.equal(freePorts(state, range).length, 0);
  assert.throws(() => allocatePort(state, range, 'srv-d'), /havuzu dolu/);

  releasePort(state, 'srv-b');
  assert.deepEqual(freePorts(state, range), [second]);
  assert.equal(allocatePort(state, range, 'srv-d'), second);
});
