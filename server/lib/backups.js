// Yedekler.
//
// Her yedek tek bir tar.gz: sunucu dizininin tamamı, symlink'ler atlanır (jail
// dışına işaret eden bağlar arşive girmez). Saklanan meta veri dosya adı, boyut,
// sha256 özeti ve kimin ne zaman aldığıdır.
//
// Geri yükleme "önce temizle, sonra yaz" yapar: yedekte olmayan dosyalar silinir,
// yani geri dönüş gerçekten o ana dönmektir. Arşiv girişleri yeniden doğrulanır —
// kurcalanmış bir arşiv dizin dışına yazamaz.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomId } from './crypto.js';
import { createTarGz, extractTarGz, safeEntryName } from './tar.js';
import { audit } from './store.js';
import { STATUS } from './servers.js';

export const DEFAULT_KEEP = 5;

export class Backups {
  #store;
  #servers;
  #dir;

  constructor({ store, servers, dir }) {
    this.#store = store;
    this.#servers = servers;
    this.#dir = dir;
  }

  get dir() {
    return this.#dir;
  }

  async init() {
    await fs.mkdir(this.#dir, { recursive: true });
  }

  filePath(backupId) {
    return path.join(this.#dir, `${backupId}.tar.gz`);
  }

  find(backupId) {
    return this.#store.state.backups.find((item) => item.id === backupId) || null;
  }

  list(serverId = null) {
    const items = this.#store.state.backups.filter((item) => !serverId || item.serverId === serverId);
    return [...items].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async #collect(root) {
    const entries = [];
    const stack = [{ absolute: root, relative: '' }];
    while (stack.length) {
      const current = stack.pop();
      let dirents;
      try {
        dirents = await fs.readdir(current.absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (dirent.name === '.lumo') continue;
        const absolute = path.join(current.absolute, dirent.name);
        const relative = current.relative ? `${current.relative}/${dirent.name}` : dirent.name;
        if (dirent.isSymbolicLink()) continue; // jail güvenliği: bağları arşivleme
        if (dirent.isDirectory()) {
          entries.push({ name: relative, type: '5' });
          stack.push({ absolute, relative });
          continue;
        }
        if (!dirent.isFile()) continue;
        const stat = await fs.stat(absolute);
        const data = await fs.readFile(absolute);
        entries.push({ name: relative, type: '0', data, mode: stat.mode & 0o777, mtime: stat.mtimeMs });
      }
    }
    return entries;
  }

  /** Anlık yedek alır. Sunucu çalışıyor olabilir; not olarak kaydedilir. */
  async create(serverId, { name = null, actor = 'sistem', keep = DEFAULT_KEEP } = {}) {
    const server = this.#servers.findServer(serverId);
    if (!server) throw Object.assign(new Error('Sunucu bulunamadı.'), { status: 404 });
    const jail = this.#servers.jail(serverId);
    await jail.ensureRoot();
    const root = jail.root;

    const entries = await this.#collect(root);
    const archive = createTarGz(entries);
    const id = randomId('bkp-');
    const file = this.filePath(id);
    await fs.writeFile(file, archive, { mode: 0o600 });
    const checksum = createHash('sha256').update(archive).digest('hex');
    const runningAtCreation = this.#servers.status(serverId) !== STATUS.OFFLINE;

    const meta = {
      id,
      serverId,
      // Arşivde tam yol saklanmaz; panel dizinini taşısan da yedekler çalışır.
      file: path.basename(file),
      name: name || `yedek-${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
      sizeBytes: archive.length,
      fileCount: entries.filter((item) => item.type === '0').length,
      checksum,
      createdAt: new Date().toISOString(),
      createdBy: actor,
      runningAtCreation,
    };

    await this.#store.update((state) => {
      state.backups.push(meta);
      audit(state, {
        actor,
        action: 'backup.create',
        target: server.name,
        detail: { backup: meta.name, sizeBytes: meta.sizeBytes, files: meta.fileCount },
      });
    });

    const pruned = await this.prune(serverId, keep, { actor: 'sistem' });
    return { ...meta, pruned };
  }

  async read(backupId) {
    const meta = this.find(backupId);
    if (!meta) throw Object.assign(new Error('Yedek bulunamadı.'), { status: 404 });
    const buffer = await fs.readFile(this.filePath(meta.id));
    const checksum = createHash('sha256').update(buffer).digest('hex');
    return { meta, buffer, checksumMatches: checksum === meta.checksum };
  }

  async remove(backupId, { actor = 'sistem' } = {}) {
    const meta = this.find(backupId);
    if (!meta) throw Object.assign(new Error('Yedek bulunamadı.'), { status: 404 });
    await fs.rm(this.filePath(meta.id), { force: true });
    const server = this.#servers.findServer(meta.serverId);
    await this.#store.update((state) => {
      state.backups = state.backups.filter((item) => item.id !== backupId);
      audit(state, { actor, action: 'backup.delete', target: server?.name || meta.serverId, detail: { backup: meta.name } });
    });
    return { id: backupId };
  }

  /** En yeni `keep` yedeği tutar, kalanları siler (zamanlanmış görevler kullanır). */
  async prune(serverId, keep = DEFAULT_KEEP, { actor = 'sistem' } = {}) {
    const items = this.list(serverId);
    const doomed = items.slice(Math.max(0, keep));
    for (const item of doomed) {
      await fs.rm(this.filePath(item.id), { force: true });
    }
    if (doomed.length) {
      const ids = new Set(doomed.map((item) => item.id));
      await this.#store.update((state) => {
        state.backups = state.backups.filter((item) => !ids.has(item.id));
        audit(state, { actor, action: 'backup.prune', target: serverId, detail: { removed: doomed.length, keep } });
      });
    }
    return doomed.map((item) => item.id);
  }

  /** Yedekten geri yükler: önce sunucuyu durdurur, sonra dizini yedekteki hâle getirir. */
  async restore(backupId, { actor = 'sistem' } = {}) {
    const { meta, buffer, checksumMatches } = await this.read(backupId);
    const server = this.#servers.findServer(meta.serverId);
    if (!server) throw Object.assign(new Error('Yedeğin sunucusu artık yok.'), { status: 404 });
    if (!checksumMatches) {
      throw Object.assign(new Error('Yedek dosyası bozulmuş (sha256 uyuşmuyor). Geri yükleme reddedildi.'), {
        status: 409,
      });
    }

    if (this.#servers.status(server.id) !== STATUS.OFFLINE) {
      await this.#servers.stop(server.id, { force: true, actor });
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    const jail = this.#servers.jail(server.id);
    await jail.ensureRoot();
    const root = jail.root;

    const entries = extractTarGz(buffer)
      .map((entry) => ({ ...entry, name: safeEntryName(entry.name) }))
      .filter((entry) => entry.name);

    const wanted = new Set(entries.map((entry) => entry.name));
    // Yedekte olmayan dosyaları sil (geri dönüş gerçekten o an olsun).
    const existing = await this.#existing(root, '');
    for (const relative of existing) {
      if (wanted.has(relative)) continue;
      await fs.rm(path.join(root, relative), { recursive: true, force: true }).catch(() => {});
    }

    for (const entry of entries) {
      const target = path.join(root, entry.name);
      const resolved = path.resolve(target);
      if (!resolved.startsWith(root + path.sep)) continue; // son savunma hattı
      if (entry.type === 'dir') {
        await fs.mkdir(resolved, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, entry.data, entry.mode ? { mode: entry.mode } : {});
    }

    await this.#store.update((state) => {
      audit(state, {
        actor,
        action: 'backup.restore',
        target: server.name,
        detail: { backup: meta.name, files: entries.filter((item) => item.type === 'file').length },
      });
    });
    return { restored: entries.filter((item) => item.type === 'file').length, dirs: entries.filter((item) => item.type === 'dir').length };
  }

  async #existing(root, relative = '') {
    const out = [];
    let dirents;
    try {
      dirents = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const dirent of dirents) {
      if (!relative && dirent.name === '.lumo') continue;
      const next = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        out.push(next);
        out.push(...(await this.#existing(root, next)));
      } else {
        out.push(next);
      }
    }
    return out;
  }

  async usage() {
    const items = this.list();
    return {
      count: items.length,
      totalBytes: items.reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
    };
  }

  /** Panel açılışında diski durumla tutarlı hâle getir: kaydı olmayan arşivleri sil. */
  async reconcile() {
    await this.init();
    const known = new Set(this.list().map((item) => item.file));
    const files = await fs.readdir(this.#dir).catch(() => []);
    let removed = 0;
    for (const file of files) {
      if (file.endsWith('.tar.gz') && !known.has(file)) {
        await fs.rm(path.join(this.#dir, file), { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}
