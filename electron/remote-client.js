'use strict';
// Modo CLIENT do Maestrus remoto — MULTI-HOST. Conecta UMA vez no relay (sala
// da conta, por uid) e fala com TODOS os hosts online da conta: máquinas em
// modo servidor (descobertas via HOST_LIST/presença) e sandboxes cloud
// (adicionados sob demanda). Lista os projetos de cada host e roteia
// claude.send/loadHistory/stop pra lá, re-emitindo os eventos de streaming como
// se fossem locais (projectId prefixado "remote:<hostId>:" pra o renderer casar).
//
// Descoberta por login: como o relay roteia por conta e o relay_token é emitido
// só pela licença, basta conectar e pedir HOST_LIST — os projetos das outras
// máquinas da MESMA conta aparecem sozinhos, sem código de pareamento.

const { RelayLink } = require('../relay/link');
let WebSocketImpl = null;
try { WebSocketImpl = require('ws'); } catch {}

let link = null;
let conn = null;                 // { url, deviceId } da conexão atual
const hosts = new Map();         // deviceId -> { deviceId, name, os }
let primaryHostId = null;        // último host explicitamente adicionado (compat)
let cachedProjects = [];
let syncing = false;             // true enquanto puxa projects.list dos hosts
let lastSyncAt = 0;              // ts do último refresh concluído
let state = { connected: false, status: 'idle', hostName: null };
let onState = null;
let onRemoteEvent = null;
let onProjectsChanged = null; // chamado após refreshProjects bem-sucedido
const dispatchListeners = new Set(); // coletores one-shot (orquestrador → cloud)

function isRemote(id) { return typeof id === 'string' && id.startsWith('remote:'); }
function isShared(id) { return typeof id === 'string' && id.startsWith('shared:'); }
function isCloudHost(did) { return typeof did === 'string' && did.startsWith('cloud-'); }
function parse(id) { const m = /^remote:([^:]+):(.+)$/.exec(id || ''); return m ? { hostId: m[1], projectId: m[2] } : null; }
function getHostId() { return primaryHostId; }
function getHosts() { return Array.from(hosts.values()); }
function hasHost(deviceId) { return hosts.has(deviceId); }

function tag(p, host) {
  const hid = host.deviceId;
  // Projeto cloud (host cloud-*) é 1ª classe: source='cloud' (ícone de nuvem),
  // não 'production' (máquina). Espelha a shim web.
  const cloud = isCloudHost(hid);
  return {
    id: `remote:${hid}:${p.id}`, name: p.name, source: cloud ? 'cloud' : (p.source || 'production'), cloud,
    remoteHostId: hid, remoteHostName: host.name, remoteProjectId: p.id,
    // Engine respeita o projeto: o container tem Claude CLI próprio (OAuth) —
    // não força mais 'cloud' (relíquia do proxy removido).
    model: p.model || 'default', thinkingMode: p.thinkingMode || 'medium', permissionMode: p.permissionMode || 'default', engine: p.engine || 'claude',
    repoUrl: null, localPath: null, mountPath: null, sessionId: p.sessionId || null,
    codeDir: null, driveDir: null, sessionDir: null, createdAt: 0, updatedAt: 0,
    // Conversas (forks) do projeto no host — sem isso o client não vê os forks.
    conversations: Array.isArray(p.conversations) ? p.conversations : [],
  };
}

// Resumo pro banner "Conectado a X": 1 host = nome; vários = "N máquinas".
function summaryName() {
  const n = hosts.size;
  if (n === 0) return null;
  if (n === 1) return Array.from(hosts.values())[0].name || 'Host';
  return `${n} máquinas`;
}
function emitState() {
  state = {
    connected: link ? state.connected : false, status: state.status, hostName: summaryName(),
    hosts: getHosts(), hostCount: hosts.size, syncing, projectCount: cachedProjects.length, lastSyncAt,
  };
  onState && onState({ ...state });
}

