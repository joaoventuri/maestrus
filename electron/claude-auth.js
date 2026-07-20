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

let _bin = null;
async function claudeBin() {
  if (_bin) return _bin;
  try { const b = runtime.claudeBin(); if (b) { _bin = b; return _bin; } } catch {}
  try { const all = await findAll('claude'); _bin = all[0] || 'claude'; } catch { _bin = 'claude'; }
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
function login(onLog, { console: useConsole = false, env: extraEnv = null } = {}) {
  return new Promise(async (resolve) => {
    cancelLogin();
    const bin = await claudeBin();
    const env = await envWithPath(extraEnv);
    const args = ['auth', 'login', useConsole ? '--console' : '--claudeai'];
    onLog(`$ ${bin} ${args.join(' ')}\n`);
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
