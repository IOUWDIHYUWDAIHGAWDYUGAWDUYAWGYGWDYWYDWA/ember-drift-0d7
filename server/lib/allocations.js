// Port tahsis havuzu (Pterodactyl'deki "allocations").
//
// Aralık PANEL_PORT_RANGE ile verilir. Bir port en fazla bir sunucuya verilir ve
// sunucu silinince havuza geri döner. Panel bu defteri şifreli durumda tutar.

export function allocationInUse(server, range) {
  const port = server?.allocation?.port;
  return typeof port === 'number' && port >= range.min && port <= range.max;
}

/**
 * Boş bir port seçer ve `state.allocations` defterine yazar.
 * Havuz doluysa hata fırlatır (sessizce aralık dışına taşmak yok).
 */
export function allocatePort(state, range, serverId, { bind = '127.0.0.1' } = {}) {
  const taken = new Set((state.allocations || []).map((item) => item.port));
  for (const server of state.servers || []) {
    if (server.id === serverId) continue;
    if (server.allocation?.port) taken.add(server.allocation.port);
  }
  for (let port = range.min; port <= range.max; port += 1) {
    if (!taken.has(port)) {
      state.allocations.push({ port, serverId, bind, assignedAt: new Date().toISOString() });
      return port;
    }
  }
  throw Object.assign(
    new Error(
      `Port havuzu dolu (${range.min}-${range.max}). PANEL_PORT_RANGE değerini büyüt ya da bir sunucuyu sil.`,
    ),
    { status: 409 },
  );
}

export function releasePort(state, serverId) {
  const before = (state.allocations || []).length;
  state.allocations = (state.allocations || []).filter((item) => item.serverId !== serverId);
  return before - state.allocations.length;
}

export function freePorts(state, range, limit = 50) {
  const taken = new Set((state.allocations || []).map((item) => item.port));
  const out = [];
  for (let port = range.min; port <= range.max && out.length < limit; port += 1) {
    if (!taken.has(port)) out.push(port);
  }
  return out;
}

export function poolUsage(state, range) {
  const total = range.max - range.min + 1;
  const used = (state.allocations || []).filter((item) => item.port >= range.min && item.port <= range.max).length;
  return { total, used, free: Math.max(0, total - used) };
}
