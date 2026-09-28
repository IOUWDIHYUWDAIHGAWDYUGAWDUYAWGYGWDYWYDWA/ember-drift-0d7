// Sunucu dosya sistemi: listeleme, okuma, yazma, taşıma, silme, disk kullanımı.
//
// Her yol `realpath` karşılaştırmasıyla sunucunun kök dizinine hapsedilir.
// Mutlak yollar, `..`, null bayt ve kökün dışına çıkan sembolik bağlar reddedilir.
// Panel bu katmanın altında dosya işlemi yapmaz.

import fs from 'node:fs/promises';
import path from 'node:path';

const TEXT_SNIFF_BYTES = 4096;

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.bin', '.sqlite', '.db', '.mp3', '.mp4',
]);

export function isProbablyBinary(buf) {
  const slice = buf.subarray(0, TEXT_SNIFF_BYTES);
  if (slice.includes(0)) return true;
  let weird = 0;
  for (const byte of slice) {
    if (byte < 9 || (byte > 13 && byte < 32)) weird += 1;
  }
  return slice.length > 0 && weird / slice.length > 0.05;
}

export class FileJail {
  #root;
  #realRoot = null;

  constructor(root) {
    this.#root = path.resolve(root);
  }

  get root() {
    return this.#root;
  }

  async ensureRoot() {
    await fs.mkdir(this.#root, { recursive: true });
    this.#realRoot = await fs.realpath(this.#root);
    return this.#realRoot;
  }

  async #realRootPath() {
    if (!this.#realRoot) await this.ensureRoot();
    return this.#realRoot;
  }

  #clean(relative) {
    const rel = String(relative ?? '');
    if (rel.includes('\0')) throw Object.assign(new Error('Yolda geçersiz karakter var.'), { status: 400 });
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw Object.assign(new Error('Mutlak yollar kabul edilmez.'), { status: 400 });
    }
    const normalized = path.normalize(rel).replace(/\\/g, '/');
    if (normalized === '..' || normalized.startsWith('../')) {
      throw Object.assign(new Error('Sunucu dizininin dışına çıkılamaz.'), { status: 400 });
    }
    return normalized === '.' ? '' : normalized;
  }

  /** Güvenli mutlak yol. `mustExist` ise hedef var olmalıdır. */
  async resolve(relative, { mustExist = false } = {}) {
    const rel = this.#clean(relative);
    const realRoot = await this.#realRootPath();
    const candidate = path.resolve(realRoot, rel);
    const insideRoot = candidate === realRoot || candidate.startsWith(realRoot + path.sep);
    if (!insideRoot) {
      throw Object.assign(new Error('Sunucu dizininin dışına çıkılamaz.'), { status: 400 });
    }
    let exists = true;
    try {
      await fs.lstat(candidate);
    } catch {
      exists = false;
    }
    if (exists) {
      const realFull = await fs.realpath(candidate).catch(() => null);
      if (!realFull) throw Object.assign(new Error(`Yol çözümlenemedi: ${rel}`), { status: 400 });
      if (!inside(realRoot, realFull)) {
        throw Object.assign(new Error('Yol sunucu dizininin dışına işaret ediyor.'), { status: 400 });
      }
      return { absolute: realFull, relative: rel, exists: true };
    }
    if (mustExist) throw Object.assign(new Error(`Bulunamadı: ${rel || '/'}`), { status: 404 });
    // Henüz var olmayan hedef: en yakın var olan üst dizin kökün içinde mi?
    // (Sembolik bağ üzerinden kök dışına yazmayı engeller.)
    let probe = path.dirname(candidate);
    for (;;) {
      let realProbe = null;
      try {
        realProbe = await fs.realpath(probe);
      } catch {
        realProbe = null;
      }
      if (realProbe) {
        if (!inside(realRoot, realProbe)) {
          throw Object.assign(new Error('Sembolik bağ sunucu dizininin dışına işaret ediyor.'), { status: 400 });
        }
        break;
      }
      const parent = path.dirname(probe);
      if (parent === probe || probe === realRoot) break;
      probe = parent;
    }
    return { absolute: candidate, relative: rel, exists: false };
  }

  async list(relative = '') {
    const { absolute, relative: rel } = await this.resolve(relative, { mustExist: true });
    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    const items = [];
    for (const dirent of dirents) {
      if (dirent.name === '.lumo' || dirent.name === '.lumo-install') continue;
      const itemPath = path.join(absolute, dirent.name);
      const stat = await fs.lstat(itemPath).catch(() => null);
      if (!stat) continue;
      const isLink = stat.isSymbolicLink();
      const isDir = !isLink && stat.isDirectory();
      items.push({
        name: dirent.name,
        path: rel ? `${rel}/${dirent.name}` : dirent.name,
        type: isDir ? 'dir' : isLink ? 'link' : 'file',
        size: isDir ? null : stat.size,
        mode: (stat.mode & 0o777).toString(8).padStart(3, '0'),
        mtime: stat.mtime.toISOString(),
      });
    }
    items.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (b.type === 'dir' && a.type !== 'dir') return 1;
      return a.name.localeCompare(b.name, 'tr');
    });
    return { path: rel, items };
  }

  async read(relative, { maxBytes = 2 * 1024 * 1024 } = {}) {
    const { absolute, relative: rel } = await this.resolve(relative, { mustExist: true });
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) throw Object.assign(new Error('Bu yol bir dizin.'), { status: 400 });
    if (stat.size > maxBytes) {
      throw Object.assign(new Error(`Dosya çok büyük (${stat.size} bayt). İndirme için /download kullan.`), { status: 413 });
    }
    const data = await fs.readFile(absolute);
    const binary = isProbablyBinary(data) || BINARY_EXT.has(path.extname(absolute).toLowerCase());
    return {
      path: rel,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      binary,
      content: binary ? null : data.toString('utf8'),
      data: binary ? data.toString('base64') : null,
    };
  }

  async write(relative, buffer) {
    const { absolute, relative: rel } = await this.resolve(relative);
    if (!rel) throw Object.assign(new Error('Dosya adı gerekli.'), { status: 400 });
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, buffer);
    return { path: rel, size: buffer.length };
  }

  async mkdir(relative) {
    const { absolute, relative: rel } = await this.resolve(relative);
    if (!rel) throw Object.assign(new Error('Klasör adı gerekli.'), { status: 400 });
    await fs.mkdir(absolute, { recursive: true });
    return { path: rel };
  }

  async remove(relative) {
    const { absolute, relative: rel } = await this.resolve(relative, { mustExist: true });
    if (!rel) throw Object.assign(new Error('Sunucu kök dizini silinemez.'), { status: 400 });
    await fs.rm(absolute, { recursive: true, force: true });
    return { path: rel };
  }

  async rename(from, to) {
    const src = await this.resolve(from, { mustExist: true });
    const dst = await this.resolve(to);
    if (!dst.relative) throw Object.assign(new Error('Hedef adı gerekli.'), { status: 400 });
    if (src.relative.startsWith(`${dst.relative}/`)) {
      throw Object.assign(new Error('Bir klasör kendi içine taşınamaz.'), { status: 400 });
    }
    await fs.mkdir(path.dirname(dst.absolute), { recursive: true });
    await fs.rename(src.absolute, dst.absolute);
    return { from: src.relative, to: dst.relative };
  }

  /** Dizin boyutu (bayt). Diskteki limit kontrolünde kullanılır. */
  async usage(relative = '', { maxEntries = 200000 } = {}) {
    const { absolute } = await this.resolve(relative);
    let total = 0;
    let files = 0;
    const stack = [absolute];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of entries) {
        if (dirent.name === '.lumo') continue;
        const full = path.join(current, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (dirent.isSymbolicLink()) continue;
        const stat = await fs.stat(full).catch(() => null);
        if (!stat) continue;
        total += stat.size;
        files += 1;
        if (files > maxEntries) return { bytes: total, files, truncated: true };
      }
    }
    return { bytes: total, files, truncated: false };
  }
}
