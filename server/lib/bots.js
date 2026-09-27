import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomId } from './crypto.js';
import { HttpError } from './http.js';
import { procStats } from './system.js';

const MAX_LOG_LINES = 1500;
const MAX_UPLOAD_TOTAL = 50 * 1024 * 1024;
const MAX_UPLOAD_FILE = 10 * 1024 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;
const CRASH_WINDOW_MS = 60 * 60 * 1000;
const MAX_CRASHES_PER_WINDOW = 20;
const HEALTHY_UPTIME_MS = 60 * 1000;

/**
 * Bota geçirilebilecek ortam değişkenleri. Panelin kendi ortamı ASLA
 * olduğu gibi aktarılmaz — aksi halde PANEL_MASTER_KEY bot koduna sızardı.
 */
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'TMPDIR', 'USER', 'LOGNAME',
  'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'NUMBER_OF_PROCESSORS',
];

export const RUNTIMES = ['node', 'npm', 'custom'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BotManager {
  #store;
  #root;
  #driver;
  #defaultImage;
  #runtimes = new Map();

  constructor({ store, root, driver = 'local', defaultImage = 'node:22-alpine' }) {
    this.#store = store;
    this.#root = path.resolve(root);
    this.#driver = driver;
    this.#defaultImage = defaultImage;
    fs.mkdirSync(this.#root, { recursive: true });
  }

  get driver() {
    return this.#driver;
  }

  get root() {
    return this.#root;
  }

  // ---------------------------------------------------------------- bot CRUD

  list() {
    return this.#store.data.bots.map((bot) => ({ ...bot, status: this.status(bot.id) }));
  }

  get(id) {
    const bot = this.#store.data.bots.find((b) => b.id === id);
    if (!bot) throw new HttpError(404, 'Bot bulunamadı');
    return bot;
  }

  create(input) {
    const name = requireName(input?.name);
    const id = randomId('bot_');
    const bot = {
      id,
      name,
      description: typeof input?.description === 'string' ? input.description.slice(0, 500) : '',
      driver: input?.driver === 'docker' ? 'docker' : input?.driver === 'local' ? 'local' : this.#driver,
      image: typeof input?.image === 'string' && input.image ? input.image.slice(0, 200) : this.#defaultImage,
      runtime: RUNTIMES.includes(input?.runtime) ? input.runtime : 'node',
      entry: typeof input?.entry === 'string' && input.entry ? sanitizeRel(input.entry) : 'index.js',
      command: typeof input?.command === 'string' ? input.command.slice(0, 200) : '',
      args: Array.isArray(input?.args) ? input.args.map((a) => String(a).slice(0, 200)).slice(0, 30) : [],
      env: sanitizeEnv(input?.env),
      autoRestart: input?.autoRestart !== false,
      autoStart: input?.autoStart !== false,
      readOnly: input?.readOnly !== false,
      network: 'bridge',
      limits: sanitizeLimits(input?.limits),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.#store.data.bots.push(bot);
    fs.mkdirSync(this.botDir(id), { recursive: true });
    this.#store.save();
    return bot;
  }

  update(id, patch) {
    const bot = this.get(id);
    if (patch?.name !== undefined) bot.name = requireName(patch.name);
    if (patch?.description !== undefined) bot.description = String(patch.description).slice(0, 500);
    if (patch?.runtime !== undefined && RUNTIMES.includes(patch.runtime)) bot.runtime = patch.runtime;
    if (patch?.entry !== undefined && patch.entry !== '') bot.entry = sanitizeRel(patch.entry);
    if (patch?.command !== undefined) bot.command = String(patch.command).slice(0, 200);
    if (patch?.args !== undefined && Array.isArray(patch.args)) {
      bot.args = patch.args.map((a) => String(a).slice(0, 200)).slice(0, 30);
    }
    if (patch?.image !== undefined && patch.image !== '') bot.image = String(patch.image).slice(0, 200);
    if (patch?.env !== undefined) bot.env = sanitizeEnv(patch.env);
    if (patch?.autoRestart !== undefined) bot.autoRestart = Boolean(patch.autoRestart);
    if (patch?.autoStart !== undefined) bot.autoStart = Boolean(patch.autoStart);
    if (patch?.readOnly !== undefined) bot.readOnly = Boolean(patch.readOnly);
    if (patch?.limits !== undefined) bot.limits = sanitizeLimits(patch.limits);
    bot.updatedAt = new Date().toISOString();
    this.#store.save();
    return bot;
  }

  async remove(id) {
    const bot = this.get(id);
    // Yolu bot kayıttan düşmeden ÖNCE hesapla: botDir() kaydı doğrular ve
    // silme sonrası çağrılırsa 404 atardı.
    const dir = path.join(this.#root, id);
    const driver = bot.driver ?? this.#driver;
    await this.stop(id).catch(() => {});
    this.#store.data.bots = this.#store.data.bots.filter((b) => b.id !== id);
    this.#store.save();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (driver === 'docker') {
      await run('docker', ['network', 'rm', this.#networkName(id)]).catch(() => {});
    }
    this.#runtimes.delete(id);
    return true;
  }

  /**
   * Panel açılışında otomatik başlatma işaretli botları ayağa kaldırır.
   * Makine/süpervizör yeniden başladığında botların kendiliğinden dönmesi için.
   */
  async autostartAll() {
    const started = [];
    for (const bot of this.#store.data.bots) {
      if (!bot.autoStart) continue;
      try {
        await this.start(bot.id);
        started.push(bot.name);
      } catch (err) {
        this.#log(bot.id, 'panel', `otomatik başlatma başarısız: ${err.message}`);
      }
    }
    return started;
  }

  // ------------------------------------------------------------ durum / log

  botDir(id) {
    this.get(id);
    return path.join(this.#root, id);
  }

  status(id) {
    const rt = this.#runtimes.get(id);
    if (!rt) {
      return { state: 'stopped', pid: null, startedAt: null, uptimeMs: 0, restarts: 0, exitCode: null, lastError: null, stats: null };
    }
    const stats = procStats(rt.child?.pid) ?? null;
    return {
      state: rt.state,
      pid: rt.child?.pid ?? null,
      startedAt: rt.startedAt,
      uptimeMs: rt.startedAt ? Date.now() - rt.startedAt : 0,
      restarts: rt.restarts,
      exitCode: rt.exitCode,
      lastError: rt.lastError,
      retryIn: rt.retryIn ?? null,
      stats,
    };
  }

  logs(id, since = 0) {
    const rt = this.#runtimes.get(id);
    if (!rt) return { lines: [], seq: 0 };
    return { lines: rt.logs.filter((l) => l.seq > since), seq: rt.logSeq };
  }

  /** Canlı konsol aboneliği. Dönen fonksiyon abonelikten çıkarır. */
  subscribe(id, listener) {
    const rt = this.#runtime(id);
    rt.listeners.add(listener);
    return () => rt.listeners.delete(listener);
  }

  // ---------------------------------------------------------------- yaşam

  async start(id) {
    const bot = this.get(id);
    const rt = this.#runtime(id);
    if (rt.child) throw new HttpError(409, 'Bot zaten çalışıyor');
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    rt.stopping = false;
    rt.exitCode = null;
    rt.lastError = null;
    rt.retryIn = null;

    const dir = this.botDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const driver = bot.driver || this.#driver;

    let child;
    if (driver === 'docker') {
      rt.kind = 'docker';
      await this.#ensureNetwork(id);
      this.#log(id, 'panel', `docker image çalıştırılıyor: ${bot.image}`);
      child = spawn('docker', this.#dockerArgs(bot, dir), { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      rt.kind = 'local';
      const [cmd, ...args] = this.#localCommand(bot);
      this.#log(id, 'panel', `süreç başlatılıyor: ${cmd} ${args.join(' ')}`);
      child = spawn(cmd, args, {
        cwd: dir,
        env: botEnv(bot.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX'te kendi süreç grubunda çalışsın ki alt süreçler de birlikte ölsün.
        detached: process.platform !== 'win32',
      });
    }

    rt.child = child;
    rt.startedAt = Date.now();
    rt.crashTimes = (rt.crashTimes ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    this.#setState(id, 'running');

    child.on('error', (err) => {
      rt.lastError = err.message;
      this.#log(id, 'panel', `süreç hatası: ${err.message}`);
    });

    this.#pipeLogs(id, child);

    child.on('exit', (code, signal) => {
      rt.child = null;
      rt.exitCode = code;
      const uptime = Date.now() - (rt.startedAt ?? Date.now());
      rt.startedAt = null;
      const wanted = rt.stopping;
      this.#log(id, 'panel', `süreç sonlandı (kod=${code ?? '—'}, sinyal=${signal ?? '—'}, süre=${Math.round(uptime / 1000)}s)`);

      if (wanted) {
        this.#setState(id, 'stopped');
        return;
      }

      // Uzun süre sağlıklı çalıştıysa çökme geçmişini sıfırla: koruma yalnızca
      // hızlı çökme döngülerini yakalar, ara sıra çöken botu kalıcı olarak düşürmez.
      if (uptime >= HEALTHY_UPTIME_MS) rt.crashTimes = [];
      rt.crashTimes = [...(rt.crashTimes ?? []), Date.now()].filter((t) => Date.now() - t < CRASH_WINDOW_MS);
      this.#setState(id, 'crashed', { exitCode: code });

      if (!bot.autoRestart) return;
      if (rt.crashTimes.length > MAX_CRASHES_PER_WINDOW) {
        rt.lastError = `Çok fazla çökme (${rt.crashTimes.length}/${MAX_CRASHES_PER_WINDOW} saat). Otomatik yeniden başlatma durduruldu.`;
        this.#log(id, 'panel', rt.lastError);
        this.#setState(id, 'failed');
        return;
      }
      this.#scheduleRestart(id, rt.crashTimes.length);
    });

    // docker run istemcisi hemen ölürse (imaj yok vb.) exit olayı zaten işlenir.
    return this.status(id);
  }

  async stop(id, { timeoutMs = 10000 } = {}) {
    const rt = this.#runtime(id);
    rt.stopping = true;
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    rt.retryIn = null;

    const child = rt.child;
    if (!child) {
      rt.state = 'stopped';
      this.#emit(id, { type: 'status', status: this.status(id) });
      return this.status(id);
    }

    if (rt.kind === 'docker') {
      await run('docker', ['stop', '--time', '10', this.#containerName(id)]).catch(() => {});
    }

    const exited = new Promise((resolve) => child.once('exit', resolve));
    this.#kill(child, 'SIGTERM');
    const timedOut = await Promise.race([exited.then(() => false), delay(timeoutMs).then(() => true)]);
    if (timedOut) {
      this.#log(id, 'panel', 'SIGTERM yetmedi, SIGKILL gönderiliyor');
      this.#kill(child, 'SIGKILL');
      await Promise.race([exited, delay(3000)]);
    }
    rt.state = 'stopped';
    rt.child = null;
    rt.startedAt = null;
    this.#emit(id, { type: 'status', status: this.status(id) });
    return this.status(id);
  }

  async restart(id) {
    await this.stop(id);
    return this.start(id);
  }

  /** Panel kapanırken bütün botları düzgünce durdur. */
  async shutdown() {
    await Promise.allSettled(this.#store.data.bots.map((b) => this.stop(b.id, { timeoutMs: 4000 })));
  }

  // ---------------------------------------------------------------- dosyalar

  listFiles(id, rel = '') {
    const target = this.#resolve(id, rel);
    if (!fs.existsSync(target)) throw new HttpError(404, 'Yol bulunamadı');
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new HttpError(403, 'Sembolik bağlantılar desteklenmiyor');
    if (!stat.isDirectory()) throw new HttpError(400, 'Bu yol bir dizin değil');
    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .map((entry) => {
        const full = path.join(target, entry.name);
        let size = null;
        let mtime = null;
        try {
          const st = fs.lstatSync(full);
          size = st.size;
          mtime = st.mtime.toISOString();
        } catch {
          /* yarış durumu: yok say */
        }
        return {
          name: entry.name,
          path: [rel.replace(/^\/+|\/+$/g, ''), entry.name].filter(Boolean).join('/'),
          type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file',
          size,
          mtime,
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: rel.replace(/^\/+|\/+$/g, ''), entries };
  }

  readFile(id, rel) {
    const target = this.#resolve(id, rel);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new HttpError(400, 'Bu yol bir dosya değil');
    if (stat.size > MAX_EDIT_BYTES) throw new HttpError(413, 'Dosya editör sınırından büyük (1 MB)');
    const buf = fs.readFileSync(target);
    const binary = buf.includes(0);
    return {
      path: rel,
      size: stat.size,
      binary,
      content: binary ? null : buf.toString('utf8'),
      mtime: stat.mtime.toISOString(),
    };
  }

  writeFile(id, rel, content) {
    const target = this.#resolve(id, rel, { allowMissing: true });
    if (Buffer.byteLength(content ?? '') > MAX_EDIT_BYTES) throw new HttpError(413, 'İçerik 1 MB sınırını aşıyor');
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new HttpError(403, 'Sembolik bağlantı üzerine yazılamaz');
      if (stat.isDirectory()) throw new HttpError(400, 'Bu yol bir dizin');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content ?? '', { mode: 0o644 });
    return { path: rel, size: Buffer.byteLength(content ?? '') };
  }

  mkdir(id, rel) {
    const target = this.#resolve(id, rel, { allowMissing: true });
    fs.mkdirSync(target, { recursive: true });
    return { path: rel };
  }

  deletePath(id, rel) {
    const target = this.#resolve(id, rel);
    if (target === this.botDir(id)) throw new HttpError(400, 'Bot kök dizini silinemez');
    if (!fs.existsSync(target)) throw new HttpError(404, 'Yol bulunamadı');
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.rmSync(target, { force: true });
    return { path: rel };
  }

  /** Base64 gövde ile çoklu dosya yükleme (tarayıcıdan FileReader ile). */
  uploadFiles(id, files) {
    if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, 'Yüklenecek dosya yok');
    let total = 0;
    const written = [];
    for (const file of files) {
      const rel = sanitizeRel(file?.path ?? file?.name ?? '');
      if (!rel) throw new HttpError(400, 'Dosya adı boş olamaz');
      const buf = Buffer.from(String(file?.contentBase64 ?? ''), 'base64');
      if (buf.length > MAX_UPLOAD_FILE) throw new HttpError(413, `${rel} çok büyük (tek dosya sınırı 10 MB)`);
      total += buf.length;
      if (total > MAX_UPLOAD_TOTAL) throw new HttpError(413, 'Toplam yükleme 50 MB sınırını aştı');
      const target = this.#resolve(id, rel, { allowMissing: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      written.push({ path: rel, size: buf.length });
    }
    return written;
  }

  // ------------------------------------------------------------- iç yardımcı

  #runtime(id) {
    let rt = this.#runtimes.get(id);
    if (!rt) {
      rt = {
        child: null,
        kind: null,
        state: 'stopped',
        startedAt: null,
        exitCode: null,
        lastError: null,
        restarts: 0,
        retryIn: null,
        stopping: false,
        restartTimer: null,
        crashTimes: [],
        logs: [],
        logSeq: 0,
        partial: { stdout: '', stderr: '' },
        listeners: new Set(),
      };
      this.#runtimes.set(id, rt);
    }
    return rt;
  }

  #networkName(id) {
    return `lumo-net-${id}`;
  }

  #containerName(id) {
    return `lumo-bot-${id}`;
  }

  async #ensureNetwork(id) {
    const name = this.#networkName(id);
    const result = await run('docker', ['network', 'inspect', name]).catch((err) => ({ failed: true, err }));
    if (result.failed) {
      // Her bot kendi ağında: birbirlerine erişemezler ama internet erişimi var.
      await run('docker', ['network', 'create', name]).catch((err) => {
        throw new HttpError(500, `docker ağı oluşturulamadı: ${err.message}`);
      });
    }
  }

  /**
   * Konteyner sertleştirmesi:
   *  root değil, tüm yetenekler düşürülmüş, no-new-privileges, pids/cpu/mem sınırı,
   *  kök dosya sistemi salt-okunur, /tmp tmpfs, kendi izole ağı, sadece kendi dizini mount.
   *  Böylece bot ne panele ne başka bir botun dosyalarına erişebilir.
   */
  #dockerArgs(bot, dir) {
    const readOnly = bot.readOnly !== false;
    const args = ['run', '--rm', '--init', '--name', this.#containerName(bot.id), '--label', `lumo.bot=${bot.id}`];
    args.push('--security-opt', 'no-new-privileges', '--cap-drop', 'ALL');
    args.push('--pids-limit', String(bot.limits?.pids ?? 256));
    args.push('--memory', bot.limits?.memory ?? '512m');
    args.push('--cpus', String(bot.limits?.cpus ?? 0.5));
    args.push('--network', this.#networkName(bot.id));
    if (readOnly) args.push('--read-only', '--tmpfs', '/tmp:rw,size=64m');
    args.push('-v', `${dir}:/app${readOnly ? ':ro' : ''}`, '-w', '/app');
    for (const [key, value] of Object.entries(bot.env ?? {})) args.push('-e', `${key}=${value}`);
    args.push(bot.image || this.#defaultImage);
    const [cmd, ...rest] = this.#containerCommand(bot);
    args.push(cmd, ...rest);
    return args;
  }

  #containerCommand(bot) {
    const extra = bot.args ?? [];
    if (bot.runtime === 'npm') return ['npm', bot.entry || 'start', ...extra];
    if (bot.runtime === 'custom') return [bot.command || 'sh', ...extra];
    return [bot.command || 'node', bot.entry || 'index.js', ...extra];
  }

  #localCommand(bot) {
    const extra = bot.args ?? [];
    if (bot.runtime === 'npm') {
      return [process.platform === 'win32' ? 'npm.cmd' : 'npm', bot.entry && bot.entry !== 'index.js' ? bot.entry : 'start', ...extra];
    }
    if (bot.runtime === 'custom') {
      if (!bot.command) throw new HttpError(400, 'custom runtime için komut gerekli');
      return [bot.command, ...extra];
    }
    return [process.execPath, bot.entry || 'index.js', ...extra];
  }

  #pipeLogs(id, child) {
    const rt = this.#runtime(id);
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', (chunk) => {
        const combined = rt.partial[stream] + chunk;
        const parts = combined.split(/\r?\n/);
        rt.partial[stream] = parts.pop() ?? '';
        for (const line of parts) this.#log(id, stream === 'stderr' ? 'stderr' : 'stdout', line);
        // Konsol etkileşimi için stdin'e yazılabilir olması yeterli; satır yoksa bekler.
        if (rt.partial[stream].length > 8192) {
          this.#log(id, stream === 'stderr' ? 'stderr' : 'stdout', rt.partial[stream]);
          rt.partial[stream] = '';
        }
      });
      child[stream].on('error', () => {});
    }
  }

  /** Konsola girdi gönder (bot stdin'ini okurken yararlı). */
  sendInput(id, text) {
    const rt = this.#runtime(id);
    if (!rt.child || !rt.child.stdin.writable) throw new HttpError(409, 'Bot çalışmıyor');
    rt.child.stdin.write(String(text) + '\n');
    this.#log(id, 'stdin', text);
    return true;
  }

  #log(id, stream, text) {
    const rt = this.#runtime(id);
    rt.logSeq += 1;
    const line = { seq: rt.logSeq, at: new Date().toISOString(), stream, text: String(text).slice(0, 4000) };
    rt.logs.push(line);
    if (rt.logs.length > MAX_LOG_LINES) rt.logs.splice(0, rt.logs.length - MAX_LOG_LINES);
    this.#emit(id, { type: 'log', line });
  }

  #setState(id, state, extra = {}) {
    const rt = this.#runtime(id);
    rt.state = state;
    Object.assign(rt, extra);
    this.#emit(id, { type: 'status', status: this.status(id) });
  }

  #emit(id, event) {
    const rt = this.#runtime(id);
    for (const listener of rt.listeners) {
      try {
        listener(event);
      } catch {
        /* kopmuş istemci: yok say */
      }
    }
  }

  #scheduleRestart(id, attempt) {
    const rt = this.#runtime(id);
    const wait = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30000);
    rt.restarts += 1;
    rt.retryIn = wait;
    this.#setState(id, 'restarting');
    this.#log(id, 'panel', `otomatik yeniden başlatma #${rt.restarts} — ${Math.round(wait / 1000)}s sonra`);
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null;
      this.start(id).catch((err) => {
        this.#log(id, 'panel', `yeniden başlatma başarısız: ${err.message}`);
        this.#scheduleRestart(id, attempt + 1);
      });
    }, wait);
  }

  #kill(child, signal = 'SIGTERM') {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* yok say */
      }
      return;
    }
    try {
      // detached → negatif pid ile tüm süreç grubunu hedefle
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* süreç zaten ölmüş */
      }
    }
  }

  /**
   * Yolu bot dizininin içinde çözer ve dizin dışına kaçışı (../ veya symlink) engeller.
   * Gerçek (realpath) karşılaştırması yapılır, bu yüzden sembolik bağlantı hilesi işe yaramaz.
   */
  #resolve(id, rel, { allowMissing = false } = {}) {
    const base = this.botDir(id);
    const cleaned = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (cleaned.split('/').some((seg) => seg === '..')) throw new HttpError(400, 'Geçersiz yol (.. içeriyor)');
    const target = path.resolve(base, cleaned);
    if (target !== base && !target.startsWith(base + path.sep)) throw new HttpError(400, 'Geçersiz yol');

    if (fs.existsSync(base)) {
      const realBase = fs.realpathSync(base);
      let probe = target;
      while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      if (fs.existsSync(probe)) {
        const real = fs.realpathSync(probe);
        if (real !== realBase && !real.startsWith(realBase + path.sep)) {
          throw new HttpError(403, 'Yol bot kök dizininin dışına çıkıyor');
        }
      }
    }
    if (!allowMissing && !fs.existsSync(target)) throw new HttpError(404, 'Yol bulunamadı');
    return target;
  }
}

