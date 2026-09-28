// Lumo Panel arayüzü — bağımlılıksız, tek dosya SPA.
//
// Kurallar: satır içi script/stil yok (CSP), tüm kullanıcı verisi HTML'e
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
};

const TERMINAL_STATES = ['offline', 'crashed', 'suspended'];

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
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
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

function pill(status) {
  return `<span class="pill ${esc(status)}">${esc(status)}</span>`;
}

function bar(used, total, label) {
  if (!total) return `<div class="small muted">${esc(label)}: —</div>`;
  const pct = Math.min(100, Math.round((used / total) * 100));
  const cls = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';
  return `
    <div class="small muted">${esc(label)}: ${fmtBytes(used)} / ${fmtBytes(total)} (${pct}%)</div>
    <div class="bar ${cls}"><span data-pct="${pct}"></span></div>`;
}

// CSP `style-src 'self'` satır içi style özniteliğini engeller; genişlikleri
// CSSOM üzerinden uygularız (CSP bunu kısıtlamaz).
function applyBarWidths(root = document) {
  root.querySelectorAll('.bar > span[data-pct]').forEach((el) => {
    el.style.width = `${el.dataset.pct}%`;
  });
}

function selectedServer() {
  return state.servers.find((item) => item.id === state.selectedId) || null;
}

// --- Kabuk (giriş sonrası) --------------------------------------------------

