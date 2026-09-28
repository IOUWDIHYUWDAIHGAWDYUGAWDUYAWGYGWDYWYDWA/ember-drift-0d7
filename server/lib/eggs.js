// Egg (yumurta) şablonları — Pterodactyl'in "nest → egg → sunucu" mantığı.
//
// Bir egg şunları tanımlar: hangi Docker imajı, hangi kurulum komutu (bir kez),
// hangi başlangıç komutu, hangi ortam değişkenleri (bazıları sır), "başladı"
// çıktısını yakalayan desen ve varsayılan kaynak limitleri.
//
// Sunucu oluştururken egg seçilir; değişkenler doğrulanır, `{{DEGISKEN}}`
// yer tutucuları başlangıç komutunda doldurulur. Yerleşik egg'ler koddadır,
// yönetici kendi egg'lerini de ekleyebilir (state.eggs).

export const NESTS = [
  { id: 'discord', name: 'Discord Botları', description: 'discord.js / discord.py / benzeri botlar' },
  { id: 'runtime', name: 'Genel Çalışma Ortamları', description: 'Kendi başlangıç komutunu getir' },
];

// Node 20 `(?i)` satır içi bayrağını desteklemez; desenler her zaman `i`
// bayrağıyla derlenir (bkz. servers.js ve validateEggShape).
const DEFAULT_STARTUP_DETECTION = String.raw`\b(online|ready|logged in|connected as|listening on|bot hazır|hazır)\b`;

function variable(key, name, opts = {}) {
  return {
    key,
    name,
    description: opts.description ?? '',
    default: opts.default ?? '',
    required: opts.required ?? false,
    secret: opts.secret ?? false,
    rules: opts.rules ?? null,
  };
}

function egg(def) {
  return {
    stopSignal: 'SIGTERM',
    stopTimeoutSeconds: 15,
    startupTimeoutMs: 90000,
    restartPolicy: 'always',
    allocations: [],
    configFiles: {},
    builtin: true,
    ...def,
  };
}

export const BUILTIN_EGGS = [
  egg({
    id: 'discord-js',
    nest: 'discord',
    name: 'Node.js 20 — discord.js',
    description: 'Node 20 imajı, npm ile bağımlılık kurulumu, `npm start` başlangıcı.',
    docker: { image: 'node:20-alpine', workdir: '/home/container' },
    install: 'npm install --omit=dev --no-audit --no-fund',
    startup: 'npm start',
    startupDetection: DEFAULT_STARTUP_DETECTION,
    features: { memoryMb: 512, cpu: 1, diskMb: 2048, pids: 256 },
    allocations: [{ name: 'PORT', protocol: 'tcp', description: 'Botun web panosu / health endpoint portu (isteğe bağlı)' }],
    variables: [
      variable('DISCORD_TOKEN', 'Bot Token', {
        description: 'Discord Developer Portal → Bot → Token',
        required: true,
        secret: true,
        rules: /^[A-Za-z0-9_.-]{50,}$/,
      }),
      variable('DISCORD_GUILD_ID', 'Test sunucusu ID', { description: 'Komutların anında yükleneceği sunucu', secret: false }),
      variable('COMMAND_PREFIX', 'Komut öneki', { default: '!', secret: false }),
      variable('NODE_ENV', 'Node ortamı', { default: 'production', secret: false }),
      variable('TZ', 'Saat dilimi', { default: 'Europe/Istanbul', secret: false }),
    ],
  }),
  egg({
    id: 'discord-py',
    nest: 'discord',
    name: 'Python 3.12 — discord.py',
    description: 'Python 3.12 imajı, requirements.txt kurulumu, `python bot.py` başlangıcı.',
    docker: { image: 'python:3.12-alpine', workdir: '/home/container' },
    install: 'pip install --no-cache-dir -r requirements.txt',
    startup: 'python bot.py',
    startupDetection: DEFAULT_STARTUP_DETECTION,
    features: { memoryMb: 512, cpu: 1, diskMb: 2048, pids: 256 },
    variables: [
      variable('DISCORD_TOKEN', 'Bot Token', { required: true, secret: true }),
      variable('PYTHONUNBUFFERED', 'Çıktıyı arabelleksizleştir', { default: '1', secret: false }),
      variable('TZ', 'Saat dilimi', { default: 'Europe/Istanbul', secret: false }),
    ],
  }),
  egg({
    id: 'node-service',
    nest: 'runtime',
    name: 'Node.js servis (kendi komutun)',
    description: 'Şablonsuz Node çalıştırıcısı: başlangıç komutunu sunucu bazında yazarsın.',
    docker: { image: 'node:20-alpine', workdir: '/home/container' },
    install: null,
    startup: 'node index.js',
    startupDetection: DEFAULT_STARTUP_DETECTION,
    features: { memoryMb: 512, cpu: 1, diskMb: 1024, pids: 256 },
    allocations: [{ name: 'PORT', protocol: 'tcp', description: 'Servisin dinleyeceği port' }],
    variables: [
      variable('TZ', 'Saat dilimi', { default: 'Europe/Istanbul', secret: false }),
      variable('CUSTOM_SECRET', 'Ek sır', { secret: true, required: false }),
    ],
  }),
  egg({
    id: 'debian-shell',
    nest: 'runtime',
    name: 'Debian — serbest komut',
    description: 'Boş bir Debian ortamı; başlangıç komutunda ne yazarsan o çalışır.',
    docker: { image: 'debian:bookworm-slim', workdir: '/home/container' },
    install: null,
    startup: 'bash -c "while true; do echo \\"Lumo: boş ortam çalışıyor\\"; sleep 60; done"',
    features: { memoryMb: 256, cpu: 0.5, diskMb: 1024, pids: 128 },
    variables: [variable('TZ', 'Saat dilimi', { default: 'Europe/Istanbul', secret: false })],
  }),
];

