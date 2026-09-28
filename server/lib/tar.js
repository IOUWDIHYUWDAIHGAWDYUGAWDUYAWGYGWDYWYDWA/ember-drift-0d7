// Saf Node tar (ustar + GNU uzun ad) yazıcı/okuyucu.
//
// Yedekler için dışarıdan `tar` ikilisine güvenmek istemedik: Windows'ta Git Bash
// olmadan tar yok, Alpine'de busybox tar var ama farklı davranıyor. 200 satır
// kod, her yerde aynı sonuç.
//
// Yol güvenliği: çıkarırken mutlak yollar, `..` bileşenleri ve sürücü harfleri
// reddedilir. Yedek dosyası kurcalanmış olsa bile dizin dışına yazılamaz.

import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;

function octal(value, length) {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  return `${text}\0`;
}

function headerBlock({ name, size, mode = 0o644, type = '0', mtime = Date.now() }) {
  const buf = Buffer.alloc(BLOCK);
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) throw new Error(`tar giriş adı çok uzun: ${name}`);
  nameBuf.copy(buf, 0);
  buf.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii');
  buf.write(octal(0, 8), 116, 8, 'ascii');
  buf.write(octal(size, 12), 124, 12, 'ascii');
  buf.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii');
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

function padding(size) {
  const rest = size % BLOCK;
  return rest === 0 ? 0 : BLOCK - rest;
}

/** Uzun adları GNU `L` kaydıyla taşır (bsdtar ve GNU tar bunu destekler). */
function longNameBlocks(name) {
  const data = Buffer.from(`${name}\0`, 'utf8');
  return [
    headerBlock({ name: '././@LongLink', size: data.length, mode: 0o644, type: 'L' }),
    data,
    Buffer.alloc(padding(data.length)),
  ];
}

/**
 * entries: [{ name, data (Buffer), mode, type ('0' dosya | '5' dizin) }]
 * Dizinler için data boş olmalıdır.
 */
export function createTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const isDir = entry.type === '5' || entry.dir === true;
    const data = isDir ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    let name = String(entry.name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (isDir && !name.endsWith('/')) name += '/';
    const bytes = Buffer.byteLength(name, 'utf8');
    let headerName = name;
    if (bytes > 100) {
      // ustar alanı 100 bayttır; tam ad GNU `L` kaydında taşınır.
      parts.push(...longNameBlocks(name));
      headerName = Buffer.from(name, 'utf8').subarray(0, 100).toString('utf8').replace(/\uFFFD+$/, '');
    }
    parts.push(
      headerBlock({
        name: headerName,
        size: data.length,
        mode: entry.mode ?? (isDir ? 0o755 : 0o644),
        type: isDir ? '5' : '0',
        mtime: entry.mtime,
      }),
    );
    if (!isDir) {
      parts.push(data);
      const pad = padding(data.length);
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // arşiv sonu
  return Buffer.concat(parts);
}

export function createTarGz(entries) {
  return gzipSync(createTar(entries), { level: 6 });
}

function readString(buf, offset, length) {
  const end = buf.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return buf.toString('utf8', offset, stop);
}

function readOctal(buf, offset, length) {
  const text = readString(buf, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Arşivden çıkan giriş adını güvenli hâle getirir; şüpheliyse null döner. */
export function safeEntryName(rawName) {
  let name = String(rawName ?? '').replace(/\\/g, '/').trim();
  name = name.replace(/^\.\//, '');
  if (!name || name === '/') return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = [];
  for (const piece of name.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') return null;
    parts.push(piece);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}

/**
 * tar.gz içeriğini çıkarır.
 * Dönen değer: [{ name, type: 'file'|'dir', mode, data }]
 * Desteklenmeyen kayıt türleri (sembolik bağ, cihaz) sessizce atlanır.
 */
export function extractTarGz(buffer) {
  const tar = gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  let pendingName = null;
  let zeroBlocks = 0;

  const readPayload = (size) => {
    const start = offset;
    offset += size + padding(size);
    return tar.subarray(start, start + size);
  };

  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (block.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] || 0x30);
    const rawName = readString(block, 0, 100);

    if (type === 'L') {
      pendingName = readPayload(size).toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x' || type === 'g' || type === 'X') {
      readPayload(size); // PAX başlıkları: bu panel kendi arşivlerini okur, atla
      continue;
    }
    const name = safeEntryName(pendingName ?? rawName);
    pendingName = null;
    if (type === '5') {
      readPayload(size);
      if (name) entries.push({ name, type: 'dir', mode: readOctal(block, 100, 8) });
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') {
      readPayload(size);
      continue;
    }
    const data = readPayload(size);
    if (name) entries.push({ name, type: 'file', mode: readOctal(block, 100, 8), data });
  }
  return entries;
}
