// Makine ve panel süreci istatistikleri.
//
// Linux'ta gerçek değerler okunur; başka platformlarda eksik alanlar null döner.
// Uydurma sayı göstermektense "bilinmiyor" demek daha dürüsttür.

import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export async function gpuInfo() {
  // 1. NVIDIA SMI (Cross-platform)
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 3000 },
    );
    const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const gpus = lines.map((line) => {
        const parts = line.split(',').map((s) => s.trim());
        const model = parts[0] || 'NVIDIA GPU';
        const totalMb = Number(parts[1]) || 0;
        const usedMb = Number(parts[2]) || 0;
        const freeMb = Number(parts[3]) || 0;
        return {
          model,
          totalVramBytes: totalMb * 1024 * 1024,
          usedVramBytes: usedMb * 1024 * 1024,
          freeVramBytes: freeMb * 1024 * 1024,
        };
      });
      const totalVramBytes = gpus.reduce((sum, g) => sum + g.totalVramBytes, 0);
      const usedVramBytes = gpus.reduce((sum, g) => sum + g.usedVramBytes, 0);
      return {
        available: true,
        gpus,
        totalVramBytes,
        usedVramBytes,
      };
    }
  } catch {
    // nvidia-smi bulunamadı
  }

  // 2. Windows (PowerShell Display Adapter Registry 64-bit VRAM + Win32_VideoController fallback)
  if (process.platform === 'win32') {
    try {
      const psCode = [
        'Get-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\00*" -ErrorAction SilentlyContinue |',
        'Where-Object { $_.DriverDesc } | ForEach-Object {',
        '  $v = if ($_.PSObject.Properties["HardwareInformation.qwMemorySize"]) { [int64]$_."HardwareInformation.qwMemorySize" } else { [int64]$_."HardwareInformation.MemorySize" };',
        '  [PSCustomObject]@{ model = [string]$_.DriverDesc; vramBytes = [int64]$v }',
        '} | ConvertTo-Json -Compress',
      ].join(' ');
      const encoded = Buffer.from(psCode, 'utf16le').toString('base64');
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 4000 });
      if (stdout && stdout.trim()) {
        const raw = JSON.parse(stdout.trim());
        const list = Array.isArray(raw) ? raw : [raw];
        const gpus = list
          .filter((item) => item && item.model && !/Remote Display|Basic Render|Mirror/i.test(item.model))
          .map((item) => ({
            model: String(item.model),
            totalVramBytes: Number(item.vramBytes) || 0,
            usedVramBytes: null,
            freeVramBytes: null,
          }));
        if (gpus.length > 0) {
          const totalVramBytes = gpus.reduce((sum, g) => sum + g.totalVramBytes, 0);
          return {
            available: true,
            gpus,
            totalVramBytes,
            usedVramBytes: null,
          };
        }
      }
    } catch {
      // Windows sorgusu başarısız olursa devam et
    }
  }

  // 3. Linux (sysfs DRM mem_info_vram_total)
  if (process.platform === 'linux') {
    try {
      const drmPath = '/sys/class/drm';
      const entries = await fs.readdir(drmPath).catch(() => []);
      const cards = entries.filter((name) => /^card\d+$/.test(name));
      const gpus = [];
      for (const card of cards) {
        const vramTotalFile = `${drmPath}/${card}/device/mem_info_vram_total`;
        const vramUsedFile = `${drmPath}/${card}/device/mem_info_vram_used`;
        const totalStr = await fs.readFile(vramTotalFile, 'utf8').catch(() => null);
        if (totalStr) {
          const total = Number(totalStr.trim()) || 0;
          const usedStr = await fs.readFile(vramUsedFile, 'utf8').catch(() => null);
          const used = usedStr ? Number(usedStr.trim()) || 0 : null;
          gpus.push({
            model: `GPU (${card})`,
            totalVramBytes: total,
            usedVramBytes: used,
            freeVramBytes: used !== null ? Math.max(0, total - used) : null,
          });
        }
      }
      if (gpus.length > 0) {
        const totalVramBytes = gpus.reduce((sum, g) => sum + g.totalVramBytes, 0);
        const usedVramBytes = gpus.some((g) => g.usedVramBytes !== null)
          ? gpus.reduce((sum, g) => sum + (g.usedVramBytes || 0), 0)
          : null;
        return {
          available: true,
          gpus,
          totalVramBytes,
          usedVramBytes,
        };
      }
    } catch {
      // Linux sysfs okunamadı
    }
  }

  return {
    available: false,
    gpus: [],
    totalVramBytes: 0,
    usedVramBytes: null,
    message: 'Harici GPU / Bağımsız VRAM algılanmadı (Sanal / Paylaşımlı Sistem Belleği)',
  };
}

export async function systemInfo({ dataDir, driver, dockerVersion }) {
  const cpus = os.cpus() || [];
  const [cpuPercent, disk, memory, gpu] = await Promise.all([
    panelCpuPercent(),
    diskUsage(dataDir),
    processMemory(),
    gpuInfo(),
  ]);
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
    gpu,
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