function renderShell() {
  document.body.innerHTML = `
    <div class="topbar">
      <h1>Lumo Panel</h1>
      <span id="driver" class="stat"></span>
      <span class="spacer"></span>
      <span id="hostStats" class="stat"></span>
      <span class="small muted" id="whoami"></span>
      <button class="ghost" data-action="refresh">Yenile</button>
      <button class="ghost" data-action="logout">Çıkış</button>
    </div>
    <div class="layout">
      <div class="sidebar">
        <div class="row">
          <strong class="small">Sunucular</strong>
          <span class="spacer"></span>
          <button class="ghost small" data-action="new-server" id="newServerBtn">+ Yeni</button>
        </div>
        <div id="serverList" class="mt"></div>
        <div id="poolInfo" class="small muted mt"></div>
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
    list.innerHTML = `<div class="small muted">Henüz sunucu yok. “+ Yeni” ile bir egg seçip botunu kur.</div>`;
  } else {
    list.innerHTML = state.servers
      .map(
        (server) => `
      <button class="server-item ${server.id === state.selectedId ? 'active' : ''}" data-action="select-server" data-id="${esc(server.id)}">
        <span class="name">${esc(server.name)}</span>
        <span class="meta">${esc(server.eggName)} · ${esc(server.status)}${server.allocation ? ` · :${server.allocation.port}` : ''}</span>
      </button>`,
      )
      .join('');
  }
  const pool = document.getElementById('poolInfo');
  if (pool && state.pool) {
    pool.textContent = `Port havuzu: ${state.pool.usage.used}/${state.pool.usage.total} dolu · ${state.pool.range.min}-${state.pool.range.max}`;
  }
  const button = document.getElementById('newServerBtn');
  if (button) button.style.display = state.me?.role === 'admin' ? '' : 'none';
}

function renderTopbar() {
  const driver = document.getElementById('driver');
  if (driver) {
    driver.textContent = state.system
      ? `${state.system.driver}${state.system.docker ? ` ${state.system.docker}` : ''} · ${state.system.counts.running}/${state.system.counts.servers} çalışıyor`
      : '';
  }
  const stats = document.getElementById('hostStats');
  if (stats && state.system) {
    const memPct = Math.round(((state.system.totalMemoryBytes - state.system.freeMemoryBytes) / state.system.totalMemoryBytes) * 100);
    stats.textContent = `yük ${state.system.loadAvg.join(' ')} · ram ${memPct}% · panel ${fmtBytes(state.system.panel.memoryBytes)}`;
  }
  const who = document.getElementById('whoami');
  if (who && state.me) who.textContent = `${state.me.username} (${state.me.role})`;
}

// --- Ana içerik -------------------------------------------------------------

function renderMain() {
  const main = document.getElementById('main');
  if (!main) return;
  renderTopbar();
  if (!state.selectedId) {
    main.innerHTML = `
      <div class="card">
        <h3>Hoş geldin${state.me ? `, ${esc(state.me.username)}` : ''}</h3>
        <p class="muted">Soldan bir sunucu seç ya da yeni bir tane oluştur. Her sunucu kendi egg şablonuyla,
        kendi kaynak limitleriyle ve kendi portuyla izole bir ortamda çalışır.</p>
        <div class="grid-2 mt">
          <div><h4>Sunucular</h4><div class="mono">${state.system ? state.system.counts.servers : '—'} adet · ${state.system ? state.system.counts.running : '—'} çalışıyor</div></div>
          <div><h4>Egg şablonları</h4><div class="mono">${state.eggs.length} yüklü</div></div>
          <div><h4>Yedekler</h4><div class="mono">${state.system ? state.system.counts.backups : '—'} adet · ${state.system ? fmtBytes(state.system.backups.totalBytes) : '—'}</div></div>
          <div><h4>Port havuzu</h4><div class="mono">${state.pool ? `${state.pool.usage.free} boş port` : '—'}</div></div>
        </div>
      </div>`;
    return;
  }
  if (!state.detail) {
    main.innerHTML = '<div class="card muted">Yükleniyor…</div>';
    return;
  }
  const server = state.detail;
  const tabs = [
    ['konsol', 'Konsol'],
    ['dosyalar', 'Dosyalar'],
    ['ayarlar', 'Değişkenler & Ayarlar'],
    ['yedekler', 'Yedekler'],
    ['gorevler', 'Zamanlanmış Görevler'],
  ];
  if (state.me?.role !== 'viewer') tabs.push(['denetim', 'Denetim Kaydı']);
  if (state.me?.role === 'admin') tabs.push(['kullanicilar', 'Kullanıcılar'], ['sistem', 'Sistem']);

  main.innerHTML = `
    <div class="card">
      <div class="row">
        <strong>${esc(server.name)}</strong>
        ${pill(server.status)}
        <span class="small muted mono">${esc(server.eggName)}${server.allocation ? ` · port ${server.allocation.port}` : ''}</span>
        <span class="spacer"></span>
        <button class="primary" data-action="power" data-power="start">Başlat</button>
        <button data-action="power" data-power="restart">Yeniden Başlat</button>
        <button data-action="power" data-power="stop">Durdur</button>
        <button class="danger" data-action="power" data-power="kill">Öldür</button>
      </div>
      ${server.suspended ? `<div class="error mt">Askıda: ${esc(server.suspendReason || '')}</div>` : ''}
      <div class="grid-2 mt">
        <div>${bar(server.stats.memoryBytes || 0, server.stats.memoryLimitBytes || 0, 'Bellek')}</div>
        <div>${bar(server.stats.diskBytes || 0, server.stats.diskLimitBytes || 0, 'Disk')}</div>
        <div class="small muted">CPU: <span class="mono">${server.stats.cpuPercent === null || server.stats.cpuPercent === undefined ? '—' : `${server.stats.cpuPercent.toFixed(1)}%`}</span>
          · limit ${server.limits.cpu} çekirdek</div>
        <div class="small muted">Çalışma süresi: <span class="mono">${fmtDuration(server.uptimeMs)}</span>
          · yeniden başlatma ${server.restartCount} · çökme ${server.crashCount}</div>
      </div>
      ${server.lastError ? `<div class="error small mt">Son hata: ${esc(server.lastError)}</div>` : ''}
    </div>
    <div class="tabs">
      ${tabs.map(([id, label]) => `<button data-action="tab" data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${esc(label)}</button>`).join('')}
    </div>
    <div id="tabBody"></div>`;

  renderTab();
  applyBarWidths(main);
}

function renderTab(refresh = true) {
  const body = document.getElementById('tabBody');
  if (!body) return;
  const server = state.detail;
  if (!server) return;
  const renderers = {
    konsol: renderConsole,
    dosyalar: renderFiles,
    ayarlar: renderSettings,
    yedekler: renderBackupsTab,
    gorevler: renderSchedulesTab,
    denetim: renderAuditTab,
    kullanicilar: renderUsersTab,
    sistem: renderSystemTab,
  };
  (renderers[state.tab] || renderConsole)(body, server, refresh);
  applyBarWidths(body);
}

// --- Sekmeler ---------------------------------------------------------------

function renderConsole(body, server) {
  const readOnly = state.me?.role === 'viewer';
  body.innerHTML = `
    <div class="card">
      <div class="row">
        <span class="small muted">Canlı akış (SSE). Konsol çıktısı sunucuda son 1500 satır tutulur.</span>
        <span class="spacer"></span>
        <button class="ghost small" data-action="clear-console">Temizle</button>
        <button class="ghost small" data-action="power" data-power="install">Kurulumu Çalıştır</button>
      </div>
      <div class="console mt" id="console"></div>
      <form data-form="console" class="row mt">
        <input name="command" class="grow" placeholder="Konsola komut gönder (örn. /ping)" autocomplete="off" ${readOnly ? 'disabled' : ''} />
        <button class="primary" type="submit" ${readOnly ? 'disabled' : ''}>Gönder</button>
      </form>
    </div>`;
  const consoleEl = document.getElementById('console');
  for (const entry of state.logs) appendLog(consoleEl, entry);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function appendLog(target, entry) {
  if (!target) return;
  const line = document.createElement('div');
  const time = entry.at ? new Date(entry.at).toLocaleTimeString('tr-TR') : '';
  line.className = entry.stream === 'err' ? 'err' : entry.stream === 'in' ? 'in' : entry.line?.startsWith('[lumo]') ? 'sys' : '';
  line.textContent = `[${time}] ${entry.line}`;
  target.appendChild(line);
  const max = 1500;
  while (target.childElementCount > max) target.removeChild(target.firstChild);
  target.scrollTop = target.scrollHeight;
}

function renderFiles(body, server, refresh) {
  const files = state.files;
  const readOnly = state.me?.role === 'viewer';
  const crumbs = files.path
    ? `<button class="ghost small" data-action="files-up">▲ üst dizin</button><span class="mono small">/${esc(files.path)}</span>`
    : '<span class="mono small">/ (kök)</span>';

  body.innerHTML = `
    <div class="card">
      <div class="row">${crumbs}
        <span class="spacer"></span>
        <button class="ghost small" data-action="files-refresh">Yenile</button>
      </div>
      <table class="mt">
        <thead><tr><th>Ad</th><th class="nowrap">Boyut</th><th class="nowrap">İzin</th><th class="nowrap">Değişti</th><th></th></tr></thead>
        <tbody>
          ${(files.items || [])
            .map(
              (item) => `
            <tr>
              <td>${item.type === 'dir' ? '📁 ' : '📄 '}<span class="mono">${esc(item.name)}</span>${item.type === 'link' ? ' <span class="muted small">(bağ)</span>' : ''}</td>
              <td class="mono nowrap">${item.type === 'dir' ? '—' : fmtBytes(item.size)}</td>
              <td class="mono nowrap">${esc(item.mode)}</td>
              <td class="small nowrap muted">${fmtDate(item.mtime)}</td>
              <td class="nowrap">
                ${
                  item.type === 'dir'
                    ? `<button class="ghost small" data-action="files-open" data-path="${esc(item.path)}">Aç</button>`
                    : `<button class="ghost small" data-action="files-view" data-path="${esc(item.path)}">Düzenle</button>
                       <a class="btn ghost small" href="/api/servers/${esc(server.id)}/download?path=${encodeURIComponent(item.path)}">İndir</a>`
                }
                <button class="ghost small" data-action="files-rename" data-path="${esc(item.path)}">Yeniden adlandır</button>
                <button class="danger small" data-action="files-delete" data-path="${esc(item.path)}">Sil</button>
              </td>
            </tr>`,
            )
            .join('') || '<tr><td colspan="5" class="muted">Bu dizin boş.</td></tr>'}
        </tbody>
      </table>
      <div class="row mt">
        <input id="fileUpload" type="file" multiple ${readOnly ? 'disabled' : ''} />
        <button data-action="files-upload" ${readOnly ? 'disabled' : ''}>Yükle</button>
        <span class="spacer"></span>
        <input id="newDirName" placeholder="yeni-klasör" />
        <button data-action="files-mkdir" ${readOnly ? 'disabled' : ''}>Klasör Oluştur</button>
      </div>
    </div>
    <div class="card${files.editing ? '' : ' hidden'}" id="editorCard">
      <h3 class="mono">${esc(files.editing || '')}</h3>
      ${
        files.isBinary
          ? '<div class="muted">İkili dosya; panel içinde düzenlenemez. İndirip kendi editöründe aç.</div>'
          : `<textarea id="editor" rows="18" spellcheck="false" ${readOnly ? 'disabled' : ''}></textarea>
             <div class="row mt"><button class="primary" data-action="files-save" ${readOnly ? 'disabled' : ''}>Kaydet</button>
             <button class="ghost" data-action="files-close">Kapat</button></div>`
      }
    </div>`;
  if (files.editing && !files.isBinary) {
    const editor = document.getElementById('editor');
    if (editor) editor.value = files.content ?? '';
  }
  if (refresh) loadFiles(server.id, files.path);
}

function renderSettings(body, server) {
  const isAdmin = state.me?.role === 'admin';
  const readOnly = state.me?.role === 'viewer';
  const variables = server.variables || {};
  const fields = (server.eggVariables || [])
    .map((item) => {
      const current = variables[item.key] ?? '';
      const masked = item.secret && current === '••••••••';
      return `
        <div class="field">
          <label for="var-${esc(item.key)}">${esc(item.name)} <span class="mono">(${esc(item.key)})</span>
            ${item.required ? '<span class="warn">zorunlu</span>' : ''}${item.secret ? ' <span class="muted">sır</span>' : ''}</label>
          <input id="var-${esc(item.key)}" data-var="${esc(item.key)}" value="${masked ? '' : esc(current)}"
            placeholder="${masked ? 'değiştirmek için yaz (boş = dokunma)' : esc(item.default || '')}" ${readOnly ? 'disabled' : ''} />
          ${item.description ? `<div class="small muted">${esc(item.description)}</div>` : ''}
        </div>`;
    })
    .join('');

  body.innerHTML = `
    <div class="card">
      <h3>Genel</h3>
      <div class="grid-2">
        <div class="field"><label for="srvName">Ad</label><input id="srvName" value="${esc(server.name)}" ${readOnly ? 'disabled' : ''} /></div>
        <div class="field"><label for="srvPolicy">Yeniden başlatma politikası</label>
          <select id="srvPolicy" ${readOnly ? 'disabled' : ''}>
            ${['always', 'on-failure', 'never'].map((value) => `<option value="${value}" ${server.restartPolicy === value ? 'selected' : ''}>${value}</option>`).join('')}
          </select></div>
        <div class="field"><label for="srvAuto"><input type="checkbox" id="srvAuto" ${server.autoStart ? 'checked' : ''} ${readOnly ? 'disabled' : ''} /> Panel açılınca başlat</label></div>
        <div class="field"><label for="srvStartup">Başlangıç komutu (boş = egg varsayılanı)</label>
          <input id="srvStartup" value="${esc(server.startupOverride || '')}" placeholder="${esc(server.startupCommand || '')}" ${readOnly ? 'disabled' : ''} /></div>
      </div>
      <h4>Kaynak limitleri</h4>
      <div class="grid-2">
        <div class="field"><label for="limMem">Bellek (MB)</label><input id="limMem" type="number" min="128" value="${server.limits.memoryMb}" ${readOnly ? 'disabled' : ''} /></div>
        <div class="field"><label for="limCpu">CPU (çekirdek)</label><input id="limCpu" type="number" step="0.1" min="0.1" value="${server.limits.cpu}" ${readOnly ? 'disabled' : ''} /></div>
        <div class="field"><label for="limDisk">Disk (MB)</label><input id="limDisk" type="number" min="64" value="${server.limits.diskMb}" ${readOnly ? 'disabled' : ''} /></div>
        <div class="field"><label for="limPids">Süreç limiti (pids)</label><input id="limPids" type="number" min="32" value="${server.limits.pids}" ${readOnly ? 'disabled' : ''} /></div>
      </div>
      <div class="row">
        <button class="primary" data-action="save-settings" ${readOnly ? 'disabled' : ''}>Kaydet</button>
        <span class="small muted">Çalışan sunucuda limitler bir sonraki başlatmada geçerli olur.</span>
      </div>
      <h4>Başlangıç değişkenleri</h4>
      ${fields || '<div class="muted small">Bu egg değişken tanımlamıyor.</div>'}
      <div class="row mt">
        <button class="primary" data-action="save-variables" ${readOnly ? 'disabled' : ''}>Değişkenleri Kaydet</button>
      </div>
    </div>
    <div class="card">
      <h3>Tehlikeli bölge</h3>
      <div class="row">
        ${isAdmin ? (server.suspended
          ? '<button data-action="resume">Askıdan Çıkar</button>'
          : '<button class="danger" data-action="suspend">Askıya Al</button>') : ''}
        ${isAdmin ? '<button class="danger" data-action="delete-server">Sunucuyu Sil (dosyalar kalsın)</button>' : ''}
        ${isAdmin ? '<button class="danger" data-action="delete-server-files">Sunucuyu ve Dosyaları Sil</button>' : ''}
      </div>
      <div class="small muted mt">Sunucu kimliği: <span class="mono">${esc(server.id)}</span> · egg: <span class="mono">${esc(server.egg)}</span> · kurulum: ${fmtDate(server.installedAt)}</div>
    </div>`;
}

function renderBackupsTab(body, server) {
  body.innerHTML = `
    <div class="card">
      <div class="row">
        <input id="backupName" placeholder="yedek adı (isteğe bağlı)" />
        <input id="backupKeep" class="w-narrow" type="number" min="1" max="50" value="5" title="saklanacak yedek sayısı" />
        <button class="primary" data-action="create-backup">Yedek Al</button>
        <span class="small muted">Yedek, sunucu dizininin tamamını tar.gz olarak alır; symlink'ler atlanır.</span>
      </div>
      <table class="mt">
        <thead><tr><th>Ad</th><th class="nowrap">Boyut</th><th class="nowrap">Dosya</th><th class="nowrap">Tarih</th><th class="nowrap">Kim</th><th></th></tr></thead>
        <tbody>
          ${state.backups
            .map(
              (item) => `
            <tr>
              <td>${esc(item.name)}</td>
              <td class="mono nowrap">${fmtBytes(item.sizeBytes)}</td>
              <td class="mono nowrap">${item.fileCount}</td>
              <td class="small nowrap">${fmtDate(item.createdAt)}</td>
              <td class="small nowrap">${esc(item.createdBy)}</td>
              <td class="nowrap">
                <a class="btn ghost small" href="/api/backups/${esc(item.id)}/download">İndir</a>
                <button class="ghost small" data-action="restore-backup" data-id="${esc(item.id)}">Geri Yükle</button>
                <button class="danger small" data-action="delete-backup" data-id="${esc(item.id)}">Sil</button>
              </td>
            </tr>`,
            )
            .join('') || '<tr><td colspan="6" class="muted">Yedek yok.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

function renderSchedulesTab(body, server) {
  const rows = state.schedules
    .map(
      (item) => `
      <tr>
        <td>${esc(item.name)}<div class="small muted">${esc(item.description || '')}</div></td>
        <td class="mono nowrap">${esc(item.cron)}<div class="small muted">${item.nextRun ? `sonraki: ${fmtDate(item.nextRun)}` : '—'}</div></td>
        <td class="small mono">${(item.tasks || []).map((task) => esc(task.action === 'power' ? `güç:${task.power}` : task.action === 'command' ? `komut:${task.command}` : `yedek(${task.keep})`)).join('<br>')}</td>
        <td class="nowrap">${item.enabled ? '<span class="ok small">açık</span>' : '<span class="muted small">kapalı</span>'}</td>
        <td class="small">${item.lastRun ? `${fmtDate(item.lastRun.at)} ${item.lastRun.ok ? '<span class="ok">✓</span>' : '<span class="error">✗</span>'}` : '—'}</td>
        <td class="nowrap">
          <button class="ghost small" data-action="run-schedule" data-id="${esc(item.id)}">Şimdi çalıştır</button>
          <button class="ghost small" data-action="toggle-schedule" data-id="${esc(item.id)}" data-enabled="${item.enabled}">${item.enabled ? 'Kapat' : 'Aç'}</button>
          <button class="danger small" data-action="delete-schedule" data-id="${esc(item.id)}">Sil</button>
        </td>
      </tr>`,
    )
    .join('');

  body.innerHTML = `
    <div class="card">
      <h3>Yeni görev</h3>
      <div class="grid-2">
        <div class="field"><label for="schName">Ad</label><input id="schName" placeholder="Günlük yedek" /></div>
        <div class="field"><label for="schCron">Cron (dakika saat gün ay haftagün)</label><input id="schCron" placeholder="0 4 * * *" class="mono" /></div>
      </div>
      <div class="field"><label for="schDesc">Açıklama</label><input id="schDesc" placeholder="Her gece 04:00'te yedek al" /></div>
      <div class="field">
        <label for="schSteps">Adımlar (satır başına bir adım)</label>
        <textarea id="schSteps" rows="3" spellcheck="false">power:restart
backup:5</textarea>
        <div class="small muted">Biçim: <span class="mono">power:start|stop|restart|kill</span>, <span class="mono">command:/komut</span>, <span class="mono">backup:5</span> (5 = saklanacak yedek sayısı).</div>
      </div>
      <button class="primary" data-action="create-schedule">Görev Ekle</button>
    </div>
    <div class="card">
      <h3>Görevler</h3>
      <table>
        <thead><tr><th>Ad</th><th class="nowrap">Cron</th><th>Adımlar</th><th class="nowrap">Durum</th><th class="nowrap">Son çalışma</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">Görev yok.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function renderAuditTab(body) {
  body.innerHTML = `
    <div class="card">
      <div class="row"><h3 class="m0">Denetim kaydı</h3><span class="spacer"></span>
        <span class="small muted">Sır değerleri asla kaydedilmez.</span></div>
      <table class="mt">
        <thead><tr><th class="nowrap">Zaman</th><th>Kim</th><th>İşlem</th><th>Hedef</th><th>Detay</th><th>IP</th></tr></thead>
        <tbody>
          ${state.audit
            .map(
              (item) => `<tr>
                <td class="small nowrap">${fmtDate(item.at)}</td>
                <td class="small">${esc(item.actor)}</td>
                <td class="mono small">${esc(item.action)}</td>
                <td class="small">${esc(item.target || '—')}</td>
                <td class="mono small">${esc(item.detail ? JSON.stringify(item.detail) : '—')}</td>
                <td class="small mono">${esc(item.ip || '—')}</td>
              </tr>`,
            )
            .join('') || '<tr><td colspan="6" class="muted">Kayıt yok.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

function renderUsersTab(body) {
  body.innerHTML = `
    <div class="card">
      <h3>Yeni kullanıcı</h3>
      <div class="grid-2">
        <div class="field"><label for="newUser">Kullanıcı adı</label><input id="newUser" /></div>
        <div class="field"><label for="newPass">Parola (min 10)</label><input id="newPass" type="password" /></div>
        <div class="field"><label for="newRole">Rol</label>
          <select id="newRole"><option value="viewer">viewer (sadece okuma)</option><option value="operator">operator (güç, dosya, yedek, görev)</option><option value="admin">admin (tam yetki)</option></select></div>
      </div>
      <button class="primary" data-action="create-user">Ekle</button>
    </div>
    <div class="card">
      <h3>Kullanıcılar</h3>
      <table>
        <thead><tr><th>Ad</th><th>Rol</th><th class="nowrap">Son giriş</th><th class="nowrap">Oluşturuldu</th><th></th></tr></thead>
        <tbody>
          ${state.users
            .map(
              (item) => `<tr>
                <td>${esc(item.username)}${item.id === state.me?.id ? ' <span class="muted small">(sen)</span>' : ''}</td>
                <td>
                  <select data-role-for="${esc(item.id)}" ${item.id === state.me?.id ? 'disabled' : ''}>
                    ${['viewer', 'operator', 'admin'].map((role) => `<option value="${role}" ${item.role === role ? 'selected' : ''}>${role}</option>`).join('')}
                  </select>
                </td>
                <td class="small nowrap">${fmtDate(item.lastLoginAt)}</td>
                <td class="small nowrap">${fmtDate(item.createdAt)}</td>
                <td class="nowrap">
                  <button class="ghost small" data-action="save-role" data-id="${esc(item.id)}" ${item.id === state.me?.id ? 'disabled' : ''}>Rolü kaydet</button>
                  <button class="ghost small" data-action="reset-password" data-id="${esc(item.id)}">Parola sıfırla</button>
                  <button class="danger small" data-action="delete-user" data-id="${esc(item.id)}" ${item.id === state.me?.id ? 'disabled' : ''}>Sil</button>
                </td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function renderSystemTab(body) {
  const sys = state.system;
  body.innerHTML = `
    <div class="card">
      <h3>Sistem</h3>
      ${
        sys
          ? `<div class="grid-2">
        <div><h4>Makine</h4>
          <div class="mono small">${esc(sys.hostname)} · ${esc(sys.platform)}</div>
          <div class="mono small">node ${esc(sys.node)} · ${sys.cpuCount} çekirdek</div>
          <div class="mono small">${esc(sys.cpuModel || '')}</div>
          <div class="mono small">yük: ${sys.loadAvg.join(' ')} · açık: ${fmtDuration(sys.uptimeSeconds * 1000)}</div>
        </div>
        <div><h4>Bellek</h4>
          ${bar(sys.totalMemoryBytes - sys.freeMemoryBytes, sys.totalMemoryBytes, 'RAM')}
        </div>
        <div><h4>Disk</h4>
          ${sys.disk ? bar(sys.disk.usedBytes, sys.disk.totalBytes, 'Disk') : '<div class="muted small">Bilinmiyor</div>'}
        </div>
        <div><h4>Panel süreci</h4>
          <div class="mono small">pid ${sys.panel.pid} · ${fmtBytes(sys.panel.memoryBytes)} · açık ${fmtDuration(sys.panel.uptimeSeconds * 1000)}</div>
          <div class="mono small">sürücü: ${esc(sys.driver)}${sys.docker ? ` · docker ${esc(sys.docker)}` : ''}</div>
        </div>
        <div><h4>Sayaçlar</h4>
          <div class="mono small">${sys.counts.servers} sunucu · ${sys.counts.running} çalışıyor · ${sys.counts.users} kullanıcı</div>
          <div class="mono small">${sys.counts.backups} yedek (${fmtBytes(sys.backups.totalBytes)}) · ${sys.counts.schedules} görev · ${sys.counts.eggs} egg</div>
          <div class="mono small">port havuzu: ${sys.allocations.used}/${sys.allocations.total}</div>
        </div>
      </div>`
          : '<div class="muted">Yükleniyor…</div>'
      }
    </div>
    <div class="card">
      <h3>Egg şablonları</h3>
      <table>
        <thead><tr><th>Ad</th><th>Nest</th><th class="nowrap">İmaj</th><th class="nowrap">Başlangıç</th><th>Kaynak varsayılanı</th></tr></thead>
        <tbody>
          ${state.eggs
            .map(
              (egg) => `<tr>
                <td>${esc(egg.name)}<div class="small muted">${esc(egg.description || '')}</div></td>
                <td class="small">${esc(state.nests.find((n) => n.id === egg.nest)?.name || egg.nest)}</td>
                <td class="mono small">${esc(egg.docker.image)}</td>
                <td class="mono small">${esc(egg.startup)}</td>
                <td class="mono small">${egg.features.memoryMb}MB · ${egg.features.cpu} cpu · ${egg.features.diskMb}MB</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

// --- Veri yükleme -----------------------------------------------------------

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
  // Önce veriyi çek, sonra kabuğu çiz: hoş geldin kartı ilk boyamada dolu görünsün
  // (refreshAll'ın render çağrıları DOM hazır değilse sessizce çıkar).
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
  if (state.selectedId && !state.detail) await selectServer(state.selectedId);
  renderTopbar();
  if (state.selectedId && state.detail) {
    const fresh = state.servers.find((item) => item.id === state.selectedId);
    if (fresh) {
      state.detail = { ...state.detail, ...fresh, variables: state.detail.variables };
      const pillEl = document.querySelector('.pill');
      if (pillEl) {
        pillEl.className = `pill ${fresh.status}`;
        pillEl.textContent = fresh.status;
      }
    }
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
      const el = document.querySelector('.pill');
      if (el) {
        el.className = `pill ${payload.status}`;
        el.textContent = payload.status;
      }
    } else if (payload.type === 'stats' && state.detail) {
      state.detail.stats = payload.stats;
    }
  };
  stream.onerror = () => {
    /* tarayıcı otomatik yeniden bağlanır (retry: 3000) */
  };
}

async function loadFiles(serverId, path) {
  try {
    const result = await api('GET', `/api/servers/${serverId}/files?path=${encodeURIComponent(path || '')}`);
    state.files.path = result.path;
    state.files.items = result.items;
    renderTab(false);
    renderFiles(document.getElementById('tabBody'), state.detail, false);
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

// --- Giriş ekranları --------------------------------------------------------

function renderSetup(status) {
  document.body.innerHTML = `
    <div class="card center">
      <h3>Lumo Panel kurulumu</h3>
      <p class="muted small">İlk yönetici hesabını oluştur. Parola en az 10 karakter olmalı.</p>
      <div class="field"><label for="setupUser">Kullanıcı adı</label><input id="setupUser" autocomplete="username" /></div>
      <div class="field"><label for="setupPass">Parola</label><input id="setupPass" type="password" autocomplete="new-password" /></div>
      <div class="field"><label for="setupPass2">Parola (tekrar)</label><input id="setupPass2" type="password" autocomplete="new-password" /></div>
      <button class="primary" data-action="do-setup">Kurulumu Tamamla</button>
      <div class="small muted mt">Sürüm ${esc(status.version)}</div>
    </div>`;
}

function renderLogin() {
  document.body.innerHTML = `
    <div class="card center">
      <h3>Lumo Panel</h3>
      <div class="field"><label for="loginUser">Kullanıcı adı</label><input id="loginUser" autocomplete="username" /></div>
      <div class="field"><label for="loginPass">Parola</label><input id="loginPass" type="password" autocomplete="current-password" /></div>
      <button class="primary" data-action="do-login">Giriş</button>
    </div>`;
}

function renderNewServerDialog() {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <form method="dialog" id="newServerForm">
      <h3 class="mt0">Yeni sunucu</h3>
      <div class="grid-2">
        <div class="field"><label for="nsName">Ad</label><input id="nsName" placeholder="Moderasyon Botu" /></div>
        <div class="field"><label for="nsEgg">Egg (şablon)</label>
          <select id="nsEgg">
            ${state.eggs.map((egg) => `<option value="${esc(egg.id)}">${esc(egg.name)} — ${esc(state.nests.find((n) => n.id === egg.nest)?.name || egg.nest)}</option>`).join('')}
          </select></div>
      </div>
      <div class="field"><label for="nsPort"><input type="checkbox" id="nsPort" checked /> Port tahsis et (egg port istiyorsa)</label></div>
      <div class="field"><label for="nsAuto"><input type="checkbox" id="nsAuto" checked /> Panel açılınca başlat</label></div>
      <div id="nsVars"></div>
      <div class="row">
        <button class="primary" type="button" data-action="create-server">Oluştur</button>
        <button type="button" data-action="close-dialog">Vazgeç</button>
      </div>
      <div class="small muted mt">Değişkenler egg'e göre değişir; sırlar şifreli kasada tutulur ve bota yalnızca kendi sürecinde aktarılır.</div>
    </form>`;
  document.body.appendChild(dialog);
  const select = dialog.querySelector('#nsEgg');
  const renderVars = () => {
    const egg = state.eggs.find((item) => item.id === select.value);
    dialog.querySelector('#nsVars').innerHTML = egg
      ? `<h4>Başlangıç değişkenleri</h4>` +
        egg.variables
          .map(
            (item) => `<div class="field"><label for="nsv-${esc(item.key)}">${esc(item.name)} (${esc(item.key)})${item.required ? ' *' : ''}</label>
              <input id="nsv-${esc(item.key)}" data-var="${esc(item.key)}" value="${esc(item.secret ? '' : item.default || '')}" />
              ${item.description ? `<div class="small muted">${esc(item.description)}</div>` : ''}</div>`,
          )
          .join('')
      : '';
  };
  select.addEventListener('change', renderVars);
  renderVars();
  dialog.showModal();
}

// --- Eylemler ---------------------------------------------------------------

async function handleAction(action, el) {
  const server = state.detail;
  try {
    switch (action) {
      case 'logout': {
        await api('POST', '/api/auth/logout');
        state.stream?.close();
        renderLogin();
        break;
      }
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
        if (state.tab === 'denetim') await loadAudit();
        break;
      case 'tab': {
        state.tab = el.dataset.tab;
        renderMain();
        if (state.tab === 'dosyalar') await loadFiles(state.selectedId, '');
        if (state.tab === 'yedekler') await loadBackups(state.selectedId);
        if (state.tab === 'gorevler') await loadSchedules(state.selectedId);
        if (state.tab === 'denetim') await loadAudit();
        if (state.tab === 'kullanicilar') await loadUsers();
        break;
      }
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
        toast(`${power} komutu gönderildi.`);
        break;
      }
      case 'clear-console':
        state.logs = [];
        renderTab(false);
        renderConsole(document.getElementById('tabBody'), server);
        break;
      case 'save-settings': {
        await api('PATCH', `/api/servers/${server.id}`, {
          name: document.getElementById('srvName').value.trim(),
          restartPolicy: document.getElementById('srvPolicy').value,
          autoStart: document.getElementById('srvAuto').checked,
          startupOverride: document.getElementById('srvStartup').value.trim() || null,
          limits: {
            memoryMb: Number(document.getElementById('limMem').value),
            cpu: Number(document.getElementById('limCpu').value),
            diskMb: Number(document.getElementById('limDisk').value),
            pids: Number(document.getElementById('limPids').value),
          },
        });
        toast('Ayarlar kaydedildi.');
        await selectServer(server.id);
        break;
      }
      case 'save-variables': {
        const variables = {};
        document.querySelectorAll('[data-var]').forEach((input) => {
          if (input.value !== '') variables[input.dataset.var] = input.value;
        });
        await api('PATCH', `/api/servers/${server.id}`, { variables });
        toast('Değişkenler kaydedildi.');
        await selectServer(server.id);
        break;
      }
      case 'suspend':
        await api('POST', `/api/servers/${server.id}/suspend`, { reason: 'yönetici kararı' });
        await selectServer(server.id);
        break;
      case 'resume':
        await api('POST', `/api/servers/${server.id}/resume`);
        await selectServer(server.id);
        break;
      case 'delete-server':
      case 'delete-server-files': {
        const withFiles = action === 'delete-server-files';
        if (!confirm(`${server.name} silinsin mi?${withFiles ? ' Dosyalar ve yedekler de silinecek!' : ''}`)) break;
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
      // --- dosyalar
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
        renderFiles(document.getElementById('tabBody'), server, false);
        break;
      }
      case 'files-close':
        state.files.editing = null;
        renderTab(false);
        renderFiles(document.getElementById('tabBody'), server, false);
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
        if (!name) throw new Error('Klasör adı gerekli.');
        const path = state.files.path ? `${state.files.path}/${name}` : name;
        await api('POST', `/api/servers/${server.id}/mkdir`, { path });
        await loadFiles(server.id, state.files.path);
        break;
      }
      case 'files-upload': {
        const input = document.getElementById('fileUpload');
        if (!input.files?.length) throw new Error('Dosya seç.');
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
      // --- yedekler
      case 'create-backup':
        await api('POST', `/api/servers/${server.id}/backups`, {
          name: document.getElementById('backupName').value.trim() || null,
          keep: Number(document.getElementById('backupKeep').value) || 5,
        });
        toast('Yedek alındı.');
        await loadBackups(server.id);
        break;
      case 'restore-backup':
        if (!confirm('Yedek geri yüklenecek. Sunucu durdurulacak ve dizin yedekteki hâle dönecek. Devam?')) break;
        await api('POST', `/api/backups/${el.dataset.id}/restore`);
        toast('Yedek geri yüklendi.');
        await selectServer(server.id);
        break;
      case 'delete-backup':
        if (!confirm('Yedek silinsin mi?')) break;
        await api('DELETE', `/api/backups/${el.dataset.id}`);
        await loadBackups(server.id);
        break;
      // --- görevler
      case 'create-schedule': {
        const steps = document.getElementById('schSteps').value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (!steps.length) throw new Error('En az bir adım yaz.');
        const tasks = steps.map((line) => {
          const [kind, ...rest] = line.split(':');
          const value = rest.join(':').trim();
          if (kind.trim() === 'power') return { action: 'power', power: value };
          if (kind.trim() === 'command') return { action: 'command', command: value };
          if (kind.trim() === 'backup') return { action: 'backup', keep: Number(value) || 5 };
          throw new Error(`Anlaşılmayan adım: ${line}`);
        });
        await api('POST', '/api/schedules', {
          serverId: server.id,
          name: document.getElementById('schName').value.trim() || 'Görev',
          description: document.getElementById('schDesc').value.trim(),
          cron: document.getElementById('schCron').value.trim(),
          tasks,
          enabled: true,
        });
        toast('Görev eklendi.');
        await loadSchedules(server.id);
        break;
      }
      case 'run-schedule':
        await api('POST', `/api/schedules/${el.dataset.id}/run`);
        toast('Görev çalıştırıldı.');
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
      // --- kullanıcılar
      case 'create-user':
        await api('POST', '/api/users', {
          username: document.getElementById('newUser').value.trim(),
          password: document.getElementById('newPass').value,
          role: document.getElementById('newRole').value,
        });
        toast('Kullanıcı eklendi.');
        await loadUsers();
        break;
      case 'save-role': {
        const select = document.querySelector(`select[data-role-for="${el.dataset.id}"]`);
        await api('PATCH', `/api/users/${el.dataset.id}`, { role: select.value });
        toast('Rol güncellendi.');
        await loadUsers();
        break;
      }
      case 'reset-password': {
        const password = prompt('Yeni parola (min 10 karakter):');
        if (!password) break;
        await api('PATCH', `/api/users/${el.dataset.id}`, { password });
        toast('Parola değiştirildi; kullanıcının oturumları kapatıldı.');
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
  // Kurulum ve giriş ekranlarında form yok: Enter ana eylemi tetiklesin.
  const card = event.target.closest('.card');
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
  document.body.innerHTML = `<div class="card center"><h3>Panel yüklenemedi</h3><div class="error">${esc(err.message)}</div></div>`;
});

export { state, esc, api };
