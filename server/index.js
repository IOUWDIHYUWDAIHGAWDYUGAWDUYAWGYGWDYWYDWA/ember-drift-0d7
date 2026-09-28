#!/usr/bin/env node
// Lumo Panel — HTTP sunucusu, rotalar, kimlik doğrulama, statik dosyalar.
//
// Katmanlar: config → store (şifreli durum) → supervisors (docker/local) →
// backups, schedules → bu dosya (HTTP yüzeyi).

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { allocatePort, freePorts, poolUsage, releasePort } from './lib/allocations.js';
import { Backups } from './lib/backups.js';
import { loadConfig, loadDotEnv } from './lib/config.js';
import { maskVariables, sanitizeVariables, missingRequired, findEgg, allEggs, NESTS, validateEggShape } from './lib/eggs.js';
import {
  MIME,
  RateLimiter,
  clientIp,
  parseCookies,
  readBody,
  readJson,
  securityHeaders,
  sendBuffer,
  sendError,
  sendJson,
  serializeCookie,
} from './lib/http.js';
import { Schedules, validateSchedule } from './lib/schedules.js';
import { STATUS, Servers } from './lib/servers.js';
import { Store, audit } from './lib/store.js';
import * as docker from './lib/docker.js';
import { systemInfo } from './lib/system.js';
import {
  createSessionToken,
  hashPassword,
  parseMasterKey,
  randomId,
  verifyPassword,
  verifySessionToken,
} from './lib/crypto.js';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const COOKIE_NAME = 'lumo_session';
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
const JSON_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 25 * 1024 * 1024;
const READ_MAX_BYTES = 2 * 1024 * 1024;

// Kullanıcı bulunamadığında da aynı scrypt maliyetini ödemek için: yanıt süresi
// kullanıcı adının var olup olmadığını ele vermez.
const DUMMY_PASSWORD = hashPassword('lumo-panel-dummy-password');

