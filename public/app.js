/* Lumo Panel — arayüz. Bağımlılık yok, tamamen vanilla JS. */

const appEl = document.getElementById('app');
const toastRoot = document.getElementById('toasts');
const modalRoot = document.getElementById('modal-root');

const state = { user: null, bots: [], needsSetup: false };
let viewCleanup = null;
let viewRefresh = null;
let refreshSidebar = null;
let shellCleanup = null;

// ------------------------------------------------------------------- helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') applyStyle(el, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'type' || key === 'placeholder') el[key] = value;
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Stilleri CSSOM üzerinden uygular.
 * Panelin CSP'si `style-src 'self'` olduğu için `style="..."` niteliği tarayıcı
 * tarafından reddedilir; `el.style.setProperty` ise CSP'den etkilenmez.
 */
function applyStyle(el, value) {
  if (!value) return;
  if (typeof value === 'object') {
    for (const [prop, val] of Object.entries(value)) el.style.setProperty(prop, val);
    return;
  }
  for (const declaration of String(value).split(';')) {
    const index = declaration.indexOf(':');
    if (index < 0) continue;
    const prop = declaration.slice(0, index).trim();
    const val = declaration.slice(index + 1).trim();
    if (prop && val) el.style.setProperty(prop, val);
  }
}

const pad = (n) => String(n).padStart(2, '0');