// Conecta o link UMA vez (idempotente). Reusa a conexão se já está viva pra a
// mesma conta — chamadas subsequentes (pareamento, cloud-ensure, discovery) só
// acumulam hosts, sem derrubar nada.
function ensureLink({ url, token, deviceId, refreshTokenFn }) {
  if (link && conn && conn.deviceId === deviceId) return link; // já conectado
  if (link) { try { link.close(); } catch {} link = null; }
  conn = { url, deviceId };
  link = new RelayLink({
    url, token, deviceId, role: 'client', WebSocketImpl, refreshTokenFn,
    onStatus: (s) => {
      state.status = s; state.connected = s === 'online';
      emitState();
      if (s === 'online') onOnline().catch(() => {});
    },
    onEvent: (f) => {
      if (f.channel === 'claude' && f.payload) {
        const hid = f.from || primaryHostId;   // f.from = deviceId do host (relay anexa)
        const p = { ...f.payload };
        // Atualiza cache local quando o host notifica mudança de modelo/settings
        if (p.type === 'project.updated' && p.project) {
          const host = (hid && hosts.get(hid)) || { deviceId: hid, name: 'Host', os: '' };
          const tagged = tag(p.project, host);
          let found = false;
          cachedProjects = cachedProjects.map((cp) => {
            if (cp.id !== tagged.id) return cp;
            found = true;
            // Mescla também nome e CONVERSAS (forks): criar/renomear/excluir um
            // fork em qualquer device aparece aqui na hora, sem re-fetch.
            return { ...cp, name: tagged.name, model: tagged.model, thinkingMode: tagged.thinkingMode, permissionMode: tagged.permissionMode, engine: tagged.engine, conversations: tagged.conversations };
          });
          if (!found) cachedProjects = [...cachedProjects, tagged]; // projeto novo criado no host
          try { onProjectsChanged && onProjectsChanged(); } catch {}
        }
        if (p.projectId && p.projectId !== '*' && hid) p.projectId = `remote:${hid}:${p.projectId}`;
        if (onRemoteEvent) onRemoteEvent(p);
        dispatchListeners.forEach((fn) => { try { fn(p); } catch {} });
      }
    },
    onPresence: (f) => {
      if (!f.deviceId) return;
      if (f.online === false) { hosts.delete(f.deviceId); }
      else { hosts.set(f.deviceId, { deviceId: f.deviceId, name: (f.host && f.host.name) || 'Host', os: (f.host && f.host.os) || '' }); }
      emitState();
      scheduleRefresh();   // coalesce rajadas de presença num fan-out só
    },
  });
  link.connect();
  state = { connected: false, status: 'connecting', hostName: summaryName() };
  emitState();
  return link;
}

// Ao ficar online: descobre os hosts da conta (HOST_LIST) e puxa os projetos.
// Se a lista vier vazia (race: client reconectou antes do host), re-tenta após 4s.
// O onPresence também vai pegar quando o host voltar, mas o retry acelera o caso
// mais comum (host sempre ligado, só o client dormiu).
async function onOnline() {
  try {
    const list = await link.hostList(5000).catch(() => []);
    for (const h of (Array.isArray(list) ? list : [])) {
      if (h && h.deviceId) hosts.set(h.deviceId, { deviceId: h.deviceId, name: h.name || 'Host', os: h.os || '' });
    }
    emitState();
    await refreshProjects();
    // Retry se nenhum host encontrado ainda (pode estar registrando no relay)
    if (hosts.size === 0) {
      setTimeout(async () => {
        if (!link || !state.connected) return;
        try {
          const list2 = await link.hostList(4000).catch(() => []);
          for (const h of (Array.isArray(list2) ? list2 : [])) {
            if (h && h.deviceId) hosts.set(h.deviceId, { deviceId: h.deviceId, name: h.name || 'Host', os: h.os || '' });
          }
          if (hosts.size > 0) { emitState(); await refreshProjects(); }
        } catch {}
      }, 4000);
    }
  } catch {}
}

