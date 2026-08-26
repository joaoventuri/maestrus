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
const fs = require('fs');
let WebSocketImpl = null;
try { WebSocketImpl = require('ws'); } catch {}

let link = null;
let conn = null;                 // { url, deviceId } da conexão atual
const hosts = new Map();         // deviceId -> { deviceId, name, os }
const _pendingDrop = new Map();  // deviceId -> timer (grace antes de remover host)
let selfHostId = null;           // meu PRÓPRIO host (se esta máquina é host) — o
                                 // client não deve se descobrir/listar a si mesmo
function setSelfHostId(id) { selfHostId = id || null; }
let primaryHostId = null;        // último host explicitamente adicionado (compat)
let cachedProjects = [];
let syncing = false;             // true enquanto puxa projects.list dos hosts
let lastSyncAt = 0;              // ts do último refresh concluído
let state = { connected: false, status: 'idle', hostName: null };
let onState = null;
let onRemoteEvent = null;
let onProjectsChanged = null; // chamado após refreshProjects bem-sucedido
let onIdentityConflict = null; // relay reportou colisão de did (config clonada)
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
    onIdentityConflict: () => { try { onIdentityConflict && onIdentityConflict(); } catch {} },
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
        // Projeto apagado no host (por qualquer device) → some da lista na hora.
        if (p.type === 'project.removed' && p.projectId) {
          const tid = hid ? `remote:${hid}:${p.projectId}` : null;
          if (tid) cachedProjects = cachedProjects.filter((cp) => cp.id !== tid);
          try { onProjectsChanged && onProjectsChanged(); } catch {}
        }
        if (p.projectId && p.projectId !== '*' && hid) p.projectId = `remote:${hid}:${p.projectId}`;
        if (onRemoteEvent) onRemoteEvent(p);
        dispatchListeners.forEach((fn) => { try { fn(p); } catch {} });
      }
    },
    onPresence: (f) => {
      if (!f.deviceId) return;
      if (f.deviceId === selfHostId) return;   // não me descubro a mim mesmo
      if (f.online === false) {
        // GRACE: presença pisca em reconexão (host cai e volta em segundos). Não
        // derruba o host + projetos na hora — confirma após 6s. Sem isso a lista
        // sumia e reaparecia num loop quando a máquina oscilava (ex.: notebook
        // fechando/abrindo). Se voltar online antes, o timer é cancelado.
        if (_pendingDrop.has(f.deviceId)) return;
        const t = setTimeout(() => {
          _pendingDrop.delete(f.deviceId);
          hosts.delete(f.deviceId);
          emitState();
          scheduleRefresh();
        }, 6000);
        _pendingDrop.set(f.deviceId, t);
        return;
      }
      const pend = _pendingDrop.get(f.deviceId);
      if (pend) { clearTimeout(pend); _pendingDrop.delete(f.deviceId); }
      hosts.set(f.deviceId, { deviceId: f.deviceId, name: (f.host && f.host.name) || 'Host', os: (f.host && f.host.os) || '' });
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
// RECONCILIA a lista local de hosts com a lista AUTORITATIVA do relay (hostList).
// Adiciona os que vieram e REMOVE os fantasmas (dids antigos de uma máquina que
// regenerou o id, que antes ficavam pra sempre → "3 máquinas conectadas" com só
// 2 reais). Não poda com lista vazia (race) nem hosts com drop pendente (graça).
function reconcileHosts(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const fresh = new Set();
  for (const h of list) {
    if (h && h.deviceId && h.deviceId !== selfHostId) {
      fresh.add(h.deviceId);
      hosts.set(h.deviceId, { deviceId: h.deviceId, name: h.name || 'Host', os: h.os || '' });
    }
  }
  for (const did of Array.from(hosts.keys())) {
    if (!fresh.has(did) && !_pendingDrop.has(did)) hosts.delete(did);
  }
  return true;
}
async function onOnline() {
  try {
    const list = await link.hostList(5000).catch(() => []);
    reconcileHosts(list);
    emitState();
    await refreshProjects();
    // Retry se nenhum host encontrado ainda (pode estar registrando no relay)
    if (hosts.size === 0) {
      setTimeout(async () => {
        if (!link || !state.connected) return;
        try {
          const list2 = await link.hostList(4000).catch(() => []);
          if (reconcileHosts(list2) && hosts.size > 0) { emitState(); await refreshProjects(); }
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
  _refreshTimer = setTimeout(async () => {
    _refreshTimer = null;
    // Reconcilia a lista de hosts com a autoritativa (poda fantasmas) e refetcha.
    try { if (link && state.connected) { const l = await link.hostList(4000).catch(() => null); if (l) { reconcileHosts(l); emitState(); } } } catch {}
    refreshProjects().catch(() => {});
  }, 400);
}

async function refreshProjects() {
  if (!link) return [];
  syncing = true; emitState();                 // UI mostra "sincronizando…"
  const all = [];
  // Puxa os projetos de cada host em paralelo; um host offline não derruba os outros.
  await Promise.all(Array.from(hosts.values()).map(async (host) => {
    try {
      const r = await link.rpc(host.deviceId, 'projects.list', {}, 8000);
      if (!Array.isArray(r)) throw new Error('bad_list');
      for (const p of r) {
        // Defesa em profundidade: hosts antigos podem ainda anunciar o
        // orquestrador/Inicializador — nunca os trate como sessão remota.
        if (p && p.id !== 'maestrus' && p.id !== 'starter') all.push(tag(p, host));
      }
    } catch {
      // Host não respondeu AGORA (RPC transitório) → PRESERVA os projetos que
      // já tínhamos dele. Antes o cachedProjects=all zerava a contribuição do
      // host em qualquer falha → a lista piscava/sumia num loop na reconexão.
      for (const cp of cachedProjects) if (cp.remoteHostId === host.deviceId) all.push(cp);
    }
  }));
  cachedProjects = all;
  syncing = false; lastSyncAt = Date.now(); emitState();
  try { onProjectsChanged && onProjectsChanged(); } catch {}
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
// Watchdog: o turno ainda está rodando NO HOST? Usado pra destravar o "pensando".
async function statusOf(remoteId) {
  const r = parse(remoteId); if (!r || !link) return { busy: false, known: false };
  const res = await link.rpc(r.hostId, 'claude.status', { projectId: r.projectId }, 6000).catch(() => null);
  return res && typeof res.busy === 'boolean' ? { busy: !!res.busy, known: res.known !== false } : { busy: false, known: false };
}
async function statusShared(id) {
  const res = await sharedRpc(id, 'claude.status', {}, 6000).catch(() => null);
  return res && typeof res.busy === 'boolean' ? { busy: !!res.busy, known: res.known !== false } : { busy: false, known: false };
}
// Fila de turno de um projeto REMOTO: a fila mora no host, então tudo aqui é
// RPC. O client nunca guarda fila própria — se guardasse, voltaria o problema
// de cada dispositivo ter a sua.
async function queueCall(remoteId, method, params = {}) {
  const r = parse(remoteId); if (!r || !link) return null;
  return link.rpc(r.hostId, method, { ...params, projectId: r.projectId }, 8000).catch(() => null);
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
  for (const k of ['model', 'thinkingMode', 'permissionMode', 'engine', 'voiceMode']) {
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

// Cria um projeto NUM host específico. O host clona o repo lá; o token do git
// vai junto (repo privado) e vira credencial salva no host — as conversas do
// Maestrus no host passam a ter acesso ao git também. Retorna o projeto já
// "tagueado" (remote:<host>:<id>). Erros do host (repo_auth_required, clone_failed)
// sobem como Error pra UI reagir igual ao create local.
async function createOnHost(hostId, input) {
  if (!link) throw new Error('not_connected');
  const host = hosts.get(hostId) || { deviceId: hostId, name: 'Host', os: '' };
  const res = await link.rpc(hostId, 'projects.create', input || {}, 240000);
  if (!res || res.ok === false) throw new Error((res && res.error) || 'create_failed');
  try { refreshProjects(); } catch {}
  return tag(res, host);
}

// Envia o .jsonl de uma sessão local pro projeto NUM host, em pedaços (o relay
// corta frames > 1MB). onProgress(pct 0-100) permite barra em tempo real.
async function uploadSessionToHost(hostId, projectId, sessionId, filePath, onProgress) {
  if (!link) throw new Error('not_connected');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('session_file_not_found');
  const CHUNK = 512 * 1024; // 512KB cru → ~683KB em base64, abaixo do teto de 1MB
  const size = fs.statSync(filePath).size;
  const total = Math.max(1, Math.ceil(size / CHUNK));
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    for (let index = 0; index < total; index++) {
      const read = fs.readSync(fd, buf, 0, CHUNK, index * CHUNK);
      const dataB64 = buf.subarray(0, read).toString('base64');
      const r = await link.rpc(hostId, 'sessions.uploadChunk', { projectId, sessionId, index, total, dataB64 }, 60000);
      if (!r || r.ok === false) throw new Error((r && r.error) || 'upload_failed');
      if (typeof onProgress === 'function') { try { onProgress(Math.round(((index + 1) / total) * 100)); } catch {} }
    }
  } finally { fs.closeSync(fd); }
  try { refreshProjects(); } catch {}
  return { ok: true, sessionId };
}

// true se o id "remote:<host>:<pid>" aponta pra um host ATUALMENTE conectado
// (distingue projeto de container/host vivo do stub legado de cloud-runtime).
function isHostConnected(id) {
  const r = parse(id);
  return !!(r && hosts.has(r.hostId));
}

// Apaga um projeto NO host (container cloud incluso) via relay. O host remove
// do projectStore + arquivos e faz broadcast de project.removed.
async function deleteOnHost(id) {
  if (!link) throw new Error('not_connected');
  const r = parse(id);
  if (!r) throw new Error('bad_id');
  const res = await link.rpc(r.hostId, 'projects.delete', { id: r.projectId }, 30000);
  if (!res || res.ok === false) throw new Error((res && res.error) || 'delete_failed');
  cachedProjects = cachedProjects.filter((p) => p.id !== id);
  try { refreshProjects(); } catch {}
  return { ok: true };
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
  _pendingDrop.forEach((t) => clearTimeout(t)); _pendingDrop.clear();
  link = null; conn = null; primaryHostId = null; hosts.clear(); cachedProjects = [];
  state = { connected: false, status: 'idle', hostName: null };
  onState && onState({ ...state });
  return { ok: true };
}

// Reconexão SOFT: troca o socket (força re-registro no relay) SEM zerar a lista
// de hosts/projetos. Usado no wake-from-sleep — o disconnect() antigo fazia
// hosts.clear() → a UI piscava "nenhum conectado" → "2 máquinas" a cada tampa
// aberta. Aqui os hosts persistem através da reconexão; só o `connected` blinka
// por ~1s enquanto o socket volta. Se não há link, sinaliza pro caller subir um.
function reconnect() {
  if (!link || !link.forceReconnect) return { ok: false, error: 'no_link' };
  try { link.forceReconnect(); } catch {}
  return { ok: true };
}
function getState() { return { ...state }; }
function isHealthy(maxAgeMs = 30000) { return !!(link && link.isHealthy && link.isHealthy(maxAgeMs)); }
function setOnState(fn) { onState = fn; }
function setOnRemoteEvent(fn) { onRemoteEvent = fn; }
function setOnProjectsChanged(fn) { onProjectsChanged = fn; }
function setOnIdentityConflict(fn) { onIdentityConflict = fn; }

async function sendShared(id, message) { return sharedRpc(id, 'claude.send', { message }, 120000); }
async function loadHistoryShared(id) { return sharedRpc(id, 'claude.loadHistory', {}, 15000).catch(() => []); }
async function stopShared(id) { return sharedRpc(id, 'claude.stop', {}, 8000).catch(() => false); }

module.exports = {
  start, startDiscovery, refreshProjects, listProjects, send, loadHistory, statusOf, statusShared, stopProject, dispatchOneShot, patchProject, createOnHost, uploadSessionToHost, deleteOnHost, isHostConnected, setSelfHostId,
  startShared, listSharedProjects, disconnectShared, sharedRpc, sendShared, loadHistoryShared, stopShared,
  rpc, queueCall, isRemote, isShared, isCloudHost, getHostId, getHosts, hasHost, addHost, updateToken, disconnect, reconnect, getState, isHealthy, setOnState, setOnRemoteEvent, setOnProjectsChanged, setOnIdentityConflict,
};
