import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { Store } from './lib/store.js';
import { BotManager } from './lib/bots.js';
import { hostStats } from './lib/system.js';
import {
  randomId,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  parseMasterKey,
} from './lib/crypto.js';
import {
  HttpError,
  MIME,
  RateLimiter,
  parseCookies,
  readJson,
  securityHeaders,
  sendJson,
  serializeCookie,
} from './lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = path.resolve(ROOT, process.env.PANEL_DATA_DIR ?? 'data');
const BOTS_DIR = path.resolve(ROOT, process.env.PANEL_BOTS_DIR ?? 'bots');
const SESSION_TTL_MS = Number(process.env.PANEL_SESSION_TTL_HOURS ?? 12) * 60 * 60 * 1000;
const TRUST_PROXY = process.env.PANEL_TRUST_PROXY === '1';
const COOKIE = 'lumo_session';

const masterKey = resolveMasterKey();
const store = new Store({ file: path.join(DATA_DIR, 'panel.enc'), key: masterKey });
const bots = new BotManager({
  store,
  root: BOTS_DIR,
  driver: process.env.PANEL_BOT_DRIVER === 'docker' ? 'docker' : 'local',
});
const loginLimiter = new RateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
setInterval(() => loginLimiter.cleanup(), 5 * 60 * 1000).unref();

// --------------------------------------------------------------------- rotalar

const routes = [];