// Adiciona um host conhecido (pareamento / cloud sandbox) antes mesmo do
// HOST_LIST/presença chegarem.
function addHost(deviceId, name) {
  if (!deviceId) return;
  if (!hosts.has(deviceId)) hosts.set(deviceId, { deviceId, name: name || 'Host', os: '' });
  primaryHostId = deviceId;
  emitState();
}

// Pareamento / cloud-ensure: conecta (idempotente) e passa a rastrear este host.
function start({ url, token, deviceId, hostDeviceId, hostName, refreshTokenFn }) {
  ensureLink({ url, token, deviceId, refreshTokenFn });
  if (hostDeviceId) addHost(hostDeviceId, hostName);
  if (state.connected) refreshProjects().catch(() => {});
  return { ok: true, hostName: hostName || summaryName() };
}

// Descoberta por login: conecta sem host fixo — o HOST_LIST popula tudo.
function startDiscovery({ url, token, deviceId, refreshTokenFn }) {
  ensureLink({ url, token, deviceId, refreshTokenFn });
  return { ok: true };
}

// Debounce: rajadas de presença (vários hosts entrando juntos) coalescem num
// único fan-out de projects.list em vez de um por evento.
let _refreshTimer = null;
function scheduleRefresh() {
  if (_refreshTimer) return;
  _refreshTimer = setTimeout(() => { _refreshTimer = null; refreshProjects().catch(() => {}); }, 400);
}

async function refreshProjects() {
  if (!link) return [];
  syncing = true; emitState();                 // UI mostra "sincronizando…"
  const all = [];
  // Puxa os projetos de cada host em paralelo; um host offline não derruba os outros.
  await Promise.all(Array.from(hosts.values()).map(async (host) => {
    try {
      const r = await link.rpc(host.deviceId, 'projects.list', {}, 8000);
      if (Array.isArray(r)) for (const p of r) {
        // Defesa em profundidade: hosts antigos podem ainda anunciar o
        // orquestrador/Inicializador — nunca os trate como sessão remota.
        if (p && p.id !== 'maestrus' && p.id !== 'starter') all.push(tag(p, host));
      }
    } catch {}
  }));
  cachedProjects = all;
  syncing = false; lastSyncAt = Date.now(); emitState();
  if (all.length > 0) try { onProjectsChanged && onProjectsChanged(); } catch {}
  return cachedProjects;
}
function listProjects() { return cachedProjects; }

async function send(remoteId, message) {
  const r = parse(remoteId); if (!r || !link) throw new Error('Sem conexão remota');
  return link.rpc(r.hostId, 'claude.send', { projectId: r.projectId, message }, 120000);
}
async function loadHistory(remoteId) {
  const r = parse(remoteId); if (!r || !link) return [];
  return link.rpc(r.hostId, 'claude.loadHistory', { projectId: r.projectId }, 15000).catch(() => []);
}
async function stopProject(remoteId) {
  const r = parse(remoteId); if (!r || !link) return false;
  return link.rpc(r.hostId, 'claude.stop', { projectId: r.projectId }, 8000).catch(() => false);
}

// Dispatch one-shot pra um projeto remoto/cloud: dispara claude.send e coleta
// o stream até 'done', devolvendo o texto final. Usado pelo orquestrador.
async function dispatchOneShot(remoteId, message, { timeoutMs = 300000 } = {}) {
  const r = parse(remoteId); if (!r || !link) throw new Error('Sem conexão remota');
  return new Promise((resolve, reject) => {
    let lastAssistant = '';
    const listener = (p) => {
      if (p.projectId !== remoteId) return;
      if (p.type === 'assistant-text' && p.text) lastAssistant = p.text;
      else if (p.type === 'done') { cleanup(); resolve({ text: lastAssistant, usage: p.usage || null, cost: p.cost || 0, sessionId: p.sessionId || null }); }
      else if (p.type === 'error') { cleanup(); reject(new Error(p.text || 'erro remoto')); }
    };
    const tid = setTimeout(() => { cleanup(); resolve({ text: lastAssistant, usage: null, cost: 0, sessionId: null }); }, timeoutMs);
    function cleanup() { clearTimeout(tid); dispatchListeners.delete(listener); }
    dispatchListeners.add(listener);
    link.rpc(r.hostId, 'claude.send', { projectId: r.projectId, message }, timeoutMs).catch((e) => { cleanup(); reject(e); });
  });
}

