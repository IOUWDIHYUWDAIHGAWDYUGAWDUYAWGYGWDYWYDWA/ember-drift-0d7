// Lumo Panel arayüzü — Pterodactyl esintili, bağımlılıksız modern SPA.
//
// Kurallar: satır içi script/stil yok (CSP uyumlu), tüm kullanıcı verisi HTML'e
// yazılmadan önce kaçırılır, olay yönetimi tek bir delege dinleyiciyle yapılır.

const state = {
  me: null,
  servers: [],
  eggs: [],
  nests: [],
  selectedId: null,
  detail: null,
  tab: 'konsol',
  files: { path: '', items: [], editing: null, isBinary: false },
  backups: [],
  schedules: [],
  audit: [],
  users: [],
  system: null,
  pool: null,
  stream: null,
  logs: [],
  searchQuery: '',
};

// --- İkon Kütüphanesi (Temiz ve Hafif Inline SVG) ---------------------------

const ICONS = {
  terminal: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
  folder: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  users: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
  archive: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`,
  globe: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  playCircle: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
  settings: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  clipboard: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>`,
  server: `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,
  play: `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
  rotate: `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`,
  square: `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`,
  zap: `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`,
  cpu: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>`,
  database: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`,
  hardDrive: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>`,
  activity: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
  logo: `<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
};

// --- Yardımcılar ------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) throw new Error(data.error || `İstek başarısız (${res.status})`);
  return data;
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3200);
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return `${days}g ${hours}sa`;
  if (hours) return `${hours}sa ${minutes}dk`;
  if (minutes) return `${minutes}dk ${seconds}sn`;
  return `${seconds}sn`;
}

function fmtDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('tr-TR');
  } catch {
    return String(value);
  }
}

function statusLabel(status) {
  const map = {
    running: 'Çalışıyor',
    starting: 'Başlatılıyor',
    installing: 'Kuruluyor',
    stopping: 'Durduruluyor',
    crashed: 'Çöktü',
    suspended: 'Askıda',
    offline: 'Durduruldu',
  };
  return map[status] || status;
}

function statusBadge(status) {
  return `<span class="status-badge ${esc(status)}"><span class="status-dot"></span><span>${esc(statusLabel(status))}</span></span>`;
}

// CSP style-src 'self' satır içi style="..." özniteliğini engeller; genişlikler CSSOM ile uygulanır.
function applyBarWidths(root = document) {
  root.querySelectorAll('.bar-fill[data-pct], .bar > span[data-pct]').forEach((el) => {
    const pct = Math.max(0, Math.min(100, Number(el.dataset.pct) || 0));
    el.style.width = `${pct}%`;
  });
}

function selectedServer() {
  return state.servers.find((item) => item.id === state.selectedId) || null;
}

// --- Ana Kabuk ve Üst Navigasyon --------------------------------------------

function renderShell() {
  document.body.innerHTML = `
    <div class="topbar">
      <div class="brand" data-action="goto-servers" title="Sunucu listesine dön">
        ${ICONS.logo}
        <span>Lumo</span>
      </div>
      <div class="breadcrumb-nav" id="topbarNav"></div>
      <span class="spacer"></span>
      <div id="hostStats" class="host-stats-chip"></div>
      <div class="user-badge" id="whoami"></div>
      <button class="ghost small" data-action="refresh" title="Yenile">${ICONS.refresh} Yenile</button>
      <button class="ghost small" data-action="logout">Çıkış</button>
    </div>
    <div class="layout">
      <div class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">Sunucular (${state.servers.length})</span>
          <button class="primary small" data-action="new-server" id="newServerBtn" title="Yeni bot / servis oluştur">${ICONS.plus} Yeni</button>
        </div>
        <div id="serverList"></div>
        <div class="spacer"></div>
        <div id="poolInfo" class="meta-tag mono mt"></div>
      </div>
      <div class="main" id="main"></div>
    </div>`;
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  const list = document.getElementById('serverList');
  if (!list) return;
  if (state.servers.length === 0) {
    list.innerHTML = `<div class="small muted mt">Henüz sunucu yok. “+ Yeni” ile bir şablon seçip botunu kur.</div>`;
  } else {
    list.innerHTML = state.servers
      .map((server) => `
        <button class="server-item ${server.id === state.selectedId ? 'active' : ''}" data-action="select-server" data-id="${esc(server.id)}">
          <div class="server-item-row">
            <span class="name">${esc(server.name)}</span>
            <span class="status-dot ${esc(server.status)}"></span>
          </div>
          <span class="meta">${esc(server.eggName)}${server.allocation ? ` · :${server.allocation.port}` : ''}</span>
        </button>`)
      .join('');
  }
  const pool = document.getElementById('poolInfo');
  if (pool && state.pool) {
    pool.textContent = `Portlar: ${state.pool.usage.used}/${state.pool.usage.total} dolu (${state.pool.range.min}-${state.pool.range.max})`;
  }
  const button = document.getElementById('newServerBtn');
  if (button) button.style.display = state.me?.role === 'admin' ? '' : 'none';
}

function renderTopbar() {
  const nav = document.getElementById('topbarNav');
  if (nav) {
    if (state.selectedId && state.detail) {
      nav.innerHTML = `
        <span class="breadcrumb-sep">/</span>
        <span class="breadcrumb-link" data-action="goto-servers">Sunucular</span>
        <span class="breadcrumb-sep">/</span>
        <span class="breadcrumb-current">${esc(state.detail.name)}</span>`;
    } else {
      nav.innerHTML = `
        <span class="breadcrumb-sep">/</span>
        <span class="breadcrumb-current">Sunucular</span>`;
    }
  }

  const stats = document.getElementById('hostStats');
  if (stats && state.system) {
    const memPct = Math.round(((state.system.totalMemoryBytes - state.system.freeMemoryBytes) / state.system.totalMemoryBytes) * 100);
    const vramStr = state.system.gpu?.available ? ` · vram ${fmtBytes(state.system.gpu.totalVramBytes)}` : '';
    stats.innerHTML = `
      <span>yük ${esc(state.system.loadAvg.join(' '))}</span>
      <span>·</span>
      <span>ram ${memPct}%</span>
      ${vramStr ? `<span>·</span><span class="ok" style="font-weight: 600;">vram ${fmtBytes(state.system.gpu.totalVramBytes)}</span>` : ''}
      <span>·</span>
      <span>${state.system.counts.running}/${state.system.counts.servers} aktif</span>`;
  }

  const who = document.getElementById('whoami');
  if (who && state.me) {
    const initial = (state.me.username || 'U')[0].toUpperCase();
    who.innerHTML = `
      <span class="user-avatar">${esc(initial)}</span>
      <span>${esc(state.me.username)}</span>
      <span class="user-role-badge ${esc(state.me.role)}">${esc(state.me.role)}</span>`;
  }
}

// --- Ana İçerik ve Pterodactyl Sunucu Arayüzü -------------------------------