function fmtBytes(n) {
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

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d) return `${d}g ${hh}sa`;
  if (hh) return `${hh}sa ${pad(mm)}dk`;
  if (mm) return `${mm}dk ${pad(ss)}sn`;
  return `${ss}sn`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message);
  toastRoot.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }
  if (!res.ok) {
    if (res.status === 401) {
      state.user = null;
      boot();
    }
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

const STATE_LABEL = {
  running: 'çalışıyor',
  restarting: 'yeniden başlıyor',
  stopped: 'durdu',
  crashed: 'çöktü',
  failed: 'durdu (koruma)',
};

function statusPill(status) {
  const s = status?.state ?? 'stopped';
  return h('span', { class: `pill state-${s}` }, h('span', { class: 'dot' }), STATE_LABEL[s] ?? s);
}

function applyStatus(pillEl, status) {
  const s = status?.state ?? 'stopped';
  pillEl.className = `pill state-${s}`;
  pillEl.replaceChildren(h('span', { class: 'dot' }), STATE_LABEL[s] ?? s);
}

function openModal({ title, body, footer, wide = false }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  const modal = h(
    'div',
    { class: 'modal', style: wide ? 'max-width:1050px' : null },
    h('div', { class: 'modal-head' }, h('span', { class: 'title' }, title), h('span', { class: 'spacer' }), h('button', { class: 'btn icon', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  backdrop.append(modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  modalRoot.append(backdrop);
  return close;
}

/** Aktif görünümü bırakır (canlı konsol aboneliği, zamanlayıcılar). Kabuğa dokunmaz. */
function releaseView() {
  if (viewCleanup) {
    try {
      viewCleanup();
    } catch {
      /* yok say */
    }
  }
  viewCleanup = null;
  viewRefresh = null;
  refreshSidebar = null;
}

/**
 * Kabuğu tamamen yıkar: görünüm temizliği + hash dinleyicisi.
 * Çıkışta veya oturum düştüğünde çağrılır; aksi halde artık DOM'da olmayan
 * elemanlara çizen bir dinleyici kalır.
 */
function destroyShell() {
  releaseView();
  if (shellCleanup) {
    try {
      shellCleanup();
    } catch {
      /* yok say */
    }
    shellCleanup = null;
  }
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'bot' && parts[1]) return { name: 'bot', id: parts[1], tab: parts[2] ?? 'console' };
  if (parts[0] === 'system') return { name: 'system' };
  if (parts[0] === 'audit') return { name: 'audit' };
  return { name: 'overview' };
}

function go(hash) {
  // Aynı adrese tıklamak da görünümü tazelemeli; hash değişmediği için
  // tarayıcı olay üretmez, bu yüzden elle tetikliyoruz.
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

// ---------------------------------------------------------------- boot / auth

async function boot() {
  destroyShell();
  try {
    const setup = await api('/api/setup/status');
    state.needsSetup = setup.needsSetup;
    if (setup.needsSetup) return renderSetup();
    try {
      const me = await api('/api/me');
      state.user = me.user;
      const bots = await api('/api/bots');
      state.bots = bots.bots;
      return renderShell();
    } catch {
      return renderLogin();
    }
  } catch (err) {
    appEl.className = 'auth';
    appEl.replaceChildren(
      h('div', { class: 'auth-card' }, h('h2', {}, 'Panel ile bağlantı kurulamadı'), h('p', { class: 'hint' }, err.message)),
    );
  }
}

function authShell(title, hint, form) {
  appEl.className = 'auth';
  appEl.replaceChildren(
    h(
      'div',
      { class: 'auth-card' },
      h(
        'div',
        { class: 'auth-logo' },
        h('div', { class: 'logo-mark' }, 'L'),
        h('div', {}, h('div', { class: 'logo-text' }, 'Lumo Panel'), h('div', { class: 'logo-sub' }, 'bot kontrol merkezi')),
      ),
      h('h2', {}, title),
      h('p', { class: 'hint' }, hint),
      form,
    ),
  );
}

function renderSetup() {
  const username = h('input', { placeholder: 'admin', autocomplete: 'username', autofocus: true });
  const password = h('input', { type: 'password', placeholder: 'en az 10 karakter', autocomplete: 'new-password' });
  const confirmInput = h('input', { type: 'password', placeholder: 'parolayı tekrarla', autocomplete: 'new-password' });
  const submit = h('button', { class: 'btn primary full', type: 'submit' }, 'Yönetici hesabı oluştur');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (password.value !== confirmInput.value) return toast('Parolalar eşleşmiyor', 'error');
        submit.disabled = true;
        try {
          const res = await api('/api/setup', { method: 'POST', body: { username: username.value, password: password.value } });
          state.user = res.user;
          toast('Kurulum tamamlandı', 'success');
          await boot();
        } catch (err) {
          toast(err.message, 'error');
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Kullanıcı adı'), username),
    h('label', { class: 'field' }, h('span', {}, 'Parola'), password),
    h('label', { class: 'field' }, h('span', {}, 'Parola (tekrar)'), confirmInput),
    h('div', { class: 'note info mb' }, 'Bu parola tek yönlü (scrypt) özetlenir; panel verisi ve bot token\'ları AES-256-GCM ile şifreli saklanır.'),
    submit,
  );
  authShell('İlk kurulum', 'Panelde henüz kullanıcı yok. İlk yönetici hesabını oluştur.', form);
}

function renderLogin() {
  const username = h('input', { placeholder: 'kullanıcı adı', autocomplete: 'username', autofocus: true });
  const password = h('input', { type: 'password', placeholder: 'parola', autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn primary full', type: 'submit' }, 'Giriş yap');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          const res = await api('/api/auth/login', { method: 'POST', body: { username: username.value, password: password.value } });
          state.user = res.user;
          await boot();
        } catch (err) {
          toast(err.message, 'error');
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Kullanıcı adı'), username),
    h('label', { class: 'field' }, h('span', {}, 'Parola'), password),
    submit,
  );
  authShell('Giriş yap', 'Devam etmek için yönetici hesabınla giriş yap.', form);
}

// ---------------------------------------------------------------------- shell

function renderShell() {
  destroyShell();
  appEl.className = '';

  const mainEl = h('div', { class: 'main' });
  const botListEl = h('div', { class: 'bot-list' });
  const current = route();

  const navItems = [
    { key: 'overview', label: 'Genel Bakış', hash: '#/' },
    { key: 'system', label: 'Sistem', hash: '#/system' },
    { key: 'audit', label: 'Denetim Kaydı', hash: '#/audit' },
  ];

  const shell = h(
    'div',
    { class: 'shell' },
    h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'sidebar-head' },
        h('div', { class: 'logo-mark' }, 'L'),
        h('div', {}, h('div', { class: 'logo-text' }, 'Lumo'), h('div', { class: 'logo-sub' }, 'bot paneli')),
      ),
      h(
        'div',
        { class: 'nav' },
        navItems.map((item) =>
          h(
            'button',
            {
              class: `nav-item ${current.name === item.key ? 'active' : ''}`,
              onclick: () => go(item.hash),
            },
            h('span', { class: 'label' }, item.label),
          ),
        ),
      ),
      h(
        'div',
        { class: 'sidebar-section' },
        h('span', {}, 'Botlar'),
        h('button', { class: 'btn icon sm', title: 'Yeni bot', onclick: () => openCreateBot() }, '+'),
      ),
      botListEl,
      h(
        'div',
        { class: 'sidebar-foot' },
        h('div', { class: 'avatar' }, (state.user?.username ?? '?').slice(0, 1).toUpperCase()),
        h('div', { style: 'flex:1;min-width:0' }, h('div', { style: 'font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis' }, state.user?.username), h('div', { class: 'dim', style: 'font-size:11px' }, 'yönetici')),
        h('button', { class: 'btn icon sm', title: 'Parola değiştir', onclick: openPasswordModal }, '⚿'),
        h('button', { class: 'btn icon sm', title: 'Çıkış', onclick: logout }, '⏻'),
      ),
    ),
    mainEl,
  );

  appEl.replaceChildren(shell);

  refreshSidebar = () => {
    botListEl.replaceChildren(...botSidebarItems());
  };
  refreshSidebar();

  renderMain(mainEl, current);

  const onHashChange = () => {
    const next = route();
    renderNavActive(shell, next);
    renderMain(mainEl, next);
  };
  window.addEventListener('hashchange', onHashChange);
  shellCleanup = () => window.removeEventListener('hashchange', onHashChange);
}

function renderNavActive(shell, current) {
  const items = shell.querySelectorAll('.nav-item');
  const keys = ['overview', 'system', 'audit'];
  items.forEach((el, i) => el.classList.toggle('active', keys[i] === current.name));
}

function botSidebarItems() {
  if (state.bots.length === 0) {
    return [h('div', { class: 'dim', style: 'font-size:12px;padding:8px 11px' }, 'Henüz bot yok')];
  }
  const current = route();
  return state.bots.map((bot) =>
    h(
      'button',
      {
        class: `nav-item ${current.name === 'bot' && current.id === bot.id ? 'active' : ''}`,
        onclick: () => go(`#/bot/${bot.id}/console`),
        title: bot.name,
      },
      h('span', { class: `dot state-${bot.status?.state ?? 'stopped'}`, style: dotColor(bot.status?.state) }),
      h('span', { class: 'label' }, bot.name),
    ),
  );
}

function dotColor(s) {
  const map = { running: '#22c55e', restarting: '#f59e0b', crashed: '#ef4444', failed: '#ef4444', stopped: '#64748b' };
  return `background:${map[s] ?? '#64748b'}`;
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    /* yok say */
  }
  state.user = null;
  boot();
}

function openPasswordModal() {
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const save = h('button', { class: 'btn primary' }, 'Kaydet');
  const close = openModal({
    title: 'Parola değiştir',
    body: h(
      'div',
      {},
      h('label', { class: 'field' }, h('span', {}, 'Mevcut parola'), current),
      h('label', { class: 'field' }, h('span', {}, 'Yeni parola (en az 10 karakter)'), next),
    ),
    footer: [h('button', { class: 'btn', onclick: () => close() }, 'Vazgeç'), save],
  });
  save.addEventListener('click', async () => {
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: current.value, next: next.value } });
      toast('Parola güncellendi', 'success');
      close();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------------- main

async function renderMain(main, current) {
  releaseView();
  main.replaceChildren(h('div', { class: 'dim' }, 'Yükleniyor…'));
  const content = h('div');
  main.replaceChildren(content);
  try {
    if (current.name === 'bot') await viewBot(content, current.id, current.tab);
    else if (current.name === 'system') await viewSystem(content);
    else if (current.name === 'audit') await viewAudit(content);
    else await viewOverview(content);
  } catch (err) {
    content.replaceChildren(
      h('div', { class: 'card' }, h('h3', {}, 'Bir şeyler ters gitti'), h('p', { class: 'card-sub' }, err.message)),
    );
  }
}

// ------------------------------------------------------------------ genel bakış

async function viewOverview(main) {
  const data = await api('/api/system');
  const host = data.host;
  const memPct = Math.round((host.memUsed / host.memTotal) * 100);
  const loadPct = host.cpuCount ? Math.min(100, Math.round((host.loadavg[0] / host.cpuCount) * 100)) : 0;

  const stats = h('div', { class: 'grid stats mb' });
  const cardsEl = h('div', { class: 'grid bots' });

  function paintStats(sys) {
    stats.replaceChildren(
      statCard('Bot durumu', `${sys.runningCount}`, `/ ${sys.botCount} çalışıyor`, `sürücü: ${sys.panel.driver}`),
      statCard('CPU yükü', `${host.loadavg[0] ?? 0}`, `/ ${host.cpuCount} çekirdek`, null, loadPct, `${loadPct}% kullanım`),
      statCard('Bellek', fmtBytes(host.memUsed), ` / ${fmtBytes(host.memTotal)}`, null, memPct, `${memPct}% dolu`),
      statCard('Çalışma süresi', fmtDuration(host.uptime * 1000), 'makine açık kalma', `panel: ${fmtDuration(host.panelUptime * 1000)}`),
    );
  }

  function paintCards() {
    if (state.bots.length === 0) {
      cardsEl.replaceChildren(
        h(
          'div',
          { class: 'card empty', style: 'grid-column:1/-1' },
          h('div', { class: 'big' }, 'Henüz bot yok'),
          h('div', {}, 'Dosyalarını yüklemek ve 7/24 çalıştırmak için ilk botunu oluştur.'),
          h('div', { class: 'mt' }, h('button', { class: 'btn primary', onclick: () => openCreateBot() }, 'Bot oluştur')),
        ),
      );
      return;
    }
    cardsEl.replaceChildren(...state.bots.map((bot) => botCard(bot)));
  }

  paintStats(data);
  paintCards();
  // Not: DOM `append(null)` çağrısını "null" metnine çevirir — boşları süz.
  main.append(
    ...[
      pageHead('Genel Bakış', `${host.hostname} · ${host.platform}/${host.arch} · node ${host.node}`),
      h(
        'div',
        { class: 'row mb' },
        h('button', { class: 'btn primary', onclick: () => openCreateBot() }, '+ Yeni bot'),
        h('button', { class: 'btn', onclick: () => renderMain(main, { name: 'overview' }) }, '↻ Yenile'),
      ),
      stats,
      h('div', { class: 'sidebar-section', style: 'padding:0 0 10px' }, h('span', {}, 'Botlar')),
      cardsEl,
      host.docker === false && data.panel.driver === 'docker'
        ? h('div', { class: 'note mt' }, 'Uyarı: sürücü "docker" seçili ama /var/run/docker.sock görünmüyor. Konteynerler başlatılamaz.')
        : null,
    ].filter(Boolean),
  );

  viewRefresh = () => {
    paintStats({ ...data, runningCount: state.bots.filter((b) => ['running', 'restarting'].includes(b.status?.state)).length, botCount: state.bots.length });
    paintCards();
  };
}

function statCard(label, value, suffix, foot, percent, footLabel) {
  return h(
    'div',
    { class: 'card stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value, suffix ? h('small', {}, ` ${suffix}`) : null),
    typeof percent === 'number' ? h('div', { class: 'bar' }, h('span', { style: `width:${Math.min(100, Math.max(0, percent))}%` })) : null,
    (foot || footLabel) && h('div', { class: 'stat-foot' }, footLabel ?? foot),
  );
}

function botCard(bot) {
  const pill = statusPill(bot.status);
  const running = ['running', 'restarting'].includes(bot.status?.state);
  return h(
    'div',
    { class: 'card bot-card' },
    h(
      'div',
      { class: 'bot-card-head' },
      h('div', { class: 'avatar', style: 'border-radius:9px' }, bot.name.slice(0, 1).toUpperCase()),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'name' }, bot.name), h('div', { class: 'bot-card-meta' }, bot.id)),
      pill,
    ),
    h(
      'div',
      { class: 'bot-card-meta' },
      `süre: ${fmtDuration(bot.status?.uptimeMs)}  ·  yeniden başlatma: ${bot.status?.restarts ?? 0}  ·  ${bot.driver}`,
    ),
    h(
      'div',
      { class: 'row' },
      running
        ? h('button', { class: 'btn sm danger', onclick: () => botAction(bot.id, 'stop') }, '■ Durdur')
        : h('button', { class: 'btn sm success', onclick: () => botAction(bot.id, 'start') }, '▶ Başlat'),
      h('button', { class: 'btn sm', onclick: () => botAction(bot.id, 'restart') }, '↻'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => go(`#/bot/${bot.id}/console`) }, 'Konsol →'),
    ),
  );
}

