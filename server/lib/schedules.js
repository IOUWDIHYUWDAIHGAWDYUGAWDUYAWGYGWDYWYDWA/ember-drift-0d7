// Zamanlanmış görevler (Pterodactyl schedules karşılığı).
//
// Bir görev: cron ifadesi + sırayla çalışan adımlar. Adımlar sunucuyu başlatıp
// durdurabilir, konsola komut gönderebilir veya yedek alabilir. Her çalıştırma
// kaydedilir: ne zaman, hangi adım, sonucu.

import { randomId } from './crypto.js';
import { audit } from './store.js';
import { describeCron, nextRun, parseCron } from './cron.js';

export const TASK_ACTIONS = ['power', 'command', 'backup'];
export const POWER_ACTIONS = ['start', 'stop', 'restart', 'kill', 'install'];

const HISTORY_LIMIT = 10;
const MAX_TASKS = 10;

function minuteKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}T${date.getHours()}:${date.getMinutes()}`;
}

export function validateSchedule(input, { serverExists } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Görev tanımı bir nesne olmalı.');
  const serverId = String(input.serverId ?? '').trim();
  if (!serverId) throw new Error('Görev bir sunucuya bağlı olmalı.');
  if (serverExists && !serverExists(serverId)) throw new Error('Sunucu bulunamadı.');
  const cron = String(input.cron ?? '').trim();
  parseCron(cron); // geçersizse fırlatır
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (rawTasks.length === 0) throw new Error('Görevde en az bir adım olmalı.');
  if (rawTasks.length > MAX_TASKS) throw new Error(`En fazla ${MAX_TASKS} adım tanımlanabilir.`);
  const tasks = rawTasks.map((task, index) => {
    const action = String(task.action ?? '').trim();
    if (!TASK_ACTIONS.includes(action)) {
      throw new Error(`${index + 1}. adım: bilinmeyen eylem "${task.action}" (geçerli: ${TASK_ACTIONS.join(', ')}).`);
    }
    if (action === 'power') {
      const power = String(task.power ?? '').trim();
      if (!POWER_ACTIONS.includes(power)) {
        throw new Error(`${index + 1}. adım: geçersiz güç eylemi (${POWER_ACTIONS.join(', ')}).`);
      }
      return { action, power, delaySeconds: clampDelay(task.delaySeconds) };
    }
    if (action === 'command') {
      const command = String(task.command ?? '').trim();
      if (!command) throw new Error(`${index + 1}. adım: komut boş olamaz.`);
      if (command.length > 512) throw new Error(`${index + 1}. adım: komut çok uzun.`);
      return { action, command, delaySeconds: clampDelay(task.delaySeconds) };
    }
    const keep = Number(task.keep);
    return {
      action: 'backup',
      keep: Number.isInteger(keep) && keep >= 1 && keep <= 50 ? keep : 5,
      name: task.name ? String(task.name).slice(0, 80) : null,
      delaySeconds: clampDelay(task.delaySeconds),
    };
  });
  return {
    id: String(input.id ?? '').trim() || randomId('sch-'),
    serverId,
    name: String(input.name ?? 'Görev').trim().slice(0, 80) || 'Görev',
    description: String(input.description ?? '').slice(0, 200),
    cron,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    tasks,
  };
}

function clampDelay(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(600, Math.max(0, Math.round(num)));
}

export class Schedules {
  #store;
  #servers;
  #backups;
  #logger;
  #timer = null;
  #running = new Set();

  constructor({ store, servers, backups, logger = console, intervalMs = 20_000 }) {
    this.#store = store;
    this.#servers = servers;
    this.#backups = backups;
    this.#logger = logger;
    this.intervalMs = intervalMs;
  }

  start() {
    if (this.#timer) return this.#timer;
    this.#timer = setInterval(() => {
      this.tick().catch((err) => this.#logger.warn?.(`[lumo] zamanlayıcı hatası: ${err.message}`));
    }, this.intervalMs);
    this.#timer.unref?.();
    return this.#timer;
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  list(serverId = null) {
    return this.#store.state.schedules
      .filter((item) => !serverId || item.serverId === serverId)
      .map((item) => this.decorate(item));
  }

  decorate(schedule) {
    let next = null;
    let described = null;
    try {
      next = nextRun(schedule.cron)?.toISOString() ?? null;
      described = describeCron(schedule.cron);
    } catch {
      next = null;
    }
    return { ...schedule, nextRun: next, description: described };
  }

  /** Her tur: minute anahtarı bir kez çalıştırılır, panel yeniden başlasa bile tekrarlanmaz. */
  async tick(now = new Date()) {
    const key = minuteKey(now);
    const state = this.#store.state;
    const due = [];
    for (const schedule of state.schedules) {
      if (!schedule.enabled) continue;
      if (schedule.lastRunMinute === key) continue;
      let cron;
      try {
        cron = parseCron(schedule.cron);
      } catch {
        continue; // bozuk ifade kayıtlı olsa bile paneli düşürmez
      }
      if (!cron.matches(now)) continue;
      schedule.lastRunMinute = key;
      due.push(schedule);
    }
    if (due.length) await this.#store.save();
    for (const schedule of due) {
      await this.run(schedule, { actor: 'zamanlayıcı' }).catch(() => {});
    }
    return due.map((item) => item.id);
  }

  async runNow(scheduleId, { actor = 'sistem' } = {}) {
    const schedule = this.#store.state.schedules.find((item) => item.id === scheduleId);
    if (!schedule) throw Object.assign(new Error('Görev bulunamadı.'), { status: 404 });
    return this.run(schedule, { actor, manual: true });
  }

  async run(schedule, { actor = 'zamanlayıcı', manual = false } = {}) {
    if (this.#running.has(schedule.id)) {
      return { skipped: true, reason: 'Bu görev hâlâ çalışıyor.' };
    }
    this.#running.add(schedule.id);
    const startedAt = new Date();
    const results = [];
    try {
      for (const task of schedule.tasks) {
        if (task.delaySeconds) await new Promise((resolve) => setTimeout(resolve, task.delaySeconds * 1000));
        try {
          const detail = await this.#executeTask(schedule, task);
          results.push({ action: task.action, ok: true, detail: detail ?? null });
        } catch (err) {
          results.push({ action: task.action, ok: false, error: err.message });
        }
      }
    } finally {
      this.#running.delete(schedule.id);
    }

    const failed = results.filter((item) => !item.ok);
    const run = {
      at: startedAt.toISOString(),
      ok: failed.length === 0,
      manual,
      actor,
      results,
      durationMs: Date.now() - startedAt.getTime(),
    };

    await this.#store.update((state) => {
      const target = state.schedules.find((item) => item.id === schedule.id);
      if (target) {
        target.lastRun = run;
        target.history = [run, ...(target.history || [])].slice(0, HISTORY_LIMIT);
      }
      const server = state.servers.find((item) => item.id === schedule.serverId);
      audit(state, {
        actor,
        action: 'schedule.run',
        target: server?.name || schedule.serverId,
        detail: { schedule: schedule.name, ok: run.ok, steps: results.length, failed: failed.length },
      });
    });

    return run;
  }

  async #executeTask(schedule, task) {
    const serverId = schedule.serverId;
    if (task.action === 'power') {
      const manager = this.#servers;
      if (task.power === 'start') return manager.start(serverId, { actor: 'zamanlayıcı' });
      if (task.power === 'stop') return manager.stop(serverId, { actor: 'zamanlayıcı' });
      if (task.power === 'restart') return manager.restart(serverId, { actor: 'zamanlayıcı' });
      if (task.power === 'kill') return manager.kill(serverId, { actor: 'zamanlayıcı' });
      if (task.power === 'install') return manager.install(serverId, { actor: 'zamanlayıcı' });
    }
    if (task.action === 'command') {
      return this.#servers.input(serverId, task.command);
    }
    if (task.action === 'backup') {
      const backup = await this.#backups.create(serverId, {
        name: task.name || undefined,
        actor: 'zamanlayıcı',
        keep: task.keep,
      });
      return { backupId: backup.id, sizeBytes: backup.sizeBytes };
    }
    throw new Error(`Bilinmeyen adım: ${task.action}`);
  }
}
