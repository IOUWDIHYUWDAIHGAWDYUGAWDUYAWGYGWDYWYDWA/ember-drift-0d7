import fs from 'node:fs';
import path from 'node:path';
import { encrypt, decrypt, randomId } from './crypto.js';

const EMPTY = {
  version: 1,
  users: [],
  bots: [],
  audit: [],
};

/**
 * Tüm panel durumu (kullanıcılar, bot tanımları, bot .env sırları) diske
 * AES-256-GCM ile şifrelenmiş TEK bir dosya olarak yazılır.
 * Dosyayı kopyalayan biri ana anahtar olmadan hiçbir şey okuyamaz.
 */
export class Store {
  #file;
  #key;
  #data;

  constructor({ file, key }) {
    this.#file = file;
    this.#key = key;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#data = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.#file)) return structuredClone(EMPTY);
    const raw = fs.readFileSync(this.#file, 'utf8').trim();
    if (!raw) return structuredClone(EMPTY);
    let parsed;
    try {
      parsed = JSON.parse(decrypt(this.#key, raw));
    } catch (err) {
      throw new Error(
        `Veri dosyası çözülemedi (${this.#file}). PANEL_MASTER_KEY yanlış olabilir. Detay: ${err.message}`,
      );
    }
    return { ...structuredClone(EMPTY), ...parsed };
  }

  get data() {
    return this.#data;
  }

  get file() {
    return this.#file;
  }

  /** Atomik yazma: önce .tmp, sonra rename. Kesintide dosya bozulmaz. */
  save() {
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const payload = encrypt(this.#key, JSON.stringify(this.#data));
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
    try {
      fs.chmodSync(this.#file, 0o600);
    } catch {
      /* Windows'ta chmod sınırlı; sorun değil */
    }
  }

  /** Denetim kaydı: sadece son 500 olay tutulur, sır içermez. */
  audit(action, { actor = 'system', detail = '' } = {}) {
    this.#data.audit.unshift({
      id: randomId('a_'),
      at: new Date().toISOString(),
      actor,
      action,
      detail: String(detail).slice(0, 300),
    });
    this.#data.audit = this.#data.audit.slice(0, 500);
  }
}
