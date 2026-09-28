// Docker sürücüsü.
//
// Panel konteyner başına izolasyon kurar. Amaç Pterodactyl'in Wings daemon'ının
// yaptığı işin küçük bir kısmını, ayrı bir süreç yazmadan yapmak: kaynak
// limitleri, salt-okunur kök dosya sistemi, düşürülmüş yetenekler, bot başına
// ayrı ağ ve yalnızca kendi dizinine mount.
//
// Sözleşme: hiçbir komut kabuk üzerinden geçmez; `execFile`/`spawn` ile argüman
// dizisi kullanılır, böylece sunucu adına yazılan metin komut çalıştıramaz.

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

export const CONTAINER_WORKDIR = '/home/container';

export function containerName(serverId) {
  return `lumo-${serverId}`;
}

export function networkName(serverId) {
  return `lumo-net-${serverId}`;
}

export function run(cmd, args, { timeoutMs = 60000, input = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? error?.message ?? ''),
        });
      },
    );
    if (input !== null && child.stdin) {
      child.stdin.end(input);
    }
  });
}

export async function dockerVersion() {
  const result = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15000 });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/** Windows'ta Docker Desktop ters eğik çizgi istemez. */
export function hostPathForMount(dir) {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/') : resolved;
}

/**
 * Container'ı çalıştıracak argümanları üretir.
 * `server`: {id, limits, allocation}, `egg`: {docker, variables...}
 */
export function containerArgs({
  server,
  egg,
  dir,
  env,
  command,
  name = containerName(server.id),
  network = null,
  readOnly = true,
  workdir = CONTAINER_WORKDIR,
  removeAfterExit = true,
}) {
  const limits = server.limits || {};
  const args = ['run', '--init'];
  if (removeAfterExit) args.push('--rm');
  args.push('-i', '--name', name);
  args.push('--label', `lumo.server=${server.id}`);
  args.push('--hostname', `lumo-${server.id}`);

  args.push('--memory', `${limits.memoryMb || 512}m`);
  args.push('--memory-swap', `${limits.memoryMb || 512}m`);
  args.push('--cpus', String(limits.cpu || 1));
  args.push('--pids-limit', String(limits.pids || 256));
  args.push('--blkio-weight', '500');

  args.push('--cap-drop', 'ALL');
  args.push('--security-opt', 'no-new-privileges:true');
  if (readOnly) {
    args.push('--read-only');
    args.push('--tmpfs', '/tmp:rw,size=128m');
  }

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    // Panel kullanıcısıyla aynı UID: mount edilen dizinde dosya sahipliği karışmasın.
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }

  if (network) args.push('--network', network);

  args.push('-v', `${hostPathForMount(dir)}:${workdir}`);
  args.push('-w', workdir);

  for (const [key, value] of Object.entries(env || {})) {
    args.push('-e', `${key}=${value}`);
  }

  if (server.allocation?.port) {
    const bind = server.allocation.bind || '127.0.0.1';
    args.push('-p', `${bind}:${server.allocation.port}:${server.allocation.port}`);
  }

  args.push(egg.docker.image);
  args.push('/bin/sh', '-c', command);
  return args;
}

/** Ağ yoksa oluşturur: her bot kendi köprüsünde, botlar birbirini göremez. */
export async function ensureNetwork(serverId) {
  const name = networkName(serverId);
  const inspect = await run('docker', ['network', 'inspect', name], { timeoutMs: 15000 });
  if (inspect.code === 0) return name;
  const created = await run('docker', ['network', 'create', name], { timeoutMs: 30000 });
  if (created.code !== 0) {
    const again = await run('docker', ['network', 'inspect', name], { timeoutMs: 15000 });
    if (again.code !== 0) throw new Error(`Docker ağı oluşturulamadı: ${created.stderr.trim()}`);
  }
  return name;
}

export async function removeNetwork(serverId) {
  await run('docker', ['network', 'rm', networkName(serverId)], { timeoutMs: 20000 });
}

export async function stopContainer(serverId, timeoutSeconds = 15) {
  return run('docker', ['stop', '-t', String(timeoutSeconds), containerName(serverId)], { timeoutMs: (timeoutSeconds + 20) * 1000 });
}

export async function killContainer(serverId) {
  return run('docker', ['kill', containerName(serverId)], { timeoutMs: 30000 });
}

export async function removeContainer(serverId) {
  return run('docker', ['rm', '-f', containerName(serverId)], { timeoutMs: 30000 });
}

const UNITS = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

export function parseSize(text) {
  const match = /^\s*([\d.]+)\s*([a-zA-Z]*)\s*$/.exec(String(text ?? ''));
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || 'b').toLowerCase();
  return Math.round(value * (UNITS[unit] ?? 1));
}

export function parseStatsLine(raw) {
  const [cpuRaw = '', memRaw = ''] = String(raw ?? '').trim().split('|');
  const [used, limit] = memRaw.split('/').map((part) => part.trim());
  const cpu = Number.parseFloat(cpuRaw.replace('%', '').trim());
  return {
    cpuPercent: Number.isFinite(cpu) ? cpu : null,
    memoryBytes: parseSize(used),
    memoryLimitBytes: parseSize(limit),
  };
}

/** `docker stats --no-stream` çıktısını tek seferde okur. */
export async function containerStats(serverId) {
  const result = await run(
    'docker',
    ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', containerName(serverId)],
    { timeoutMs: 15000 },
  );
  if (result.code !== 0) return null;
  const line = result.stdout.trim().split('\n')[0] || '';
  if (!line) return null;
  return parseStatsLine(line);
}

/**
 * Kurulum (install) komutunu ayrı bir konteynerde çalıştırır; Pterodactyl'in
 * "installer container" adımının karşılığı. Çıktı satır satır `onLog`a verilir.
 */
export function runInstall({ server, egg, dir, env, command, onLog }) {
  return new Promise((resolve) => {
    if (!command) {
      resolve({ code: 0, skipped: true });
      return;
    }
    const args = containerArgs({
      server,
      egg,
      dir,
      env,
      command,
      name: `lumo-install-${server.id}`,
      network: null,
      removeAfterExit: true,
    });
    const child = spawn('docker', args, { windowsHide: true });
    let lastLine = '';
    const handle = (chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i += 1) lastLine = lines[i];
      for (const line of text.split(/\r?\n/).filter((item) => item.length)) {
        onLog?.(line.replace(/\u0000/g, ''));
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => resolve({ code: 1, error: err.message, lastLine }));
    child.on('close', (code) => resolve({ code: code ?? 1, lastLine }));
  });
}
