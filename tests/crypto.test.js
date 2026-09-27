import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  parseMasterKey,
} from '../server/lib/crypto.js';
import { Store } from '../server/lib/store.js';

const key = randomBytes(32);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-test-'));

test('AES-256-GCM gidiş-dönüş', () => {
  const samples = ['kısa', 'a'.repeat(5000), 'üç ışık 🌙 emoji', JSON.stringify({ token: 'abc.def' })];
  for (const sample of samples) {
    assert.equal(decrypt(key, encrypt(key, sample)), sample);
  }
});

test('aynı girdi her seferinde farklı şifreli çıktı verir (rastgele IV)', () => {
  assert.notEqual(encrypt(key, 'aynı metin'), encrypt(key, 'aynı metin'));
});

test('kurcalanmış şifreli veri reddedilir', () => {
  const payload = encrypt(key, 'gizli veri');
  const buf = Buffer.from(payload, 'base64');
  buf[buf.length - 1] ^= 0xff; // son byte'ı boz
  assert.throws(() => decrypt(key, buf.toString('base64')));
});

test('yanlış anahtar çözmez', () => {
  const payload = encrypt(key, 'gizli veri');
  assert.throws(() => decrypt(randomBytes(32), payload));
});

test('parola scrypt ile özetlenir ve doğrulanır', () => {
  const { salt, hash } = hashPassword('çok-gizli-parola-123');
  assert.ok(!hash.includes('çok-gizli'));
  assert.equal(verifyPassword('çok-gizli-parola-123', salt, hash), true);
  assert.equal(verifyPassword('yanlış-parola-123', salt, hash), false);
});

test('aynı parola farklı salt ile farklı özet üretir', () => {
  const a = hashPassword('aynı-parola-1234');
  const b = hashPassword('aynı-parola-1234');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('oturum anahtarı imzalanır, kurcalanamaz ve süresi dolar', () => {
  const token = signToken({ uid: 'u_1' }, key, 60_000);
  assert.equal(verifyToken(token, key).uid, 'u_1');
  assert.equal(verifyToken(token, randomBytes(32)), null);
  assert.equal(verifyToken(`${token}x`, key), null);
  assert.equal(verifyToken('bozuk', key), null);
  assert.equal(verifyToken(signToken({ uid: 'u_1' }, key, -1000), key), null);
});

test('ana anahtar doğrulanır', () => {
  assert.equal(parseMasterKey(randomBytes(32).toString('hex')).length, 32);
  assert.equal(parseMasterKey(randomBytes(32).toString('base64')).length, 32);
  assert.throws(() => parseMasterKey('kısa'));
  assert.throws(() => parseMasterKey(''));
});

test('store verisi diskte düz metin görünmez, anahtarla geri açılır', () => {
  const dir = tmp();
  const file = path.join(dir, 'panel.enc');
  const store = new Store({ file, key });
  store.data.users.push({ id: 'u_1', username: 'admin', salt: 's', hash: 'h' });
  store.data.bots.push({ id: 'bot_1', name: 'Moderasyon', env: { DISCORD_TOKEN: 'MTIz.Gizli.Token' } });
  store.save();

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('MTIz.Gizli.Token'), 'token düz metin olarak diskte');
  assert.ok(!raw.includes('admin'), 'kullanıcı adı düz metin olarak diskte');

  const reopened = new Store({ file, key });
  assert.equal(reopened.data.bots[0].env.DISCORD_TOKEN, 'MTIz.Gizli.Token');
  assert.equal(reopened.data.users[0].username, 'admin');
});

test('store yanlış anahtarla açılmaz', () => {
  const dir = tmp();
  const file = path.join(dir, 'panel.enc');
  const store = new Store({ file, key });
  store.data.bots.push({ id: 'bot_1', name: 'x' });
  store.save();
  assert.throws(() => new Store({ file, key: randomBytes(32) }));
});
