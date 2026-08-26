'use strict';
// Autenticação do Claude CLI (engine 'claude' = assinatura PRÓPRIA do usuário).
// Quando o usuário usa o Claude CLI pela primeira vez ele não está logado e
// mandar mensagem só dá erro. O Maestrus:
//   1) DETECTA via `claude auth status --json` (loggedIn true/false);
//   2) inicia `claude auth login --claudeai`, captura a URL OAuth e ABRE o
//      navegador; o usuário aprova e o Claude mostra um CÓDIGO;
//   3) o usuário cola o código no Maestrus → escrevemos no stdin do processo
//      ("Paste code here if prompted > "); ao validar, o processo encerra 0 e a
//      gente confirma com auth status → conectado.
//
// (O fluxo headless do Claude não usa loopback — o redirect leva a uma página
//  que mostra o código pra colar. Por isso o campo de código.)

const { spawn } = require('child_process');
const runtime = require('./runtime');
const { shellPath, findAll } = require('./requirements');

// Roda `<bin> --version` rápido pra confirmar que o binário REALMENTE executa.
// No Windows um claude.exe embutido de arquitetura errada (ou dependência
// faltando) "existe" mas não roda → sem esta checagem o login travava nele em
// vez de cair pro claude que o usuário instalou no sistema.
function verifyBin(bin) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(bin, ['--version'], { stdio: 'ignore', shell: useShell(bin) }); }
    catch { return resolve(false); }
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    p.on('error', () => fin(false));
    p.on('close', (code) => fin(code === 0));
    setTimeout(() => { try { p.kill(); } catch {} fin(false); }, 8000);
  });
}

let _bin = null;
async function claudeBin() {
  if (_bin) return _bin;
  // 1) embutido — só se REALMENTE executa (Windows: exe de arch errada não roda)
  try { const b = runtime.claudeBin(); if (b && await verifyBin(b)) { _bin = b; return _bin; } } catch {}
  // 2) claude do SISTEMA (o que o usuário instalou / no PATH)
  try { const all = await findAll('claude'); for (const c of all) { if (await verifyBin(c)) { _bin = c; return _bin; } } if (all[0]) { _bin = all[0]; return _bin; } } catch {}
  _bin = 'claude';
  return _bin;
}
function useShell(b) { return process.platform === 'win32' && /\.(cmd|bat)$/i.test(b || ''); }

// Env limpo: usa a assinatura do PRÓPRIO usuário (OAuth) — sem as variáveis do
// proxy Maestrus (que forçariam o engine medido). `extra` permite apontar pra
// outro perfil de conta (CLAUDE_CONFIG_DIR — ver claude-profiles.js).
async function envWithPath(extra) {
  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  try { const p = await shellPath(); if (p) env.PATH = p; } catch {}
  // PREPEND os runtimes EMBUTIDOS (node/git/claude). Numa máquina NOVA — ex.:
  // Windows recém-instalado SEM Node/Git no PATH — o `claude auth login` não
  // achava o node/git do runtime e falhava ("não gera a sessão"). O spawn de
  // chat (claude-pty.buildEnv) já fazia isso; o de auth não → login quebrava.
  try {
    const sep = process.platform === 'win32' ? ';' : ':';
    const dirs = (runtime.pathDirs ? runtime.pathDirs() : []) || [];
    let cur = env.PATH || '';
    const have = cur.toLowerCase().split(sep);
    for (const d of dirs.slice().reverse()) {
      if (d && !have.includes(String(d).toLowerCase())) cur = d + sep + cur;
    }
    env.PATH = cur;
    if (process.platform !== 'win32' && env.Path && !env.PATH) env.PATH = env.Path;
  } catch {}
  if (extra) Object.assign(env, extra);
  return env;
}

// { ok, loggedIn, email?, method?, plan?, error? }
async function status(extraEnv) {
  const bin = await claudeBin();
  const env = await envWithPath(extraEnv);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let proc;
    try {
      proc = spawn(bin, ['auth', 'status', '--json'], { stdio: 'pipe', env, shell: useShell(bin) });
    } catch (e) { return finish({ ok: false, loggedIn: false, error: e.message }); }
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (out += d.toString()));
    proc.on('close', () => {
      try {
        const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
        finish({ ok: true, loggedIn: !!j.loggedIn, email: j.email || null, method: j.authMethod || null, plan: j.subscriptionType || null });
      } catch {
        finish({ ok: true, loggedIn: /logged in|authenticated/i.test(out) && !/not logged in/i.test(out) });
      }
    });
    proc.on('error', () => finish({ ok: false, loggedIn: false, error: 'claude_not_found' }));
    setTimeout(() => { try { proc.kill(); } catch {} finish({ ok: false, loggedIn: false, error: 'timeout' }); }, 12000);
  });
}

