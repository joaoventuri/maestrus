'use strict';
// Autenticação do Codex CLI (engine 'codex' = assinatura ChatGPT do usuário).
// Espelha o claude-auth.js:
//   1) DETECTA via `codex login status` (+ fallback ~/.codex/auth.json);
//   2) DESKTOP: `codex login` abre o navegador (loopback) e completa sozinho;
//      CONTAINER/headless: `codex login --device-auth` mostra uma URL + CÓDIGO
//      que o usuário aprova em chatgpt.com (o CLI faz polling e encerra 0);
//   3) `codex logout` desconecta. Tokens em ~/.codex/auth.json.
// Também instala o Codex CLI on-demand (`npm i -g @openai/codex`) se faltar.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('./runtime');
const { shellPath, findAll } = require('./requirements');

function useShell(b) { return process.platform === 'win32' && /\.(cmd|bat)$/i.test(b || ''); }

// Verifica uma INVOCAÇÃO completa ({cmd, args}) rodando `--version`. args já
// contém o prefixo necessário (ex.: [caminho/do/codex.js] quando via node).
function verifyInvocation({ cmd, args }) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, [...args, '--version'], { stdio: 'ignore', shell: args.length ? false : useShell(cmd) }); }
    catch { return resolve(false); }
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    p.on('error', () => fin(false));
    p.on('close', (code) => fin(code === 0));
    setTimeout(() => { try { p.kill(); } catch {} fin(false); }, 8000);
  });
}

// Dir GRAVÁVEL onde instalamos o Codex on-demand (sem -g / sem sudo). Espelha a
// ideia do runtime embutido do Claude: um binário gerenciado pelo app.
function localCodexDir() {
  try { const { app } = require('electron'); if (app && app.getPath) return path.join(app.getPath('userData'), 'codex-cli'); } catch {}
  return path.join(os.homedir(), '.maestrus', 'codex-cli');
}
// O launcher OFICIAL do pacote (@openai/codex/bin/codex.js) — ele mesmo acha e
// spawna o binário nativo certo pra plataforma. Resolver por ELE (via node),
// em vez de adivinhar caminhos de binário nativo por SO/arch, é determinístico
// e não depende de shebang (Windows não entende) nem de shims .cmd/.ps1 que o
// npm gera diferente por versão/SO — era a causa real do "INSTALL_FAILED"
// instantâneo (a detecção do bundle embutido nunca batia com o path real).
function jsEntryIn(dir) {
  const p = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}
// Binário do Codex instalado localmente pelo app (npm --prefix <dir>) — mantido
// como diagnóstico/compat; a invocação real usa jsEntryIn (mais confiável).
function installedBin() { return jsEntryIn(localCodexDir()); }

// node a usar pra rodar o launcher: o EMBUTIDO tem prioridade (funciona numa
// máquina sem Node no PATH).
function nodeCmd() {
  try { const n = runtime.nodeBin && runtime.nodeBin(); if (n && fs.existsSync(n)) return n; } catch {}
  return process.platform === 'win32' ? 'node.exe' : 'node';
}
// Plataforma/arquitetura REAIS vistas pelo node que vai RODAR o launcher — não
// necessariamente as do processo atual! Um node embutido x64 rodando via
// Rosetta num Mac Apple Silicon reporta process.arch='x64' PRA SI MESMO, mas o
// `npm install` (se deixado auto-detectar) pode escolher o pacote nativo
// ERRADO (visto na prática: instalou @openai/codex-darwin-arm64 enquanto o
// launcher, rodando via esse node x64, procurava por -x64 → "Missing optional
// dependency"). Forçamos --os/--cpu explícitos casados com quem VAI RODAR o
// launcher, exatamente como o before-pack.js faz no build-time — sem isso, a
// escolha do pacote nativo fica ambígua/errada nesse cenário.
function nodeArchOf(nodeBin) {
  try {
    const r = spawnSync(nodeBin, ['-e', 'process.stdout.write(process.platform+" "+process.arch)'], { timeout: 8000, encoding: 'utf8' });
    const out = (r.stdout || '').trim().split(' ');
    if (out.length === 2 && out[0] && out[1]) return { platform: out[0], arch: out[1] };
  } catch {}
  return { platform: process.platform, arch: process.arch }; // fallback: o do próprio Electron
}

