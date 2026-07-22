const { Store } = require('./electron-compat');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Migração one-shot: copia claui/claui-projects.json → maestrus/maestrus-projects.json
// (legado do nome anterior do app). Só roda se o novo não existe ainda.
(function migrateFromClaui() {
  try {
    let appData;
    if (process.platform === 'win32') appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    else if (process.platform === 'darwin') appData = path.join(os.homedir(), 'Library', 'Application Support');
    else appData = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const oldStore = path.join(appData, 'claui', 'claui-projects.json');
    const newDir = path.join(appData, 'maestrus');
    const newStore = path.join(newDir, 'maestrus-projects.json');
    if (fs.existsSync(oldStore) && !fs.existsSync(newStore)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.copyFileSync(oldStore, newStore);
      console.log(`[maestrus] migrou store: ${oldStore} → ${newStore}`);
    }
  } catch (e) { console.error('[maestrus] migrate store falhou:', e && e.message); }
})();

const store = new Store({
  name: 'maestrus-projects',
  defaults: { projects: {}, settings: {} },
});

function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function list() {
  const projects = store.get('projects') || {};
  return Object.values(projects).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// ─── Conversas (forks) por projeto ──────────────────────────────────────────
// Um projeto pode ter N conversas além da principal. Cada conversa é um
// "projeto virtual" com id composto `<projectId>#<convId>`: todo o pipeline
// existente (spawn, eventos, busy, history, relay) funciona sem saber de
// conversas — get/save/patch aqui traduzem o id composto de/para o registro
// `conversations[]` do projeto pai. A conversa principal continua sendo o
// project.sessionId de sempre (nada muda para projetos sem forks).
const CONV_SEP = '#';

function splitConvId(id) {
  const i = String(id || '').indexOf(CONV_SEP);
  if (i < 0) return null;
  return { pid: String(id).slice(0, i), convId: String(id).slice(i + 1) };
}

function _virtualConv(parent, conv) {
  return {
    ...parent,
    id: parent.id + CONV_SEP + conv.id,
    name: conv.title || parent.name,
    // fork ainda não materializado: resume a sessão de origem (+ --fork-session)
    sessionId: conv.sessionId || conv.forkFrom || null,
    conversations: undefined,
    __convOf: parent.id,
    __convId: conv.id,
    __forkPending: !!(conv.forkFrom && !conv.sessionId),
    // sem sessão própria: não adotar o .jsonl mais recente do codeDir (seria o da principal)
    __noAdopt: !conv.sessionId,
  };
}

function get(id) {
  const sp = splitConvId(id);
  if (!sp) return store.get(`projects.${id}`) || null;
  const parent = store.get(`projects.${sp.pid}`) || null;
  if (!parent) return null;
  const conv = (parent.conversations || []).find((c) => c.id === sp.convId);
  if (!conv) return null;
  return _virtualConv(parent, conv);
}

function listConversations(pid) {
  const p = store.get(`projects.${pid}`) || null;
  return (p && p.conversations) || [];
}

function createConversation(pid, { title, forkFrom } = {}) {
  const p = store.get(`projects.${pid}`);
  if (!p) return null;
  const now = Date.now();
  const conv = { id: genId(), title: title || 'Conversa', sessionId: null, forkFrom: forkFrom || null, createdAt: now, updatedAt: now };
  p.conversations = [...(p.conversations || []), conv];
  p.updatedAt = now;
  store.set(`projects.${pid}`, p);
  return conv;
}

function patchConversation(pid, convId, cpatch) {
  const p = store.get(`projects.${pid}`);
  if (!p) return null;
  const idx = (p.conversations || []).findIndex((c) => c.id === convId);
  if (idx < 0) return null;
  p.conversations[idx] = { ...p.conversations[idx], ...cpatch, updatedAt: Date.now() };
  p.updatedAt = Date.now();
  store.set(`projects.${pid}`, p);
  return p.conversations[idx];
}

function deleteConversation(pid, convId) {
  const p = store.get(`projects.${pid}`);
  if (!p) return null;
  const conv = (p.conversations || []).find((c) => c.id === convId) || null;
  p.conversations = (p.conversations || []).filter((c) => c.id !== convId);
  p.updatedAt = Date.now();
  store.set(`projects.${pid}`, p);
  return conv;
}

function createDraft(input) {
  const now = Date.now();
  return {
    id: genId(),
    name: input.name,
    source: input.source,
    repoUrl: input.repoUrl || null,
    localPath: input.localPath || null,
    mountPath: input.mountPath || null,
    sessionId: null,
    codeDir: null,
    driveDir: null,
    sessionDir: null,
    model: input.model || 'sonnet',
    thinkingMode: input.thinkingMode || 'medium',
    permissionMode: input.permissionMode || 'bypassPermissions',
    engine: input.engine || 'claude', // 'claude' (CLI local) | 'cloud' (Maestrus Cloud AI)
    createdAt: now,
    updatedAt: now,
  };
}

function patch(id, patch) {
  const sp = splitConvId(id);
  if (sp) {
    // Conversa virtual: title/sessionId vão pro registro da conversa; o resto
    // (model, thinkingMode, …) aplica no projeto pai (compartilhado).
    const convPatch = {};
    const parentPatch = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'name' || k === 'title') convPatch.title = v;
      else if (k === 'sessionId') convPatch.sessionId = v;
      else parentPatch[k] = v;
    }
    if (Object.keys(convPatch).length) patchConversation(sp.pid, sp.convId, convPatch);
    if (Object.keys(parentPatch).length) patchInternal(sp.pid, parentPatch);
    return get(id);
  }
  return patchInternal(id, patch);
}

