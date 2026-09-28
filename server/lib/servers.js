// Süpervizör: sunucu (bot) süreçlerinin tüm yaşam döngüsü.
//
// Pterodactyl'in power durumları burada da geçerli:
//   offline → starting → running → stopping → offline
//                ↘ crashed (çökme koruması)      ↘ suspended (limit/askı)
//
// Port edilen davranışlar:
//   • startup detection: egg'in deseni başlangıç penceresinde görülmezse süreç
//     öldürülür ve çökme sayılır (Pterodactyl'in startup timeout'u).
//   • artan bekleme ile yeniden başlatma (1s → 30s) + çökme koruması.
//   • kaynak limitleri (bellek/cpu/pid/diskte) sunucu bazında zorlanır.
//   • panel yeniden başlarsa "açılışta başlat" işaretli sunucular geri gelir.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as docker from './docker.js';
import { FileJail } from './files.js';
import { findEgg, renderTemplate } from './eggs.js';
import { audit } from './store.js';

export const STATUS = {
  OFFLINE: 'offline',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  INSTALLING: 'installing',
  CRASHED: 'crashed',
  SUSPENDED: 'suspended',
};

export const POWER_STATES = Object.values(STATUS);

const LOG_BUFFER_LINES = 1500;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const HEALTHY_UPTIME_MS = 5 * 60_000;
const STATS_INTERVAL_MS = 5000;
const DISK_INTERVAL_MS = 60_000;

/** Host ortamından bota aktarılacak zararsız değişkenler. Bilinçli olarak kısa:
 *  process.env'i olduğu gibi geçirmek PANEL_MASTER_KEY'i bot koduna sızdırırdı. */
const HOST_ENV_ALLOWLIST = ['LANG', 'LC_ALL', 'TZ'];

export function cleanLogLine(line) {
  return String(line).replace(/\u0000/g, '').replace(/\r$/, '');
}

export class Servers extends EventEmitter {
  #store;
  #config;
  #records = new Map();
  #jails = new Map();
  #shuttingDown = false;

  constructor({ store, config }) {
    super();
    this.#store = store;
    this.#config = config;
    this.config = config;
  }

  get config() {
    return this.#config;
  }

  set config(value) {
    this.#config = value;
  }

  get driver() {
    return this.#config.driver;
  }

  set driver(value) {
    this.#config.driver = value;
  }

  serverDir(serverId) {
    return path.join(this.#config.serversDir, serverId);
  }

  jail(serverId) {
    let jail = this.#jails.get(serverId);
    if (!jail) {
      jail = new FileJail(this.serverDir(serverId));
      this.#jails.set(serverId, jail);
    }
    return jail;
  }

  eggFor(server) {
    const egg = findEgg(server.egg, this.#store.state.eggs);
    if (!egg) throw Object.assign(new Error(`Bilinmeyen egg: ${server.egg}`), { status: 400 });
    return egg;
  }

  findServer(serverId) {
    return this.#store.state.servers.find((item) => item.id === serverId) || null;
  }

  #record(serverId) {
    let record = this.#records.get(serverId);
    if (!record) {
      record = {
        id: serverId,
        status: STATUS.OFFLINE,
        child: null,
        startedAt: null,
        restarts: 0,
        crashTimes: [],
        exitCode: null,
        lastError: null,
        stopping: false,
        logs: [],
        seq: 0,
        startupTimer: null,
        stopTimer: null,
        restartTimer: null,
        statsTimer: null,
        diskTimer: null,
        stats: { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, diskBytes: null, diskLimitBytes: null },
        lastLogAt: null,
      };
      this.#records.set(serverId, record);
    }
    return record;
  }

  runtime(serverId) {
    return this.#record(serverId);
  }

  /** Görünür durum: kayıt yoksa sunucunun kalıcı alanlarına bakılır. */
  status(serverId) {
    const server = this.findServer(serverId);
    const record = this.#records.get(serverId);
    if (record && record.status !== STATUS.OFFLINE) return record.status;
    if (server?.suspended) return STATUS.SUSPENDED;
    return record?.status ?? STATUS.OFFLINE;
  }

  pushLog(serverId, line, stream = 'out', { silent = false } = {}) {
    const record = this.#record(serverId);
    record.seq += 1;
    record.lastLogAt = new Date().toISOString();
    const entry = { seq: record.seq, at: record.lastLogAt, stream, line: cleanLogLine(line) };
    record.logs.push(entry);
    if (record.logs.length > LOG_BUFFER_LINES) record.logs.splice(0, record.logs.length - LOG_BUFFER_LINES);
    if (!silent) this.emit('log', { serverId, entry });
    return entry;
  }

  logs(serverId, since = 0) {
    const record = this.#record(serverId);
    return { seq: record.seq, entries: record.logs.filter((item) => item.seq > Number(since || 0)) };
  }

  subscribe(serverId, listener) {
    const handler = (payload) => {
      if (payload.serverId === serverId) listener(payload.entry);
    };
    this.on('log', handler);
    return () => this.off('log', handler);
  }

  #setStatus(serverId, status) {
    const record = this.#record(serverId);
    if (record.status === status) return;
    record.status = status;
    this.emit('state', { serverId, status });
  }

