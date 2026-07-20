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

function get(id) {
  return store.get(`projects.${id}`) || null;
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
  const cur = get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  store.set(`projects.${id}`, next);
  return next;
}

function save(project) {
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

module.exports = { list, get, createDraft, save, patch, remove, getSetting, setSetting, ensureMaestrus, MAESTRUS_ID, ensureStarter, STARTER_ID, isTombstoned, tombstonedIds, tombstones, addTombstones };