let _loginProc = null;

// Dispara `claude auth login`. Streama o output via onLog (e abre a URL OAuth no
// navegador). MANTÉM o processo vivo aguardando o código no stdin. Resolve
// quando o processo encerra (depois de submitCode) com { ok, code }.
//
// SEMPRE `--claudeai`: é a ASSINATURA do usuário. O `--console` autentica no
// Anthropic Console (escopo org:create_api_key), ou seja, na API cobrada por
// token — a conta errada, com cobrança no lugar errado. O Windows caiu no
// `--console` por acreditar que `--claudeai` dependia de um loopback bloqueado
// pelo firewall; isso não é verdade: o redirect é platform.claude.com e o
// fluxo também é paste-code. Quem quiser o Console tem que pedir explicitamente.
function login(onLog, { console: useConsole = false, env: extraEnv = null } = {}) {
  return new Promise(async (resolve) => {
    cancelLogin();
    const bin = await claudeBin();
    const env = await envWithPath(extraEnv);
    const args = ['auth', 'login', useConsole ? '--console' : '--claudeai'];
    // Identifica o ambiente no log. Sem isto, "funciona numa máquina e na
    // outra não" vira adivinhação: o CLI empacotado em cada instalação pode
    // ter versões diferentes, e um fluxo OAuth antigo sai com exit 0 sem
    // autenticar nada.
    onLog(`$ ${bin} ${args.join(' ')}\n`);
    try {
      const v = await new Promise((res) => {
        const p2 = spawn(bin, ['--version'], { env, shell: useShell(bin) });
        let out = ''; const t = setTimeout(() => { try { p2.kill(); } catch {} res(''); }, 8000);
        p2.stdout.on('data', (d) => { out += d.toString(); });
        p2.on('close', () => { clearTimeout(t); res(out.trim()); });
        p2.on('error', () => { clearTimeout(t); res(''); });
      });
      onLog(`[cli ${v || 'desconhecido'} | config ${env.CLAUDE_CONFIG_DIR || 'padrão (~/.claude)'}]\n`);
    } catch {}
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env, shell: useShell(bin) });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    _loginProc = proc;
    // O próprio CLI já abre o navegador ("Opening browser…"); não reabrimos aqui
    // pra não criar uma 2ª aba. A URL vai via onLog e o renderer mostra um
    // botão "abrir o link" como fallback caso o auto-open falhe.
    const onData = (d) => { onLog(d.toString()); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('close', (code) => { _loginProc = null; onLog(`\n[exit ${code}]\n`); resolve({ ok: code === 0, code }); });
    proc.on('error', (e) => { _loginProc = null; onLog(`\n[erro: ${e.message}]\n`); resolve({ ok: false, error: e.message }); });
    // OAuth pode demorar; corta em 10 min se travar.
    setTimeout(() => { if (_loginProc === proc) cancelLogin(); }, 10 * 60 * 1000);
  });
}

// Escreve o código colado pelo usuário no stdin do processo de login.
function submitCode(code) {
  if (!_loginProc || !_loginProc.stdin || _loginProc.stdin.destroyed) return { ok: false, error: 'no_login' };
  try { _loginProc.stdin.write(String(code || '').trim() + '\n'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function cancelLogin() {
  if (_loginProc) { try { _loginProc.kill(); } catch {} _loginProc = null; return true; }
  return false;
}

async function logout(extraEnv) {
  const bin = await claudeBin();
  const env = await envWithPath(extraEnv);
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(bin, ['auth', 'logout'], { stdio: 'ignore', env, shell: useShell(bin) }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    proc.on('error', () => resolve({ ok: false }));
    proc.on('close', (code) => resolve({ ok: code === 0 }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, error: 'timeout' }); }, 12000);
  });
}

module.exports = { status, login, submitCode, cancelLogin, logout };
