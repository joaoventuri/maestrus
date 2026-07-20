'use strict';
// Perfis de conta do Claude CLI — N contas (planos) no mesmo Maestrus.
//
// Como funciona: o Claude CLI respeita CLAUDE_CONFIG_DIR. Cada perfil ganha um
// diretório próprio (credenciais isoladas = outra conta/assinatura), MAS o
// subdiretório de SESSÕES (projects/) é um symlink/junction pro
// ~/.claude/projects compartilhado — trocar de conta CONTINUA a mesma conversa
// (o --resume acha o mesmo .jsonl, e o sessionFilePath() do Maestrus também).
//
// Perfil 'default' = o ~/.claude de sempre (zero mudança pra quem tem 1 conta).
// O perfil ativo é global (vale pra todos os projetos do host) e é aplicado no
// PRÓXIMO turno — o claude é spawnado por mensagem, então a troca é imediata.
//
// Login de um perfil novo usa o mesmo fluxo paste-code do claude-auth, com
// CLAUDE_CONFIG_DIR apontado pro perfil — utilizável por IPC (desktop) e por
// RPC via relay (web app / PWA controlando o host).

const { app } = require('./electron-compat'); // funciona no Electron E headless (container)
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeAuth = require('./claude-auth');

const DEFAULT_ID = 'default';

function storeFile() { return path.join(app.getPath('userData'), 'claude-profiles.json'); }
function profilesRoot() { return path.join(app.getPath('userData'), 'claude-profiles'); }
function defaultProjectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }

function readStore() {
  try {
    const s = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return { active: s.active || DEFAULT_ID, profiles: Array.isArray(s.profiles) ? s.profiles : [] };
  } catch { return { active: DEFAULT_ID, profiles: [] }; }
}
function writeStore(s) {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch (e) { console.warn('[claude-profiles] write falhou:', e.message); }
}

function configDir(id) {
  if (!id || id === DEFAULT_ID) return null; // usa o ~/.claude padrão
  return path.join(profilesRoot(), id);
}

// Garante o dir do perfil com projects/ linkado pro compartilhado e o
// .claude.json semeado (pula onboarding interativo do CLI).
function ensureProfileDir(id) {
  const dir = configDir(id);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const shared = defaultProjectsDir();
  try { fs.mkdirSync(shared, { recursive: true }); } catch {}
  const link = path.join(dir, 'projects');
  let hasLink = false;
  try { fs.lstatSync(link); hasLink = true; } catch {}
  if (!hasLink) {
    try { fs.symlinkSync(shared, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e) { console.warn('[claude-profiles] link projects falhou:', e.message); }
  }
  const cj = path.join(dir, '.claude.json');
  if (!fs.existsSync(cj)) {
    try { fs.writeFileSync(cj, JSON.stringify({ hasCompletedOnboarding: true, projects: {} }, null, 2) + '\n', 'utf8'); } catch {}
  }
  return dir;
}

function list() {
  const s = readStore();
  return {
    ok: true,
    active: s.active,
    profiles: [{ id: DEFAULT_ID, name: 'Principal', createdAt: 0 }, ...s.profiles],
  };
}

function getActive() { return readStore().active; }

function setActive(id) {
  const s = readStore();
  if (id !== DEFAULT_ID && !s.profiles.some((p) => p.id === id)) return { ok: false, error: 'not_found' };
  if (id !== DEFAULT_ID) ensureProfileDir(id);
  s.active = id;
  writeStore(s);
  console.log('[claude-profiles] ativo →', id);
  return { ok: true, active: id };
}

function create(name) {
  const s = readStore();
  const id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const label = String(name || '').trim().slice(0, 40) || `Conta ${s.profiles.length + 2}`;
  s.profiles.push({ id, name: label, createdAt: Date.now() });
  writeStore(s);
  ensureProfileDir(id);
  return { ok: true, id, name: label };
}

function remove(id) {
  if (id === DEFAULT_ID) return { ok: false, error: 'cannot_remove_default' };
  const s = readStore();
  if (!s.profiles.some((p) => p.id === id)) return { ok: false, error: 'not_found' };
  s.profiles = s.profiles.filter((p) => p.id !== id);
  if (s.active === id) s.active = DEFAULT_ID;
  writeStore(s);
  const dir = configDir(id);
  // remove o LINK projects primeiro (nunca o conteúdo compartilhado), depois o resto
  try { fs.unlinkSync(path.join(dir, 'projects')); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return { ok: true, active: s.active };
}

// Env vars pro spawn do claude respeitar um perfil (default = sem override).
function envVars(id) {
  const target = id === undefined || id === null ? getActive() : id;
  const dir = configDir(target);
  if (!dir) return {};
  return { CLAUDE_CONFIG_DIR: ensureProfileDir(target) || dir };
}

// Onde fica o .claude.json (trust dialog etc.) do perfil ativo.
function claudeJsonPath(id) {
  const target = id === undefined || id === null ? getActive() : id;
  const dir = configDir(target);
  return dir ? path.join(ensureProfileDir(target) || dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

// { ok, loggedIn, email?, plan? } de um perfil específico.
async function status(id) {
  return claudeAuth.status(envVars(id));
}

// ─── Login de perfil (paste-code), consumível por IPC e por RPC (polling) ────
let _login = { profileId: null, active: false, url: null, log: '', done: false, ok: false };

function loginStart(id) {
  const dir = configDir(id);
  if (id !== DEFAULT_ID && !dir) return { ok: false, error: 'not_found' };
  _login = { profileId: id, active: true, url: null, log: '', done: false, ok: false };
  claudeAuth.login((chunk) => {
    _login.log += chunk;
    if (!_login.url) {
      const m = _login.log.match(/https:\/\/[^\s'"]*(?:claude\.com|claude\.ai|anthropic\.com)[^\s'"]*/i);
      if (m) _login.url = m[0];
    }
  }, { env: envVars(id) })
    .then((r) => { _login.done = true; _login.ok = !!(r && r.ok); _login.active = false; })
    .catch(() => { _login.done = true; _login.active = false; });
  return { ok: true };
}

function loginState() {
  return {
    ok: true,
    profileId: _login.profileId,
    active: _login.active,
    url: _login.url,
    done: _login.done,
    success: _login.ok,
    log: _login.log.slice(-400),
  };
}

function loginCode(code) { return claudeAuth.submitCode(code); }
function loginCancel() { claudeAuth.cancelLogin(); _login.active = false; return { ok: true }; }

module.exports = {
  DEFAULT_ID, list, getActive, setActive, create, remove,
  envVars, configDir, claudeJsonPath, ensureProfileDir, status,
  loginStart, loginState, loginCode, loginCancel,
};