async function botAction(id, action) {
  try {
    await api(`/api/bots/${id}/${action}`, { method: 'POST', body: {} });
    toast(`Komut gönderildi: ${action}`, 'success');
    const r = await api('/api/bots');
    state.bots = r.bots;
    if (refreshSidebar) refreshSidebar();
    if (viewRefresh) viewRefresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// --------------------------------------------------------------------- bot detay

function pageHead(title, sub) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null));
}

async function viewBot(main, id, tab) {
  let { bot } = await api(`/api/bots/${id}`);

  const pill = statusPill(bot.status);
  const metaEl = h('div', { class: 'sub' });
  const btnStart = h('button', { class: 'btn success sm', onclick: () => act('start') }, '▶ Başlat');
  const btnStop = h('button', { class: 'btn danger sm', onclick: () => act('stop') }, '■ Durdur');
  const btnRestart = h('button', { class: 'btn sm', onclick: () => act('restart') }, '↻ Yeniden başlat');

  function paint(status) {
    applyStatus(pill, status);
    const running = ['running', 'restarting'].includes(status?.state);
    btnStart.disabled = running;
    btnStop.disabled = !running;
    metaEl.textContent = `${bot.id} · sürücü: ${bot.driver} · süre: ${fmtDuration(status?.uptimeMs)} · yeniden başlatma: ${status?.restarts ?? 0}${status?.lastError ? ` · son hata: ${status.lastError}` : ''}`;
  }
  paint(bot.status);

  async function act(action) {
    try {
      const res = await api(`/api/bots/${id}/${action}`, { method: 'POST', body: {} });
      paint(res.status);
      const r = await api('/api/bots');
      state.bots = r.bots;
      if (refreshSidebar) refreshSidebar();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const tabs = [
    { key: 'console', label: 'Konsol' },
    { key: 'files', label: 'Dosyalar' },
    { key: 'settings', label: 'Ayarlar' },
  ];
  const tabsEl = h(
    'div',
    { class: 'tabs' },
    tabs.map((t) =>
      h('button', { class: `tab ${t.key === tab ? 'active' : ''}`, onclick: () => go(`#/bot/${id}/${t.key}`) }, t.label),
    ),
  );

  const body = h('div');
  main.append(
    h(
      'div',
      { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'row' }, h('h1', {}, bot.name), pill), metaEl),
      h('div', { class: 'row' }, btnStart, btnRestart, btnStop),
    ),
    tabsEl,
    body,
  );

  if (tab === 'files') viewFiles(body, bot);
  else if (tab === 'settings') viewSettings(body, bot);
  else viewConsole(body, bot, paint);
}