// Propaga mudança de modelo/settings de um projeto remoto para o host via relay.
async function patchProject(id, patch) {
  const r = parse(id); if (!r || !link) return null;
  const allowed = {};
  for (const k of ['model', 'thinkingMode', 'permissionMode', 'engine']) {
    if (patch[k] !== undefined) allowed[k] = patch[k];
  }
  if (!Object.keys(allowed).length) return null;
  try {
    const updated = await link.rpc(r.hostId, 'projects.patch', { id: r.projectId, patch: allowed }, 8000);
    if (updated) {
      const host = hosts.get(r.hostId) || { deviceId: r.hostId, name: 'Host', os: '' };
      const tagged = tag(updated, host);
      cachedProjects = cachedProjects.map((p) =>
        p.id === id ? { ...p, model: tagged.model, thinkingMode: tagged.thinkingMode, permissionMode: tagged.permissionMode, engine: tagged.engine } : p
      );
      return tagged;
    }
    return null;
  } catch { return null; }
}

// ─── Shared Workspaces (segunda link para sala de outro owner) ──────────────
const sharedLinks = new Map(); // shareId → { link, shareId, ownerUid, hosts, projects }

function startShared({ shareId, ownerUid, url, token, deviceId, refreshTokenFn }) {
  if (sharedLinks.has(shareId)) {
    const existing = sharedLinks.get(shareId);
    existing.refreshFn = refreshTokenFn;
    return { ok: true };
  }
  const ctx = { shareId, ownerUid, link: null, hosts: new Map(), projects: [], refreshFn: refreshTokenFn };
  const sl = new RelayLink({
    url, token, deviceId: `share-${shareId}-${deviceId}`, role: 'client', WebSocketImpl,
    refreshTokenFn,
    onStatus: (s) => {
      if (s === 'online') onSharedOnline(ctx).catch(() => {});
    },
    onEvent: (f) => {
      if (f.channel === 'claude' && f.payload) {
        const hid = f.from;
        const p = { ...f.payload };
        if (p.projectId && p.projectId !== '*' && hid) p.projectId = `shared:${ownerUid}:${hid}:${p.projectId}`;
        if (onRemoteEvent) onRemoteEvent(p);
        dispatchListeners.forEach((fn) => { try { fn(p); } catch {} });
      }
    },
    onPresence: (f) => {
      if (!f.deviceId) return;
      if (f.online === false) { ctx.hosts.delete(f.deviceId); }
      else { ctx.hosts.set(f.deviceId, { deviceId: f.deviceId, name: (f.host && f.host.name) || 'Host', os: (f.host && f.host.os) || '' }); }
      onSharedOnline(ctx).catch(() => {});
    },
  });
  ctx.link = sl;
  sharedLinks.set(shareId, ctx);
  sl.connect();
  return { ok: true };
}

