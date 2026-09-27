import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  timingSafeEqual,
  createHmac,
  randomUUID,
} from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;
const SCRYPT_KEYLEN = 64;

/** Kısa, dosya adı olarak güvenli rastgele kimlik. */
export function randomId(prefix = '') {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

export function uuid() {
  return randomUUID();
}

/**
 * AES-256-GCM. Çıktı: base64( iv | authTag | ciphertext )
 * Aynı girdi her çağrıda farklı çıktı verir (rastgele IV).
 */
export function encrypt(key, plaintext) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(key, payload) {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('şifreli veri bozuk veya kesik');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // final() auth tag uyuşmazsa fırlatır → kurcalanmış veri sessizce geçemez.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Parola saklama: scrypt + rastgele salt. Düz parola hiçbir yerde tutulmaz. */
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex') };
}

export function verifyPassword(password, salt, hash) {
  const expected = Buffer.from(String(hash), 'hex');
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  // Sabit zamanlı karşılaştırma → zamanlama saldırısına kapalı.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data, key) => createHmac('sha256', key).update(data).digest('base64url');

/** Sunucuda durum tutmayan (stateless) HMAC imzalı oturum anahtarı. */
export function signToken(payload, key, ttlMs) {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const data = b64url(JSON.stringify(body));
  return `${data}.${sign(data, key)}`;
}

export function verifyToken(token, key) {
  if (typeof token !== 'string') return null;
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const data = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(data, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body.exp !== 'number' || body.exp < Date.now()) return null;
  return body;
}

/** 32 byte ana anahtarı hex veya base64 girdiden üretir. */
export function parseMasterKey(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('PANEL_MASTER_KEY tanımlı değil');
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('PANEL_MASTER_KEY 32 byte olmalı (64 hex karakter)');
  return key;
}
