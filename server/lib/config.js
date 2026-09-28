// Yapılandırma: .env dosyası + ortam değişkenleri.
//
// Node 20'nin `--env-file` bayrağına bağlı kalmamak için .env'i kendimiz okuyoruz.
// Kural: gerçek ortam değişkenleri .env'i her zaman ezer (systemd/Docker kazanır).

import fs from 'node:fs/promises';
import path from 'node:path';

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function loadDotEnv(file = path.join(process.cwd(), '.env'), env = process.env) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return {};
  }
  const parsed = parseEnvFile(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return parsed;
}

function int(value, fallback) {
  const num = Number.parseInt(value ?? '', 10);
  return Number.isFinite(num) ? num : fallback;
}

function num(value, fallback) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function parsePortRange(text, fallback = [30000, 30099]) {
  const match = /^(\d{2,5})\s*-\s*(\d{2,5})$/.exec(String(text ?? '').trim());
  if (!match) return { min: fallback[0], max: fallback[1] };
  const min = Math.max(1024, Math.min(Number(match[1]), 65535));
  const max = Math.max(min, Math.min(Number(match[2]), 65535));
  return { min, max };
}

export async function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const dataDir = path.resolve(cwd, env.PANEL_DATA_DIR || './data');
  const serversDir = path.resolve(cwd, env.PANEL_SERVERS_DIR || path.join(dataDir, 'servers'));
  const driver = (env.PANEL_BOT_DRIVER || 'local').trim().toLowerCase();
  if (!['docker', 'local'].includes(driver)) {
    throw new Error(`PANEL_BOT_DRIVER "docker" ya da "local" olmalı (verilen: ${driver}).`);
  }
  return {
    cwd,
    port: int(env.PANEL_PORT, 8080),
    host: env.PANEL_HOST || '0.0.0.0',
    dataDir,
    serversDir,
    backupsDir: path.join(dataDir, 'backups'),
    stateFile: path.join(dataDir, 'panel.enc'),
    masterKey: env.PANEL_MASTER_KEY,
    driver,
    portRange: parsePortRange(env.PANEL_PORT_RANGE),
    portBind: env.PANEL_PORT_BIND || '127.0.0.1',
    defaults: {
      memoryMb: int(env.PANEL_DEFAULT_MEMORY_MB, 512),
      cpu: num(env.PANEL_DEFAULT_CPU, 1),
      diskMb: int(env.PANEL_DEFAULT_DISK_MB, 2048),
      pids: int(env.PANEL_DEFAULT_PIDS, 256),
    },
    startupTimeoutMs: int(env.PANEL_STARTUP_TIMEOUT_MS, 90_000),
    crashLimit: int(env.PANEL_CRASH_LIMIT, 5),
    crashWindowMs: int(env.PANEL_CRASH_WINDOW_MS, 600_000),
    trustProxy: bool(env.PANEL_TRUST_PROXY, false),
    insecureCookies: bool(env.PANEL_INSECURE_COOKIES, false),
    auditLimit: int(env.PANEL_AUDIT_LIMIT, 2000),
    accessLog: env.PANEL_ACCESS_LOG === '1',
    sessionTtlMs: int(env.PANEL_SESSION_TTL_MS, 12 * 3600_000),
    login: {
      windowMs: int(env.PANEL_LOGIN_WINDOW_MS, 600_000),
      maxAttempts: int(env.PANEL_LOGIN_MAX_ATTEMPTS, 10),
    },
  };
}