async function onSharedOnline(ctx) {
  try {
    const list = await ctx.link.hostList(5000).catch(() => []);
    for (const h of (Array.isArray(list) ? list : [])) {
      if (h && h.deviceId) ctx.hosts.set(h.deviceId, { deviceId: h.deviceId, name: h.name || 'Host', os: h.os || '' });
    }
    const all = [];
    await Promise.all(Array.from(ctx.hosts.values()).map(async (host) => {
      try {
        const r = await ctx.link.rpc(host.deviceId, 'projects.list', {}, 8000);
        if (Array.isArray(r)) for (const p of r) {
          all.push({
            id: `shared:${ctx.ownerUid}:${host.deviceId}:${p.id}`,
            name: p.name, source: p.source || 'production', cloud: false,
            remoteHostId: host.deviceId, remoteHostName: host.name,
            remoteProjectId: p.id, sharedFromUid: ctx.ownerUid, shareId: ctx.shareId,
            model: p.model || 'default', thinkingMode: p.thinkingMode || 'medium',
            permissionMode: p.permissionMode || 'default', engine: p.engine || 'claude',
            repoUrl: null, localPath: null, sessionId: p.sessionId || null,
          });
        }
      } catch {}
    }));
    ctx.projects = all;
    // Re-emit state so renderer sees the new shared projects
    emitState();
    if (all.length > 0) try { onProjectsChanged && onProjectsChanged(); } catch {}
  } catch {}
}

function listSharedProjects() {
  const all = [];
  for (const ctx of sharedLinks.values()) all.push(...ctx.projects);
  return all;
}

function disconnectShared(shareId) {
  const ctx = sharedLinks.get(shareId);
  if (ctx) { try { ctx.link && ctx.link.close(); } catch {} sharedLinks.delete(shareId); emitState(); }
}

function sharedRpc(id, channel, payload, timeout) {
  // id format: shared:<ownerUid>:<hostDeviceId>:<projectId>
  const m = /^shared:([^:]+):([^:]+):(.+)$/.exec(id || '');
  if (!m) throw new Error('ID compartilhado inválido');
  const [, ownerUid, hostDeviceId, projectId] = m;
  // Find the share context for this owner
  for (const ctx of sharedLinks.values()) {
    if (String(ctx.ownerUid) === String(ownerUid)) {
      return ctx.link.rpc(hostDeviceId, channel, { ...payload, projectId }, timeout);
    }
  }
  throw new Error('Sem conexão para workspace compartilhado');
}

// RPC genérico pro host conectado — usado pelo main.js pra rotear qualquer
// canal (claude.*, claudeProfiles.*, files.upload…) sem wrapper dedicado.
function rpc(hostId, channel, payload = {}, timeout = 30000) {
  if (!link) return Promise.reject(new Error('remote não conectado'));
  return link.rpc(hostId || primaryHostId, channel, payload, timeout);
}

function updateToken(token) { if (link && token) link.opts.token = token; }
function disconnect() {
  try { link && link.close(); } catch {}
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  link = null; conn = null; primaryHostId = null; hosts.clear(); cachedProjects = [];
  state = { connected: false, status: 'idle', hostName: null };
  onState && onState({ ...state });
  return { ok: true };
}

function getState() { return { ...state }; }
function isHealthy(maxAgeMs = 30000) { return !!(link && link.isHealthy && link.isHealthy(maxAgeMs)); }
function setOnState(fn) { onState = fn; }
function setOnRemoteEvent(fn) { onRemoteEvent = fn; }
function setOnProjectsChanged(fn) { onProjectsChanged = fn; }

async function sendShared(id, message) { return sharedRpc(id, 'claude.send', { message }, 120000); }
async function loadHistoryShared(id) { return sharedRpc(id, 'claude.loadHistory', {}, 15000).catch(() => []); }
async function stopShared(id) { return sharedRpc(id, 'claude.stop', {}, 8000).catch(() => false); }

module.exports = {
  start, startDiscovery, refreshProjects, listProjects, send, loadHistory, stopProject, dispatchOneShot, patchProject,
  startShared, listSharedProjects, disconnectShared, sharedRpc, sendShared, loadHistoryShared, stopShared,
  rpc, isRemote, isShared, isCloudHost, getHostId, getHosts, hasHost, addHost, updateToken, disconnect, getState, isHealthy, setOnState, setOnRemoteEvent, setOnProjectsChanged,
};