// npm a usar: o EMBUTIDO (mesmo node do runtime) tem prioridade — numa máquina
// sem Node no PATH o `npm` do sistema não existe e a instalação falhava.
function npmCmd() {
  try {
    const nd = runtime.nodeDir && runtime.nodeDir();
    if (nd) {
      for (const rel of [process.platform === 'win32' ? 'npm.cmd' : 'npm', path.join('bin', 'npm')]) {
        const c = path.join(nd, rel);
        if (fs.existsSync(c)) return c;
      }
    }
  } catch {}
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// Resolve COMO invocar o Codex CLI agora: { cmd, args } — args já inclui tudo
// que precede os argumentos reais do CLI (ex.: [jsEntryPath] quando via node).
// Ordem: 1) embutido em BUILD-TIME (before-pack bundleCodex) → 2) instalado
// ON-DEMAND pelo app (dir gravável) → 3) instalação do SISTEMA no PATH.
async function resolveInvocation() {
  try { const js = runtime.codexJsEntry && runtime.codexJsEntry(); if (js) return { cmd: nodeCmd(), args: [js] }; } catch {}
  { const js = jsEntryIn(localCodexDir()); if (js) return { cmd: nodeCmd(), args: [js] }; }
  try {
    const all = await findAll('codex');
    for (const c of all) { if (await verifyInvocation({ cmd: c, args: [] })) return { cmd: c, args: [] }; }
  } catch {}
  return { cmd: process.platform === 'win32' ? 'codex.cmd' : 'codex', args: [] };
}

let _inv = null;
async function getInvocation() {
  if (_inv && (_inv.args[0] ? (() => { try { return fs.existsSync(_inv.args[0]); } catch { return false; } })() : true)) return _inv;
  _inv = await resolveInvocation();
  return _inv;
}
function resetBin() { _inv = null; }

async function envWithPath(extra) {
  const env = { ...process.env };
  // Env limpo — a assinatura ChatGPT vem do ~/.codex/auth.json, não da API key.
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  try { const p = await shellPath(); if (p) env.PATH = p; } catch {}
  try {
    const sep = process.platform === 'win32' ? ';' : ':';
    const dirs = (runtime.pathDirs ? runtime.pathDirs() : []) || [];
    let cur = env.PATH || '';
    const have = cur.toLowerCase().split(sep);
    for (const d of dirs.slice().reverse()) {
      if (d && !have.includes(String(d).toLowerCase())) cur = d + sep + cur;
    }
    env.PATH = cur;
  } catch {}
  if (extra) Object.assign(env, extra);
  return env;
}

function authFileLoggedIn() {
  try {
    const f = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(f)) return false;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return !!(j && (j.tokens || j.OPENAI_API_KEY || j.access_token || j.id_token));
  } catch { return false; }
}

// { ok, loggedIn, method?, email?, error? }
async function status(extraEnv) {
  const { cmd, args: prefix } = await getInvocation();
  const env = await envWithPath(extraEnv);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let proc;
    try { proc = spawn(cmd, [...prefix, 'login', 'status'], { stdio: 'pipe', env, shell: prefix.length ? false : useShell(cmd) }); }
    catch (e) { return finish({ ok: authFileLoggedIn(), loggedIn: authFileLoggedIn(), error: e.message }); }
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (out += d.toString()));
    proc.on('close', (code) => {
      const notLogged = /not logged in|no.*(credential|account)|logged out|please (run )?codex login/i.test(out);
      const logged = !notLogged && (code === 0) && /(logged in|signed in|chatgpt|api key|account|authenticated|@)/i.test(out);
      const emailMatch = out.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      const method = /api key/i.test(out) ? 'apikey' : /chatgpt|subscription|plus|pro|team/i.test(out) ? 'chatgpt' : null;
      finish({ ok: true, loggedIn: logged || authFileLoggedIn(), email: emailMatch ? emailMatch[0] : null, method });
    });
    proc.on('error', () => finish({ ok: authFileLoggedIn(), loggedIn: authFileLoggedIn(), error: 'codex_not_found' }));
    setTimeout(() => { try { proc.kill(); } catch {} finish({ ok: true, loggedIn: authFileLoggedIn(), error: 'timeout' }); }, 12000);
  });
}

let _loginProc = null;

// Headless (container/Linux sem display) → device-auth (código pra aprovar no
// site). Desktop (mac/win) → browser loopback (completa sozinho).
function defaultDeviceAuth() {
  return !!process.env.MAESTRUS_USER_ID || (process.platform === 'linux' && !process.env.DISPLAY);
}