  /** Egg değişkenleri + tahsis edilen porttan ortamı kurar. */
  buildEnv(server, egg) {
    const env = {};
    if (this.driver === 'docker') {
      env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      env.HOME = docker.CONTAINER_WORKDIR;
      env.PWD = docker.CONTAINER_WORKDIR;
      env.TMPDIR = '/tmp';
      env.NPM_CONFIG_CACHE = '/tmp/.npm';
    } else {
      env.PATH = process.env.PATH || '';
      env.HOME = this.serverDir(server.id);
      env.TMPDIR = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
    }
    for (const key of HOST_ENV_ALLOWLIST) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (!env.LANG) env.LANG = 'C.UTF-8';
    for (const [key, value] of Object.entries(server.variables || {})) {
      env[key] = String(value ?? '');
    }
    for (const [key, value] of Object.entries(server.environment || {})) {
      env[key] = String(value ?? '');
    }
    if (server.allocation?.port) {
      env[server.allocation.name || 'PORT'] = String(server.allocation.port);
    }
    return env;
  }

  buildCommand(server, egg) {
    const values = { ...(server.variables || {}) };
    if (server.allocation?.port) values[server.allocation.name || 'PORT'] = String(server.allocation.port);
    const startup = renderTemplate(server.startupOverride || egg.startup, values);
    return startup.trim();
  }

  #shellForLocal() {
    if (process.platform === 'win32') {
      return { cmd: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c'] };
    }
    return { cmd: '/bin/sh', args: ['-c'] };
  }

