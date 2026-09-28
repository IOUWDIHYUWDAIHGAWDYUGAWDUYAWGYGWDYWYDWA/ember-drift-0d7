import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSessionToken,
  decrypt,
  encrypt,
  hashPassword,
  open,
  parseMasterKey,
  seal,
  verifyPassword,
  verifySessionToken,
} from '../server/lib/crypto.js';

const KEY = Buffer.alloc(32, 7);

test('ana anahtar: hex ve base64 kabul, kısa/boş anahtar reddedilir', () => {
  assert.equal(parseMasterKey('a1'.repeat(32)).length, 32);
  assert.equal(parseMasterKey(KEY.toString('base64')).length, 32);
  assert.throws(() => parseMasterKey('c0ffee'), /geçersiz/i);
  assert.throws(() => parseMasterKey(''), /PANEL_MASTER_KEY/);
  assert.throws(() => parseMasterKey('abc'), /geçersiz/i);
  assert.throws(() => parseMasterKey('z'.repeat(64)), /geçersiz/i);
});

test('AES-256-GCM: gidiş-dönüş çalışır, kurcalama reddedilir', () => {
  const blob = encrypt(KEY, 'gizli token');
  assert.equal(decrypt(KEY, blob).toString('utf8'), 'gizli token');

  // Aynı düz metin her seferinde farklı şifreli metin üretir (rastgele nonce).
  assert.notDeepEqual(encrypt(KEY, 'gizli token'), blob);

  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => decrypt(KEY, tampered));

  const otherKey = Buffer.alloc(32, 9);
  assert.throws(() => decrypt(otherKey, blob));
  assert.throws(() => decrypt(KEY, Buffer.alloc(4)));
});

test('seal/open: AAD uyuşmazsa çözülemez', () => {
  const payload = { a: 1, b: ['x'] };
  const sealed = seal(KEY, payload, 'lumo:state');
  assert.deepEqual(open(KEY, sealed, 'lumo:state'), payload);
  assert.throws(() => open(KEY, sealed, 'baska-baglam'));
});

test('scrypt parola: doğru parola geçer, yanlış parola geçmez', () => {
  const { salt, hash } = hashPassword('çok-gizli-parola');
  assert.equal(verifyPassword('çok-gizli-parola', salt, hash), true);
  assert.equal(verifyPassword('yanlış', salt, hash), false);
  assert.equal(verifyPassword('çok-gizli-parola', salt, 'zz'), false);
  assert.equal(verifyPassword('x', undefined, undefined), false);
  // Aynı parola farklı salt ile farklı özet üretir.
  assert.notEqual(hashPassword('aynı').hash, hashPassword('aynı').hash);
});

test('oturum bileti: imza, süre ve kurcalama kontrolü', () => {
  const token = createSessionToken(KEY, { userId: 'usr-1', sessionVersion: 3, ttlMs: 60_000 });
  const payload = verifySessionToken(KEY, token);
  assert.equal(payload.sub, 'usr-1');
  assert.equal(payload.ver, 3);

  assert.equal(verifySessionToken(KEY, 'garbage'), null);
  assert.equal(verifySessionToken(KEY, `${token}x`), null);
  assert.equal(verifySessionToken(Buffer.alloc(32, 1), token), null);

  const expired = createSessionToken(KEY, { userId: 'usr-1', ttlMs: -1000 });
  assert.equal(verifySessionToken(KEY, expired), null);
});