// ---------------------------------------------------------------- yardımcılar

function botEnv(extra) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (!env.HOME) env.HOME = os.homedir();
  return { ...env, ...(extra ?? {}) };
}

function requireName(name) {
  const value = String(name ?? '').trim();
  if (value.length < 2 || value.length > 60) throw new HttpError(400, 'Bot adı 2-60 karakter olmalı');
  return value;
}

function sanitizeEnv(env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) throw new HttpError(400, 'env bir nesne olmalı');
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new HttpError(400, `Geçersiz değişken adı: ${key}`);
    out[key] = String(value).slice(0, 8000);
  }
  return out;
}

function sanitizeLimits(limits) {
  const input = limits && typeof limits === 'object' ? limits : {};
  const memory = typeof input.memory === 'string' && /^\d+[kmg]?$/i.test(input.memory) ? input.memory.toLowerCase() : '512m';
  const cpus = Number.isFinite(Number(input.cpus)) ? Math.min(Math.max(Number(input.cpus), 0.1), 8) : 0.5;
  const pids = Number.isFinite(Number(input.pids)) ? Math.min(Math.max(Math.floor(Number(input.pids)), 32), 4096) : 256;
  return { memory, cpus, pids };
}

function sanitizeRel(rel) {
  const cleaned = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!cleaned) return '';
  if (cleaned.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) {
    throw new HttpError(400, 'Geçersiz göreli yol');
  }
  return cleaned.slice(0, 400);
}

function run(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} zaman aşımı`));
    }, timeout);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${cmd} çıkış kodu ${code}`));
    });
  });
}