// Dispara `codex login`. Streama a saída via onLog (URL/código). Resolve quando o
// processo encerra (browser completa sozinho; device-auth encerra após aprovar).
function login(onLog, { deviceAuth = defaultDeviceAuth(), env: extraEnv = null } = {}) {
  return new Promise(async (resolve) => {
    cancelLogin();
    const { cmd, args: prefix } = await getInvocation();
    const env = await envWithPath(extraEnv);
    const cliArgs = deviceAuth ? ['login', '--device-auth'] : ['login'];
    onLog(`$ ${cmd} ${[...prefix, ...cliArgs].join(' ')}\n`);
    let proc;
    try { proc = spawn(cmd, [...prefix, ...cliArgs], { stdio: ['pipe', 'pipe', 'pipe'], env, shell: prefix.length ? false : useShell(cmd) }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    _loginProc = proc;
    const onData = (d) => { onLog(d.toString()); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('close', (code) => { _loginProc = null; onLog(`\n[exit ${code}]\n`); resolve({ ok: code === 0, code }); });
    proc.on('error', (e) => { _loginProc = null; onLog(`\n[erro: ${e.message}]\n`); resolve({ ok: false, error: e.message }); });
    setTimeout(() => { if (_loginProc === proc) cancelLogin(); }, 10 * 60 * 1000);
  });
}

// Alguns fluxos do Codex podem pedir algo no stdin — mantém paridade com o Claude.
function submitCode(code) {
  if (!_loginProc || !_loginProc.stdin || _loginProc.stdin.destroyed) return { ok: false, error: 'no_login' };
  try { _loginProc.stdin.write(String(code || '').trim() + '\n'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Login por API key (pipe do valor no stdin: `codex login --with-api-key`).
function loginWithApiKey(key, extraEnv) {
  return new Promise(async (resolve) => {
    const { cmd, args: prefix } = await getInvocation();
    const env = await envWithPath(extraEnv);
    let proc;
    try { proc = spawn(cmd, [...prefix, 'login', '--with-api-key'], { stdio: ['pipe', 'pipe', 'pipe'], env, shell: prefix.length ? false : useShell(cmd) }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (out += d.toString()));
    try { proc.stdin.write(String(key || '').trim() + '\n'); proc.stdin.end(); } catch {}
    proc.on('close', (code) => resolve({ ok: code === 0, output: out.trim() }));
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, error: 'timeout' }); }, 15000);
  });
}

function cancelLogin() {
  if (_loginProc) { try { _loginProc.kill(); } catch {} _loginProc = null; return true; }
  return false;
}

async function logout(extraEnv) {
  const { cmd, args: prefix } = await getInvocation();
  const env = await envWithPath(extraEnv);
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(cmd, [...prefix, 'logout'], { stdio: 'ignore', env, shell: prefix.length ? false : useShell(cmd) }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    proc.on('error', () => resolve({ ok: false }));
    proc.on('close', (code) => { try { const f = path.join(os.homedir(), '.codex', 'auth.json'); if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} resolve({ ok: code === 0 }); });
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, error: 'timeout' }); }, 12000);
  });
}