function renderMain() {
  const main = document.getElementById('main');
  if (!main) return;
  renderTopbar();

  if (!state.selectedId) {
    renderDashboard(main);
    return;
  }

  if (!state.detail) {
    main.innerHTML = '<div class="pter-card muted">Sunucu yükleniyor…</div>';
    return;
  }

  const server = state.detail;
  const isOffline = server.status === 'offline';
  const isRunning = server.status === 'running';
  const isStarting = server.status === 'starting';

  // Yüzdeler
  const memUsed = server.stats.memoryBytes || 0;
  const memTotal = server.stats.memoryLimitBytes || (server.limits.memoryMb * 1024 * 1024) || 1;
  const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));
  const memClass = memPct > 90 ? 'danger' : memPct > 75 ? 'warn' : '';

  const diskUsed = server.stats.diskBytes || 0;
  const diskTotal = server.stats.diskLimitBytes || (server.limits.diskMb * 1024 * 1024) || 1;
  const diskPct = Math.min(100, Math.round((diskUsed / diskTotal) * 100));
  const diskClass = diskPct > 90 ? 'danger' : diskPct > 75 ? 'warn' : '';

  const cpuPct = Math.min(100, Math.round(server.stats.cpuPercent || 0));
  const cpuClass = cpuPct > 90 ? 'danger' : cpuPct > 70 ? 'warn' : '';

  // Pterodactyl Menü Sekmeleri
  const tabs = [
    ['konsol', 'Konsol', ICONS.terminal],
    ['dosyalar', 'Dosyalar', ICONS.folder],
    ['gorevler', 'Zamanlanmış Görevler', ICONS.clock],
    ['kullanicilar', 'Kullanıcılar', ICONS.users],
    ['yedekler', 'Yedekler', ICONS.archive],
    ['ag', 'Ağ & Portlar', ICONS.globe],
    ['baslangic', 'Başlangıç & Değişkenler', ICONS.playCircle],
    ['ayarlar', 'Ayarlar & Limitler', ICONS.settings],
  ];
  if (state.me?.role !== 'viewer') {
    tabs.push(['denetim', 'Aktivite Kaydı', ICONS.clipboard]);
  }
  if (state.me?.role === 'admin') {
    tabs.push(['sistem', 'Sistem & Şablonlar', ICONS.server]);
  }

  main.innerHTML = `
    <!-- Pterodactyl Server Header -->
    <div class="server-header">
      <div class="server-header-main">
        <div class="server-title-wrap">
          <h2 class="server-title">${esc(server.name)}</h2>
          <div class="server-meta-tags">
            ${statusBadge(server.status)}
            <span class="meta-tag mono">${esc(server.eggName)}</span>
            ${server.allocation ? `<span class="meta-tag mono" title="Tıklayınca kopyalar" data-action="copy-text" data-text="127.0.0.1:${server.allocation.port}">:${server.allocation.port}</span>` : ''}
            ${server.suspended ? `<span class="meta-tag danger">ASKIDA: ${esc(server.suspendReason || '')}</span>` : ''}
            ${server.lastError ? `<span class="meta-tag danger">Hata: ${esc(server.lastError)}</span>` : ''}
          </div>
        </div>
        <div class="power-actions">
          <button class="btn-power btn-power-start" data-action="power" data-power="start" ${isRunning || isStarting ? 'disabled' : ''}>
            ${ICONS.play} <span>Başlat</span>
          </button>
          <button class="btn-power btn-power-restart" data-action="power" data-power="restart" ${isOffline ? 'disabled' : ''}>
            ${ICONS.rotate} <span>Yeniden Başlat</span>
          </button>
          <button class="btn-power btn-power-stop" data-action="power" data-power="stop" ${isOffline ? 'disabled' : ''}>
            ${ICONS.square} <span>Durdur</span>
          </button>
          <button class="btn-power btn-power-kill" data-action="power" data-power="kill" ${isOffline ? 'disabled' : ''}>
            ${ICONS.zap} <span>Zorla Kapat</span>
          </button>
        </div>
      </div>

      <!-- Pterodactyl 4 Metric Cards -->
      <div class="server-metrics-grid">
        <div class="metric-card">
          <div class="metric-icon-wrap">${ICONS.database}</div>
          <div class="metric-content">
            <div class="metric-label">BELLEK KULLANIMI</div>
            <div class="metric-value mono">${fmtBytes(memUsed)} <span class="metric-max">/ ${fmtBytes(memTotal)}</span></div>
            <div class="bar-track"><div class="bar-fill ${memClass}" data-pct="${memPct}"></div></div>
          </div>
        </div>

        <div class="metric-card">
          <div class="metric-icon-wrap">${ICONS.cpu}</div>
          <div class="metric-content">
            <div class="metric-label">CPU YÜKÜ</div>
            <div class="metric-value mono">${server.stats.cpuPercent === null || server.stats.cpuPercent === undefined ? '0.0%' : `${server.stats.cpuPercent.toFixed(1)}%`} <span class="metric-max">/ ${server.limits.cpu} Çekirdek</span></div>
            <div class="bar-track"><div class="bar-fill ${cpuClass}" data-pct="${cpuPct}"></div></div>
          </div>
        </div>

        <div class="metric-card">
          <div class="metric-icon-wrap">${ICONS.hardDrive}</div>
          <div class="metric-content">
            <div class="metric-label">DİSK ALANI</div>
            <div class="metric-value mono">${fmtBytes(diskUsed)} <span class="metric-max">/ ${fmtBytes(diskTotal)}</span></div>
            <div class="bar-track"><div class="bar-fill ${diskClass}" data-pct="${diskPct}"></div></div>
          </div>
        </div>

        <div class="metric-card">
          <div class="metric-icon-wrap">${ICONS.activity}</div>
          <div class="metric-content">
            <div class="metric-label">ÇALIŞMA & AĞ</div>
            <div class="metric-value mono">${fmtDuration(server.uptimeMs)}</div>
            <div class="metric-sub mono">${server.allocation ? `Port: :${server.allocation.port}` : 'Port: Yok'} · Çökme: ${server.crashCount}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Pterodactyl Sub-Navigation Tabs Bar -->
    <div class="server-subnav">
      ${tabs
        .map(
          ([id, label, iconSvg]) => `
        <button data-action="tab" data-tab="${id}" class="subnav-item ${state.tab === id ? 'active' : ''}">
          <span class="subnav-icon">${iconSvg}</span>
          <span>${esc(label)}</span>
        </button>`,
        )
        .join('')}
    </div>
    <div id="tabBody"></div>`;

  renderTab();
  applyBarWidths(main);
}

// --- Dashboard (Tüm Sunucular Genel Görünümü) ------------------------------