function viewConsole(container, bot, onStatus) {
  const body = h('div', { class: 'console-body' });
  const followState = h('span', {}, 'takip: açık');
  let follow = true;
  body.addEventListener('scroll', () => {
    follow = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    followState.textContent = `takip: ${follow ? 'açık' : 'kapalı'}`;
  });

  function writeLine(line) {
    const el = h(
      'div',
      { class: `console-line ${line.stream}` },
      h('span', { class: 'ts' }, fmtTime(line.at)),
      h('span', { class: 'msg' }, line.text),
    );
    body.append(el);
    if (body.childElementCount > 3000) body.firstElementChild?.remove();
    if (follow) body.scrollTop = body.scrollHeight;
  }

  const input = h('input', { placeholder: 'bota stdin gönder (Enter)…' });
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value) return;
    const text = input.value;
    input.value = '';
    try {
      await api(`/api/bots/${bot.id}/input`, { method: 'POST', body: { text } });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  container.append(
    h(
      'div',
      { class: 'console' },
      h(
        'div',
        { class: 'console-bar' },
        h('span', { class: 'dot', style: 'width:8px;height:8px;border-radius:50%;background:#22c55e' }),
        h('span', { class: 'mono', style: 'font-size:11.5px' }, `canlı akış · bot ${bot.id}`),
        h('span', { class: 'spacer' }),
        followState,
        h('button', { class: 'btn sm', onclick: () => body.replaceChildren() }, 'Temizle'),
      ),
      body,
      h('div', { class: 'console-input' }, input),
    ),
  );

  const es = new EventSource(`/api/bots/${bot.id}/stream`);
  es.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.type === 'log') writeLine(data.line);
    else if (data.type === 'status') onStatus?.(data.status);
  };
  es.onerror = () => {
    writeLine({ stream: 'panel', text: '— bağlantı koptu, yeniden bağlanılıyor —', at: new Date().toISOString() });
  };

  viewCleanup = () => es.close();
}