// Auto-instalação SILENCIOSA e ROBUSTA: baixa o Codex CLI mais recente pra um
// dir GRAVÁVEL do app (npm --prefix, SEM -g → sem sudo/perm global) usando o
// npm/node EMBUTIDO. { ok, installed, alreadyPresent?, error? }
function install(onLog) {
  return new Promise(async (resolve) => {
    // Já tem embutido (build-time) ou instalado antes → não baixa de novo.
    if (await verifyInvocation(await getInvocation())) return resolve({ ok: true, installed: false, alreadyPresent: true });
    const dir = localCodexDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      return resolve({ ok: false, error: `Não consegui criar a pasta de instalação (${dir}): ${e.message}` });
    }
    // package.json mínimo pra o npm não subir procurando raiz no projeto.
    try { fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'maestrus-codex', version: '0.0.0', private: true }) + '\n'); } catch {}
    const npm = npmCmd();
    const env = await envWithPath();
    // --os/--cpu EXPLÍCITOS casados com quem vai RODAR o launcher (nodeCmd()) —
    // não confia na auto-detecção do npm, que pode escolher o pacote nativo
    // errado sob Rosetta/arquiteturas mistas (ver comentário em nodeArchOf).
    const { platform: tPlat, arch: tArch } = nodeArchOf(nodeCmd());
    onLog && onLog(`Baixando o Codex CLI mais recente… (${tPlat}-${tArch}, $ ${npm})\n`);
    const args = ['install', '@openai/codex@latest', '--prefix', dir, `--os=${tPlat}`, `--cpu=${tArch}`, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'];
    let proc;
    try { proc = spawn(npm, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env, shell: process.platform === 'win32' }); }
    catch (e) { return resolve({ ok: false, error: `Não consegui iniciar o npm (${npm}): ${e.message}` }); }
    // Diagnóstico COMPLETO (stdout+stderr) — antes só guardava stderr, e com
    // --loglevel=error uma instalação bem-sucedida não escreve nada nele; se
    // a detecção do binário falhasse por outro motivo, a mensagem virava o
    // genérico "install_failed" sem pista nenhuma. Agora guarda tudo.
    let diag = '';
    let spawnErr = null;
    proc.stdout.on('data', (d) => { const s = d.toString(); diag += s; onLog && onLog(s); });
    proc.stderr.on('data', (d) => { const s = d.toString(); diag += s; onLog && onLog(s); });
    proc.on('close', async (code) => {
      resetBin();
      // Retry curto: logo após o npm fechar, o filesystem às vezes ainda não
      // "assentou" (visto na prática — o mesmo binário que falha aqui funciona
      // perfeitamente 1 tick depois). 3 tentativas com backoff evitam um falso
      // negativo numa instalação que na verdade deu certo.
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));
        resetBin();
        ok = await verifyInvocation(await getInvocation());
      }
      if (ok) { onLog && onLog('Codex CLI instalado.\n'); resolve({ ok: true, installed: true }); return; }
      const tail = diag.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      resolve({ ok: false, error: tail || `npm saiu com código ${code} sem erro visível (pasta: ${dir})` });
    });
    proc.on('error', (e) => { spawnErr = e; resolve({ ok: false, error: `Falha ao rodar o npm: ${e.message}` }); });
    setTimeout(() => { try { proc.kill(); } catch {} if (!spawnErr) resolve({ ok: false, error: 'Instalação demorou demais (timeout de 3min) — verifique sua conexão.' }); }, 180000);
  });
}

// ─── Login por POLLING (web/PWA via relay) ──────────────────────────────────
// O host roda o spawn; o client (web/mobile) chama loginStart e depois faz poll
// de loginState pra pegar { url, code, log, done, ok } — não dá pra streamar
// eventos onLog pelo relay. Espelha o claudeProfiles.loginStart/loginState.
let _ls = { active: false, url: null, code: null, log: '', done: false, ok: false };
function _push(line) {
  _ls.log = (_ls.log + line).slice(-4000);
  const u = line && line.match(/https?:\/\/(?!localhost|127\.0\.0\.1)[^\s'"]+/);
  if (u) _ls.url = u[0];
  // device-auth mostra um user code tipo ABCD-1234
  const c = line && line.match(/\b([A-Z0-9]{4}[-\s]?[A-Z0-9]{4})\b/);
  if (c && /code/i.test(line)) _ls.code = c[1].replace(/\s/, '-');
}
function loginStart(opts = {}) {
  if (_ls.active) return { ok: true, active: true };
  _ls = { active: true, url: null, code: null, log: '', done: false, ok: false };
  (async () => {
    const inst = await install(_push);
    if (inst && inst.ok === false) { _ls.active = false; _ls.done = true; _ls.ok = false; return; }
    // web/container = headless → device-auth por padrão.
    const r = await login(_push, { deviceAuth: opts.deviceAuth !== false });
    _ls.active = false; _ls.done = true; _ls.ok = !!(r && r.ok);
  })().catch(() => { _ls.active = false; _ls.done = true; _ls.ok = false; });
  return { ok: true, active: true };
}
function loginState() { return { ..._ls }; }
function loginCode(code) { return submitCode(code); }
function loginCancel() { const r = cancelLogin(); _ls.active = false; return { ok: r }; }

module.exports = { status, login, submitCode, loginWithApiKey, cancelLogin, logout, install, resetBin, installedBin, localCodexDir, getInvocation, verifyInvocation, loginStart, loginState, loginCode, loginCancel };