function renderDashboard(main) {
  const runningCount = state.servers.filter((s) => s.status === 'running').length;
  const filteredServers = state.servers.filter((s) => {
    if (!state.searchQuery) return true;
    const q = state.searchQuery.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.eggName.toLowerCase().includes(q);
  });

  main.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Sunucu Kontrol Paneli</h3>
          <p class="muted small">Lumo altyapısındaki botlarınızı ve servislerinizi izole Docker konteynerlerinde yönetin.</p>
        </div>
        ${state.me?.role === 'admin' ? `<button class="primary" data-action="new-server">${ICONS.plus} Yeni Sunucu Oluştur</button>` : ''}
      </div>
      <div class="grid-3 mt">
        <div class="metric-card">
          <div class="metric-icon-wrap">${ICONS.server}</div>
          <div class="metric-content">
            <div class="metric-label">TOPLAM SUNUCU</div>
            <div class="metric-value mono">${state.servers.length} Adet <span class="metric-max">· ${runningCount} Çalışıyor</span></div>
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-icon-wrap">${ICONS.cpu}</div>
          <div class="metric-content">
            <div class="metric-label">SİSTEM VRAM / GPU</div>
            <div class="metric-value mono">${state.system?.gpu?.available ? `${fmtBytes(state.system.gpu.totalVramBytes)}` : 'Paylaşımlı (0 B)'} <span class="metric-max">${state.system?.gpu?.available ? 'Özel VRAM' : 'Sanal GPU'}</span></div>
            <div class="metric-sub mono">${esc(state.system?.gpu?.gpus?.[0]?.model || state.system?.gpu?.message || 'Harici VRAM Yok')}</div>
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-icon-wrap">${ICONS.globe}</div>
          <div class="metric-content">
            <div class="metric-label">PORT HAVUZU</div>
            <div class="metric-value mono">${state.pool ? `${state.pool.usage.free} Boş Port` : '—'} <span class="metric-max">/ ${state.pool ? state.pool.usage.total : '—'} Toplam</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="row mt" style="margin-bottom: 1rem;">
      <input id="serverSearch" class="grow" placeholder="Sunucu adı veya şablon ile ara..." value="${esc(state.searchQuery)}" />
    </div>

    <div class="dashboard-servers-grid">
      ${filteredServers
        .map((server) => {
          const memMb = Math.round((server.stats?.memoryBytes || 0) / (1024 * 1024));
          const diskMb = Math.round((server.stats?.diskBytes || 0) / (1024 * 1024));
          return `
          <div class="server-card-box" data-action="select-server" data-id="${esc(server.id)}">
            <div class="server-card-top">
              <div>
                <h4 class="server-card-name">${esc(server.name)}</h4>
                <div class="server-card-egg">${esc(server.eggName)}${server.allocation ? ` · :${server.allocation.port}` : ''}</div>
              </div>
              ${statusBadge(server.status)}
            </div>
            <div class="server-card-metrics">
              <div class="server-card-metric-item">
                <span class="server-card-metric-label">RAM</span>
                <span class="server-card-metric-val">${memMb} / ${server.limits.memoryMb}M</span>
              </div>
              <div class="server-card-metric-item">
                <span class="server-card-metric-label">CPU</span>
                <span class="server-card-metric-val">${server.stats?.cpuPercent === null || server.stats?.cpuPercent === undefined ? '0%' : `${server.stats.cpuPercent.toFixed(1)}%`}</span>
              </div>
              <div class="server-card-metric-item">
                <span class="server-card-metric-label">DİSK</span>
                <span class="server-card-metric-val">${diskMb} / ${server.limits.diskMb}M</span>
              </div>
            </div>
            <div class="row">
              <span class="small muted mono">Açık: ${fmtDuration(server.uptimeMs)}</span>
              <span class="spacer"></span>
              <button class="ghost small">Yönet →</button>
            </div>
          </div>`;
        })
        .join('') || '<div class="muted small">Eşleşen sunucu bulunamadı.</div>'}
    </div>`;

  const searchInput = document.getElementById('serverSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderDashboard(main);
    });
  }
}

// --- Sekme Yönlendirme ------------------------------------------------------

function renderTab(refresh = true) {
  const body = document.getElementById('tabBody');
  if (!body) return;
  const server = state.detail;
  if (!server) return;

  const renderers = {
    konsol: renderConsole,
    dosyalar: renderFiles,
    gorevler: renderSchedulesTab,
    kullanicilar: renderUsersTab,
    yedekler: renderBackupsTab,
    ag: renderNetworkTab,
    baslangic: renderStartupTab,
    ayarlar: renderSettingsTab,
    denetim: renderAuditTab,
    sistem: renderSystemTab,
  };

  (renderers[state.tab] || renderConsole)(body, server, refresh);
  applyBarWidths(body);
}

// --- 1. Konsol Sekmesi (Pterodactyl Terminal) --------------------------------

function renderConsole(body, server) {
  const readOnly = state.me?.role === 'viewer';
  body.innerHTML = `
    <div class="console-wrapper">
      <div class="console-header">
        <div class="console-live-badge">
          <span class="status-dot running"></span>
          <span>CANLI AKIŞ (SSE)</span>
        </div>
        <div class="row">
          <button class="ghost small" data-action="clear-console">Konsolu Temizle</button>
          <button class="ghost small" data-action="power" data-power="install" ${readOnly ? 'disabled' : ''}>Kurulumu Çalıştır</button>
        </div>
      </div>
      <div class="console-body" id="console"></div>
      <form data-form="console" class="console-input-bar">
        <span class="console-prompt-sym">&gt;_</span>
        <input name="command" class="console-input" placeholder="Konsola komut gönder (örn. /ping, stop)..." autocomplete="off" ${readOnly ? 'disabled' : ''} />
        <button class="primary small" type="submit" ${readOnly ? 'disabled' : ''}>Gönder</button>
      </form>
    </div>`;

  const consoleEl = document.getElementById('console');
  for (const entry of state.logs) appendLog(consoleEl, entry);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function appendLog(target, entry) {
  if (!target) return;
  const line = document.createElement('div');
  line.className = 'line';
  const time = entry.at ? new Date(entry.at).toLocaleTimeString('tr-TR') : '';
  const streamCls = entry.stream === 'err' ? 'err' : entry.stream === 'in' ? 'in' : entry.line?.startsWith('[lumo]') ? 'sys' : '';

  line.innerHTML = `<span class="time">[${esc(time)}]</span><span class="${streamCls}">${esc(entry.line)}</span>`;
  target.appendChild(line);

  const max = 1500;
  while (target.childElementCount > max) target.removeChild(target.firstChild);
  target.scrollTop = target.scrollHeight;
}

// --- 2. Dosya Yöneticisi (Pterodactyl File Manager) --------------------------

function renderFiles(body, server, refresh) {
  const files = state.files;
  const readOnly = state.me?.role === 'viewer';

  // Tıklanabilir Breadcrumb Gezintisi
  const segments = (files.path || '').split('/').filter(Boolean);
  let accumulated = '';
  const crumbsHtml = [
    `<span class="breadcrumb-link" data-action="files-open" data-path="">/ (kök)</span>`,
    ...segments.map((seg) => {
      accumulated = accumulated ? `${accumulated}/${seg}` : seg;
      return `<span class="breadcrumb-sep">/</span><span class="breadcrumb-link" data-action="files-open" data-path="${esc(accumulated)}">${esc(seg)}</span>`;
    }),
  ].join(' ');

  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div class="row">${crumbsHtml}</div>
        <div class="row">
          ${files.path ? `<button class="ghost small" data-action="files-up">▲ Üst Dizin</button>` : ''}
          <button class="ghost small" data-action="files-refresh">${ICONS.refresh} Yenile</button>
        </div>
      </div>

      <div class="row mt" style="margin-bottom: 0.85rem;">
        <input id="newDirName" placeholder="yeni-klasör" ${readOnly ? 'disabled' : ''} />
        <button class="ghost small" data-action="files-mkdir" ${readOnly ? 'disabled' : ''}>+ Klasör Oluştur</button>
        <span class="spacer"></span>
        <input id="fileUpload" type="file" multiple ${readOnly ? 'disabled' : ''} />
        <button class="primary small" data-action="files-upload" ${readOnly ? 'disabled' : ''}>Yükle</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Ad</th>
            <th class="nowrap">Boyut</th>
            <th class="nowrap">İzin</th>
            <th class="nowrap">Değiştirilme</th>
            <th style="text-align: right;">İşlemler</th>
          </tr>
        </thead>
        <tbody>
          ${(files.items || [])
            .map((item) => `
            <tr>
              <td>
                ${item.type === 'dir' ? '📁' : '📄'}
                <span class="mono" style="${item.type === 'dir' ? 'font-weight: 600; cursor: pointer;' : ''}"
                  ${item.type === 'dir' ? `data-action="files-open" data-path="${esc(item.path)}"` : ''}>
                  ${esc(item.name)}
                </span>
                ${item.type === 'link' ? '<span class="muted small">(bağ)</span>' : ''}
              </td>
              <td class="mono nowrap">${item.type === 'dir' ? '—' : fmtBytes(item.size)}</td>
              <td class="mono nowrap">${esc(item.mode)}</td>
              <td class="small nowrap muted">${fmtDate(item.mtime)}</td>
              <td class="nowrap" style="text-align: right;">
                ${
                  item.type === 'dir'
                    ? `<button class="ghost small" data-action="files-open" data-path="${esc(item.path)}">Aç</button>`
                    : `<button class="ghost small" data-action="files-view" data-path="${esc(item.path)}">Düzenle</button>
                       <a class="btn ghost small" href="/api/servers/${esc(server.id)}/download?path=${encodeURIComponent(item.path)}">İndir</a>`
                }
                <button class="ghost small" data-action="files-rename" data-path="${esc(item.path)}" ${readOnly ? 'disabled' : ''}>Yeniden Adlandır</button>
                <button class="danger small" data-action="files-delete" data-path="${esc(item.path)}" ${readOnly ? 'disabled' : ''}>Sil</button>
              </td>
            </tr>`)
            .join('') || '<tr><td colspan="5" class="muted">Bu dizin boş.</td></tr>'}
        </tbody>
      </table>
    </div>

    <!-- Entegre Dosya Editörü -->
    <div class="pter-card${files.editing ? '' : ' hidden'}" id="editorCard">
      <div class="pter-card-header">
        <h3 class="mono">${esc(files.editing || '')}</h3>
        <div class="row">
          ${files.isBinary ? '' : `<button class="primary small" data-action="files-save" ${readOnly ? 'disabled' : ''}>Kaydet</button>`}
          <button class="ghost small" data-action="files-close">Kapat</button>
        </div>
      </div>
      ${
        files.isBinary
          ? '<div class="muted small">İkili (binary) dosya formatı; tarayıcı içi editörde düzenlenemez. İndirip açın.</div>'
          : `<textarea id="editor" rows="22" spellcheck="false" ${readOnly ? 'disabled' : ''}></textarea>`
      }
    </div>`;

  if (files.editing && !files.isBinary) {
    const editor = document.getElementById('editor');
    if (editor) editor.value = files.content ?? '';
  }
  if (refresh) loadFiles(server.id, files.path);
}

// --- 3. Zamanlanmış Görevler (Pterodactyl Schedules) ------------------------

