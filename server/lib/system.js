// Makine ve panel süreci istatistikleri.
//
// Linux'ta gerçek değerler okunur; başka platformlarda eksik alanlar null döner.
// Uydurma sayı göstermektense "bilinmiyor" demek daha dürüsttür.

import fs from 'node:fs/promises';
import os from 'node:os';

async function cpuTimes() {
  try {
    const text = await fs.readFile('/proc/stat', 'utf8');
    const line = text.split('\n').find((item) => item.startsWith('cpu '));
    if (!line) return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((sum, value) => sum + value, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

let lastCpu = null;

export async function panelCpuPercent() {
  const current = await cpuTimes();
  if (!current) return null;
  const previous = lastCpu;
  lastCpu = current;
  if (!previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

export async function diskUsage(target) {
  try {
    const stat = await fs.statfs(target);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    return { totalBytes: total, freeBytes: free, usedBytes: total - free };
  } catch {
    return null;
  }
}

export async function processMemory() {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}

export async function systemInfo({ dataDir, driver, dockerVersion }) {
  const cpus = os.cpus() || [];
  const [cpuPercent, disk, memory] = await Promise.all([panelCpuPercent(), diskUsage(dataDir), processMemory()]);
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    node: process.version,
    cpuModel: cpus[0]?.model?.trim() || null,
    cpuCount: cpus.length,
    loadAvg: os.loadavg().map((value) => Number(value.toFixed(2))),
    uptimeSeconds: Math.round(os.uptime()),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    panel: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memoryBytes: memory.rssBytes,
      heapUsedBytes: memory.heapUsedBytes,
      cpuPercent,
    },
    disk,
    driver,
    docker: dockerVersion || null,
  };
}