export const PANEL_VERSION = '0.2.0';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function boolOf(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeLimits(input = {}, eggFeatures = {}, defaults = {}) {
  return {
    memoryMb: Math.round(clampNumber(input.memoryMb, 128, 65536, eggFeatures.memoryMb ?? defaults.memoryMb ?? 512)),
    cpu: Number(clampNumber(input.cpu, 0.1, 32, eggFeatures.cpu ?? defaults.cpu ?? 1).toFixed(2)),
    diskMb: Math.round(clampNumber(input.diskMb, 64, 1048576, eggFeatures.diskMb ?? defaults.diskMb ?? 2048)),
    pids: Math.round(clampNumber(input.pids, 32, 32768, eggFeatures.pids ?? defaults.pids ?? 256)),
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    passwordChangedAt: user.passwordChangedAt || null,
  };
}

export async function createApp({ env = process.env, cwd = process.cwd(), logger = console } = {}) {
  await loadDotEnv(path.join(cwd, '.env'), env);
  const config = await loadConfig({ env, cwd });
  const key = parseMasterKey(config.masterKey);

  const store = new Store({ file: config.stateFile, key });
  await store.load();

  const servers = new Servers({ store, config });
  Object.defineProperty(servers, '__store', { value: store, enumerable: false });

  await fs.mkdir(config.serversDir, { recursive: true });
  const backups = new Backups({ store, servers, dir: config.backupsDir });
  await backups.reconcile();
  const schedules = new Schedules({ store, servers, backups, logger });

  let dockerVersion = null;
  if (config.driver === 'docker') {
    dockerVersion = await docker.dockerVersion();
    if (!dockerVersion) {
      throw new Error(
        'PANEL_BOT_DRIVER=docker ayarlı ama Docker erişilemiyor. Docker kurulu mu, soket izinleri doğru mu?',
      );
    }
  }

  const loginLimiter = new RateLimiter(config.login);

  // --- Yardımcılar ---------------------------------------------------------

  const currentUser = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const payload = verifySessionToken(key, cookies[COOKIE_NAME]);
    if (!payload) return null;
    const user = store.state.users.find((item) => item.id === payload.sub);
    if (!user) return null;
    if (user.sessionVersion !== payload.ver) return null;
    return user;
  };

  const setSession = (res, user) => {
    const token = createSessionToken(key, {
      userId: user.id,
      sessionVersion: user.sessionVersion,
      ttlMs: config.sessionTtlMs,
    });
    res.setHeader(
      'Set-Cookie',
      serializeCookie(COOKIE_NAME, token, {
        maxAge: config.sessionTtlMs,
        secure: !config.insecureCookies,
      }),
    );
  };

  const clearSession = (res) => {
    res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', { maxAge: 0, secure: !config.insecureCookies }));
  };

  // Doğrulama modülleri framework'ten bağımsız kalsın diye durum kodunu burada
  // ekliyoruz: geçersiz girdi 400'dür, 500 (sunucu hatası) değil.
  const checked = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (err.status) throw err;
      throw httpError(400, err.message);
    }
  };

  const requireSetupAvailable = () => {
    if (store.state.users.length > 0) throw httpError(409, 'Kurulum zaten tamamlanmış.');
  };

  const serverView = (server, { reveal = false } = {}) => {
    const egg = findEgg(server.egg, store.state.eggs) || { id: server.egg, name: server.egg, variables: [], features: {} };
    const maskedEnvironment = Object.fromEntries(
      Object.keys(server.environment || {}).map((key) => [key, '••••••••']),
    );
    return {
      ...servers.summary(server),
      eggName: egg.name ?? server.egg,
      eggNest: egg.nest ?? null,
      startupCommand: servers.buildCommand(server, egg),
      eggVariables: (egg.variables || []).map((item) => ({
        key: item.key,
        name: item.name,
        description: item.description,
        required: item.required,
        secret: item.secret,
        default: item.secret ? '' : item.default,
      })),
      variables: reveal ? { ...server.variables } : maskVariables(egg, server.variables || {}),
      environment: reveal ? { ...(server.environment || {}) } : maskedEnvironment,
    };
  };

  const serverById = (id) => {
    const server = servers.findServer(id);
    if (!server) throw httpError(404, 'Sunucu bulunamadı.');
    return server;
  };

  const backupById = (id) => {
    const meta = backups.find(id);
    if (!meta) throw httpError(404, 'Yedek bulunamadı.');
    return meta;
  };

  const userById = (id) => {
    const user = store.state.users.find((item) => item.id === id);
    if (!user) throw httpError(404, 'Kullanıcı bulunamadı.');
    return user;
  };

  const activeAdminCount = () => store.state.users.filter((item) => item.role === 'admin').length;

  // --- Rotalar -------------------------------------------------------------

  const routes = [];
  const route = (method, pattern, handler, options = {}) => {
    routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handler,
      auth: options.auth ?? true,
      role: options.role ?? 'viewer',
      body: options.body ?? 'none',
      pattern,
    });
  };

  const match = (method, pathname) => {
    const parts = pathname.split('/').filter(Boolean);
    for (const item of routes) {
      if (item.method !== method || item.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let index = 0; index < parts.length; index += 1) {
        const segment = item.segments[index];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[index]);
        } else if (segment !== parts[index]) {
          ok = false;
          break;
        }
      }
      if (ok) return { ...item, params };
    }
    return null;
  };

  // --- Herkese açık --------------------------------------------------------

  route('GET', '/api/health', async ({ res }) => {
    sendJson(res, 200, {
      ok: true,
      version: PANEL_VERSION,
      driver: config.driver,
      docker: dockerVersion,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }, { auth: false });

  route('GET', '/api/setup/status', async ({ res }) => {
    sendJson(res, 200, {
      needsSetup: store.state.users.length === 0,
      panelName: store.state.panel?.name || 'Lumo Panel',
      version: PANEL_VERSION,
    });
  }, { auth: false });

  route('POST', '/api/setup', async ({ res, body, ip }) => {
    requireSetupAvailable();
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      throw httpError(400, 'Kullanıcı adı 3-32 karakter olmalı (harf, rakam, . _ -).');
    }
    if (password.length < 10) throw httpError(400, 'Parola en az 10 karakter olmalı.');
    const { salt, hash } = hashPassword(password);
    const user = {
      id: randomId('usr-'),
      username,
      role: 'admin',
      salt,
      hash,
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      passwordChangedAt: new Date().toISOString(),
    };
    await store.update((state) => {
      state.users.push(user);
      audit(state, { actor: username, action: 'panel.setup', detail: { username }, ip }, config.auditLimit);
    });
    setSession(res, user);
    sendJson(res, 201, { user: publicUser(user) });
  }, { auth: false, body: 'json' });

  route('POST', '/api/auth/login', async ({ res, body, ip }) => {
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const throttleKey = `${ip}:${username.toLowerCase()}`;
    if (!loginLimiter.hit(throttleKey)) {
      throw httpError(429, 'Çok fazla hatalı deneme. Lütfen sonra tekrar dene.');
    }
    const user = store.state.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
    const ok = verifyPassword(password, user?.salt ?? DUMMY_PASSWORD.salt, user?.hash ?? DUMMY_PASSWORD.hash);
    if (!user || !ok) {
      await store.update((state) => {
        audit(state, { actor: username || '(boş)', action: 'auth.login.failed', ip }, config.auditLimit);
      });
      throw httpError(401, 'Kullanıcı adı veya parola hatalı.');
    }
    loginLimiter.reset(throttleKey);
    await store.update((state) => {
      const target = state.users.find((item) => item.id === user.id);
      if (target) target.lastLoginAt = new Date().toISOString();
      audit(state, { actor: user.username, action: 'auth.login', ip }, config.auditLimit);
    });
    setSession(res, user);
    sendJson(res, 200, { user: publicUser(user) });
  }, { auth: false, body: 'json' });

  route('POST', '/api/auth/logout', async ({ res, user, ip }) => {
    await store.update((state) => {
      audit(state, { actor: user.username, action: 'auth.logout', ip }, config.auditLimit);
    });
    clearSession(res);
    sendJson(res, 200, { ok: true });
  });

  route('POST', '/api/auth/password', async ({ res, body, user, ip }) => {
    const current = String(body.currentPassword ?? '');
    const next = String(body.newPassword ?? '');
    if (!verifyPassword(current, user.salt, user.hash)) throw httpError(400, 'Mevcut parola hatalı.');
    if (next.length < 10) throw httpError(400, 'Yeni parola en az 10 karakter olmalı.');
    if (next === current) throw httpError(400, 'Yeni parola eskisiyle aynı olamaz.');
    const { salt, hash } = hashPassword(next);
    await store.update((state) => {
      const target = state.users.find((item) => item.id === user.id);
      if (target) {
        target.salt = salt;
        target.hash = hash;
        target.passwordChangedAt = new Date().toISOString();
        target.sessionVersion += 1; // tüm eski çerezler geçersiz
      }
      audit(state, { actor: user.username, action: 'auth.password.change', ip }, config.auditLimit);
    });
    clearSession(res);
    sendJson(res, 200, { ok: true, reauth: true });
  }, { body: 'json' });

  route('GET', '/api/me', async ({ res, user }) => {
    sendJson(res, 200, { user: publicUser(user) });
  });

  // --- Sunucular -----------------------------------------------------------

  route('GET', '/api/servers', async ({ res }) => {
    sendJson(res, 200, { servers: store.state.servers.map((item) => serverView(item)) });
  });

  route('GET', '/api/servers/:id', async ({ res, params }) => {
    const server = serverById(params.id);
    sendJson(res, 200, { server: serverView(server), logs: servers.logs(server.id).entries.slice(-200) });
  });

  route('POST', '/api/servers', async ({ res, body, user, ip }) => {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 64) throw httpError(400, 'Sunucu adı 1-64 karakter olmalı.');
    const egg = findEgg(String(body.egg ?? '').trim(), store.state.eggs);
    if (!egg) throw httpError(400, 'Egg bulunamadı.');

    const { values, custom, errors } = sanitizeVariables(egg, body.variables || {});
    if (errors.length) throw httpError(400, errors.join(' '));
    const missing = missingRequired(egg, values);
    if (missing.length) throw httpError(400, `Zorunlu değişkenler eksik: ${missing.join(', ')}`);

    const startupOverride = body.startupOverride ? String(body.startupOverride).trim() : null;
    if (startupOverride && startupOverride.length > 4096) throw httpError(400, 'Başlangıç komutu çok uzun.');

    const server = {
      id: randomId('srv-'),
      name,
      egg: egg.id,
      variables: values,
      environment: custom,
      limits: normalizeLimits(body.limits || {}, egg.features, config.defaults),
      autoStart: boolOf(body.autoStart, false),
      restartPolicy: ['always', 'on-failure', 'never'].includes(body.restartPolicy) ? body.restartPolicy : egg.restartPolicy || 'always',
      startupOverride,
      allocation: null,
      suspended: false,
      suspendReason: null,
      createdAt: new Date().toISOString(),
      installedAt: null,
      restartCount: 0,
      lastExit: null,
    };

    const wantsPort = (egg.allocations || []).length > 0 && body.allocatePort !== false;
    await store.update((state) => {
      state.servers.push(server);
      if (wantsPort) {
        const port = allocatePort(state, config.portRange, server.id, { bind: config.portBind });
        server.allocation = { name: egg.allocations[0].name || 'PORT', port, bind: config.portBind };
      }
      audit(state, {
        actor: user.username,
        action: 'server.create',
        target: name,
        detail: { egg: egg.id, limits: server.limits, port: server.allocation?.port ?? null },
        ip,
      }, config.auditLimit);
    });
    await servers.jail(server.id).ensureRoot();
    sendJson(res, 201, { server: serverView(server) });
  }, { role: 'admin', body: 'json' });

  route('PATCH', '/api/servers/:id', async ({ res, params, body, user, ip }) => {
    const server = serverById(params.id);
    const egg = findEgg(server.egg, store.state.eggs) || { variables: [], features: {} };
    const changes = {};

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 64) throw httpError(400, 'Sunucu adı 1-64 karakter olmalı.');
      changes.name = name;
    }
    if (body.variables !== undefined) {
      const merged = { ...server.variables, ...(body.variables || {}) };
      const { values, custom, errors } = sanitizeVariables(egg, merged);
      if (errors.length) throw httpError(400, errors.join(' '));
      const missing = missingRequired(egg, values);
      if (missing.length) throw httpError(400, `Zorunlu değişkenler eksik: ${missing.join(', ')}`);
      changes.variables = values;
      changes.environment = { ...(server.environment || {}), ...custom };
    }
    if (body.environment !== undefined) {
      const environment = {};
      for (const [key, value] of Object.entries(body.environment || {})) {
        const normalized = String(key).trim().toUpperCase();
        if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(normalized)) throw httpError(400, `Geçersiz değişken adı: ${key}`);
        environment[normalized] = String(value ?? '');
      }
      changes.environment = environment;
    }
    if (body.limits !== undefined) changes.limits = normalizeLimits(body.limits, egg.features, config.defaults);
    if (body.autoStart !== undefined) changes.autoStart = boolOf(body.autoStart, false);
    if (body.restartPolicy !== undefined) {
      if (!['always', 'on-failure', 'never'].includes(body.restartPolicy)) throw httpError(400, 'Geçersiz yeniden başlatma politikası.');
      changes.restartPolicy = body.restartPolicy;
    }
    if (body.startupOverride !== undefined) {
      const value = body.startupOverride ? String(body.startupOverride).trim() : null;
      if (value && value.length > 4096) throw httpError(400, 'Başlangıç komutu çok uzun.');
      changes.startupOverride = value;
    }

    await store.update((state) => {
      const target = state.servers.find((item) => item.id === server.id);
      Object.assign(target, changes);
      audit(state, {
        actor: user.username,
        action: 'server.update',
        target: target.name,
        detail: { fields: Object.keys(changes) },
        ip,
      }, config.auditLimit);
    });
    sendJson(res, 200, { server: serverView(server) });
  }, { role: 'operator', body: 'json' });

  route('DELETE', '/api/servers/:id', async ({ res, params, query, user, ip }) => {
    const server = serverById(params.id);
    const deleteFiles = boolOf(query.get('files'), false);
    const wasRunning = servers.status(server.id) !== STATUS.OFFLINE;
    await servers.destroy(server.id);
    const removedBackups = [];
    for (const item of backups.list(server.id)) removedBackups.push(item.id);

    await store.update((state) => {
      releasePort(state, server.id);
      state.servers = state.servers.filter((item) => item.id !== server.id);
      state.schedules = state.schedules.filter((item) => item.serverId !== server.id);
      if (deleteFiles) state.backups = state.backups.filter((item) => item.serverId !== server.id);
      audit(state, {
        actor: user.username,
        action: 'server.delete',
        target: server.name,
        detail: { deleteFiles, wasRunning, backupsRemoved: deleteFiles ? removedBackups.length : 0 },
        ip,
      }, config.auditLimit);
    });

    if (deleteFiles) {
      for (const backupId of removedBackups) {
        await fs.rm(backups.filePath(backupId), { force: true }).catch(() => {});
      }
      await fs.rm(servers.serverDir(server.id), { recursive: true, force: true }).catch(() => {});
    }
    sendJson(res, 200, { ok: true, filesDeleted: deleteFiles, backupsRemoved: deleteFiles ? removedBackups.length : 0 });
  }, { role: 'admin' });

  route('POST', '/api/servers/:id/power', async ({ res, params, body, user, ip }) => {
    const server = serverById(params.id);
    const action = String(body.action ?? '').trim();
    // Metotlar bağlı (bound) çağrılır: aksi hâlde `this` kaybı olur.
    const actions = {
      start: (options) => servers.start(server.id, options),
      stop: (options) => servers.stop(server.id, options),
      restart: (options) => servers.restart(server.id, options),
      kill: (options) => servers.kill(server.id, options),
      install: (options) => servers.install(server.id, options),
    };
    if (!actions[action]) throw httpError(400, `Geçersiz güç eylemi: ${action} (start, stop, restart, kill, install)`);
    const result = await actions[action]({ actor: user.username, force: action === 'kill' });
    await store.update((state) => {
      audit(state, { actor: user.username, action: `server.${action}`, target: server.name, ip }, config.auditLimit);
    });
    sendJson(res, 200, { status: servers.status(server.id), result: result ?? null });
  }, { role: 'operator', body: 'json' });

  route('POST', '/api/servers/:id/suspend', async ({ res, params, body, user, ip }) => {
    const server = serverById(params.id);
    const result = await servers.suspend(server.id, {
      reason: String(body?.reason ?? 'yönetici kararı').slice(0, 200),
      actor: user.username,
    });
    sendJson(res, 200, result);
  }, { role: 'admin', body: 'json' });

  route('POST', '/api/servers/:id/resume', async ({ res, params, user }) => {
    const server = serverById(params.id);
    sendJson(res, 200, await servers.resume(server.id, { actor: user.username }));
  }, { role: 'admin' });

  route('POST', '/api/servers/:id/input', async ({ res, params, body, user }) => {
    const server = serverById(params.id);
    const command = String(body.command ?? '');
    if (!command.trim()) throw httpError(400, 'Komut boş olamaz.');
    if (command.length > 512) throw httpError(400, 'Komut çok uzun.');
    servers.input(server.id, command);
    sendJson(res, 200, { ok: true });
  }, { role: 'operator', body: 'json' });

  route('GET', '/api/servers/:id/logs', async ({ res, params, query }) => {
    const server = serverById(params.id);
    sendJson(res, 200, servers.logs(server.id, Number(query.get('since') || 0)));
  });

  route('GET', '/api/servers/:id/stream', async ({ req, res, params }) => {
    const server = serverById(params.id);
    securityHeaders(res, { hsts: false });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n`);
    const backlog = servers.logs(server.id).entries.slice(-200);
    for (const entry of backlog) res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'state', status: servers.status(server.id) })}\n\n`);

    const unsubscribeLog = servers.subscribe(server.id, (entry) => {
      res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    });
    const onState = (payload) => {
      if (payload.serverId !== server.id) return;
      res.write(`data: ${JSON.stringify({ type: 'state', status: payload.status })}\n\n`);
    };
    servers.on('state', onState);
    const statsTimer = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'stats', stats: servers.runtime(server.id).stats })}\n\n`);
    }, 5000);
    const pingTimer = setInterval(() => res.write(': ping\n\n'), 25_000);

    const cleanup = () => {
      unsubscribeLog();
      servers.off('state', onState);
      clearInterval(statsTimer);
      clearInterval(pingTimer);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  route('GET', '/api/servers/:id/usage', async ({ res, params }) => {
    const server = serverById(params.id);
    const usage = await servers.jail(server.id).usage();
    sendJson(res, 200, {
      bytes: usage.bytes,
      files: usage.files,
      limitBytes: (server.limits.diskMb || 0) * 1024 * 1024,
      truncated: usage.truncated,
    });
  });

  // --- Dosya yöneticisi ----------------------------------------------------

  route('GET', '/api/servers/:id/files', async ({ res, params, query }) => {
    const server = serverById(params.id);
    sendJson(res, 200, await servers.jail(server.id).list(query.get('path') || ''));
  });

  route('GET', '/api/servers/:id/file', async ({ res, params, query }) => {
    const server = serverById(params.id);
    sendJson(res, 200, await servers.jail(server.id).read(query.get('path') || '', { maxBytes: READ_MAX_BYTES }));
  });

  route('PUT', '/api/servers/:id/file', async ({ res, params, body, user }) => {
    const server = serverById(params.id);
    const rel = String(body.path ?? '');
    if (typeof body.content !== 'string') throw httpError(400, 'Dosya içeriği (content) gerekli.');
    const buffer = body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8');
    const result = await servers.jail(server.id).write(rel, buffer);
    await store.update((state) => {
      audit(state, { actor: user.username, action: 'file.write', target: server.name, detail: { path: result.path } }, config.auditLimit);
    });
    sendJson(res, 200, result);
  }, { role: 'operator', body: 'json' });

  route('POST', '/api/servers/:id/upload', async ({ res, params, body, user }) => {
    const server = serverById(params.id);
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) throw httpError(400, 'Yüklenecek dosya yok.');
    const jail = servers.jail(server.id);
    const written = [];
    let totalBytes = 0;
    for (const item of files) {
      const rel = String(item.path ?? '').trim();
      if (!rel) throw httpError(400, 'Her dosya için yol (path) gerekli.');
      const buffer = Buffer.from(String(item.content ?? ''), 'base64');
      totalBytes += buffer.length;
      await jail.write(rel, buffer);
      written.push({ path: rel, size: buffer.length });
    }
    await store.update((state) => {
      audit(state, {
        actor: user.username,
        action: 'file.upload',
        target: server.name,
        detail: { files: written.length, bytes: totalBytes },
      }, config.auditLimit);
    });
    sendJson(res, 200, { written, totalBytes });
  }, { role: 'operator', body: 'json', bodyLimit: UPLOAD_LIMIT });

  route('POST', '/api/servers/:id/mkdir', async ({ res, params, body }) => {
    const server = serverById(params.id);
    sendJson(res, 200, await servers.jail(server.id).mkdir(String(body.path ?? '')));
  }, { role: 'operator', body: 'json' });

  route('POST', '/api/servers/:id/rename', async ({ res, params, body, user }) => {
    const server = serverById(params.id);
    const result = await servers.jail(server.id).rename(String(body.from ?? ''), String(body.to ?? ''));
    await store.update((state) => {
      audit(state, { actor: user.username, action: 'file.rename', target: server.name, detail: result }, config.auditLimit);
    });
    sendJson(res, 200, result);
  }, { role: 'operator', body: 'json' });

  route('DELETE', '/api/servers/:id/file', async ({ res, params, query, user }) => {
    const server = serverById(params.id);
    const rel = query.get('path') || '';
    const result = await servers.jail(server.id).remove(rel);
    await store.update((state) => {
      audit(state, { actor: user.username, action: 'file.delete', target: server.name, detail: result }, config.auditLimit);
    });
    sendJson(res, 200, result);
  }, { role: 'operator' });

  route('GET', '/api/servers/:id/download', async ({ res, params, query }) => {
    const server = serverById(params.id);
    const jail = servers.jail(server.id);
    const rel = query.get('path') || '';
    const { absolute } = await jail.resolve(rel, { mustExist: true });
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) throw httpError(400, 'Dizin indirilemez; yedek almak için yedekleri kullan.');
    const data = await fs.readFile(absolute);
    const name = path.basename(absolute);
    sendBuffer(res, 200, data, MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', {
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\-]/g, '_')}"`,
    });
  });

  // --- Yedekler ------------------------------------------------------------

  route('GET', '/api/servers/:id/backups', async ({ res, params }) => {
    const server = serverById(params.id);
    sendJson(res, 200, { backups: backups.list(server.id) });
  });

  route('POST', '/api/servers/:id/backups', async ({ res, params, body, user }) => {
    const server = serverById(params.id);
    const meta = await backups.create(server.id, {
      name: body.name ? String(body.name).slice(0, 80) : null,
      actor: user.username,
      keep: Number.isInteger(body.keep) ? clampNumber(body.keep, 1, 50, 5) : 5,
    });
    sendJson(res, 201, { backup: meta });
  }, { role: 'operator', body: 'json' });

  route('GET', '/api/backups/:id/download', async ({ res, params }) => {
    const meta = backupById(params.id);
    const { buffer, checksumMatches } = await backups.read(meta.id);
    sendBuffer(res, 200, buffer, 'application/gzip', {
      'Content-Disposition': `attachment; filename="${meta.file}"`,
      'X-Lumo-Checksum-Valid': String(checksumMatches),
    });
  });

  route('POST', '/api/backups/:id/restore', async ({ res, params, user }) => {
    const meta = backupById(params.id);
    const result = await backups.restore(meta.id, { actor: user.username });
    sendJson(res, 200, result);
  }, { role: 'operator' });

  route('DELETE', '/api/backups/:id', async ({ res, params, user }) => {
    const meta = backupById(params.id);
    sendJson(res, 200, await backups.remove(meta.id, { actor: user.username }));
  }, { role: 'operator' });

  // --- Zamanlanmış görevler ------------------------------------------------

  route('GET', '/api/schedules', async ({ res, query }) => {
    sendJson(res, 200, { schedules: schedules.list(query.get('serverId') || null) });
  });

  route('POST', '/api/schedules', async ({ res, body, user, ip }) => {
    const clean = checked(() => validateSchedule(body, { serverExists: (id) => Boolean(servers.findServer(id)) }));
    const schedule = {
      ...clean,
      createdAt: new Date().toISOString(),
      createdBy: user.username,
      lastRun: null,
      lastRunMinute: null,
      history: [],
    };
    await store.update((state) => {
      state.schedules.push(schedule);
      const server = state.servers.find((item) => item.id === schedule.serverId);
      audit(state, {
        actor: user.username,
        action: 'schedule.create',
        target: server?.name || schedule.serverId,
        detail: { name: schedule.name, cron: schedule.cron, steps: schedule.tasks.length },
        ip,
      }, config.auditLimit);
    });
    sendJson(res, 201, { schedule: schedules.decorate(schedule) });
  }, { role: 'operator', body: 'json' });

  route('PATCH', '/api/schedules/:id', async ({ res, params, body, user }) => {
    const existing = store.state.schedules.find((item) => item.id === params.id);
    if (!existing) throw httpError(404, 'Görev bulunamadı.');
    const merged = checked(() => validateSchedule({ ...existing, ...body }, { serverExists: (id) => Boolean(servers.findServer(id)) }));
    await store.update((state) => {
      const target = state.schedules.find((item) => item.id === params.id);
      Object.assign(target, merged, { lastRunMinute: target.lastRunMinute });
      const server = state.servers.find((item) => item.id === target.serverId);
      audit(state, {
        actor: user.username,
        action: 'schedule.update',
        target: server?.name || target.serverId,
        detail: { name: target.name, cron: target.cron, enabled: target.enabled },
      }, config.auditLimit);
    });
    sendJson(res, 200, { schedule: schedules.decorate(existing) });
  }, { role: 'operator', body: 'json' });

  route('DELETE', '/api/schedules/:id', async ({ res, params, user }) => {
    const existing = store.state.schedules.find((item) => item.id === params.id);
    if (!existing) throw httpError(404, 'Görev bulunamadı.');
    await store.update((state) => {
      state.schedules = state.schedules.filter((item) => item.id !== params.id);
      audit(state, { actor: user.username, action: 'schedule.delete', detail: { name: existing.name } }, config.auditLimit);
    });
    sendJson(res, 200, { ok: true });
  }, { role: 'operator' });

  route('POST', '/api/schedules/:id/run', async ({ res, params, user }) => {
    const result = await schedules.runNow(params.id, { actor: user.username });
    sendJson(res, 200, { run: result });
  }, { role: 'operator' });

  // --- Egg'ler ve tahsisler ------------------------------------------------

  route('GET', '/api/eggs', async ({ res }) => {
    sendJson(res, 200, {
      nests: NESTS,
      eggs: allEggs(store.state.eggs).map((egg) => ({
        id: egg.id,
        nest: egg.nest,
        name: egg.name,
        description: egg.description,
        author: egg.author || 'Lumo',
        builtin: Boolean(egg.builtin),
        docker: egg.docker,
        startup: egg.startup,
        install: egg.install,
        restartPolicy: egg.restartPolicy,
        stopTimeoutSeconds: egg.stopTimeoutSeconds,
        features: egg.features,
        allocations: egg.allocations || [],
        variables: (egg.variables || []).map((item) => ({
          key: item.key,
          name: item.name,
          description: item.description,
          default: item.secret ? '' : item.default,
          required: item.required,
          secret: item.secret,
        })),
      })),
    });
  });

  route('POST', '/api/eggs', async ({ res, body, user }) => {
    const egg = checked(() => validateEggShape(body));
    await store.update((state) => {
      state.eggs.push(egg);
      audit(state, { actor: user.username, action: 'egg.create', target: egg.name, detail: { id: egg.id } }, config.auditLimit);
    });
    sendJson(res, 201, { egg: { id: egg.id, name: egg.name, nest: egg.nest } });
  }, { role: 'admin', body: 'json' });

  route('DELETE', '/api/eggs/:id', async ({ res, params, user }) => {
    const inUse = store.state.servers.filter((item) => item.egg === params.id);
    if (inUse.length) throw httpError(409, `Bu egg ${inUse.length} sunucu tarafından kullanılıyor.`);
    await store.update((state) => {
      const before = state.eggs.length;
      state.eggs = state.eggs.filter((item) => item.id !== params.id);
      if (state.eggs.length === before) throw httpError(404, 'Özel egg bulunamadı (yerleşik egg silinemez).');
      audit(state, { actor: user.username, action: 'egg.delete', target: params.id }, config.auditLimit);
    });
    sendJson(res, 200, { ok: true });
  }, { role: 'admin' });

  route('GET', '/api/allocations', async ({ res }) => {
    sendJson(res, 200, {
      range: config.portRange,
      bind: config.portBind,
      usage: poolUsage(store.state, config.portRange),
      free: freePorts(store.state, config.portRange, 20),
      assigned: store.state.allocations,
    });
  });

  // --- Kullanıcılar, sistem, denetim --------------------------------------

  route('GET', '/api/users', async ({ res }) => {
    sendJson(res, 200, { users: store.state.users.map(publicUser) });
  }, { role: 'admin' });

  route('POST', '/api/users', async ({ res, body, user }) => {
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const role = String(body.role ?? 'viewer');
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw httpError(400, 'Kullanıcı adı 3-32 karakter olmalı.');
    if (store.state.users.some((item) => item.username.toLowerCase() === username.toLowerCase())) {
      throw httpError(409, 'Bu kullanıcı adı alınmış.');
    }
    if (!ROLE_RANK[role]) throw httpError(400, 'Geçersiz rol (viewer, operator, admin).');
    if (password.length < 10) throw httpError(400, 'Parola en az 10 karakter olmalı.');
    const { salt, hash } = hashPassword(password);
    const created = {
      id: randomId('usr-'),
      username,
      role,
      salt,
      hash,
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      passwordChangedAt: new Date().toISOString(),
    };
    await store.update((state) => {
      state.users.push(created);
      audit(state, { actor: user.username, action: 'user.create', target: username, detail: { role } }, config.auditLimit);
    });
    sendJson(res, 201, { user: publicUser(created) });
  }, { role: 'admin', body: 'json' });

  route('PATCH', '/api/users/:id', async ({ res, params, body, user }) => {
    const target = userById(params.id);
    const changes = {};
    if (body.role !== undefined) {
      if (!ROLE_RANK[body.role]) throw httpError(400, 'Geçersiz rol.');
      if (target.role === 'admin' && body.role !== 'admin' && activeAdminCount() <= 1) {
        throw httpError(409, 'Son yönetici düşürülemez.');
      }
      changes.role = body.role;
    }
    if (body.password !== undefined) {
      const password = String(body.password);
      if (password.length < 10) throw httpError(400, 'Parola en az 10 karakter olmalı.');
      const { salt, hash } = hashPassword(password);
      changes.salt = salt;
      changes.hash = hash;
      changes.passwordChangedAt = new Date().toISOString();
      changes.sessionVersion = target.sessionVersion + 1;
    }
    await store.update((state) => {
      const item = state.users.find((entry) => entry.id === target.id);
      Object.assign(item, changes);
      audit(state, {
        actor: user.username,
        action: 'user.update',
        target: target.username,
        detail: { fields: Object.keys(changes).filter((key) => key !== 'salt' && key !== 'hash') },
      }, config.auditLimit);
    });
    sendJson(res, 200, { user: publicUser(target) });
  }, { role: 'admin', body: 'json' });

  route('DELETE', '/api/users/:id', async ({ res, params, user }) => {
    const target = userById(params.id);
    if (target.id === user.id) throw httpError(409, 'Kendi hesabını silemezsin.');
    if (target.role === 'admin' && activeAdminCount() <= 1) throw httpError(409, 'Son yönetici silinemez.');
    await store.update((state) => {
      state.users = state.users.filter((item) => item.id !== target.id);
      audit(state, { actor: user.username, action: 'user.delete', target: target.username }, config.auditLimit);
    });
    sendJson(res, 200, { ok: true });
  }, { role: 'admin' });

  route('GET', '/api/system', async ({ res }) => {
    const info = await systemInfo({ dataDir: config.dataDir, driver: config.driver, dockerVersion });
    sendJson(res, 200, {
      ...info,
      panel: { ...info.panel, version: PANEL_VERSION },
      counts: {
        servers: store.state.servers.length,
        running: store.state.servers.filter((item) => servers.status(item.id) === STATUS.RUNNING).length,
        users: store.state.users.length,
        backups: store.state.backups.length,
        schedules: store.state.schedules.length,
        eggs: allEggs(store.state.eggs).length,
      },
      allocations: poolUsage(store.state, config.portRange),
      backups: await backups.usage(),
    });
  });

  route('GET', '/api/audit', async ({ res, query }) => {
    const limit = clampNumber(query.get('limit'), 1, 500, 100);
    sendJson(res, 200, { entries: store.state.audit.slice(0, limit) });
  }, { role: 'operator' });

  // --- İstek işleyici ------------------------------------------------------

  const serveStatic = async (req, res, pathname) => {
    let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    if (rel.includes('..')) throw httpError(400, 'Geçersiz yol.');
    let target = path.resolve(PUBLIC_DIR, rel);
    if (!target.startsWith(PUBLIC_DIR + path.sep)) throw httpError(400, 'Geçersiz yol.');
    let data;
    try {
      data = await fs.readFile(target);
    } catch {
      // SPA: bilinmeyen yol → index.html
      target = path.join(PUBLIC_DIR, 'index.html');
      data = await fs.readFile(target).catch(() => null);
      if (!data) throw httpError(404, 'Bulunamadı.');
    }
    securityHeaders(res);
    sendBuffer(res, 200, data, MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
  };

  const handle = async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      pathname = url.pathname.replace(/\/+$/, '') || '/';
      const ip = clientIp(req, config.trustProxy);

      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Yöntem desteklenmiyor.');
        await serveStatic(req, res, url.pathname);
        return;
      }

      const matched = match(req.method, pathname);
      if (!matched) throw httpError(404, 'Bilinmeyen uç nokta.');

      // Siteler arası sahte istek: tarayıcı gönderdiği Origin uyuşmuyorsa reddet.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
          let originHost;
          try {
            originHost = new URL(origin).host;
          } catch {
            throw httpError(403, 'Geçersiz Origin başlığı.');
          }
          if (originHost !== req.headers.host) throw httpError(403, 'Origin uyuşmuyor.');
        }
      }

      const user = matched.auth ? currentUser(req) : null;
      if (matched.auth && !user) throw httpError(401, 'Oturum gerekli.');
      if (user && ROLE_RANK[user.role] < ROLE_RANK[matched.role]) {
        throw httpError(403, `Bu işlem için ${matched.role} yetkisi gerekli.`);
      }

      let body = null;
      if (matched.body === 'json') {
        body = await readJson(req, { limit: matched.bodyLimit ?? JSON_LIMIT });
      } else if (matched.body === 'raw') {
        body = await readBody(req, { limit: matched.bodyLimit ?? JSON_LIMIT });
      }

      securityHeaders(res, { hsts: config.trustProxy });
      await matched.handler({
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        body,
        user,
        ip,
        config,
      });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) logger.error?.(`[lumo] ${req.method} ${pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        securityHeaders(res);
        sendError(res, status, err.message || 'Beklenmeyen hata.');
      } else {
        res.end();
      }
    } finally {
      if (config.accessLog) logger.log?.(`${req.method} ${pathname} ${Date.now() - started}ms`);
    }
  };

  const close = async () => {
    schedules.stop();
    await servers.shutdown();
    await store.save();
  };

  return { handle, config, store, servers, backups, schedules, close, logger, dockerVersion };
}

export async function main() {
  const logger = console;
  const app = await createApp({ logger });
  const server = http.createServer((req, res) => {
    app.handle(req, res);
  });

  await new Promise((resolve) => server.listen(app.config.port, app.config.host, resolve));
  logger.log(`[lumo] panel hazır → http://${app.config.host}:${app.config.port}`);
  logger.log(`[lumo] sürücü: ${app.config.driver}${app.dockerVersion ? ` (docker ${app.dockerVersion})` : ''}`);
  logger.log(
    `[lumo] veri: ${app.config.dataDir} · sunucular: ${app.config.serversDir} · port havuzu: ` +
      `${app.config.portRange.min}-${app.config.portRange.max}`,
  );
  if (app.config.driver === 'local') {
    logger.warn('[lumo] PANEL_BOT_DRIVER=local: botlar panel kullanıcısıyla aynı yetkide çalışır. Üretimde docker kullanın.');
  }

  app.schedules.start();
  const autoStarted = await app.servers.bootAutoStart(logger);
  if (autoStarted) logger.log(`[lumo] ${autoStarted} sunucu açılışta başlatıldı.`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.log(`[lumo] ${signal} alındı, sunucular durduruluyor...`);
    server.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, app };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[lumo] başlatılamadı: ${err.message}`);
    process.exit(1);
  });
}