function renderSchedulesTab(body, server) {
  const rows = state.schedules
    .map(
      (item) => `
      <tr>
        <td>
          <div class="font-bold">${esc(item.name)}</div>
          <div class="small muted">${esc(item.description || 'Açıklama yok')}</div>
        </td>
        <td class="mono nowrap">
          <span class="meta-tag mono">${esc(item.cron)}</span>
          <div class="small muted mt-sm">${item.nextRun ? `Sonraki: ${fmtDate(item.nextRun)}` : '—'}</div>
        </td>
        <td>
          ${(item.tasks || [])
            .map((task) => `<span class="meta-tag mono">${esc(task.action === 'power' ? `güç:${task.power}` : task.action === 'command' ? `komut:${task.command}` : `yedek(${task.keep})`)}</span> `)
            .join('')}
        </td>
        <td class="nowrap">${item.enabled ? '<span class="status-badge running"><span class="status-dot"></span>AÇIK</span>' : '<span class="status-badge offline"><span class="status-dot"></span>KAPALI</span>'}</td>
        <td class="small">${item.lastRun ? `${fmtDate(item.lastRun.at)} ${item.lastRun.ok ? '<span class="ok">✓</span>' : '<span class="error">✗</span>'}` : '—'}</td>
        <td class="nowrap" style="text-align: right;">
          <button class="ghost small" data-action="run-schedule" data-id="${esc(item.id)}">Şimdi Çalıştır</button>
          <button class="ghost small" data-action="toggle-schedule" data-id="${esc(item.id)}" data-enabled="${item.enabled}">${item.enabled ? 'Durdur' : 'Aktif Et'}</button>
          <button class="danger small" data-action="delete-schedule" data-id="${esc(item.id)}">Sil</button>
        </td>
      </tr>`,
    )
    .join('');

  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Zamanlanmış Görevler</h3>
          <p class="muted small">Cron ifadeleriyle periyodik yedek alma, sunucu yeniden başlatma veya komut çalıştırma görevleri tanımlayın.</p>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Görev Adı</th>
            <th class="nowrap">Cron / Zamanlama</th>
            <th>Adımlar</th>
            <th class="nowrap">Durum</th>
            <th class="nowrap">Son Çalışma</th>
            <th style="text-align: right;">İşlemler</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">Tanımlı zamanlanmış görev yok.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="pter-card mt">
      <div class="pter-card-header">
        <h3>Yeni Görev Ekle</h3>
      </div>
      <div class="grid-2">
        <div class="field"><label for="schName">Görev Adı</label><input id="schName" placeholder="Günlük Otomatik Yeniden Başlatma" /></div>
        <div class="field"><label for="schCron">Cron İfadesi (dakika saat gün ay haftagün)</label><input id="schCron" placeholder="0 4 * * *" class="mono" /></div>
      </div>
      <div class="field"><label for="schDesc">Açıklama</label><input id="schDesc" placeholder="Her gece 04:00'te botu yeniden başlat" /></div>
      <div class="field">
        <label for="schSteps">Görev Adımları (Her satıra bir adım)</label>
        <textarea id="schSteps" rows="3" spellcheck="false">power:restart
backup:5</textarea>
        <div class="small muted mt-sm">Desteklenen adımlar: <span class="mono">power:start|stop|restart|kill</span>, <span class="mono">command:/komut</span>, <span class="mono">backup:5</span> (5 = saklanacak maksimum yedek sayısı).</div>
      </div>
      <button class="primary" data-action="create-schedule">Görevi Kaydet</button>
    </div>`;
}

// --- 4. Kullanıcılar ve İzinler (Pterodactyl Subusers) -----------------------

function renderUsersTab(body) {
  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Kullanıcı Yönetimi</h3>
          <p class="muted small">Panele erişebilen hesaplar ve yetki seviyeleri.</p>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Kullanıcı Adı</th>
            <th>Yetki Rolü</th>
            <th class="nowrap">Son Giriş</th>
            <th class="nowrap">Kayıt Tarihi</th>
            <th style="text-align: right;">İşlemler</th>
          </tr>
        </thead>
        <tbody>
          ${state.users
            .map(
              (item) => `<tr>
                <td>
                  <span class="font-bold">${esc(item.username)}</span>
                  ${item.id === state.me?.id ? ' <span class="user-role-badge admin">(Sen)</span>' : ''}
                </td>
                <td>
                  <select data-role-for="${esc(item.id)}" ${item.id === state.me?.id ? 'disabled' : ''}>
                    ${['viewer', 'operator', 'admin'].map((role) => `<option value="${role}" ${item.role === role ? 'selected' : ''}>${role}</option>`).join('')}
                  </select>
                </td>
                <td class="small nowrap">${fmtDate(item.lastLoginAt)}</td>
                <td class="small nowrap">${fmtDate(item.createdAt)}</td>
                <td class="nowrap" style="text-align: right;">
                  <button class="ghost small" data-action="save-role" data-id="${esc(item.id)}" ${item.id === state.me?.id ? 'disabled' : ''}>Rolü Güncelle</button>
                  <button class="ghost small" data-action="reset-password" data-id="${esc(item.id)}">Parola Sıfırla</button>
                  <button class="danger small" data-action="delete-user" data-id="${esc(item.id)}" ${item.id === state.me?.id ? 'disabled' : ''}>Sil</button>
                </td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>

    ${
      state.me?.role === 'admin'
        ? `
    <div class="pter-card mt">
      <div class="pter-card-header">
        <h3>Yeni Kullanıcı Oluştur</h3>
      </div>
      <div class="grid-2">
        <div class="field"><label for="newUser">Kullanıcı Adı</label><input id="newUser" /></div>
        <div class="field"><label for="newPass">Parola (En az 10 karakter)</label><input id="newPass" type="password" /></div>
        <div class="field"><label for="newRole">Rol</label>
          <select id="newRole">
            <option value="viewer">viewer (Yalnızca izleme & okuma)</option>
            <option value="operator">operator (Güç, dosya, yedek, görev çalıştırma)</option>
            <option value="admin">admin (Tam yönetici yetkisi)</option>
          </select>
        </div>
      </div>
      <button class="primary" data-action="create-user">Kullanıcıyı Ekle</button>
    </div>`
        : ''
    }`;
}

// --- 5. Yedekler (Pterodactyl Backups) ---------------------------------------

function renderBackupsTab(body, server) {
  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Sunucu Yedekleri</h3>
          <p class="muted small">Sunucunun tüm dizinini tar.gz arşivi olarak güvenle yedekleyin veya geri yükleyin.</p>
        </div>
      </div>
      <div class="row" style="margin-bottom: 1rem;">
        <input id="backupName" class="grow" placeholder="Yedek adı (boş bırakılırsa tarih atanır)" />
        <input id="backupKeep" class="w-narrow" type="number" min="1" max="50" value="5" title="Maksimum saklanacak yedek adedi" />
        <button class="primary" data-action="create-backup">Yedek Al</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Yedek Adı</th>
            <th class="nowrap">Arşiv Boyutu</th>
            <th class="nowrap">Dosya Sayısı</th>
            <th class="nowrap">Oluşturulma</th>
            <th class="nowrap">Oluşturan</th>
            <th style="text-align: right;">İşlemler</th>
          </tr>
        </thead>
        <tbody>
          ${state.backups
            .map(
              (item) => `
            <tr>
              <td><span class="font-bold">${esc(item.name)}</span></td>
              <td class="mono nowrap">${fmtBytes(item.sizeBytes)}</td>
              <td class="mono nowrap">${item.fileCount} dosya</td>
              <td class="small nowrap">${fmtDate(item.createdAt)}</td>
              <td class="small nowrap">${esc(item.createdBy)}</td>
              <td class="nowrap" style="text-align: right;">
                <a class="btn ghost small" href="/api/backups/${esc(item.id)}/download">İndir</a>
                <button class="ghost small" data-action="restore-backup" data-id="${esc(item.id)}">Geri Yükle</button>
                <button class="danger small" data-action="delete-backup" data-id="${esc(item.id)}">Sil</button>
              </td>
            </tr>`,
            )
            .join('') || '<tr><td colspan="6" class="muted">Henüz alınmış yedek yok.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

// --- 6. Ağ & Port Tahsisleri (Pterodactyl Network) --------------------------

function renderNetworkTab(body, server) {
  const alloc = server.allocation;
  const pool = state.pool;
  const usedPct = pool ? Math.round((pool.usage.used / pool.usage.total) * 100) : 0;

  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Ağ Tahsisleri (Allocations)</h3>
          <p class="muted small">Bu sunucuya atanmış port ve ağ yapılandırması. Bot veya servisiniz bu port üzerinden dinleme yapabilir.</p>
        </div>
      </div>
      <div class="grid-2 mt">
        <div class="alloc-card primary-alloc">
          <div class="alloc-header">
            <span class="pill-alloc primary">BİRİNCİL PORT</span>
            <span class="alloc-alias mono">:${alloc ? alloc.port : 'Tahsis Edilmedi'}</span>
          </div>
          <div class="alloc-body">
            <div class="small muted">Bağlantı Adresi: <strong class="mono text-white">127.0.0.1:${alloc ? alloc.port : 'Yok'}</strong></div>
            <div class="small muted">Protokol: <span class="mono">TCP / UDP</span></div>
            <div class="small muted">Erişim: <span class="mono">Yalnızca Yerel (Loopback)</span></div>
          </div>
          <div class="alloc-footer">
            ${alloc ? `<button class="ghost small" data-action="copy-text" data-text="127.0.0.1:${alloc.port}">Adresi Kopyala</button>` : ''}
          </div>
        </div>
      </div>
    </div>

    <div class="pter-card mt">
      <div class="pter-card-header">
        <div>
          <h3>Genel Port Havuzu</h3>
          <p class="muted small">Panel genelindeki kullanılabilir ve rezerve edilmiş port istatistikleri.</p>
        </div>
      </div>
      <div class="grid-2 mt">
        <div>
          <div class="small muted">Port Aralığı: <span class="mono font-bold">${pool ? `${pool.range.min} - ${pool.range.max}` : '—'}</span></div>
          <div class="small muted mt-sm">Toplam Kapasite: <span class="mono font-bold">${pool ? pool.usage.total : '—'} Port</span></div>
          <div class="small muted mt-sm">Kullanılan Portlar: <span class="mono font-bold">${pool ? pool.usage.used : '—'} Port</span></div>
          <div class="small muted mt-sm">Kullanılabilir Boş Port: <span class="mono font-bold ok">${pool ? pool.usage.free : '—'} Port</span></div>
        </div>
        <div>
          <div class="small muted">Havuz Doluluk Oranı: <span class="mono">${usedPct}%</span></div>
          <div class="bar-track mt-sm"><div class="bar-fill" data-pct="${usedPct}"></div></div>
        </div>
      </div>
    </div>`;
}