function patchInternal(id, patch) {
  const cur = store.get(`projects.${id}`) || null;
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  store.set(`projects.${id}`, next);
  return next;
}

function save(project) {
  if (project && project.__convOf) {
    // Projeto virtual (conversa): persiste só o que é da conversa. O guarda
    // contra sessionId === forkFrom evita que um fork "herde" a sessão de
    // origem como própria caso o --fork-session não tenha gerado id novo.
    const conv = (listConversations(project.__convOf) || []).find((c) => c.id === project.__convId);
    if (conv) {
      const sid = project.sessionId || null;
      if (conv.sessionId || sid !== (conv.forkFrom || null)) {
        patchConversation(project.__convOf, project.__convId, { sessionId: sid });
        project.__forkPending = false;
        project.__noAdopt = !sid;
      }
    }
    return project;
  }
  project.updatedAt = Date.now();
  store.set(`projects.${project.id}`, project);
  return project;
}

// Lápide (tombstone) por projeto excluído: impede que o sync re-importe um id
// recém-apagado caso o manifesto remoto ainda o contenha (race com syncAll, ou
// outro dispositivo que ainda não recebeu a exclusão). TTL de 30 dias.
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
function _tombstones() { return store.get('settings.deleted_projects') || {}; }
function _saveTombstones(t) { store.set('settings.deleted_projects', t); }
function addTombstone(id) {
  if (!id) return;
  const t = _tombstones();
  t[id] = Date.now();
  _saveTombstones(t);
}
function isTombstoned(id) {
  if (!id) return false;
  const t = _tombstones();
  const ts = t[id];
  if (!ts) return false;
  if (Date.now() - ts > TOMBSTONE_TTL_MS) {
    delete t[id]; _saveTombstones(t); return false;
  }
  return true;
}
function tombstonedIds() {
  const t = _tombstones(); const now = Date.now(); const out = [];
  for (const id of Object.keys(t)) {
    if (now - t[id] > TOMBSTONE_TTL_MS) delete t[id]; else out.push(id);
  }
  _saveTombstones(t);
  return out;
}
// Mapa completo {id: timestamp} de tombstones vivos (pós-TTL). Usado pra
// sincronizar a propagação de exclusão entre dispositivos via deleted.json.
function tombstones() {
  const t = _tombstones(); const now = Date.now(); const out = {};
  for (const id of Object.keys(t)) {
    if (now - t[id] > TOMBSTONE_TTL_MS) delete t[id]; else out[id] = t[id];
  }
  _saveTombstones(t);
  return out;
}
// Merge tombstones vindos de outro dispositivo (pega o ts maior). Aprende a
// exclusão remota: novos ids também removem o projeto local caso ainda exista.
function addTombstones(incoming) {
  if (!incoming || typeof incoming !== 'object') return [];
  const t = _tombstones(); const now = Date.now();
  const fresh = [];
  for (const id of Object.keys(incoming)) {
    const ts = Number(incoming[id]) || 0;
    if (!ts || now - ts > TOMBSTONE_TTL_MS) continue;
    if (!t[id] || ts > t[id]) { t[id] = ts; if (!fresh.includes(id)) fresh.push(id); }
  }
  _saveTombstones(t);
  return fresh;
}

function remove(id) {
  store.delete(`projects.${id}`);
  addTombstone(id); // marca como excluído pro sync não re-importar
  return true;
}

function getSetting(key) {
  return store.get(`settings.${key}`);
}

function setSetting(key, value) {
  store.set(`settings.${key}`, value);
  return value;
}

const MAESTRUS_ID = 'maestrus';

function ensureMaestrus(workspaceDir) {
  let m = get(MAESTRUS_ID);
  if (m) return m;
  const now = Date.now();
  m = {
    id: MAESTRUS_ID,
    name: 'Maestrus',
    source: 'maestrus',
    repoUrl: null,
    localPath: workspaceDir,
    mountPath: null,
    sessionId: null,
    codeDir: workspaceDir,
    driveDir: null,
    sessionDir: null,
    model: 'claude-opus-4-7[1m]',
    thinkingMode: 'high',
    permissionMode: 'bypassPermissions',
    isPinned: true,
    createdAt: now,
    updatedAt: now,
  };
  store.set(`projects.${MAESTRUS_ID}`, m);
  return m;
}

// Projeto especial do INICIALIZADOR: um Claude Code dedicado a construir e
// editar o execution_start.bat (o launcher por voz). Sonnet (rápido/barato).
const STARTER_ID = 'starter';
function ensureStarter(workspaceDir) {
  let s = get(STARTER_ID);
  const now = Date.now();
  if (s) {
    // Garante o codeDir atualizado (caso o home tenha mudado).
    if (s.codeDir !== workspaceDir) { s.codeDir = workspaceDir; s.localPath = workspaceDir; store.set(`projects.${STARTER_ID}`, s); }
    return s;
  }
  s = {
    id: STARTER_ID,
    name: 'Inicializador',
    source: 'maestrus',
    repoUrl: null,
    localPath: workspaceDir,
    mountPath: null,
    sessionId: null,
    codeDir: workspaceDir,
    driveDir: null,
    sessionDir: null,
    model: 'claude-sonnet-4-6',
    thinkingMode: 'medium',
    permissionMode: 'bypassPermissions',
    isPinned: false,
    createdAt: now,
    updatedAt: now,
  };
  store.set(`projects.${STARTER_ID}`, s);
  return s;
}

module.exports = { list, get, createDraft, save, patch, remove, getSetting, setSetting, ensureMaestrus, MAESTRUS_ID, ensureStarter, STARTER_ID, isTombstoned, tombstonedIds, tombstones, addTombstones, CONV_SEP, splitConvId, listConversations, createConversation, patchConversation, deleteConversation };