function route(method, pattern, handler, opts = {}) {
  const names = [];
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          names.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}/?$`,
  );
  routes.push({ method, regex, names, handler, auth: opts.auth !== false });
}

// --- sağlık ve kurulum

route('GET', '/api/health', (ctx) => ctx.send(200, { ok: true, uptime: Math.round(process.uptime()) }), { auth: false });

route('GET', '/api/setup/status', (ctx) => ctx.send(200, { needsSetup: store.data.users.length === 0 }), { auth: false });

route(
  'POST',
  '/api/setup',
  (ctx) => {
    if (store.data.users.length > 0) throw new HttpError(409, 'Kurulum zaten tamamlanmış');
    const { username, password } = validateCredentials(ctx.body);
    const { salt, hash } = hashPassword(password);
    const user = { id: randomId('u_'), username, salt, hash, createdAt: new Date().toISOString() };
    store.data.users.push(user);
    store.audit('setup.admin_created', { actor: username, detail: `ip=${ctx.ip}` });
    store.save();
    setSessionCookie(ctx, user);
    return ctx.send(201, { user: publicUser(user) });
  },
  { auth: false },
);

// --- kimlik

route(
  'POST',
  '/api/auth/login',
  (ctx) => {
    if (!loginLimiter.hit(ctx.ip)) throw new HttpError(429, 'Çok fazla hatalı deneme. 10 dakika sonra tekrar dene.');
    const { username, password } = ctx.body ?? {};
    const user = store.data.users.find((u) => u.username === String(username ?? ''));
    // Kullanıcı yoksa da parola doğrulaması yapılır → zamanlama ile kullanıcı adı sızdırmaz.
    const ok = user ? verifyPassword(String(password ?? ''), user.salt, user.hash) : verifyPassword(String(password ?? ''), 'x'.repeat(32), 'y'.repeat(128));
    if (!user || !ok) {
      store.audit('auth.login_failed', { actor: String(username ?? '?'), detail: `ip=${ctx.ip}` });
      store.save();
      throw new HttpError(401, 'Kullanıcı adı veya parola hatalı');
    }
    loginLimiter.reset(ctx.ip);
    setSessionCookie(ctx, user);
    store.audit('auth.login', { actor: user.username, detail: `ip=${ctx.ip}` });
    store.save();
    return ctx.send(200, { user: publicUser(user) });
  },
  { auth: false },
);

route('POST', '/api/auth/logout', (ctx) => {
  ctx.res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', { maxAge: 0, secure: ctx.secure }));
  return ctx.send(200, { ok: true });
});

route('GET', '/api/me', (ctx) => ctx.send(200, { user: publicUser(ctx.user), mobile: false }));

route('POST', '/api/auth/password', (ctx) => {
  const { current, next } = ctx.body ?? {};
  if (!verifyPassword(String(current ?? ''), ctx.user.salt, ctx.user.hash)) {
    throw new HttpError(401, 'Mevcut parola hatalı');
  }
  if (String(next ?? '').length < 10) throw new HttpError(400, 'Yeni parola en az 10 karakter olmalı');
  const { salt, hash } = hashPassword(String(next));
  ctx.user.salt = salt;
  ctx.user.hash = hash;
  store.audit('auth.password_changed', { actor: ctx.user.username });
  store.save();
  return ctx.send(200, { ok: true });
});

// --- sistem

route('GET', '/api/system', (ctx) =>
  ctx.send(200, {
    host: hostStats(),
    panel: {
      driver: bots.driver,
      dataDir: DATA_DIR,
      botsDir: BOTS_DIR,
      encryptedAtRest: true,
      sessionTtlHours: SESSION_TTL_MS / 3600000,
    },
    botCount: store.data.bots.length,
    runningCount: store.data.bots.filter((b) => ['running', 'restarting'].includes(bots.status(b.id).state)).length,
  }),
);

route('GET', '/api/audit', (ctx) => ctx.send(200, { entries: store.data.audit.slice(0, 200) }));

// --- botlar

route('GET', '/api/bots', (ctx) => ctx.send(200, { bots: bots.list(), defaultDriver: bots.driver }));

route('POST', '/api/bots', (ctx) => {
  const bot = bots.create(ctx.body ?? {});
  store.audit('bot.created', { actor: ctx.user.username, detail: `${bot.name} (${bot.id})` });
  store.save();
  return ctx.send(201, { bot: { ...bot, status: bots.status(bot.id) } });
});

route('GET', '/api/bots/:id', (ctx) => {
  const bot = bots.get(ctx.params.id);
  return ctx.send(200, { bot: { ...bot, status: bots.status(bot.id) } });
});

route('PATCH', '/api/bots/:id', (ctx) => {
  const bot = bots.update(ctx.params.id, ctx.body ?? {});
  store.audit('bot.updated', { actor: ctx.user.username, detail: `${bot.name} (${bot.id})` });
  store.save();
  return ctx.send(200, { bot: { ...bot, status: bots.status(bot.id) } });
});

route('DELETE', '/api/bots/:id', async (ctx) => {
  const bot = bots.get(ctx.params.id);
  await bots.remove(ctx.params.id);
  store.audit('bot.deleted', { actor: ctx.user.username, detail: `${bot.name} (${bot.id})` });
  store.save();
  return ctx.send(200, { ok: true });
});

route('POST', '/api/bots/:id/start', async (ctx) => {
  await bots.start(ctx.params.id);
  store.audit('bot.started', { actor: ctx.user.username, detail: ctx.params.id });
  store.save();
  return ctx.send(200, { status: bots.status(ctx.params.id) });
});

route('POST', '/api/bots/:id/stop', async (ctx) => {
  await bots.stop(ctx.params.id);
  store.audit('bot.stopped', { actor: ctx.user.username, detail: ctx.params.id });
  store.save();
  return ctx.send(200, { status: bots.status(ctx.params.id) });
});

route('POST', '/api/bots/:id/restart', async (ctx) => {
  await bots.restart(ctx.params.id);
  store.audit('bot.restarted', { actor: ctx.user.username, detail: ctx.params.id });
  store.save();
  return ctx.send(200, { status: bots.status(ctx.params.id) });
});

route('POST', '/api/bots/:id/input', (ctx) => {
  bots.sendInput(ctx.params.id, String(ctx.body?.text ?? ''));
  return ctx.send(200, { ok: true });
});

route('GET', '/api/bots/:id/logs', (ctx) => {
  const since = Number(ctx.query.get('since') ?? 0);
  return ctx.send(200, { ...bots.logs(ctx.params.id, Number.isFinite(since) ? since : 0), status: bots.status(ctx.params.id) });
});

// --- canlı konsol (Server-Sent Events: ek bağımlılık yok, cookie ile aynı kaynak)

route('GET', '/api/bots/:id/stream', (ctx) => {
  const id = ctx.params.id;
  bots.get(id);
  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (event) => ctx.res.write(`data: ${JSON.stringify(event)}\n\n`);
  const { lines } = bots.logs(id, Number(ctx.query.get('since') ?? 0));
  for (const line of lines) write({ type: 'log', line });
  write({ type: 'status', status: bots.status(id) });

  const unsubscribe = bots.subscribe(id, write);
  const heartbeat = setInterval(() => ctx.res.write(': ping\n\n'), 15000);
  ctx.res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  return undefined; // yanıt açık kalır
});

// --- dosyalar

route('GET', '/api/bots/:id/files', (ctx) => ctx.send(200, bots.listFiles(ctx.params.id, ctx.query.get('path') ?? '')));

route('GET', '/api/bots/:id/file', (ctx) => {
  const rel = ctx.query.get('path');
  if (!rel) throw new HttpError(400, 'path parametresi gerekli');
  return ctx.send(200, bots.readFile(ctx.params.id, rel));
});

route('PUT', '/api/bots/:id/file', (ctx) => {
  const rel = ctx.body?.path;
  if (!rel) throw new HttpError(400, 'path gerekli');
  const result = bots.writeFile(ctx.params.id, rel, ctx.body?.content ?? '');
  store.audit('file.write', { actor: ctx.user.username, detail: `${ctx.params.id}/${rel}` });
  store.save();
  return ctx.send(200, result);
});

route('POST', '/api/bots/:id/mkdir', (ctx) => {
  const rel = ctx.body?.path;
  if (!rel) throw new HttpError(400, 'path gerekli');
  return ctx.send(201, bots.mkdir(ctx.params.id, rel));
});

route('DELETE', '/api/bots/:id/file', (ctx) => {
  const rel = ctx.query.get('path');
  if (!rel) throw new HttpError(400, 'path parametresi gerekli');
  const result = bots.deletePath(ctx.params.id, rel);
  store.audit('file.delete', { actor: ctx.user.username, detail: `${ctx.params.id}/${rel}` });
  store.save();
  return ctx.send(200, result);
});

route('POST', '/api/bots/:id/upload', (ctx) => {
  const written = bots.uploadFiles(ctx.params.id, ctx.body?.files);
  store.audit('file.upload', { actor: ctx.user.username, detail: `${ctx.params.id}: ${written.length} dosya` });
  store.save();
  return ctx.send(201, { files: written });
});

// ------------------------------------------------------------------ sunucu

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[panel] hata:', err);
    sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Sunucu hatası', code: err.code });
  });
});

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const secure = Boolean(req.socket.encrypted) || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  securityHeaders(res, { secure });
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  const ip = clientIp(req);
  const ctxBase = { req, res, url, ip, secure, query: url.searchParams, params: {}, body: {}, user: null };
  ctxBase.send = (status, payload) => sendJson(res, status, payload);

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const matched = routes.find((r) => {
    if (r.method !== req.method) return false;
    const m = r.regex.exec(url.pathname);
    if (!m) return false;
    r.names.forEach((name, i) => {
      ctxBase.params[name] = decodeURIComponent(m[i + 1]);
    });
    return true;
  });

  if (!matched) throw new HttpError(404, 'Uç nokta bulunamadı');

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    assertSameOrigin(req);
    if (req.headers['content-type']?.includes('application/json') || req.headers['content-length']) {
      ctxBase.body = await readJson(req, { limit: 64 * 1024 * 1024 });
    }
  }

  if (matched.auth) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = token ? verifyToken(token, masterKey) : null;
    const user = session ? store.data.users.find((u) => u.id === session.uid) : null;
    if (!user) throw new HttpError(401, 'Oturum gerekli');
    ctxBase.user = user;
  }

  await matched.handler(ctxBase);
}

/** SameSite=Strict + Origin kontrolü: tarayıcıdan gelen siteler arası sahte istekler engellenir. */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // curl / sunucu-sunucu istekleri: Origin yok, çerez de yok
  const host = req.headers.host;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Geçersiz Origin başlığı');
  }
  if (originHost !== host) throw new HttpError(403, 'Site dışı istek reddedildi');
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Yöntem desteklenmiyor');
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Geçersiz yol');
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    // SPA: bilinmeyen yolları index.html'e düşür
    const indexFile = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(indexFile)) throw new HttpError(404, 'Arayüz bulunamadı');
    const html = Buffer.from(renderIndexHtml(indexFile), 'utf8');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length, 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  const ext = path.extname(target).toLowerCase();
  const body = ext === '.html' ? Buffer.from(renderIndexHtml(target), 'utf8') : fs.readFileSync(target);
  // Arayüz dosyaları sürümle birlikte değiştiği için önbelleğe alınmaz:
  // güncelleme sonrası eski app.js ile yeni API'nin karışmasını engeller.
  const cache = ['.png', '.svg', '.ico', '.woff2'].includes(ext) ? 'public, max-age=86400' : 'no-cache';
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': cache,
  });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

// ------------------------------------------------------------------ yardımcı

/**
 * index.html içindeki varlık adreslerine, dosyanın değişiklik zamanına dayalı
 * sürüm damgası ekler. Böylece güncelleme sonrası tarayıcı eski app.js'i
 * önbellekten sunmaz; kullanıcı sayfayı yenilediği anda yeni sürümü alır.
 */
function renderIndexHtml(indexFile) {
  let html = fs.readFileSync(indexFile, 'utf8');
  for (const asset of ['/app.js', '/styles.css']) {
    const file = path.join(PUBLIC_DIR, asset.slice(1));
    if (!fs.existsSync(file)) continue;
    const version = Math.floor(fs.statSync(file).mtimeMs).toString(36);
    html = html.split(`${asset}"`).join(`${asset}?v=${version}"`);
  }
  return html;
}

function setSessionCookie(ctx, user) {
  const token = signToken({ uid: user.id, usr: user.username }, masterKey, SESSION_TTL_MS);
  ctx.res.setHeader('Set-Cookie', serializeCookie(COOKIE, token, { maxAge: SESSION_TTL_MS, secure: ctx.secure }));
}

function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

function validateCredentials(body) {
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'Kullanıcı adı 3-32 karakter, sadece harf/rakam/._- olabilir');
  }
  if (password.length < 10) throw new HttpError(400, 'Parola en az 10 karakter olmalı');
  return { username, password };
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'bilinmiyor';
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    if (process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

/**
 * Ana anahtar önce ortamdan okunur. Yoksa geliştirme kolaylığı için
 * keys/master.key dosyası üretilir (0600) ve uyarı basılır.
 * Üretimde PANEL_MASTER_KEY kullan — dosya anahtarı dosya sistemiyle aynı
 * güvenlik seviyesindedir.
 */
function resolveMasterKey() {
  if (process.env.PANEL_MASTER_KEY) return parseMasterKey(process.env.PANEL_MASTER_KEY);
  const keyDir = path.join(ROOT, 'keys');
  const keyFile = path.join(keyDir, 'master.key');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn('[panel] UYARI: PANEL_MASTER_KEY yok, keys/master.key üretildi. Yedeğini al!');
  }
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {
    /* Windows */
  }
  return parseMasterKey(fs.readFileSync(keyFile, 'utf8').trim());
}

// ------------------------------------------------------------------ başlat

server.listen(PORT, HOST, () => {
  const needsSetup = store.data.users.length === 0;
  console.log('');
  console.log('  Lumo Panel — Discord bot kontrol paneli');
  console.log(`  → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  sürücü: ${bots.driver}   veri: ${DATA_DIR}   botlar: ${BOTS_DIR}`);
  console.log(`  bot sayısı: ${store.data.bots.length}   kurulum gerekli: ${needsSetup ? 'EVET' : 'hayır'}`);
  console.log(`  platform: ${os.platform()}/${os.arch()}   node ${process.version}`);
  console.log('');

  // 7/24: süpervizör/makine yeniden başladıysa botları kendiliğinden ayağa kaldır.
  bots
    .autostartAll()
    .then((started) => {
      if (started.length) console.log(`[panel] otomatik başlatıldı: ${started.join(', ')}`);
    })
    .catch((err) => console.error('[panel] otomatik başlatma hatası:', err));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[panel] ${signal} alındı, botlar durduruluyor...`);
    await bots.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', (err) => console.error('[panel] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[panel] uncaughtException:', err));
