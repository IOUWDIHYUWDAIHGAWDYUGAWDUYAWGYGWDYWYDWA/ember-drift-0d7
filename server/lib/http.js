// HTTP yardımcıları: gövde okuma, çerezler, güvenlik başlıkları, hız sınırı.
// Framework yok, sadece node:http üzerinde ince bir katman.

import { randomBytes } from 'node:crypto';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// 'unsafe-inline' yok: arayüzde satır içi script/style kullanılmaz.
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export function securityHeaders(res, { hsts = false } = {}) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cache-Control', 'no-store');
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'bilinmiyor';
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure = true, httpOnly = true, sameSite = 'Strict', path = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (typeof maxAge === 'number') bits.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return bits.join('; ');
}

export function sendJson(res, status, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...extra,
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message }, extra);
}

export function sendBuffer(res, status, buffer, contentType, extra = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    ...extra,
  });
  res.end(buffer);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  sendBuffer(res, status, Buffer.from(text, 'utf8'), contentType);
}

/** Gövdeyi sınırla oku. Sınır aşılırsa bağlantı kesilir ve hata fırlatılır. */
export function readBody(req, { limit = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error(`İstek gövdesi çok büyük (limit ${limit} bayt).`), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', fail);
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

export async function readJson(req, { limit = 1024 * 1024 } = {}) {
  const buf = await readBody(req, { limit });
  if (buf.length === 0) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      throw Object.assign(new Error('JSON gövde bir nesne olmalı.'), { status: 400 });
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error('Geçersiz JSON gövdesi.'), { status: 400 });
  }
}

/** Kayan pencere hız sınırı. Basit ve bellekte: panel ölçeği için yeterli. */
export class RateLimiter {
  #hits = new Map();

  constructor({ windowMs = 600_000, max = 10 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
  }

  /** true → izin verildi, false → sınır aşıldı. */
  hit(key, now = Date.now()) {
    const entry = this.#hits.get(key);
    if (!entry || now - entry.start > this.windowMs) {
      this.#hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    if (this.#hits.size > 5000) this.sweep(now);
    return entry.count <= this.max;
  }

  reset(key) {
    this.#hits.delete(key);
  }

  retryAfterMs(key, now = Date.now()) {
    const entry = this.#hits.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.start + this.windowMs - now);
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.#hits) {
      if (now - entry.start > this.windowMs) this.#hits.delete(key);
    }
  }
}

export function randomToken(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

/** İstemci HTML'i metin olarak işlemek zorunda kalmasın diye kaçış yardımcısı. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}