// --------------------------------------------------------------------- dosyalar

function viewFiles(container, bot) {
  let currentPath = '';
  const crumbsEl = h('div', { class: 'crumbs' });
  const tableWrap = h('div', { class: 'card', style: 'padding:6px 10px' });

  async function load(rel) {
    currentPath = rel ?? '';
    tableWrap.replaceChildren(h('div', { class: 'dim', style: 'padding:14px' }, 'Yükleniyor…'));
    try {
      const data = await api(`/api/bots/${bot.id}/files?path=${encodeURIComponent(currentPath)}`);
      paintCrumbs();
      paintTable(data.entries);
    } catch (err) {
      tableWrap.replaceChildren(h('div', { class: 'dim', style: 'padding:14px' }, err.message));
    }
  }

  function paintCrumbs() {
    const segments = currentPath ? currentPath.split('/') : [];
    const nodes = [h('button', { onclick: () => load('') }, `/${bot.name}`)];
    segments.forEach((segment, index) => {
      const target = segments.slice(0, index + 1).join('/');
      nodes.push(h('span', { class: 'sep' }, '/'));
      nodes.push(h('button', { onclick: () => load(target) }, segment));
    });
    crumbsEl.replaceChildren(...nodes);
  }

  function paintTable(entries) {
    if (entries.length === 0) {
      tableWrap.replaceChildren(h('div', { class: 'dim', style: 'padding:20px;text-align:center' }, 'Bu klasör boş. "Dosya yükle" ile bot dosyalarını ekle.'));
      return;
    }
    const rows = entries.map((entry) =>
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h(
            'div',
            {
              class: `fname ${entry.type === 'dir' ? 'dir' : ''}`,
              onclick: () => (entry.type === 'dir' ? load(entry.path) : openEditor(entry.path)),
            },
            h('span', { class: 'icon-glyph' }, entry.type === 'dir' ? '▸' : entry.type === 'link' ? '⛓' : '📄'),
            entry.name,
          ),
        ),
        h('td', { class: 'fmeta' }, entry.type === 'dir' ? 'klasör' : fmtBytes(entry.size)),
        h('td', { class: 'fmeta' }, entry.mtime ? fmtDate(entry.mtime) : '—'),
        h(
          'td',
          { style: 'text-align:right;white-space:nowrap' },
          entry.type === 'file' ? h('button', { class: 'btn sm', onclick: () => openEditor(entry.path) }, 'Düzenle') : null,
          h(
            'button',
            {
              class: 'btn sm danger',
              style: 'margin-left:6px',
              onclick: async () => {
                if (!confirm(`Silinsin mi: ${entry.path}?`)) return;
                try {
                  await api(`/api/bots/${bot.id}/file?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
                  toast('Silindi', 'success');
                  load(currentPath);
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
            'Sil',
          ),
        ),
      ),
    );
    tableWrap.replaceChildren(
      h(
        'table',
        { class: 'files' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Ad'), h('th', {}, 'Boyut'), h('th', {}, 'Değişim'), h('th', {}, ''))),
        h('tbody', {}, rows),
      ),
    );
  }

  async function openEditor(rel) {
    let file;
    try {
      file = await api(`/api/bots/${bot.id}/file?path=${encodeURIComponent(rel)}`);
    } catch (err) {
      return toast(err.message, 'error');
    }
    if (file.binary) return toast('İkili dosya düzenlenemez', 'error');
    const area = h('textarea', { rows: 22, value: file.content ?? '', spellcheck: false });
    const save = h('button', { class: 'btn primary' }, 'Kaydet');
    const close = openModal({
      title: `/${rel}`,
      body: h('div', {}, area),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Kapat'), save],
      wide: true,
    });
    save.addEventListener('click', async () => {
      try {
        await api(`/api/bots/${bot.id}/file`, { method: 'PUT', body: { path: rel, content: area.value } });
        toast('Kaydedildi. Etkili olması için botu yeniden başlat.', 'success');
        close();
        load(currentPath);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function newFile() {
    const nameInput = h('input', { placeholder: 'örnek: commands/ping.js' });
    const create = h('button', { class: 'btn primary' }, 'Oluştur');
    const close = openModal({
      title: 'Yeni dosya',
      body: h('label', { class: 'field' }, h('span', {}, `Konum: /${currentPath || ''}`), nameInput),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Vazgeç'), create],
    });
    create.addEventListener('click', async () => {
      const rel = [currentPath, nameInput.value.trim()].filter(Boolean).join('/');
      if (!rel) return toast('Dosya adı gerekli', 'error');
      try {
        await api(`/api/bots/${bot.id}/file`, { method: 'PUT', body: { path: rel, content: '' } });
        close();
        load(currentPath);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function newFolder() {
    const nameInput = h('input', { placeholder: 'klasör adı' });
    const create = h('button', { class: 'btn primary' }, 'Oluştur');
    const close = openModal({
      title: 'Yeni klasör',
      body: h('label', { class: 'field' }, h('span', {}, `Konum: /${currentPath || ''}`), nameInput),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Vazgeç'), create],
    });
    create.addEventListener('click', async () => {
      const rel = [currentPath, nameInput.value.trim()].filter(Boolean).join('/');
      if (!rel) return toast('Klasör adı gerekli', 'error');
      try {
        await api(`/api/bots/${bot.id}/mkdir`, { method: 'POST', body: { path: rel } });
        close();
        load(currentPath);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none' });
  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files ?? [])];
    if (files.length === 0) return;
    toast(`${files.length} dosya yükleniyor…`);
    try {
      const payload = [];
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        payload.push({
          path: [currentPath, file.webkitRelativePath || file.name].filter(Boolean).join('/'),
          contentBase64: btoa(String.fromCharCode(...new Uint8Array(buffer))),
        });
      }
      const res = await api(`/api/bots/${bot.id}/upload`, { method: 'POST', body: { files: payload } });
      toast(`${res.files.length} dosya yüklendi`, 'success');
      fileInput.value = '';
      load(currentPath);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  container.append(
    h(
      'div',
      { class: 'row wrap mb' },
      h('button', { class: 'btn primary sm', onclick: () => fileInput.click() }, '⬆ Dosya yükle'),
      h('button', { class: 'btn sm', onclick: newFile }, '+ Yeni dosya'),
      h('button', { class: 'btn sm', onclick: newFolder }, '+ Yeni klasör'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => load(currentPath) }, '↻'),
      fileInput,
    ),
    crumbsEl,
    tableWrap,
    h('div', { class: 'note info mt' }, 'İpucu: birden fazla dosyayı aynı anda seçebilirsin. Klasör yapısını korumak istiyorsan önce klasörleri buradan oluştur.'),
  );

  load('');
}

// ---------------------------------------------------------------------- ayarlar

function viewSettings(container, bot) {
  const draft = {
    name: bot.name,
    runtime: bot.runtime,
    entry: bot.entry,
    command: bot.command,
    args: (bot.args ?? []).join(' '),
    image: bot.image,
    autoRestart: bot.autoRestart,
    readOnly: bot.readOnly,
  };

  const nameInput = h('input', { value: draft.name });
  const runtimeSelect = h(
    'select',
    {},
    ['node', 'npm', 'custom'].map((r) => h('option', { value: r, selected: r === draft.runtime }, r)),
  );
  const entryInput = h('input', { value: draft.entry, placeholder: 'index.js' });
  const commandInput = h('input', { value: draft.command, placeholder: 'node' });
  const argsInput = h('input', { value: draft.args, placeholder: '--flag deger' });
  const imageInput = h('input', { value: draft.image, placeholder: 'node:22-alpine' });

  const envRows = h('div');
  function addEnvRow(key = '', value = '') {
    const keyInput = h('input', { value: key, placeholder: 'ANAHTAR (ör. DISCORD_TOKEN)' });
    const valueInput = h('input', { value, placeholder: 'değer', type: showSecrets ? 'text' : 'password' });
    const row = h(
      'div',
      { class: 'env-row', dataset: { key: 'env' } },
      keyInput,
      valueInput,
      h('button', { class: 'btn sm danger', onclick: () => row.remove() }, '✕'),
    );
    envRows.append(row);
  }

  let showSecrets = false;
  const showToggle = h('input', { type: 'checkbox' });
  showToggle.addEventListener('change', () => {
    showSecrets = showToggle.checked;
    envRows.querySelectorAll('input').forEach((input) => {
      if (input.type === 'password' || (input.type === 'text' && input.dataset.secret === '1')) {
        input.type = showSecrets ? 'text' : 'password';
        if (showSecrets) input.dataset.secret = '1';
      }
    });
  });
  envRows.querySelectorAll('input');
  for (const [key, value] of Object.entries(bot.env ?? {})) addEnvRow(key, value);

  const autoRestart = h('input', { type: 'checkbox', checked: bot.autoRestart });
  const autoStart = h('input', { type: 'checkbox', checked: bot.autoStart !== false });
  const readOnly = h('input', { type: 'checkbox', checked: bot.readOnly });

  const saveBtn = h('button', { class: 'btn primary' }, 'Kaydet');
  saveBtn.addEventListener('click', async () => {
    const env = {};
    for (const row of envRows.querySelectorAll('.env-row')) {
      const [keyInput, valueInput] = row.querySelectorAll('input');
      const key = keyInput.value.trim();
      if (!key) continue;
      env[key] = valueInput.value;
    }
    try {
      const res = await api(`/api/bots/${bot.id}`, {
        method: 'PATCH',
        body: {
          name: nameInput.value,
          runtime: runtimeSelect.value,
          entry: entryInput.value,
          command: commandInput.value,
          args: argsInput.value.split(/\s+/).filter(Boolean),
          image: imageInput.value,
          env,
          autoRestart: autoRestart.checked,
          autoStart: autoStart.checked,
          readOnly: readOnly.checked,
        },
      });
      toast('Ayarlar kaydedildi. Değişiklikler yeniden başlatmada etkin olur.', 'success');
      const r = await api('/api/bots');
      state.bots = r.bots;
      if (refreshSidebar) refreshSidebar();
      go(`#/bot/${res.bot.id}/settings`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  container.append(
    h(
      'div',
      { class: 'grid two' },
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Çalıştırma'),
        h('p', { class: 'card-sub' }, 'Botun nasıl başlatılacağını belirle.'),
        h('label', { class: 'field' }, h('span', {}, 'Bot adı'), nameInput),
        h('label', { class: 'field' }, h('span', {}, 'Çalıştırma türü'), runtimeSelect),
        h('label', { class: 'field' }, h('span', {}, 'Giriş dosyası / npm scripti'), entryInput),
        h('label', { class: 'field' }, h('span', {}, 'Komut (custom türü için)'), commandInput),
        h('label', { class: 'field' }, h('span', {}, 'Ek argümanlar (boşlukla ayrılır)'), argsInput),
        h('label', { class: 'field' }, h('span', {}, 'Docker imajı (docker sürücüsünde)'), imageInput),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Dayanıklılık'),
        h('p', { class: 'card-sub' }, '7/24 çalışma davranışı.'),
        h(
          'div',
          { class: 'switch' },
          h('div', {}, h('div', { class: 'sw-title' }, 'Otomatik yeniden başlatma'), h('div', { class: 'sw-sub' }, 'Süreç çökerse artan aralıklarla (1s → 30s) yeniden başlatılır.')),
          autoRestart,
        ),
        h(
          'div',
          { class: 'switch' },
          h('div', {}, h('div', { class: 'sw-title' }, 'Açılışta otomatik başlat'), h('div', { class: 'sw-sub' }, 'Panel veya makine yeniden başlarsa bot kendiliğinden ayağa kalkar. Gerçek 7/24 için bunu açık tut.')),
          autoStart,
        ),
        h(
          'div',
          { class: 'switch' },
          h('div', {}, h('div', { class: 'sw-title' }, 'Salt-okunur dosya sistemi'), h('div', { class: 'sw-sub' }, 'Sadece docker sürücüsünde: bot kodun kendini değiştiremez.')),
          readOnly,
        ),
        h('div', { class: 'note' }, 'Çökme koruması: saatte 20\'den fazla çökme olursa otomatik yeniden başlatma durur ve bot "koruma" durumuna geçer.'),
      ),
    ),
    h(
      'div',
      { class: 'card mt' },
      h('h3', {}, 'Ortam değişkenleri (sırlar)'),
      h('p', { class: 'card-sub' }, 'Bot token\'ları burada tutulur; diske AES-256-GCM ile şifreli yazılır ve bota sadece kendi süreci içinde aktarılır.'),
      envRows,
      h('div', { class: 'row mt' }, h('button', { class: 'btn sm', onclick: () => addEnvRow() }, '+ Değişken ekle'), h('span', { class: 'spacer' }), h('label', { class: 'row', style: 'font-size:12.5px;color:var(--muted)' }, showToggle, 'değerleri göster')),
    ),
    h(
      'div',
      { class: 'row mt' },
      saveBtn,
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm(`"${bot.name}" botu ve TÜM dosyaları kalıcı olarak silinsin mi?`)) return;
            try {
              await api(`/api/bots/${bot.id}`, { method: 'DELETE' });
              toast('Bot silindi', 'success');
              const r = await api('/api/bots');
              state.bots = r.bots;
              if (refreshSidebar) refreshSidebar();
              go('#/');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        'Botu sil',
      ),
    ),
    h(
      'div',
      { class: 'card mt' },
      h('h3', {}, 'Kimlik'),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Bot ID'),
        h('dd', {}, bot.id),
        h('dt', {}, 'Sürücü'),
        h('dd', {}, bot.driver === 'docker' ? 'docker (izole konteyner)' : 'local (aynı makinede alt süreç)'),
        h('dt', {}, 'Kaynak yolu'),
        h('dd', {}, `bots/${bot.id}`),
        h('dt', {}, 'Sınırlar'),
        h('dd', {}, `bellek ${bot.limits?.memory} · cpu ${bot.limits?.cpus} · pid ${bot.limits?.pids}`),
      ),
      bot.driver === 'local'
        ? h('div', { class: 'note mt' }, '"local" sürücüde botlar paneli çalıştıran kullanıcıyla aynı ortamı paylaşır — izolasyon zayıftır. Gerçek 7/24 ve tam izolasyon için PANEL_BOT_DRIVER=docker kullan.')
        : h('div', { class: 'note info mt' }, 'Docker sürücüsünde her bot: kendi ağı, salt-okunur kök dosya sistemi, düşürülmüş yetenekler (cap-drop ALL), no-new-privileges, pid/cpu/bellek sınırı ve sadece kendi dizinine mount ile çalışır. Diğer botların dosyalarına veya panele erişemez.'),
    ),
  );
}

// ----------------------------------------------------------------------- sistem

async function viewSystem(main) {
  const data = await api('/api/system');
  const host = data.host;
  const memPct = Math.round((host.memUsed / host.memTotal) * 100);
  main.append(
    pageHead('Sistem', 'Panelin ve makinenin durumu'),
    h(
      'div',
      { class: 'grid two' },
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Makine'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, 'Sunucu adı'),
          h('dd', {}, host.hostname),
          h('dt', {}, 'İşletim sistemi'),
          h('dd', {}, `${host.platform} ${host.release} (${host.arch})`),
          h('dt', {}, 'İşlemci'),
          h('dd', {}, `${host.cpuModel} · ${host.cpuCount} çekirdek`),
          h('dt', {}, 'Yük ortalaması'),
          h('dd', {}, host.loadavg.join('  ')),
          h('dt', {}, 'Bellek'),
          h('dd', {}, `${fmtBytes(host.memUsed)} / ${fmtBytes(host.memTotal)} (${memPct}%)`),
          h('dt', {}, 'Çalışma süresi'),
          h('dd', {}, fmtDuration(host.uptime * 1000)),
        ),
        h('div', { class: 'bar' }, h('span', { style: `width:${memPct}%` })),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Panel'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, 'Sürüm'),
          h('dd', {}, '0.1.0'),
          h('dt', {}, 'Node'),
          h('dd', {}, host.node),
          h('dt', {}, 'Bot sürücüsü'),
          h('dd', {}, data.panel.driver),
          h('dt', {}, 'Veri dizini'),
          h('dd', {}, data.panel.dataDir),
          h('dt', {}, 'Bot dizini'),
          h('dd', {}, data.panel.botsDir),
          h('dt', {}, 'Şifreleme'),
          h('dd', {}, 'AES-256-GCM (beklemede) · scrypt (parola)'),
          h('dt', {}, 'Oturum süresi'),
          h('dd', {}, `${data.panel.sessionTtlHours} saat`),
        ),
        h('div', { class: `note ${host.docker || data.panel.driver !== 'docker' ? 'info' : ''} mt` }, host.docker
          ? 'Docker soketi bulundu — botlar izole konteynerlerde çalışabilir.'
          : 'Docker soketi yok. Botlar "local" sürücüde çalışır (geliştirme için uygun, üretimde docker kullan).'),
      ),
    ),
    h(
      'div',
      { class: 'card mt' },
      h('h3', {}, '7/24 çalışma'),
      h('p', { class: 'card-sub' }, 'Kesintisiz çalışma için panelin kendisi de dayanıklı olmalı.'),
      h(
        'ul',
        { class: 'muted', style: 'line-height:1.9;margin:0;padding-left:18px' },
        h('li', {}, 'Panel süreci bir süpervizör altında çalıştırılmalı (systemd, Docker restart: unless-stopped).'),
        h('li', {}, 'Süpervizör paneli yeniden başlatırsa bot durumları sıfırlanır; "Başlat" politikası için bot kartından elle başlat.'),
        h('li', {}, 'Her botun otomatik yeniden başlatması açık olduğu sürece çökme sonrası kendi kendine geri gelir.'),
        h('li', {}, 'Makine yeniden başlarsa botları tekrar ayağa kaldırmak için panelin açılış betiğine API çağrısı eklenebilir.'),
      ),
    ),
  );
}

