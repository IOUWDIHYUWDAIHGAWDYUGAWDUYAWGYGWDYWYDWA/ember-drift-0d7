/** HTTP yardımcıları: hata tipi, gövde okuma, cookie, güvenlik başlıkları. */

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code ?? `E${status}`;
  }
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** Gövdeyi oku; boyut sınırını aşarsa isteği kes ve 413 döndür. */
export function readBody(req, { limit = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.destroy();
        reject(new HttpError(413, `İstek gövdesi çok büyük (sınır ${Math.round(limit / 1024 / 1024)} MB)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!done) reject(err);
    });
  });
}

export async function readJson(req, opts) {
  const raw = await readBody(req, opts);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('gövde nesne değil');
    return parsed;
  } catch (err) {
    throw new HttpError(400, `Geçersiz JSON gövdesi: ${err.message}`);
  }
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

export function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Strict', path = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (typeof maxAge === 'number') bits.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return bits.join('; ');
}

/**
 * Katı güvenlik başlıkları. Uygulama tamamen kendi kaynaklarını kullanır,
 * bu yüzden CSP'de unsafe-inline yok — XSS yüzeyi minimumda tutulur.
 */
export function securityHeaders(res, { secure = false } = {}) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Basit sabit-pencereli hız sınırlayıcı (IP başına). */
export class RateLimiter {
  #hits = new Map();
  #windowMs;
  #max;

  constructor({ windowMs = 10 * 60 * 1000, max = 10 } = {}) {
    this.#windowMs = windowMs;
    this.#max = max;
  }

  /** true → izin verildi, false → sınır aşıldı. */
  hit(key) {
    const now = Date.now();
    const entry = this.#hits.get(key);
    if (!entry || now - entry.start > this.#windowMs) {
      this.#hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.#max;
  }

  reset(key) {
    this.#hits.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.#hits) {
      if (now - entry.start > this.#windowMs) this.#hits.delete(key);
    }
  }
}
