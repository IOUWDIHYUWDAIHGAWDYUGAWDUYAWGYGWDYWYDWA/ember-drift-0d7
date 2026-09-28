// Şifreli durum deposu.
//
// Panellerin çoğu bir veritabanı sunucusu ister; burası tek bir şifreli dosya
// kullanır. Yazmalar atomiktir (tmp dosya → fsync → rename), yani güç kesintisi
// ya eski ya yeni tutarlı sürümü bırakır, yarım dosya bırakmaz.
//
// Tüm durum AES-256-GCM ile şifrelidir: dosyayı kopyalayan biri anahtar olmadan
// hiçbir şey okuyamaz, kurcalarsa GCM çözümlemeyi reddeder.

import fs from 'node:fs/promises';
import path from 'node:path';
import { decrypt, encrypt, randomId } from './crypto.js';

export const STATE_VERSION = 2;

export function emptyState(now = new Date()) {
  return {
    version: STATE_VERSION,
    createdAt: now.toISOString(),
    panel: { name: 'Lumo Panel' },
    users: [],
    eggs: [], // kullanıcı tanımlı (özel) egg'ler; yerleşikler koddadır
    servers: [],
    allocations: [], // { port, serverId } — port havuzu defteri
    schedules: [],
    backups: [],
    audit: [],
  };
}

export class Store {
  #file;
  #key;
  #state = null;
  #queue = Promise.resolve();

  constructor({ file, key, aad = 'lumo:state' }) {
    this.#file = file;
    this.#key = key;
    this.aad = aad;
  }

  get file() {
    return this.#file;
  }

  get state() {
    if (!this.#state) throw new Error('Depo henüz yüklenmedi (await store.load()).');
    return this.#state;
  }

  async load() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    let raw;
    try {
      raw = await fs.readFile(this.#file);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.#state = emptyState();
        await this.save();
        return this.#state;
      }
      throw err;
    }
    let json;
    try {
      json = decrypt(this.#key, raw, this.aad).toString('utf8');
    } catch {
      throw new Error(
        `Durum dosyası çözülemedi: ${this.#file}\n` +
          'PANEL_MASTER_KEY yanlış ya da dosya bozulmuş olabilir. Yanlış anahtarla devam etmek veriyi kalıcı olarak bozar.',
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(`Durum dosyası bozuk JSON içeriyor: ${this.#file}`);
    }
    if (parsed.version !== STATE_VERSION) {
      throw new Error(
        `Beklenmeyen durum sürümü (${parsed.version}); bu panel sürümü ${STATE_VERSION} bekliyor.`,
      );
    }
    this.#state = { ...emptyState(), ...parsed };
    return this.#state;
  }

  /** Diske atomik yaz. Eşzamanlı çağrılar sıraya girer. */
  async save() {
    if (!this.#state) return;
    const blob = encrypt(this.#key, Buffer.from(JSON.stringify(this.#state), 'utf8'), this.aad);
    const tmp = `${this.#file}.${randomId('tmp-')}`;
    this.#queue = this.#queue.then(async () => {
      const handle = await fs.open(tmp, 'w', 0o600);
      try {
        await handle.write(blob);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.#file);
      await fs.chmod(this.#file, 0o600).catch(() => {});
    });
    return this.#queue;
  }

  /** Durumu değiştir ve kaydet. Mutator senkron olmalıdır. */
  async update(mutator) {
    const result = mutator(this.state);
    await this.save();
    return result;
  }
}

/** Denetim kaydı: kim, ne zaman, ne yaptı. Sır değerleri asla yazılmaz. */
export function audit(state, { actor, action, target, detail, ip }, limit = 2000) {
  state.audit.unshift({
    id: randomId('aud-'),
    at: new Date().toISOString(),
    actor: actor || 'sistem',
    action,
    target: target || null,
    detail: detail || null,
    ip: ip || null,
  });
  if (state.audit.length > limit) state.audit.length = limit;
}