async function viewAudit(main) {
  const data = await api('/api/audit');
  main.append(
    pageHead('Denetim Kaydı', 'Panelde yapılan son işlemler (sır içermez)'),
    data.entries.length === 0
      ? h('div', { class: 'card empty' }, h('div', { class: 'big' }, 'Kayıt yok'))
      : h(
          'div',
          { class: 'card' },
          data.entries.map((entry) =>
            h(
              'div',
              { class: 'audit-item' },
              h('span', { class: 'when' }, fmtDate(entry.at)),
              h('span', { class: 'what' }, h('span', { class: 'actor mono' }, entry.actor), ' — ', entry.action, entry.detail ? ` · ${entry.detail}` : ''),
            ),
          ),
        ),
  );
}

// ------------------------------------------------------------------ bot oluştur

function openCreateBot() {
  const nameInput = h('input', { placeholder: 'örnek: Moderasyon Botu', autofocus: true });
  const descInput = h('input', { placeholder: 'kısa açıklama (opsiyonel)' });
  const runtimeSelect = h('select', {}, ['node', 'npm', 'custom'].map((r) => h('option', { value: r, selected: r === 'node' }, r)));
  const entryInput = h('input', { value: 'index.js' });
  const imageInput = h('input', { value: 'node:22-alpine' });
  const create = h('button', { class: 'btn primary' }, 'Oluştur');

  const close = openModal({
    title: 'Yeni bot',
    body: h(
      'div',
      {},
      h('label', { class: 'field' }, h('span', {}, 'Bot adı'), nameInput),
      h('label', { class: 'field' }, h('span', {}, 'Açıklama'), descInput),
      h('div', { class: 'grid two' }, h('label', { class: 'field' }, h('span', {}, 'Çalıştırma türü'), runtimeSelect), h('label', { class: 'field' }, h('span', {}, 'Giriş dosyası'), entryInput)),
      h('label', { class: 'field' }, h('span', {}, 'Docker imajı'), imageInput),
      h('div', { class: 'note info' }, 'Oluşturduktan sonra "Dosyalar" sekmesinden bot kodunu yükle, "Ayarlar" sekmesinden DISCORD_TOKEN gibi sırları gir ve Başlat.'),
    ),
    footer: [h('button', { class: 'btn', onclick: () => close() }, 'Vazgeç'), create],
  });

  create.addEventListener('click', async () => {
    try {
      const res = await api('/api/bots', {
        method: 'POST',
        body: {
          name: nameInput.value,
          description: descInput.value,
          runtime: runtimeSelect.value,
          entry: entryInput.value,
          image: imageInput.value,
        },
      });
      const r = await api('/api/bots');
      state.bots = r.bots;
      close();
      toast('Bot oluşturuldu', 'success');
      if (refreshSidebar) refreshSidebar();
      go(`#/bot/${res.bot.id}/files`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ------------------------------------------------------------------ periyodik

setInterval(async () => {
  if (!state.user) return;
  try {
    const r = await api('/api/bots');
    state.bots = r.bots;
    if (refreshSidebar) refreshSidebar();
    if (viewRefresh) viewRefresh();
  } catch {
    /* sessiz: bir sonraki turda tekrar dener */
  }
}, 5000);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalRoot.childElementCount > 0) modalRoot.lastElementChild?.remove();
});

boot();