// --- 7. Başlangıç & Değişkenler (Pterodactyl Startup) -----------------------

function renderStartupTab(body, server) {
  const readOnly = state.me?.role === 'viewer';
  const variables = server.variables || {};

  const fields = (server.eggVariables || [])
    .map((item) => {
      const current = variables[item.key] ?? '';
      const masked = item.secret && current === '••••••••';
      return `
      <div class="var-card">
        <div class="var-card-header">
          <div class="var-title mono">${esc(item.name)} <span class="muted small">(${esc(item.key)})</span></div>
          <div class="row">
            ${item.required ? '<span class="var-badge req">Zorunlu</span>' : '<span class="var-badge">İsteğe Bağlı</span>'}
            ${item.secret ? '<span class="var-badge secret">Sır</span>' : ''}
          </div>
        </div>
        <input id="var-${esc(item.key)}" data-var="${esc(item.key)}" value="${masked ? '' : esc(current)}"
          placeholder="${masked ? 'Değiştirmek için yeni değer yazın (boş = eski sır korunur)' : esc(item.default || '')}"
          ${readOnly ? 'disabled' : ''} />
        ${item.description ? `<div class="small muted mt-sm">${esc(item.description)}</div>` : ''}
      </div>`;
    })
    .join('');

  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Başlangıç Komutu (Startup Command)</h3>
          <p class="muted small">Egg şablonundan gelen varsayılan başlatma komutunu görüntüleyin veya bu sunucu için özelleştirin.</p>
        </div>
      </div>
      <div class="field">
        <label for="srvStartup">Özel Başlangıç Komutu (Boş bırakılırsa egg varsayılanı kullanılır)</label>
        <input id="srvStartup" class="mono" value="${esc(server.startupOverride || '')}" placeholder="${esc(server.startupCommand || '')}" ${readOnly ? 'disabled' : ''} />
        <div class="small muted mt-sm">Egg Varsayılanı: <span class="mono">${esc(server.startupCommand || '')}</span></div>
      </div>
    </div>

    <div class="pter-card mt">
      <div class="pter-card-header">
        <div>
          <h3>Ortam Değişkenleri (Environment Variables)</h3>
          <p class="muted small">Egg tarafından belirlenen bot tokenleri, veritabanı bağlantıları veya yapılandırma parametreleri. Sırlar kasada AES-256-GCM ile şifrelenir.</p>
        </div>
      </div>
      ${fields || '<div class="muted small">Bu egg için tanımlı değişken bulunmuyor.</div>'}
      <div class="row mt">
        <button class="primary" data-action="save-startup" ${readOnly ? 'disabled' : ''}>Değişkenleri ve Başlangıcı Kaydet</button>
      </div>
    </div>`;
}

// --- 8. Ayarlar & Limitler (Pterodactyl Settings) ----------------------------

function renderSettingsTab(body, server) {
  const isAdmin = state.me?.role === 'admin';
  const readOnly = state.me?.role === 'viewer';

  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Genel Sunucu Ayarları</h3>
          <p class="muted small">Sunucu adı ve çalışma politikaları.</p>
        </div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="srvName">Sunucu Adı</label><input id="srvName" value="${esc(server.name)}" ${readOnly ? 'disabled' : ''} /></div>
        <div class="field"><label for="srvPolicy">Yeniden Başlatma Politikası</label>
          <select id="srvPolicy" ${readOnly ? 'disabled' : ''}>
            ${['always', 'on-failure', 'never'].map((value) => `<option value="${value}" ${server.restartPolicy === value ? 'selected' : ''}>${value}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label><input type="checkbox" id="srvAuto" ${server.autoStart ? 'checked' : ''} ${readOnly ? 'disabled' : ''} /> Panel açıldığında otomatik başlat</label>
        </div>
      </div>
    </div>

    <div class="pter-card mt">
      <div class="pter-card-header">
        <div>
          <h3>Kaynak Limitleri (Resource Limits)</h3>
          <p class="muted small">Konteyner için ayrılan donanım sınırları. Değişiklikler bir sonraki sunucu başlatmasında geçerli olur.</p>
        </div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="limMem">Bellek Limiti (MB)</label><input id="limMem" type="number" min="128" value="${server.limits.memoryMb}" ${readOnly ? 'disabled' : ''} /></div>
        <div class="field"><label for="limCpu">CPU Limiti (Çekirdek)</label><input id="limCpu" type="number" step="0.1" min="0.1" value="${server.limits.cpu}" ${readOnly ? 'disabled' : ''} /></div>
        <div class="field"><label for="limDisk">Disk Limiti (MB)</label><input id="limDisk" type="number" min="64" value="${server.limits.diskMb}" ${readOnly ? 'disabled' : ''} /></div>
        <div class="field"><label for="limPids">Süreç Limiti (PIDs)</label><input id="limPids" type="number" min="32" value="${server.limits.pids}" ${readOnly ? 'disabled' : ''} /></div>
      </div>
      <button class="primary" data-action="save-settings" ${readOnly ? 'disabled' : ''}>Limitleri Kaydet</button>
    </div>

    <div class="pter-card mt">
      <div class="pter-card-header">
        <div>
          <h3>Sunucu Bilgileri & Kurulum</h3>
          <p class="muted small">Teknik kimlik bilgileri ve installer'ı yeniden tetikleme.</p>
        </div>
      </div>
      <div class="small muted mono mb-sm">UUID: ${esc(server.id)} · Egg: ${esc(server.egg)} · Kurulum: ${fmtDate(server.installedAt)}</div>
      <div class="row mt">
        <button class="ghost" data-action="power" data-power="install" ${readOnly ? 'disabled' : ''}>Yükleyiciyi Yeniden Çalıştır (Reinstall)</button>
      </div>
    </div>

    ${
      isAdmin
        ? `
    <div class="pter-card mt" style="border-color: rgba(239, 68, 68, 0.4);">
      <div class="pter-card-header">
        <div>
          <h3 class="error">Tehlikeli Bölge (Danger Zone)</h3>
          <p class="muted small">Geri alınamaz sunucu silme veya askıya alma işlemleri.</p>
        </div>
      </div>
      <div class="row">
        ${server.suspended ? '<button class="primary" data-action="resume">Askıdan Çıkar</button>' : '<button class="danger" data-action="suspend">Sunucuyu Askıya Al</button>'}
        <button class="danger" data-action="delete-server">Sunucuyu Sil (Dosyalar Kalsın)</button>
        <button class="danger" data-action="delete-server-files">Sunucuyu ve Tüm Dosyaları Kalıcı Sil</button>
      </div>
    </div>`
        : ''
    }`;
}

// --- 9. Aktivite Kaydı (Pterodactyl Activity Logs) --------------------------

function renderAuditTab(body) {
  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Aktivite ve Denetim Kaydı</h3>
          <p class="muted small">Güvenlik ve denetim amaçlı son 200 işlem. Gizli sır değerleri asla günlüklere yazılmaz.</p>
        </div>
        <button class="ghost small" data-action="tab" data-tab="denetim">${ICONS.refresh} Yenile</button>
      </div>
      <table>
        <thead>
          <tr>
            <th class="nowrap">Zaman</th>
            <th>Kullanıcı</th>
            <th>İşlem Türü</th>
            <th>Hedef</th>
            <th>Detay</th>
            <th class="nowrap">İstemci IP</th>
          </tr>
        </thead>
        <tbody>
          ${state.audit
            .map(
              (item) => `<tr>
                <td class="small nowrap">${fmtDate(item.at)}</td>
                <td class="font-bold small">${esc(item.actor)}</td>
                <td class="nowrap"><span class="meta-tag mono">${esc(item.action)}</span></td>
                <td class="small mono">${esc(item.target || '—')}</td>
                <td class="mono small" style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(item.detail ? JSON.stringify(item.detail) : '—')}</td>
                <td class="small mono nowrap">${esc(item.ip || '—')}</td>
              </tr>`,
            )
            .join('') || '<tr><td colspan="6" class="muted">Kayıt bulunamadı.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

// --- 10. Sistem ve Şablonlar (Admin System) ---------------------------------

function renderSystemTab(body) {
  const sys = state.system;
  body.innerHTML = `
    <div class="pter-card">
      <div class="pter-card-header">
        <div>
          <h3>Host Donanım ve Sistem Metrikleri</h3>
          <p class="muted small">Sunucunun barındırıldığı makinenin donanım kapasitesi ve Node.js çalışma ortamı.</p>
        </div>
      </div>
      ${
        sys
          ? `
      <div class="grid-2 mt">
        <div>
          <h4>Ana Makine</h4>
          <div class="mono small">${esc(sys.hostname)} · ${esc(sys.platform)}</div>
          <div class="mono small">Node ${esc(sys.node)} · ${sys.cpuCount} Çekirdek</div>
          <div class="mono small text-dim">${esc(sys.cpuModel || '')}</div>
          <div class="mono small mt-sm">Sistem Yükü: ${sys.loadAvg.join(' ')} · Çalışma Süresi: ${fmtDuration(sys.uptimeSeconds * 1000)}</div>
        </div>
        <div>
          <h4>Bellek ve Disk</h4>
          <div class="small muted">Host RAM: ${fmtBytes(sys.totalMemoryBytes - sys.freeMemoryBytes)} / ${fmtBytes(sys.totalMemoryBytes)}</div>
          <div class="bar-track mt-sm"><div class="bar-fill" data-pct="${Math.round(((sys.totalMemoryBytes - sys.freeMemoryBytes) / sys.totalMemoryBytes) * 100)}"></div></div>
          ${
            sys.disk
              ? `
          <div class="small muted mt">Host Disk: ${fmtBytes(sys.disk.usedBytes)} / ${fmtBytes(sys.disk.totalBytes)}</div>
          <div class="bar-track mt-sm"><div class="bar-fill" data-pct="${Math.round((sys.disk.usedBytes / sys.disk.totalBytes) * 100)}"></div></div>`
              : ''
          }
        </div>
      </div>
      <div class="grid-2 mt">
        <div>
          <h4>Panel Süreci</h4>
          <div class="mono small">PID ${sys.panel.pid} · RAM: ${fmtBytes(sys.panel.memoryBytes)}</div>
          <div class="mono small">Konteyner Motoru: ${esc(sys.driver)}${sys.docker ? ` · Docker ${esc(sys.docker)}` : ''}</div>
        </div>
        <div>
          <h4>Sayaçlar</h4>
          <div class="mono small">${sys.counts.servers} Sunucu (${sys.counts.running} Çalışıyor) · ${sys.counts.users} Kullanıcı</div>
          <div class="mono small">${sys.counts.backups} Yedek (${fmtBytes(sys.backups.totalBytes)}) · ${sys.counts.eggs} Egg Şablonu</div>
        </div>
      </div>`
          : '<div class="muted">Yükleniyor…</div>'
      }
    </div>

    <div class="pter-card mt">
      <div class="pter-card-header">
        <div>
          <h3>Grafik Donanımı ve Video Belleği (GPU & VRAM)</h3>
          <p class="muted small">Host makinede algılanan ekran kartı ve toplam bağımsız/özel video belleği (VRAM) kapasitesi.</p>
        </div>
      </div>
      ${
        sys?.gpu
          ? `
      <div class="grid-2 mt">
        <div>
          <h4>Ekran Kartı (GPU)</h4>
          ${
            sys.gpu.gpus && sys.gpu.gpus.length > 0
              ? sys.gpu.gpus
                  .map(
                    (g) => `
                <div class="mono small font-bold" style="color: #fff; font-size: 0.92rem;">${esc(g.model)}</div>
                <div class="small muted mt-sm">Bağımsız VRAM: <span class="mono font-bold ok" style="font-size: 1rem;">${fmtBytes(g.totalVramBytes)}</span></div>
                ${g.usedVramBytes !== null ? `<div class="small muted mt-sm">Kullanılan VRAM: <span class="mono">${fmtBytes(g.usedVramBytes)}</span> (${Math.round((g.usedVramBytes / g.totalVramBytes) * 100)}%)</div>` : ''}
              `,
                  )
                  .join('<hr style="border: 0; border-top: 1px solid var(--border-subtle); margin: 0.75rem 0;">')
              : `<div class="muted small">${esc(sys.gpu.message || 'Harici GPU algılanmadı.')}</div>`
          }
        </div>
        <div>
          <h4>Toplam Sistem VRAM Durumu</h4>
          <div class="mono" style="font-size: 1.35rem; font-weight: 700; color: ${sys.gpu.available ? 'var(--info)' : 'var(--text-muted)'}; margin-top: 0.25rem;">
            ${sys.gpu.available ? `${fmtBytes(sys.gpu.totalVramBytes)} VRAM` : '0 Byte (Ayrılmış VRAM Yok)'}
          </div>
          <div class="small muted mt-sm" style="line-height: 1.5;">
            ${
              sys.gpu.available
                ? 'Donanımsal bağımsız video belleği başarıyla algılandı ve sisteme tanımlandı.'
                : 'Sanal makine / Paylaşımlı grafik ortamı. Bağımsız VRAM bulunmuyor; grafik veya hesaplama işlemleri standart sistem RAM\'ini paylaşımlı olarak kullanır.'
            }
          </div>
        </div>
      </div>`
          : '<div class="muted small">GPU verisi bekleniyor…</div>'
      }
    </div>

    <div class="pter-card mt">
      <div class="pter-card-header">
        <div>
          <h3>Yüklü Egg Şablonları</h3>
          <p class="muted small">Yeni sunucu oluştururken kullanılan Docker ve çalışma ortamı tanımları.</p>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Şablon Adı</th>
            <th>Nest</th>
            <th class="nowrap">Docker İmajı</th>
            <th>Varsayılan Başlangıç</th>
            <th class="nowrap">Kaynak Limitleri</th>
          </tr>
        </thead>
        <tbody>
          ${state.eggs
            .map(
              (egg) => `<tr>
                <td>
                  <span class="font-bold">${esc(egg.name)}</span>
                  <div class="small muted">${esc(egg.description || '')}</div>
                </td>
                <td class="small">${esc(state.nests.find((n) => n.id === egg.nest)?.name || egg.nest)}</td>
                <td class="mono small">${esc(egg.docker.image)}</td>
                <td class="mono small">${esc(egg.startup)}</td>
                <td class="mono small nowrap">${egg.features.memoryMb}MB RAM · ${egg.features.cpu} CPU</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

// --- Veri Yükleme ve SSE Canlı Akış ----------------------------------------

async function loadSession() {
  const status = await api('GET', '/api/setup/status');
  if (status.needsSetup) {
    renderSetup(status);
    return false;
  }
  try {
    const { user } = await api('GET', '/api/me');
    state.me = user;
  } catch {
    renderLogin();
    return false;
  }
  await refreshAll();
  renderShell();
  return true;
}

async function refreshAll() {
  const [servers, eggs, pool, system] = await Promise.all([
    api('GET', '/api/servers'),
    api('GET', '/api/eggs'),
    api('GET', '/api/allocations'),
    api('GET', '/api/system'),
  ]);
  state.servers = servers.servers;
  state.eggs = eggs.eggs;
  state.nests = eggs.nests;
  state.pool = pool;
  state.system = system;
  renderSidebar();

  if (state.selectedId && !state.detail) {
    await selectServer(state.selectedId);
  }
  renderTopbar();

  if (state.selectedId && state.detail) {
    const fresh = state.servers.find((item) => item.id === state.selectedId);
    if (fresh) {
      state.detail = { ...state.detail, ...fresh, variables: state.detail.variables };
      updateStatusBadgeInDom(fresh.status);
    }
  }
}

function updateStatusBadgeInDom(status) {
  const badgeWrap = document.querySelector('.server-title-wrap .status-badge');
  if (badgeWrap) {
    badgeWrap.className = `status-badge ${status}`;
    badgeWrap.innerHTML = `<span class="status-dot"></span><span>${esc(statusLabel(status))}</span>`;
  }
}

async function selectServer(id) {
  state.selectedId = id;
  state.detail = null;
  state.logs = [];
  state.files = { path: '', items: [], editing: null, isBinary: false };
  renderSidebar();
  renderMain();

  const { server, logs } = await api('GET', `/api/servers/${id}`);
  state.detail = server;
  state.logs = logs || [];
  renderMain();
  openStream(id);

  if (state.tab === 'yedekler') await loadBackups(id);
  if (state.tab === 'gorevler') await loadSchedules(id);
  if (state.tab === 'denetim') await loadAudit();
  if (state.tab === 'kullanicilar') await loadUsers();
}

function openStream(serverId) {
  if (state.stream) state.stream.close();
  const stream = new EventSource(`/api/servers/${serverId}/stream`);
  state.stream = stream;

  stream.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === 'log') {
      state.logs.push(payload.entry);
      if (state.logs.length > 1500) state.logs.shift();
      if (state.tab === 'konsol') appendLog(document.getElementById('console'), payload.entry);
    } else if (payload.type === 'state') {
      if (state.detail) state.detail.status = payload.status;
      updateStatusBadgeInDom(payload.status);
      renderSidebar();
    } else if (payload.type === 'stats' && state.detail) {
      state.detail.stats = payload.stats;
    }
  };
  stream.onerror = () => {};
}

async function loadFiles(serverId, path) {
  try {
    const result = await api('GET', `/api/servers/${serverId}/files?path=${encodeURIComponent(path || '')}`);
    state.files.path = result.path;
    state.files.items = result.items;
    renderTab(false);
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadBackups(serverId) {
  const { backups } = await api('GET', `/api/servers/${serverId}/backups`);
  state.backups = backups;
  if (state.tab === 'yedekler') renderTab();
}

async function loadSchedules(serverId) {
  const { schedules } = await api('GET', `/api/schedules?serverId=${encodeURIComponent(serverId)}`);
  state.schedules = schedules;
  if (state.tab === 'gorevler') renderTab();
}

async function loadAudit() {
  const { entries } = await api('GET', '/api/audit?limit=200');
  state.audit = entries;
  if (state.tab === 'denetim') renderTab();
}

async function loadUsers() {
  const { users } = await api('GET', '/api/users');
  state.users = users;
  if (state.tab === 'kullanicilar') renderTab();
}

// --- Giriş & Kurulum Ekranları ----------------------------------------------

function renderSetup(status) {
  document.body.innerHTML = `
    <div class="pter-card center">
      <div class="brand mb-sm" style="margin-bottom: 1rem;">
        ${ICONS.logo} <span>Lumo Panel Kurulumu</span>
      </div>
      <p class="muted small">İlk yönetici hesabınızı oluşturun. Parola en az 10 karakter olmalıdır.</p>
      <div class="field"><label for="setupUser">Yönetici Kullanıcı Adı</label><input id="setupUser" autocomplete="username" /></div>
      <div class="field"><label for="setupPass">Parola</label><input id="setupPass" type="password" autocomplete="new-password" /></div>
      <div class="field"><label for="setupPass2">Parola (Tekrar)</label><input id="setupPass2" type="password" autocomplete="new-password" /></div>
      <button class="primary" data-action="do-setup" style="width: 100%; margin-top: 0.5rem;">Kurulumu Tamamla</button>
      <div class="small muted mt" style="text-align: center;">Lumo v${esc(status.version)}</div>
    </div>`;
}

function renderLogin() {
  document.body.innerHTML = `
    <div class="pter-card center">
      <div class="brand" style="margin-bottom: 1.25rem;">
        ${ICONS.logo} <span>Lumo Panel</span>
      </div>
      <div class="field"><label for="loginUser">Kullanıcı Adı</label><input id="loginUser" autocomplete="username" /></div>
      <div class="field"><label for="loginPass">Parola</label><input id="loginPass" type="password" autocomplete="current-password" /></div>
      <button class="primary" data-action="do-login" style="width: 100%; margin-top: 0.5rem;">Giriş Yap</button>
    </div>`;
}

function renderNewServerDialog() {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <form method="dialog" id="newServerForm">
      <div class="pter-card-header">
        <h3 class="mt0">Yeni Sunucu Oluştur</h3>
        <button type="button" class="ghost small" data-action="close-dialog">✕</button>
      </div>
      <div class="grid-2">
        <div class="field"><label for="nsName">Sunucu Adı</label><input id="nsName" placeholder="Discord Moderasyon Botu" /></div>
        <div class="field"><label for="nsEgg">Egg (Ortam Şablonu)</label>
          <select id="nsEgg">
            ${state.eggs.map((egg) => `<option value="${esc(egg.id)}">${esc(egg.name)} — ${esc(state.nests.find((n) => n.id === egg.nest)?.name || egg.nest)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field"><label><input type="checkbox" id="nsPort" checked /> Port tahsis et (Egg port gerektiriyorsa)</label></div>
      <div class="field"><label><input type="checkbox" id="nsAuto" checked /> Panel başlatıldığında otomatik çalıştır</label></div>
      <div id="nsVars"></div>
      <div class="row mt" style="justify-content: flex-end;">
        <button type="button" data-action="close-dialog" class="ghost">Vazgeç</button>
        <button class="primary" type="button" data-action="create-server">Sunucuyu Oluştur</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);

  const select = dialog.querySelector('#nsEgg');
  const renderVars = () => {
    const egg = state.eggs.find((item) => item.id === select.value);
    dialog.querySelector('#nsVars').innerHTML = egg
      ? `<h4>Başlangıç Değişkenleri</h4>` +
        egg.variables
          .map(
            (item) => `
          <div class="field">
            <label for="nsv-${esc(item.key)}">${esc(item.name)} (${esc(item.key)})${item.required ? ' *' : ''}</label>
            <input id="nsv-${esc(item.key)}" data-var="${esc(item.key)}" value="${esc(item.secret ? '' : item.default || '')}" placeholder="${esc(item.default || '')}" />
            ${item.description ? `<div class="small muted mt-sm">${esc(item.description)}</div>` : ''}
          </div>`,
          )
          .join('')
      : '';
  };
  select.addEventListener('change', renderVars);
  renderVars();
  dialog.showModal();
}

// --- Eylemler ve Olay Dinleyicileri -----------------------------------------

async function handleAction(action, el) {
  const server = state.detail;
  try {
    switch (action) {
      case 'goto-servers':
        state.selectedId = null;
        state.detail = null;
        state.stream?.close();
        state.stream = null;
        renderSidebar();
        renderMain();
        break;
      case 'copy-text': {
        const text = el.dataset.text;
        if (text) {
          await navigator.clipboard.writeText(text);
          toast(`Adres kopyalandı: ${text}`);
        }
        break;
      }
      case 'logout':
        await api('POST', '/api/auth/logout');
        state.stream?.close();
        renderLogin();
        break;
      case 'do-login': {
        const username = document.getElementById('loginUser').value.trim();
        const password = document.getElementById('loginPass').value;
        const { user } = await api('POST', '/api/auth/login', { username, password });
        state.me = user;
        await loadSession();
        break;
      }
      case 'do-setup': {
        const username = document.getElementById('setupUser').value.trim();
        const password = document.getElementById('setupPass').value;
        const again = document.getElementById('setupPass2').value;
        if (password !== again) throw new Error('Parolalar uyuşmuyor.');
        const { user } = await api('POST', '/api/setup', { username, password });
        state.me = user;
        await loadSession();
        break;
      }
      case 'refresh':
        await refreshAll();
        if (state.selectedId) await selectServer(state.selectedId);
        break;
      case 'select-server':
        if (el.dataset.id === state.selectedId) break;
        await selectServer(el.dataset.id);
        break;
      case 'tab':
        state.tab = el.dataset.tab;
        renderMain();
        if (state.tab === 'dosyalar') await loadFiles(state.selectedId, '');
        if (state.tab === 'yedekler') await loadBackups(state.selectedId);
        if (state.tab === 'gorevler') await loadSchedules(state.selectedId);
        if (state.tab === 'denetim') await loadAudit();
        if (state.tab === 'kullanicilar') await loadUsers();
        break;
      case 'new-server':
        renderNewServerDialog();
        break;
      case 'close-dialog':
        el.closest('dialog')?.close();
        break;
      case 'create-server': {
        const dialog = el.closest('dialog');
        const variables = {};
        dialog.querySelectorAll('[data-var]').forEach((input) => {
          if (input.value !== '') variables[input.dataset.var] = input.value;
        });
        const { server: created } = await api('POST', '/api/servers', {
          name: dialog.querySelector('#nsName').value.trim(),
          egg: dialog.querySelector('#nsEgg').value,
          variables,
          autoStart: dialog.querySelector('#nsAuto').checked,
          allocatePort: dialog.querySelector('#nsPort').checked,
        });
        dialog.close();
        toast(`Sunucu oluşturuldu: ${created.name}`);
        await refreshAll();
        await selectServer(created.id);
        break;
      }
      case 'power': {
        const power = el.dataset.power;
        await api('POST', `/api/servers/${server.id}/power`, { action: power, force: power === 'kill' });
        toast(`${power} sinyali gönderildi.`);
        break;
      }
      case 'clear-console':
        state.logs = [];
        renderTab(false);
        break;
      case 'save-settings': {
        await api('PATCH', `/api/servers/${server.id}`, {
          name: document.getElementById('srvName').value.trim(),
          restartPolicy: document.getElementById('srvPolicy').value,
          autoStart: document.getElementById('srvAuto').checked,
          limits: {
            memoryMb: Number(document.getElementById('limMem').value),
            cpu: Number(document.getElementById('limCpu').value),
            diskMb: Number(document.getElementById('limDisk').value),
            pids: Number(document.getElementById('limPids').value),
          },
        });
        toast('Ayarlar başarıyla kaydedildi.');
        await selectServer(server.id);
        break;
      }
      case 'save-startup':
      case 'save-variables': {
        const variables = {};
        document.querySelectorAll('[data-var]').forEach((input) => {
          if (input.value !== '') variables[input.dataset.var] = input.value;
        });
        const startupEl = document.getElementById('srvStartup');
        const patchData = { variables };
        if (startupEl) {
          patchData.startupOverride = startupEl.value.trim() || null;
        }
        await api('PATCH', `/api/servers/${server.id}`, patchData);
        toast('Başlangıç ve değişkenler kaydedildi.');
        await selectServer(server.id);
        break;
      }
      case 'suspend':
        await api('POST', `/api/servers/${server.id}/suspend`, { reason: 'Yönetici kararı' });
        await selectServer(server.id);
        break;
      case 'resume':
        await api('POST', `/api/servers/${server.id}/resume`);
        await selectServer(server.id);
        break;
      case 'delete-server':
      case 'delete-server-files': {
        const withFiles = action === 'delete-server-files';
        if (!confirm(`${server.name} sunucusu silinsin mi?${withFiles ? ' DİKKAT: Tüm dosyalar ve yedekler de kalıcı olarak silinecek!' : ''}`)) break;
        await api('DELETE', `/api/servers/${server.id}${withFiles ? '?files=1' : ''}`);
        state.stream?.close();
        state.stream = null;
        state.selectedId = null;
        state.detail = null;
        toast('Sunucu silindi.');
        await refreshAll();
        renderMain();
        break;
      }
      // Dosya işlemleri
      case 'files-open':
        await loadFiles(server.id, el.dataset.path);
        break;
      case 'files-up': {
        const parts = (state.files.path || '').split('/').filter(Boolean);
        parts.pop();
        await loadFiles(server.id, parts.join('/'));
        break;
      }
      case 'files-refresh':
        await loadFiles(server.id, state.files.path);
        break;
      case 'files-view': {
        const result = await api('GET', `/api/servers/${server.id}/file?path=${encodeURIComponent(el.dataset.path)}`);
        state.files.editing = result.path;
        state.files.content = result.content;
        state.files.isBinary = result.binary;
        renderTab(false);
        break;
      }
      case 'files-close':
        state.files.editing = null;
        renderTab(false);
        break;
      case 'files-save': {
        const content = document.getElementById('editor').value;
        await api('PUT', `/api/servers/${server.id}/file`, { path: state.files.editing, content });
        toast('Dosya kaydedildi.');
        await loadFiles(server.id, state.files.path);
        break;
      }
      case 'files-mkdir': {
        const name = document.getElementById('newDirName').value.trim();
        if (!name) throw new Error('Klasör adı girin.');
        const path = state.files.path ? `${state.files.path}/${name}` : name;
        await api('POST', `/api/servers/${server.id}/mkdir`, { path });
        await loadFiles(server.id, state.files.path);
        break;
      }
      case 'files-upload': {
        const input = document.getElementById('fileUpload');
        if (!input.files?.length) throw new Error('Dosya seçilmedi.');
        const files = [];
        for (const file of input.files) {
          const buffer = await file.arrayBuffer();
          files.push({
            path: state.files.path ? `${state.files.path}/${file.name}` : file.name,
            content: btoa(String.fromCharCode(...new Uint8Array(buffer))),
          });
        }
        await api('POST', `/api/servers/${server.id}/upload`, { files });
        toast(`${files.length} dosya yüklendi.`);
        await loadFiles(server.id, state.files.path);
        break;
      }
      case 'files-rename': {
        const from = el.dataset.path;
        const name = prompt('Yeni ad:', from.split('/').pop());
        if (!name) break;
        const target = from.includes('/') ? `${from.slice(0, from.lastIndexOf('/'))}/${name}` : name;
        await api('POST', `/api/servers/${server.id}/rename`, { from, to: target });
        await loadFiles(server.id, state.files.path);
        break;
      }
      case 'files-delete': {
        const path = el.dataset.path;
        if (!confirm(`${path} silinsin mi?`)) break;
        await api('DELETE', `/api/servers/${server.id}/file?path=${encodeURIComponent(path)}`);
        await loadFiles(server.id, state.files.path);
        break;
      }
      // Yedek işlemleri
      case 'create-backup':
        await api('POST', `/api/servers/${server.id}/backups`, {
          name: document.getElementById('backupName').value.trim() || null,
          keep: Number(document.getElementById('backupKeep').value) || 5,
        });
        toast('Yedek alma başlatıldı.');
        await loadBackups(server.id);
        break;
      case 'restore-backup':
        if (!confirm('Yedek geri yüklenecek. Sunucu durdurulacak ve dizin yedekteki hâle dönecektir. Devam edilsin mi?')) break;
        await api('POST', `/api/backups/${el.dataset.id}/restore`);
        toast('Yedek geri yüklendi.');
        await selectServer(server.id);
        break;
      case 'delete-backup':
        if (!confirm('Yedek silinsin mi?')) break;
        await api('DELETE', `/api/backups/${el.dataset.id}`);
        await loadBackups(server.id);
        break;
      // Zamanlanmış görev işlemleri
      case 'create-schedule': {
        const steps = document.getElementById('schSteps').value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (!steps.length) throw new Error('En az bir görev adımı belirtin.');
        const tasks = steps.map((line) => {
          const [kind, ...rest] = line.split(':');
          const value = rest.join(':').trim();
          if (kind.trim() === 'power') return { action: 'power', power: value };
          if (kind.trim() === 'command') return { action: 'command', command: value };
          if (kind.trim() === 'backup') return { action: 'backup', keep: Number(value) || 5 };
          throw new Error(`Bilinmeyen adım: ${line}`);
        });
        await api('POST', '/api/schedules', {
          serverId: server.id,
          name: document.getElementById('schName').value.trim() || 'Görev',
          description: document.getElementById('schDesc').value.trim(),
          cron: document.getElementById('schCron').value.trim(),
          tasks,
          enabled: true,
        });
        toast('Görev oluşturuldu.');
        await loadSchedules(server.id);
        break;
      }
      case 'run-schedule':
        await api('POST', `/api/schedules/${el.dataset.id}/run`);
        toast('Görev manuel tetiklendi.');
        await loadSchedules(server.id);
        await refreshAll();
        break;
      case 'toggle-schedule':
        await api('PATCH', `/api/schedules/${el.dataset.id}`, { enabled: el.dataset.enabled !== 'true' });
        await loadSchedules(server.id);
        break;
      case 'delete-schedule':
        if (!confirm('Görev silinsin mi?')) break;
        await api('DELETE', `/api/schedules/${el.dataset.id}`);
        await loadSchedules(server.id);
        break;
      // Kullanıcı işlemleri
      case 'create-user':
        await api('POST', '/api/users', {
          username: document.getElementById('newUser').value.trim(),
          password: document.getElementById('newPass').value,
          role: document.getElementById('newRole').value,
        });
        toast('Kullanıcı hesabı açıldı.');
        await loadUsers();
        break;
      case 'save-role': {
        const select = document.querySelector(`select[data-role-for="${el.dataset.id}"]`);
        await api('PATCH', `/api/users/${el.dataset.id}`, { role: select.value });
        toast('Kullanıcı rolü güncellendi.');
        await loadUsers();
        break;
      }
      case 'reset-password': {
        const password = prompt('Yeni parola (en az 10 karakter):');
        if (!password) break;
        await api('PATCH', `/api/users/${el.dataset.id}`, { password });
        toast('Parola güncellendi; oturumlar sonlandırıldı.');
        break;
      }
      case 'delete-user':
        if (!confirm('Kullanıcı silinsin mi?')) break;
        await api('DELETE', `/api/users/${el.dataset.id}`);
        await loadUsers();
        break;
      default:
        break;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  event.preventDefault();
  handleAction(el.dataset.action, el);
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.form === 'console') {
    const input = form.querySelector('input[name="command"]');
    const command = input.value.trim();
    if (!command) return;
    api('POST', `/api/servers/${state.selectedId}/input`, { command })
      .then(() => {
        input.value = '';
      })
      .catch((err) => toast(err.message, true));
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.target.tagName !== 'INPUT') return;
  const form = event.target.closest('[data-form]');
  if (form) {
    event.preventDefault();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    return;
  }
  const card = event.target.closest('.pter-card, dialog');
  const button = card?.querySelector('button.primary');
  if (button) {
    event.preventDefault();
    button.click();
  }
});

setInterval(() => {
  if (!state.me) return;
  refreshAll().catch(() => {});
}, 8000);

loadSession().catch((err) => {
  document.body.innerHTML = `<div class="pter-card center"><h3>Panel yüklenemedi</h3><div class="error">${esc(err.message)}</div></div>`;
});

export { state, esc, api };