export function validateEggShape(input, { allowBuiltinId = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Egg tanımı bir nesne olmalı.');
  const id = String(input.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) {
    throw new Error('Egg kimliği küçük harf, rakam ve tire içerebilir (2-41 karakter).');
  }
  if (!allowBuiltinId && BUILTIN_EGGS.some((item) => item.id === id)) {
    throw new Error(`"${id}" yerleşik bir egg; başka bir kimlik seç.`);
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Egg adı gerekli.');
  const nest = String(input.nest ?? 'runtime').trim();
  if (!NESTS.some((item) => item.id === nest)) throw new Error(`Bilinmeyen nest: ${nest}`);
  const image = String(input.docker?.image ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) throw new Error('Geçerli bir Docker imajı yaz (örn. node:20-alpine).');
  const startup = String(input.startup ?? '').trim();
  if (!startup) throw new Error('Başlangıç komutu gerekli.');
  if (startup.length > 4096) throw new Error('Başlangıç komutu çok uzun.');
  const startupDetection = String(input.startupDetection ?? DEFAULT_STARTUP_DETECTION);
  try {
    new RegExp(startupDetection, 'i');
  } catch {
    throw new Error('Başlangıç tespiti deseni geçerli bir düzenli ifade değil.');
  }
  const variables = Array.isArray(input.variables) ? input.variables : [];
  const seen = new Set();
  const normalizedVariables = variables.map((item) => {
    const key = String(item.key ?? '').trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key)) throw new Error(`Geçersiz değişken adı: ${item.key}`);
    if (seen.has(key)) throw new Error(`Değişken iki kez tanımlanmış: ${key}`);
    seen.add(key);
    return {
      key,
      name: String(item.name ?? key).trim(),
      description: String(item.description ?? ''),
      default: String(item.default ?? ''),
      required: Boolean(item.required),
      secret: Boolean(item.secret),
      rules: null,
    };
  });
  return {
    id,
    nest,
    name,
    description: String(input.description ?? '').trim(),
    author: String(input.author ?? '').trim() || null,
    docker: { image, workdir: '/home/container' },
    install: input.install ? String(input.install) : null,
    startup,
    startupDetection,
    stopSignal: 'SIGTERM',
    stopTimeoutSeconds: clampNumber(input.stopTimeoutSeconds, 5, 300, 15),
    startupTimeoutMs: clampNumber(input.startupTimeoutMs, 5000, 900000, 90000),
    restartPolicy: ['always', 'on-failure', 'never'].includes(input.restartPolicy) ? input.restartPolicy : 'always',
    features: {
      memoryMb: clampNumber(input.features?.memoryMb, 128, 65536, 512),
      cpu: clampNumber(input.features?.cpu, 0.1, 32, 1),
      diskMb: clampNumber(input.features?.diskMb, 64, 1048576, 2048),
      pids: clampNumber(input.features?.pids, 32, 32768, 256),
    },
    variables: normalizedVariables,
    allocations: Array.isArray(input.allocations)
      ? input.allocations.slice(0, 4).map((item) => ({
          name: String(item.name ?? 'PORT').toUpperCase(),
          protocol: item.protocol === 'udp' ? 'udp' : 'tcp',
          description: String(item.description ?? ''),
        }))
      : [],
    configFiles: {},
    builtin: false,
  };
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function allEggs(customEggs = []) {
  return [...BUILTIN_EGGS, ...customEggs];
}

export function findEgg(id, customEggs = []) {
  return allEggs(customEggs).find((item) => item.id === id) || null;
}

/** Egg'de tanımlı olmayan değişkenler de kabul edilir (serbest ortam değişkeni). */
export function eggVariableMap(egg) {
  const map = new Map();
  for (const item of egg.variables || []) map.set(item.key, item);
  return map;
}

export function sanitizeVariables(egg, provided = {}) {
  const defined = eggVariableMap(egg);
  const values = {};
  const errors = [];
  const custom = {};

  for (const item of egg.variables || []) {
    const raw = provided[item.key];
    const value = raw === undefined || raw === null ? item.default : String(raw);
    if (item.required && !value.trim()) errors.push(`${item.name} (${item.key}) zorunlu.`);
    if (value && item.rules && !item.rules.test(value)) {
      errors.push(`${item.name} (${item.key}) beklenen biçimde değil.`);
    }
    values[item.key] = value;
  }

  for (const [key, value] of Object.entries(provided || {})) {
    const normalized = String(key).trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(normalized)) {
      errors.push(`Geçersiz değişken adı: ${key}`);
      continue;
    }
    if (defined.has(normalized)) continue;
    custom[normalized] = String(value ?? '');
  }

  return { values, custom, errors };
}

/** `{{DEGISKEN}}` yer tutucularını doldurur. */
export function renderTemplate(template, values) {
  return String(template ?? '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = values[key];
    return value === undefined ? '' : String(value);
  });
}

/** Egg'in beklediği zorunlu değişkenler doldurulmuş mu? */
export function missingRequired(egg, values = {}) {
  return (egg.variables || [])
    .filter((item) => item.required && !String(values[item.key] ?? '').trim())
    .map((item) => item.key);
}

/** API'ye dönerken sır değerlerini maskele. */
export function maskVariables(egg, values) {
  const out = { ...values };
  for (const item of egg.variables || []) {
    if (item.secret && out[item.key]) out[item.key] = '••••••••';
  }
  return out;
}

export { DEFAULT_STARTUP_DETECTION };
