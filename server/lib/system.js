import os from 'node:os';
import fs from 'node:fs';

/** Panelin çalıştığı makinenin anlık kaynak durumu. */
export function hostStats() {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpuModel: os.cpus()[0]?.model ?? 'bilinmiyor',
    cpuCount: os.cpus().length,
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memTotal,
    memFree,
    memUsed: memTotal - memFree,
    uptime: Math.round(os.uptime()),
    panelUptime: Math.round(process.uptime()),
    node: process.version,
    docker: hasDockerSocket(),
  };
}

function hasDockerSocket() {
  return process.platform !== 'win32' && fs.existsSync('/var/run/docker.sock');
}

/**
 * Tek bir alt süreç için bellek kullanımı. Linux dışında null döner
 * (macOS/Windows'ta /proc yok; panel yine sorunsuz çalışır, sadece bu alan boş kalır).
 */
export function procStats(pid) {
  if (!pid || os.platform() !== 'linux') return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    const threads = /Threads:\s+(\d+)/.exec(status);
    const memBytes = rss ? Number(rss[1]) * 1024 : null;
    return {
      memBytes,
      threads: threads ? Number(threads[1]) : null,
    };
  } catch {
    return null;
  }
}

export function humanBytes(n) {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(n);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
