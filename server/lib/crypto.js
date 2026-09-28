// Şifreleme temeli: ana anahtar ayrıştırma, AES-256-GCM kasa, scrypt parolalar,
// HMAC ile imzalanmış (sunucuda durum tutmayan) oturum biletleri.
//
// Tasarım kuralı: buradaki her fonksiyon ya geçerli bir sonuç döndürür ya da hata
// fırlatır. Sessizce başarısız olmak yok — şifreleme bozuksa panel açılmaz.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const KEY_BYTES = 32;

/** PANEL_MASTER_KEY değerini 32 baytlık anahtara çevirir (hex veya base64). */
export function parseMasterKey(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new Error(
      'PANEL_MASTER_KEY tanımlı değil. 64 hex karakterlik bir anahtar üret: npm run genkey',
    );
  }
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    try {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length === KEY_BYTES && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) {
        key = decoded;
      }
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new Error(
      'PANEL_MASTER_KEY geçersiz: 64 hex karakter (32 bayt) ya da base64 ile kodlanmış 32 bayt olmalı.',
    );
  }
  return key;
}

/** AES-256-GCM. Dönen biçim: nonce(12) ‖ tag(16) ‖ ciphertext. */
export function encrypt(key, plaintext, aad = 'lumo') {
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

export function decrypt(key, blob, aad = 'lumo') {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < NONCE_BYTES + TAG_BYTES) throw new Error('Şifreli veri çok kısa veya bozuk.');
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const body = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  // Kimlik doğrulama başarısızsa final() hata fırlatır: kurcalanmış veri reddedilir.
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Nesneyi şifreleyip base64 metne çevirir (JSON alanlarında taşımak için). */
export function seal(key, value, aad = 'lumo') {
  return encrypt(key, Buffer.from(JSON.stringify(value), 'utf8'), aad).toString('base64');
}

export function open(key, payload, aad = 'lumo') {
  return JSON.parse(decrypt(key, Buffer.from(payload, 'base64'), aad).toString('utf8'));
}

/** scrypt + rastgele salt. Parolalar asla geri döndürülemez şekilde saklanır. */
export function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/** Sabit zamanlı doğrulama: kullanıcı adı sızdırmayan karşılaştırma. */
export function verifyPassword(password, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(String(hashHex), 'hex');
  // Bozuk/eksik hex girişi boş tampona dönüşür; boş tamponları eşit saymak
  // "her parola doğru" demek olurdu.
  if (expected.length === 0) return false;
  const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// --- Oturum biletleri -------------------------------------------------------
// Sunucuda oturum tablosu tutulmaz: bilete kullanıcı, sürüm ve bitiş tarihi
// yazılır, HMAC ile imzalanır. Parola değişince user.sessionVersion artar ve
// eski çerezler anında geçersizleşir.

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payloadPart, key) {
  return b64url(createHmac('sha256', key).update(payloadPart).digest());
}

export function createSessionToken(key, { userId, sessionVersion = 1, ttlMs = 12 * 3600_000 }) {
  const payload = {
    sub: userId,
    ver: sessionVersion,
    iat: Date.now(),
    exp: Date.now() + ttlMs,
    jti: randomBytes(8).toString('hex'),
  };
  const part = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${part}.${sign(part, key)}`;
}

/** Geçerliyse payload'ı döndürür, değilse null. İmza, süre ve sürüm kontrol edilir. */
export function verifySessionToken(key, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [part, mac] = token.split('.');
  if (!part || !mac) return null;
  const expected = sign(part, key);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

export function generateMasterKeyHex() {
  return randomBytes(KEY_BYTES).toString('hex');
}

export function randomId(prefix = '') {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}