  #spawnServerProcess({ server, egg, dir, env, command }) {
    if (this.driver === 'docker') {
      const args = docker.containerArgs({ server, egg, dir, env, command });
      const child = spawn('docker', args, { windowsHide: true, env: process.env });
      return { child, describe: `docker run --name ${docker.containerName(server.id)}` };
    }
    const shell = this.#shellForLocal();
    const child = spawn(shell.cmd, [...shell.args, command], {
      cwd: dir,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { child, describe: `${shell.cmd} -c "${command}"` };
  }

  /** Süreci (ve varsa alt süreç ağacını) öldürür. */
  #killTree(record, signal = 'SIGTERM') {
    if (this.driver === 'docker') return;
    const child = record.child;
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* süreç zaten ölmüş olabilir */
      }
    }
  }

  #clearTimers(record) {
    for (const key of ['startupTimer', 'stopTimer', 'restartTimer', 'statsTimer', 'diskTimer']) {
      if (record[key]) {
        clearTimeout(record[key]);
        clearInterval(record[key]);
        record[key] = null;
      }
    }
  }

  /** Sunucunun kaynak limitleri ve disk kullanımıyla ilgili ön kontroller. */
  async #preflight(server) {
    const jail = this.jail(server.id);
    await jail.ensureRoot();
    const egg = this.eggFor(server);
    const usage = await jail.usage();
    const limitBytes = (server.limits.diskMb || 0) * 1024 * 1024;
    const record = this.#record(server.id);
    record.stats.diskBytes = usage.bytes;
    record.stats.diskLimitBytes = limitBytes;
    if (limitBytes && usage.bytes > limitBytes) {
      const mb = (usage.bytes / 1024 / 1024).toFixed(1);
      const error = `Disk limiti aşıldı (${mb} MB / ${server.limits.diskMb} MB). Sunucu askıya alındı.`;
      await this.suspend(server.id, { reason: error, actor: 'sistem' });
      throw Object.assign(new Error(error), { status: 409 });
    }
    return egg;
  }

  async install(serverId, { actor = 'sistem' } = {}) {
    const server = this.findServer(serverId);
    if (!server) throw Object.assign(new Error('Sunucu bulunamadı.'), { status: 404 });
    const egg = this.eggFor(server);
    if (!egg.install) throw Object.assign(new Error('Bu egg kurulum adımı tanımlamıyor.'), { status: 400 });
    if (this.status(serverId) !== STATUS.OFFLINE) {
      throw Object.assign(new Error('Kurulum yalnızca sunucu kapalıyken çalışır.'), { status: 409 });
    }
    const record = this.#record(serverId);
    const dir = this.serverDir(serverId);
    await fs.mkdir(dir, { recursive: true });
    this.#setStatus(serverId, STATUS.INSTALLING);
    this.pushLog(serverId, `[lumo] kurulum başlıyor: ${egg.install}`);
    const env = this.buildEnv(server, egg);
    let result;
    if (this.driver === 'docker') {
      result = await docker.runInstall({
        server,
        egg,
        dir,
        env,
        command: egg.install,
        onLog: (line) => this.pushLog(serverId, line, 'install'),
      });
    } else {
      result = await this.#installLocally({ server, egg, dir, env, serverId });
    }
    this.pushLog(serverId, `[lumo] kurulum bitti (çıkış kodu ${result.code})`);
    this.#setStatus(serverId, STATUS.OFFLINE);
    await this.#store.update((state) => {
      const target = state.servers.find((item) => item.id === serverId);
      if (target) target.installedAt = new Date().toISOString();
      audit(state, {
        actor,
        action: 'server.install',
        target: server.name,
        detail: { exitCode: result.code },
      });
    });
    return { code: result.code, skipped: Boolean(result.skipped) };
  }

  #installLocally({ server, egg, dir, env, serverId }) {
    return new Promise((resolve) => {
      const shell = this.#shellForLocal();
      const child = spawn(shell.cmd, [...shell.args, egg.install], { cwd: dir, env, windowsHide: true });
      child.stdout.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line) this.pushLog(serverId, line, 'install');
      });
      child.stderr.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line) this.pushLog(serverId, line, 'install');
      });
      child.on('error', (err) => resolve({ code: 1, error: err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1 }));
    });
  }

  async start(serverId, { actor = 'sistem' } = {}) {
    const server = this.findServer(serverId);
    if (!server) throw Object.assign(new Error('Sunucu bulunamadı.'), { status: 404 });
    if (server.suspended) {
      throw Object.assign(new Error(`Sunucu askıda: ${server.suspendReason || 'yönetici tarafından askıya alındı'}`), {
        status: 409,
      });
    }
    const record = this.#record(serverId);
    // Gerçek ölçüt süreç varlığıdır: yeniden başlatma beklemesi sırasında durum
    // 'starting' görünür ama ortada süreç yoktur, o yüzden engellenmemeli.
    if (record.child) {
      throw Object.assign(new Error(`Sunucu zaten ${this.status(serverId)} durumunda.`), { status: 409 });
    }
    if (this.status(serverId) === STATUS.INSTALLING) {
      throw Object.assign(new Error('Kurulum sürerken sunucu başlatılamaz.'), { status: 409 });
    }

    const egg = await this.#preflight(server);
    record.exitCode = null;
    record.lastError = null;
    record.crashTimes = record.crashTimes.filter((time) => Date.now() - time < this.#config.crashWindowMs);
    const dir = this.serverDir(serverId);
    await fs.mkdir(dir, { recursive: true });

    const env = this.buildEnv(server, egg);
    const command = this.buildCommand(server, egg);
    this.#setStatus(serverId, STATUS.STARTING);
    this.pushLog(serverId, `[lumo] başlatılıyor → ${command}`);

    try {
      if (this.driver === 'docker') await docker.ensureNetwork(serverId);
      const { child, describe } = this.#spawnServerProcess({ server, egg, dir, env, command });
      record.child = child;
      record.startedAt = new Date();
      record.stopping = false;
      record.detected = false;

      const onChunk = (stream) => (chunk) => {
        const text = chunk.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line.length) continue;
          this.pushLog(serverId, line, stream);
          if (!record.detected && egg.startupDetection) {
            try {
              // Desenler her zaman büyük/küçük harf duyarsız derlenir; egg'ler
              // Node 20'de desteklenmeyen `(?i)` yazmak zorunda kalmasın.
              if (new RegExp(egg.startupDetection, 'i').test(line)) this.#markStarted(serverId, record);
            } catch {
              /* desen eggs.js'de doğrulanır */
            }
          }
        }
      };
      child.stdout?.on('data', onChunk('out'));
      child.stderr?.on('data', onChunk('err'));
      child.on('error', (err) => {
        this.pushLog(serverId, `[lumo] süreç hatası: ${err.message}`, 'err');
        record.lastError = err.message;
      });
      child.on('close', (code, signal) => {
        this.#handleExit(serverId, { code, signal }).catch(() => {});
      });

      this.#startMonitors(server, record);
      if (egg.startupDetection && egg.startupTimeoutMs > 0) {
        const timeoutMs = Math.min(egg.startupTimeoutMs, this.#config.startupTimeoutMs);
        record.startupTimer = setTimeout(() => {
          if (record.detected || record.status !== STATUS.STARTING) return;
          this.pushLog(
            serverId,
            `[lumo] başlangıç tespiti ${Math.round(timeoutMs / 1000)} saniyede tamamlanmadı; süreç öldürülüyor.`,
            'err',
          );
          record.lastError = 'Başlangıç tespiti zaman aşımı';
          record.startupFailed = true;
          record.stopping = false;
          this.#killTree(record, 'SIGKILL');
          if (this.driver === 'docker') docker.killContainer(serverId).catch(() => {});
        }, timeoutMs);
      }
      return { status: this.status(serverId), command, describe };
    } catch (err) {
      record.child = null;
      record.startedAt = null;
      this.#setStatus(serverId, STATUS.CRASHED);
      record.lastError = err.message;
      this.pushLog(serverId, `[lumo] başlatılamadı: ${err.message}`, 'err');
      throw Object.assign(new Error(`Sunucu başlatılamadı: ${err.message}`), { status: 500 });
    }
  }

  #markStarted(serverId, record) {
    record.detected = true;
    if (record.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
    this.#setStatus(serverId, STATUS.RUNNING);
    this.pushLog(serverId, '[lumo] başlangıç tespit edildi → running');
  }

  async stop(serverId, { force = false, actor = 'sistem' } = {}) {
    const server = this.findServer(serverId);
    if (!server) throw Object.assign(new Error('Sunucu bulunamadı.'), { status: 404 });
    const record = this.#record(serverId);
    // Bekleyen otomatik yeniden başlatma iptal edilir: "Durdur" dedikten sonra
    // botun geri gelmesi kabul edilemez.
    if (record.restartTimer) {
      clearTimeout(record.restartTimer);
      record.restartTimer = null;
    }
    if (!record.child || this.status(serverId) === STATUS.OFFLINE) {
      this.#setStatus(serverId, server.suspended ? STATUS.SUSPENDED : STATUS.OFFLINE);
      return { status: this.status(serverId), alreadyStopped: true };
    }
    record.stopping = true;
    this.#setStatus(serverId, STATUS.STOPPING);
    const egg = this.eggFor(server);
    const timeoutMs = force ? 1000 : Math.min(egg.stopTimeoutSeconds * 1000, 120_000);
    this.pushLog(serverId, force ? '[lumo] zorla durduruluyor (SIGKILL)' : '[lumo] durduruluyor (SIGTERM)');

    if (this.driver === 'docker') {
      if (force) {
        await docker.killContainer(serverId);
      } else {
        const result = await docker.stopContainer(serverId, egg.stopTimeoutSeconds);
        if (result.code !== 0) await docker.killContainer(serverId);
      }
    } else {
      this.#killTree(record, force ? 'SIGKILL' : egg.stopSignal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
      if (!force) {
        record.stopTimer = setTimeout(() => {
          if (record.child && record.child.exitCode === null) {
            this.pushLog(serverId, '[lumo] süreç zamanında kapanmadı; SIGKILL gönderiliyor.', 'err');
            this.#killTree(record, 'SIGKILL');
          }
        }, timeoutMs);
      }
    }
    if (actor !== 'sistem') {
      await this.#store.update((state) => {
        audit(state, { actor, action: 'server.stop', target: server.name, detail: { force } });
      });
    }
    return { status: this.status(serverId) };
  }

  async restart(serverId, { actor = 'sistem' } = {}) {
    const server = this.findServer(serverId);
    if (!server) throw Object.assign(new Error('Sunucu bulunamadı.'), { status: 404 });
    const record = this.#record(serverId);
    const wasRunning = Boolean(record.child) && this.status(serverId) !== STATUS.OFFLINE;
    if (wasRunning) {
      record.restarting = true;
      await this.stop(serverId, { actor });
      await this.#waitForExit(serverId, 15_000);
    }
    record.restarting = false;
    return this.start(serverId, { actor });
  }

  async kill(serverId, { actor = 'sistem' } = {}) {
    return this.stop(serverId, { force: true, actor });
  }

  #waitForExit(serverId, timeoutMs) {
    const record = this.#record(serverId);
    if (!record.child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        record.child?.removeListener?.('close', onClose);
        resolve();
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        resolve();
      };
      record.child.once('close', onClose);
    });
  }

  input(serverId, line) {
    const record = this.#record(serverId);
    const server = this.findServer(serverId);
    if (!server) throw Object.assign(new Error('Sunucu bulunamadı.'), { status: 404 });
    if (!record.child || ![STATUS.RUNNING, STATUS.STARTING].includes(this.status(serverId))) {
      throw Object.assign(new Error('Sunucu çalışmıyor; konsola girdi gönderilemez.'), { status: 409 });
    }
    const text = `${String(line).replace(/[\r\n]+/g, ' ')}\n`;
    if (this.driver === 'docker') {
      // `docker run -i` stdin'i konteynere iletir, ancak bizim '-i' bayrağıyla
      // başlattığımız istemci sürecine yazmak yeterlidir.
      record.child.stdin?.write(text);
    } else {
      record.child.stdin?.write(text);
    }
    this.pushLog(serverId, `> ${line}`, 'in');
    return { ok: true };
  }

  async #handleExit(serverId, { code, signal }) {
    const record = this.#record(serverId);
    const server = this.findServer(serverId);
    this.#clearTimers(record);
    record.child = null;
    record.exitCode = typeof code === 'number' ? code : null;
    const uptimeMs = record.startedAt ? Date.now() - record.startedAt.getTime() : 0;
    record.uptimeMs = uptimeMs;
    record.startedAt = null;
    if (!server) {
      this.#setStatus(serverId, STATUS.OFFLINE);
      return;
    }

    if (record.stopping) {
      record.stopping = false;
      this.#setStatus(serverId, server.suspended ? STATUS.SUSPENDED : STATUS.OFFLINE);
      this.pushLog(serverId, `[lumo] durdu (çıkış kodu ${code ?? signal ?? 0})`);
      await this.#persistExit(server, record, { crashed: false });
      return;
    }

    const crashed = record.startupFailed === true || (typeof code === 'number' && code !== 0);
    const reason = record.startupFailed
      ? 'Başlangıç tespiti zaman aşımı'
      : `Beklenmedik çıkış (kod ${code ?? 'yok'}${signal ? `, sinyal ${signal}` : ''})`;
    record.startupFailed = false;
    this.pushLog(serverId, `[lumo] ${reason}`, crashed ? 'err' : 'out');

    // Sağlıklı çalışmışsa çökme geçmişini sıfırla: ara sıra çöken bot kalıcı düşmesin.
    if (uptimeMs > HEALTHY_UPTIME_MS) record.crashTimes = [];
    if (crashed) {
      record.crashTimes.push(Date.now());
      record.lastError = reason;
    }
    record.crashTimes = record.crashTimes.filter((time) => Date.now() - time < this.#config.crashWindowMs);

    const policy = server.restartPolicy || 'always';
    const wantsRestart = policy === 'always' || (policy === 'on-failure' && crashed);
    const mayRestart = !server.suspended && !this.#shuttingDown;

    if (!wantsRestart || !mayRestart) {
      this.#setStatus(serverId, crashed && policy !== 'never' ? STATUS.CRASHED : STATUS.OFFLINE);
      await this.#persistExit(server, record, { crashed });
      return;
    }

    if (record.crashTimes.length >= this.#config.crashLimit) {
      const message =
        `${record.crashTimes.length} çökme / ${Math.round(this.#config.crashWindowMs / 60000)} dakika: ` +
        'çökme koruması devreye girdi, otomatik yeniden başlatma durduruldu.';
      record.lastError = message;
      this.#setStatus(serverId, STATUS.CRASHED);
      this.pushLog(serverId, `[lumo] ${message}`, 'err');
      await this.#store.update((state) => {
        const target = state.servers.find((item) => item.id === serverId);
        if (target) {
          target.lastExit = { at: new Date().toISOString(), code: record.exitCode, error: reason, crashLoop: true };
          target.restartCount = record.restarts;
        }
        audit(state, {
          actor: 'sistem',
          action: 'server.crashloop',
          target: server.name,
          detail: { crashes: record.crashTimes.length, error: reason },
        });
      });
      return;
    }

    const delay = BACKOFF_MS[Math.min(record.restarts, BACKOFF_MS.length - 1)];
    record.restarts += 1;
    this.#setStatus(serverId, STATUS.STARTING);
    this.pushLog(serverId, `[lumo] ${Math.round(delay / 1000)} sn sonra otomatik yeniden başlatma (deneme ${record.restarts})`);
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null;
      if (this.#shuttingDown) return;
      this.start(serverId, { actor: 'sistem' }).catch((err) => {
        this.pushLog(serverId, `[lumo] yeniden başlatma başarısız: ${err.message}`, 'err');
      });
    }, delay);
    await this.#persistExit(server, record, { crashed });
  }

  async #persistExit(server, record, { crashed }) {
    await this.#store
      .update((state) => {
        const target = state.servers.find((item) => item.id === server.id);
        if (!target) return;
        target.lastExit = {
          at: new Date().toISOString(),
          code: record.exitCode,
          error: record.lastError || null,
          crash: crashed,
          uptimeMs: record.uptimeMs ?? null,
        };
        target.restartCount = record.restarts;
        if (crashed) target.lastCrashAt = target.lastExit.at;
      })
      .catch(() => {});
  }

  #startMonitors(server, record) {
    if (record.statsTimer) clearInterval(record.statsTimer);
    if (record.diskTimer) clearInterval(record.diskTimer);

    record.statsTimer = setInterval(() => {
      this.#sampleStats(server, record).catch(() => {});
    }, STATS_INTERVAL_MS);
    record.statsTimer.unref?.();

    record.diskTimer = setInterval(() => {
      this.#checkDiskLimit(server, record).catch(() => {});
    }, DISK_INTERVAL_MS);
    record.diskTimer.unref?.();
  }

  async #sampleStats(server, record) {
    if (!record.child) return;
    if (this.driver === 'docker') {
      const stats = await docker.containerStats(server.id);
      if (stats) {
        record.stats.cpuPercent = stats.cpuPercent;
        record.stats.memoryBytes = stats.memoryBytes;
        record.stats.memoryLimitBytes = stats.memoryLimitBytes;
      }
      return;
    }
    if (process.platform !== 'linux' || !record.child.pid) {
      record.stats.cpuPercent = null;
      record.stats.memoryBytes = null;
      return;
    }
    try {
      const statm = await fs.readFile(`/proc/${record.child.pid}/statm`, 'utf8');
      const rssPages = Number.parseInt(statm.split(/\s+/)[1], 10);
      record.stats.memoryBytes = Number.isFinite(rssPages) ? rssPages * 4096 : null;
      const stat = await fs.readFile(`/proc/${record.child.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      const ticks = Number.parseInt(fields[11], 10) + Number.parseInt(fields[12], 10);
      const now = Date.now();
      if (record.lastCpuSample) {
        const elapsed = (now - record.lastCpuSample.at) / 1000;
        const deltaTicks = ticks - record.lastCpuSample.ticks;
        const hz = 100;
        record.stats.cpuPercent = elapsed > 0 ? Math.max(0, (deltaTicks / hz / elapsed) * 100) : null;
      }
      record.lastCpuSample = { at: now, ticks };
      record.stats.memoryLimitBytes = (server.limits.memoryMb || 512) * 1024 * 1024;
    } catch {
      /* süreç kapanmış olabilir */
    }
  }

  async #checkDiskLimit(server, record) {
    if (!record.child) return;
    const limitBytes = (server.limits.diskMb || 0) * 1024 * 1024;
    if (!limitBytes) return;
    const usage = await this.jail(server.id).usage();
    record.stats.diskBytes = usage.bytes;
    record.stats.diskLimitBytes = limitBytes;
    if (usage.bytes > limitBytes) {
      const message = `Disk limiti aşıldı (${(usage.bytes / 1024 / 1024).toFixed(1)} MB / ${server.limits.diskMb} MB).`;
      this.pushLog(server.id, `[lumo] ${message} Sunucu askıya alınıyor.`, 'err');
      record.lastError = message;
      record.stopping = true;
      await this.suspend(server.id, { reason: message, actor: 'sistem' });
    }
  }

  /** Askıya alma: süreç durdurulur ve başlatma engellenir. */
  async suspend(serverId, { reason = 'yönetici kararı', actor = 'sistem' } = {}) {
    const record = this.#record(serverId);
    this.#clearTimers(record);
    if (record.child) {
      record.stopping = true;
      await this.stop(serverId, { force: true, actor }).catch(() => {});
    }
    const server = this.findServer(serverId);
    await this.#store.update((state) => {
      const target = state.servers.find((item) => item.id === serverId);
      if (target) {
        target.suspended = true;
        target.suspendReason = reason;
        target.suspendedAt = new Date().toISOString();
      }
      audit(state, { actor, action: 'server.suspend', target: server?.name || serverId, detail: { reason } });
    });
    this.#setStatus(serverId, STATUS.SUSPENDED);
    return { status: STATUS.SUSPENDED, reason };
  }

  async resume(serverId, { actor = 'sistem' } = {}) {
    const server = this.findServer(serverId);
    await this.#store.update((state) => {
      const target = state.servers.find((item) => item.id === serverId);
      if (target) {
        target.suspended = false;
        target.suspendReason = null;
        target.suspendedAt = null;
      }
      audit(state, { actor, action: 'server.resume', target: server?.name || serverId });
    });
    this.#setStatus(serverId, STATUS.OFFLINE);
    return { status: STATUS.OFFLINE };
  }

  /** Panel açılışı: "açılışta başlat" işaretli sunucuları sırayla ayağa kaldır. */
  async bootAutoStart(logger = console) {
    const servers = this.#store.state.servers.filter((item) => item.autoStart && !item.suspended);
    for (const server of servers) {
      try {
        await this.start(server.id, { actor: 'sistem' });
        logger.log?.(`[lumo] açılışta başlatıldı: ${server.name}`);
      } catch (err) {
        logger.warn?.(`[lumo] ${server.name} başlatılamadı: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return servers.length;
  }

  /** Sunucu silinirken kaynakları temizle. */
  async destroy(serverId) {
    const record = this.#record(serverId);
    this.#clearTimers(record);
    if (record.child) {
      record.stopping = true;
      record.restartTimer = null;
      if (this.driver === 'docker') {
        await docker.removeContainer(serverId).catch(() => {});
        await docker.removeNetwork(serverId).catch(() => {});
      } else {
        this.#killTree(record, 'SIGKILL');
        await this.#waitForExit(serverId, 5000);
      }
    }
    this.#records.delete(serverId);
    this.#jails.delete(serverId);
  }

  async shutdown() {
    this.#shuttingDown = true;
    const running = [...this.#records.values()].filter((record) => record.child);
    await Promise.all(
      running.map(async (record) => {
        this.#clearTimers(record);
        record.stopping = true;
        record.restartTimer = null;
        if (this.driver === 'docker') {
          await docker.stopContainer(record.id, 10).catch(() => {});
        } else {
          this.#killTree(record, 'SIGTERM');
        }
      }),
    );
    return running.length;
  }

  /** API'ye dönen özet. Sır değerleri asla maskeleme olmadan çıkmaz. */
  summary(server) {
    const record = this.#record(server.id);
    const running = Boolean(record.child) && this.status(server.id) !== STATUS.OFFLINE;
    return {
      id: server.id,
      name: server.name,
      egg: server.egg,
      status: this.status(server.id),
      suspended: Boolean(server.suspended),
      suspendReason: server.suspendReason || null,
      limits: server.limits,
      allocation: server.allocation || null,
      autoStart: Boolean(server.autoStart),
      restartPolicy: server.restartPolicy || 'always',
      startupOverride: server.startupOverride || null,
      createdAt: server.createdAt,
      installedAt: server.installedAt || null,
      environment: server.environment || null,
      lastExit: server.lastExit || null,
      restartCount: record.restarts ?? server.restartCount ?? 0,
      crashCount: record.crashTimes.length,
      uptimeMs: running && record.startedAt ? Date.now() - record.startedAt.getTime() : null,
      stats: {
        ...record.stats,
        memoryLimitBytes: record.stats.memoryLimitBytes ?? (server.limits.memoryMb || 0) * 1024 * 1024,
        diskLimitBytes: record.stats.diskLimitBytes ?? (server.limits.diskMb || 0) * 1024 * 1024,
      },
      lastError: record.lastError,
      exitCode: record.exitCode,
    };
  }
}
