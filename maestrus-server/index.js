'use strict';
// maestrus-server — headless entrypoint (Fase 1.5: módulos reais carregados).
//
// Reusa o backend do Electron (electron/*.js) SEM Electron, graças ao
// electron-compat.js (shim de app.getPath + safeStorage). Papéis:
//
//  1. HOST no relay central — mesmo fluxo do desktop Mac-Mini, deviceId
//     estável "cloud-{userId}" pra clients reconhecerem como container cloud.
//  2. Task queue (kanban dispatcher) rodando 24/7.
//  3. Orchestrate server (MCP maestrus-orchestrate) pro Claude orquestrar.
//  4. HTTP local: /health, /metrics.
//  5. WebSocket direto /ws (fase 2: bridge IPC completo).
//
// Referência: DESIGN.md na raiz do repo.

const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

// Captura o diretório do app ANTES do process.chdir() lá embaixo, pra os
// require() de electron/* resolverem corretamente. No container o layout é
// /app/index.js + /app/electron/ + /app/relay/. No dev é maestrus-server/ +
// ../electron/. Detecta os dois.
const APP_DIR = __dirname;
const ELECTRON_DIR = fs.existsSync(path.join(APP_DIR, 'electron'))
  ? path.join(APP_DIR, 'electron')            // container: /app/electron
  : path.join(APP_DIR, '..', 'electron');     // dev: ../electron

// ─── Env + defaults ─────────────────────────────────────────────────────────
const USER_ID = process.env.MAESTRUS_USER_ID || 'dev-local';
const LICENSE_KEY = process.env.MAESTRUS_LICENSE_KEY || '';
const DATA_DIR = process.env.MAESTRUS_DATA_DIR || path.join(os.homedir(), '.maestrus-server');
const PORT = parseInt(process.env.MAESTRUS_PORT || '8090', 10);
const LOG_LEVEL = process.env.MAESTRUS_LOG || 'info';
const DEVICE_ID = process.env.MAESTRUS_DEVICE_ID || `cloud-${USER_ID}`;
const HOST_NAME = process.env.MAESTRUS_HOST_NAME || `Maestrus Cloud (${USER_ID})`;

function log(level, ...args) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] >= (order[LOG_LEVEL] ?? 1)) console[level === 'debug' ? 'log' : level]('[maestrus-server]', ...args);
}

log('info', 'boot', { USER_ID, DATA_DIR, PORT, DEVICE_ID });

// HOME → DATA_DIR antes de qualquer require que use os.homedir(). Faz o
// electron-store, sessões do Claude (~/.claude), skills etc morarem no volume.
process.env.HOME = DATA_DIR;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
process.chdir(DATA_DIR);

// ─── Event bus (substitui mainWindow.webContents.send) ─────────────────────
const wsClients = new Set();
function emit(channel, payload) {
  const frame = JSON.stringify({ v: 1, type: 'event', channel, payload });
  for (const ws of wsClients) { try { ws.send(frame); } catch {} }
}
globalThis.__maestrusEmit = emit;
globalThis.__maestrusMainWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => emit(channel, payload) },
};

// ─── Módulos do backend (headless via electron-compat) ─────────────────────
const selfhost = require(path.join(ELECTRON_DIR, 'selfhost'));
if (selfhost.isEnabled()) log('info', 'SELF-HOST mode ON — sem cloud/billing, auth por SELFHOST_SECRET');
const projectStore = require(path.join(ELECTRON_DIR, 'project-store'));
const claudePty = require(path.join(ELECTRON_DIR, 'claude-pty'));
const codexPty = require(path.join(ELECTRON_DIR, 'codex-pty')); // engine Codex
function ptyFor(p) { const e = p && p.engine; return (e === 'codex' || e === 'codex-api') ? codexPty : claudePty; }
const remoteHost = require(path.join(ELECTRON_DIR, 'remote-host'));
const cloud = require(path.join(ELECTRON_DIR, 'cloud'));
const taskQueue = require(path.join(ELECTRON_DIR, 'task-queue'));
const turnQueue = require(path.join(ELECTRON_DIR, 'turn-queue')); // fila de turno por conversa
const persona = require(path.join(ELECTRON_DIR, 'persona'));     // estilo de resposta global
const claudeProfiles = require(path.join(ELECTRON_DIR, 'claude-profiles')); // multi-conta do container
const openaiKey = require(path.join(ELECTRON_DIR, 'openai-key'));
const claudeAuth = require(path.join(ELECTRON_DIR, 'claude-auth'));
const codexAuth = require(path.join(ELECTRON_DIR, 'codex-auth'));
let orchestrateServer = null;
try { orchestrateServer = require(path.join(ELECTRON_DIR, 'orchestrate-server')); } catch (e) { log('warn', 'orchestrate indisponível:', e.message); }

// Token admin: o control plane (maestrus.cloud) usa pra chamar os endpoints
// /admin/* (OAuth do Claude, etc). Vem por env; se ausente, admin fica off.
const ADMIN_TOKEN = process.env.MAESTRUS_ADMIN_TOKEN || process.env.MAESTRUS_AGENT_TOKEN || '';

// Estado do fluxo OAuth em andamento (buffer de log pra extrair a URL + código).
let _oauthState = { active: false, url: null, log: '', done: false, ok: false };

// ─── Bootstrap da conta (license via env) ───────────────────────────────────
// O container é single-tenant: a licença vem por env do control plane.
// setAccount grava no electron-store local (volume) — os módulos que chamam
// cloud.getAccount() passam a funcionar (relayToken, kanban, openai-key…).
if (LICENSE_KEY) {
  const existing = cloud.getAccount();
  if (!existing || existing.licenseKey !== LICENSE_KEY) {
    cloud.setAccount({ licenseKey: LICENSE_KEY, email: `${USER_ID}@container`, name: USER_ID, loggedAt: Date.now() });
    log('info', 'account bootstrapped from env');
  }
  projectStore.setSetting('cloud_device_id', DEVICE_ID);
} else {
  log('warn', 'MAESTRUS_LICENSE_KEY vazio — relay/kanban indisponíveis até configurar');
}

// ─── Claude events → broadcast ──────────────────────────────────────────────
// Também é o sinal de ATIVIDADE do container (qualquer turno, de qualquer via —
// relay, /ws ou task queue, todos geram eventos). O cron de auto-suspend usa
// lastActivityAt do /health pra pausar containers ociosos.
let lastActivityAt = Date.now();
// Fila de turno: mudanças viram evento pros clients, igual ao desktop host.
turnQueue.setOnChange((projectId, items) => {
  try { emit('claude:event', { projectId, type: 'queue', items, timestamp: Date.now() }); } catch {}
});

claudePty.onEvent((payload) => {
  lastActivityAt = Date.now();
  emit('claude:event', payload);
  try { maybeWebPush(payload); } catch (e) { log('warn', 'web push:', e.message); }
  // O container também drena a fila: a conversa continua mesmo com todos os
  // dispositivos desligados, que é o ponto de ter um Maestrus 24/7.
  if (payload && payload.type === 'done' && !payload.cancelled) {
    const pid = payload.projectId;
    if (pid && turnQueue.count(pid)) setTimeout(async () => {
      try {
        if (claudePty.isBusy(pid) || codexPty.isBusy(pid)) return;
        const next = turnQueue.shift(pid);
        const project = next && projectStore.get(pid);
        if (project) await ptyFor(project).send(project, next.text);
      } catch (e) { log('warn', 'drain da fila:', e.message); }
    }, 150);
  }
});

// ─── Web Push (PWA) — SÓ no Maestrus Cloud gerenciado ──────────────────────
// Quando um turno termina ('done') ou o agente pergunta ('ask-user-question')
// e NENHUM client está olhando (nem no relay, nem no /ws) há mais de 20s, o
// container avisa o backend, que dispara web push pras subscriptions do dono.
// NUNCA no self-host (sem cloud) e nunca sem LICENSE_KEY.
const PUSH_API_BASE = process.env.MAESTRUS_API_BASE || 'https://maestrus.cloud';
let lastClientSeenAt = Date.now(); // começa "presente" pra não spammar no boot
function clientsPresent() {
  try { if (wsClients.size > 0) return true; } catch {}
  try { if (typeof remoteHost.subscriberCount === 'function' && remoteHost.subscriberCount() > 0) return true; } catch {}
  return false;
}
setInterval(() => { if (clientsPresent()) lastClientSeenAt = Date.now(); }, 5000).unref();
const _pushLastAt = new Map(); // projectId → ts do último push (debounce 60s)
function maybeWebPush(payload) {
  if (!payload || (payload.type !== 'done' && payload.type !== 'ask-user-question')) return;
  if (!LICENSE_KEY || selfhost.isEnabled()) return;
  if (typeof fetch !== 'function') return; // Node < 18 (não acontece no container)
  // SEM gate de presença (o container não sabe se a PWA está visível — presença
  // tem grace e a aba mobile não fecha limpa). SEMPRE dispara; quem decide MOSTRAR
  // é o service worker no device (checa janela visível). Só debounce anti-spam.
  const pid = payload.projectId || 'unknown';
  if (Date.now() - (_pushLastAt.get(pid) || 0) < 15 * 1000) return;
  _pushLastAt.set(pid, Date.now());
  let title = 'Maestrus';
  try { const p = projectStore.get(pid); if (p && p.name) title = p.name; } catch {}
  const body = payload.type === 'done' ? 'Tarefa concluída' : 'O agente fez uma pergunta';
  fetch(`${PUSH_API_BASE}/api.php?action=push_notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ license_key: LICENSE_KEY, title, body, tag: `maestrus-${pid}`, url: '/app' }),
  }).then((r) => r.json())
    .then((j) => log('debug', 'push_notify', pid, j && j.sent))
    .catch((e) => log('warn', 'push_notify falhou:', e.message));
}

// ─── Registra como HOST no relay (RESILIENTE — coração do 24/7) ─────────────
// O container só cumpre a promessa "funciona com seu PC desligado" se o link
// com o relay sobreviver a QUALQUER falha: API fora no boot, token expirado,
// rede piscando, relay reiniciado. Três camadas:
//   1. boot com retry + backoff exponencial (30s → 10min) até conseguir;
//   2. refresh de token periódico, com falha tolerada (o watchdog cobre);
//   3. watchdog a cada 2min — se o link caiu/está zumbi, derruba e recomeça
//      do zero com token novo.
let relayStarted = false;
let _relayBackoffMs = 30 * 1000;

async function tryStartRelayHost() {
  // No modo SELF-HOST não há licença — o token é assinado localmente.
  if (!LICENSE_KEY && !selfhost.isEnabled()) return false;
  const t = await cloud.relayToken('host').catch((e) => ({ ok: false, error: e && e.message }));
  if (!t || !t.ok || !t.token) {
    log('warn', 'relay token falhou:', (t && t.error) || 'sem_resposta');
    return false;
  }
  const refreshTokenFn = async () => {
    const nt = await cloud.relayToken('host').catch(() => null);
    return (nt && nt.ok && nt.token) ? nt.token : null;
  };
  try {
    remoteHost.start({ url: t.url, token: t.token, deviceId: DEVICE_ID, refreshTokenFn });
  } catch (e) { log('warn', 'remoteHost.start falhou:', e.message); return false; }
  relayStarted = true;
  _relayBackoffMs = 30 * 1000; // reset do backoff após sucesso
  log('info', 'host registrado no relay como', DEVICE_ID);
  return true;
}

function scheduleRelayRetry() {
  const wait = _relayBackoffMs;
  _relayBackoffMs = Math.min(_relayBackoffMs * 2, 10 * 60 * 1000);
  log('info', `relay: nova tentativa em ${Math.round(wait / 1000)}s`);
  setTimeout(() => { startRelayLoop(); }, wait).unref?.();
}

// ─── Projeto MAESTRO no container ───────────────────────────────────────────
// O container É o Maestrus completo: além dos projetos do usuário, ele hospeda
// o próprio ORQUESTRADOR ('maestrus'). Sem isso, o web (que conecta no
// container como host) não tinha pra onde mandar o chat do maestro nem o
// projects.create — e caía num sandbox paralelo do cloud_start.
try {
  const maestrusDir = path.join(DATA_DIR, 'maestrus-workspace');
  fs.mkdirSync(maestrusDir, { recursive: true });
  projectStore.ensureMaestrus(maestrusDir);
  // .mcp.json com o servidor de orquestração — o claude-pty carrega do codeDir
  // do maestro em TODOS os projetos (dá claui_dispatch aos agentes do container).
  const binCands = [
    path.join(ELECTRON_DIR, 'mcp-orchestrate-bin.js'),
    path.join(APP_DIR, 'electron', 'mcp-orchestrate-bin.js'),
  ];
  const orchBin = binCands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (orchBin) {
    const cfg = { mcpServers: { 'maestrus-orchestrate': {
      type: 'stdio', command: process.execPath, args: [orchBin],
      env: { ELECTRON_RUN_AS_NODE: '1', MAESTRUS_BROWSER_NATIVE: '0' },
    } } };
    const file = path.join(maestrusDir, '.mcp.json');
    let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (!prev || JSON.stringify(prev) !== JSON.stringify(cfg)) fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }
  log('info', 'maestro (projeto maestrus) pronto no container');
} catch (e) { log('warn', 'ensureMaestrus no container falhou:', e.message); }

function startRelayLoop() {
  tryStartRelayHost().then((ok) => { if (!ok) scheduleRelayRetry(); })
    .catch((e) => { log('error', 'startRelayHost:', e.message); scheduleRelayRetry(); });
}
if (LICENSE_KEY || selfhost.isEnabled()) startRelayLoop();
else log('warn', 'sem license e sem SELFHOST — relay host não iniciado');

// Refresh de token periódico (TTL do token é 10min). Falha não é fatal — o
// watchdog abaixo reconstrói o link se ele morrer de token velho.
setInterval(async () => {
  if (!relayStarted) return;
  try {
    const nt = await cloud.relayToken('host');
    if (nt && nt.ok && nt.token) remoteHost.updateToken(nt.token);
    else log('warn', 'refresh de token do relay falhou:', (nt && nt.error) || 'sem_resposta');
  } catch (e) { log('warn', 'refresh de token do relay:', e.message); }
}, 8 * 60 * 1000).unref();

// Watchdog: se o link com o relay caiu ou virou zumbi, reconstrói do zero.
setInterval(async () => {
  if (!LICENSE_KEY) return;
  try {
    if (!relayStarted) { startRelayLoop(); return; }
    const st = remoteHost.getState();
    const healthy = remoteHost.isHealthy ? remoteHost.isHealthy(3 * 60 * 1000) : (st && st.status === 'online');
    if (st && st.status === 'online' && healthy) return;
    log('warn', 'relay watchdog: link fora (status=' + (st && st.status) + ', healthy=' + healthy + ') — reconstruindo');
    try { remoteHost.stop(); } catch {}
    relayStarted = false;
    startRelayLoop();
  } catch (e) { log('warn', 'relay watchdog:', e.message); }
}, 2 * 60 * 1000).unref();

// ─── Task queue (kanban 24/7) ───────────────────────────────────────────────
taskQueue.setMainWindow(globalThis.__maestrusMainWindow);
taskQueue.start();
log('info', 'task queue started');

// ─── Orchestrate server (MCP) ───────────────────────────────────────────────
if (orchestrateServer) {
  (async () => {
    try {
      const info = await orchestrateServer.start({
        projectStore,
        // target chega como OBJETO (orchestrate-server resolve antes — inclusive
        // sub-conversas/forks via id composto). Sem wait, dispara pelo caminho
        // normal do chat (a resposta aparece no chat do alvo); wait=true = one-shot.
        dispatchFn: async (target, prompt, opts) => {
          const proj = typeof target === 'string' ? projectStore.get(target) : target;
          if (!proj) throw new Error('project not found');
          const o = opts || {};
          if (!o.wait) {
            Promise.resolve(claudePty.send(proj, prompt)).catch((e) => log('warn', 'dispatch send falhou:', e.message));
            return { dispatched: true, async: true, text: `Disparado para "${proj.name}". Rodando em segundo plano — a resposta aparece no chat do projeto.` };
          }
          return claudePty.dispatchOneShot(proj, prompt, o);
        },
        getProjects: () => projectStore.list(),
        getProject: (id) => projectStore.get(id),
        browser: null, // headless: sem browser embutido (fase 2: playwright opcional)
      });
      claudePty.setOrchestrateInfo(info);
      log('info', 'orchestrate server on', info && info.port);
    } catch (e) { log('warn', 'orchestrate server falhou:', e.message); }
  })();
}

// ─── OpenAI key watcher (voice BYOK) ────────────────────────────────────────
openaiKey.startWatcher();
setTimeout(() => { openaiKey.fetchAndCache().catch(() => {}); }, 3000);

// ─── Anthropic key watcher (engine "Claude API" BYOK) ───────────────────────
// A chave setada em qualquer device chega aqui — o container roda a engine
// Claude API com a chave do usuário, sem proxy nem billing do Maestrus.
const anthropicKey = require(path.join(ELECTRON_DIR, 'anthropic-key'));
anthropicKey.startWatcher();
setTimeout(() => { anthropicKey.fetchAndCache().catch(() => {}); }, 3500);

// Estáticos do web app e do PWA servidos pelo PRÓPRIO servidor (uma porta só).
// No container: /app/webroot (web) e /app/approot (pwa). No dev: dist-web/dist-mobile.
function firstDir(cands) { for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} } return null; }
const WEB_DIR = firstDir([path.join(APP_DIR, 'webroot'), path.join(APP_DIR, '..', 'dist-web')]);
const PWA_DIR = firstDir([path.join(APP_DIR, 'approot'), path.join(APP_DIR, '..', 'dist-mobile')]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
function serveStatic(res, rootDir, rel, fallbackHtmls) {
  try {
    let p = path.join(rootDir, rel.replace(/^\/+/, ''));
    if (!path.resolve(p).startsWith(path.resolve(rootDir))) { res.writeHead(403); res.end(); return true; } // path traversal
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      // SPA fallback: tenta cada candidato (index.html no container; web.html/
      // mobile.html no dev sem cópia).
      const cands = Array.isArray(fallbackHtmls) ? fallbackHtmls : [fallbackHtmls];
      p = '';
      for (const c of cands) { const cp = path.join(rootDir, c); if (fs.existsSync(cp)) { p = cp; break; } }
    }
    if (!p || !fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return true; }
    const ext = path.extname(p).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    fs.createReadStream(p).pipe(res);
    return true;
  } catch { res.writeHead(500); res.end('err'); return true; }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, userId: USER_ID, deviceId: DEVICE_ID,
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      relay: relayStarted ? remoteHost.getState() : { running: false },
      projects: projectStore.list().length,
      lastActivityAt,
    }));
    return;
  }
  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end([
      `maestrus_uptime_seconds ${process.uptime()}`,
      `maestrus_memory_bytes ${process.memoryUsage().rss}`,
      `maestrus_ws_clients ${wsClients.size}`,
      `maestrus_projects ${projectStore.list().length}`,
      `maestrus_relay_up ${relayStarted && remoteHost.getState().status === 'online' ? 1 : 0}`,
      '',
    ].join('\n'));
    return;
  }
  // ─── Self-host: config pública + emissão de token de client ───────────────
  if (selfhost.isEnabled()) {
    // Config pública: o client descobre que é self-host, o nome e a url do relay.
    if (url.pathname === '/selfhost/config') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, selfhost: true, hostName: HOST_NAME, deviceId: DEVICE_ID, relayUrl: process.env.MAESTRUS_RELAY_URL_PUBLIC || process.env.MAESTRUS_RELAY_URL || null, needsSecret: true }));
      return;
    }
    // Emite token de client: o cliente prova conhecer o SELFHOST_SECRET.
    if (url.pathname === '/selfhost/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
        res.setHeader('access-control-allow-origin', '*');
        if (!selfhost.checkSecret(j.secret)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"bad_secret"}'); return; }
        const token = selfhost.signRelayToken(j.deviceId || 'web', 'client');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token, url: process.env.MAESTRUS_RELAY_URL_PUBLIC || process.env.MAESTRUS_RELAY_URL || null, hostDeviceId: DEVICE_ID, hostName: HOST_NAME }));
      });
      return;
    }
    if (url.pathname === '/selfhost/token' && req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }); res.end(); return;
    }
  }

  // ─── Admin: OAuth do Claude CLI (bridge pro control plane) ────────────────
  // Protegido por ADMIN_TOKEN. O maestrus.cloud chama estes pra o usuário
  // conectar o Claude ao container sem browser local (fluxo paste-code).
  if (url.pathname.startsWith('/admin/')) {
    const tok = req.headers['x-admin-token'] || '';
    if (!ADMIN_TOKEN || tok !== ADMIN_TOKEN) { res.writeHead(403); res.end('{"error":"forbidden"}'); return; }

    const readBody = () => new Promise((resolve) => {
      let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    });
    const jsend = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    // GET /admin/claude-auth/status → { loggedIn, email, plan }
    if (url.pathname === '/admin/claude-auth/status') {
      claudeAuth.status().then((s) => jsend(200, s)).catch((e) => jsend(500, { ok: false, error: String(e) }));
      return;
    }
    // POST /admin/claude-auth/start → dispara login, captura a URL OAuth.
    if (url.pathname === '/admin/claude-auth/start' && req.method === 'POST') {
      _oauthState = { active: true, url: null, log: '', done: false, ok: false };
      claudeAuth.login((chunk) => {
        _oauthState.log += chunk;
        // captura a URL OAuth do output do CLI (claude.com/cai/oauth, claude.ai,
        // anthropic.com, console.anthropic — o domínio varia por versão do CLI).
        const m = _oauthState.log.match(/https:\/\/[^\s'"]*(?:claude\.com|claude\.ai|anthropic\.com)[^\s'"]*/i);
        if (m && !_oauthState.url) _oauthState.url = m[0];
      }).then((r) => { _oauthState.done = true; _oauthState.ok = !!r.ok; _oauthState.active = false; })
        .catch(() => { _oauthState.done = true; _oauthState.active = false; });
      // espera até 8s pela URL aparecer
      const t0 = Date.now();
      const waitUrl = () => {
        // Login já terminou SEM sucesso (binário ausente, spawn falhou) → erro
        // de verdade, não { ok:true, url:null } que deixa o caller preso.
        if (_oauthState.done && !_oauthState.ok && !_oauthState.url) {
          return jsend(500, { ok: false, error: 'login_failed', log: _oauthState.log.slice(-500) });
        }
        if (_oauthState.url) return jsend(200, { ok: true, url: _oauthState.url, log: _oauthState.log.slice(-500) });
        if (Date.now() - t0 > 8000) {
          return jsend(200, { ok: false, error: 'oauth_url_timeout', log: _oauthState.log.slice(-500) });
        }
        setTimeout(waitUrl, 300);
      };
      waitUrl();
      return;
    }
    // POST /admin/claude-auth/code {code} → cola o código no stdin do login.
    if (url.pathname === '/admin/claude-auth/code' && req.method === 'POST') {
      readBody().then((b) => {
        const r = claudeAuth.submitCode(b.code || '');
        // espera o processo encerrar (validação) até 15s
        const t0 = Date.now();
        const waitDone = () => {
          if (_oauthState.done || Date.now() - t0 > 15000) {
            return jsend(200, { ok: _oauthState.ok, done: _oauthState.done, submit: r });
          }
          setTimeout(waitDone, 400);
        };
        waitDone();
      });
      return;
    }
    // POST /admin/claude-auth/cancel
    if (url.pathname === '/admin/claude-auth/cancel' && req.method === 'POST') {
      claudeAuth.cancelLogin(); _oauthState = { active: false, url: null, log: '', done: false, ok: false };
      return jsend(200, { ok: true });
    }
    // POST /admin/claude-auth/logout
    if (url.pathname === '/admin/claude-auth/logout' && req.method === 'POST') {
      claudeAuth.logout().then((r) => jsend(200, r)).catch((e) => jsend(500, { ok: false, error: String(e) }));
      return;
    }
    // POST /admin/set-setting {key, value} → projectStore.setSetting. Usado pelo
    // control plane pra ajustes que valem NA HORA (ex.: public_url do domínio
    // próprio — o claude-pty injeta no system prompt de toda conversa nova).
    if (url.pathname === '/admin/set-setting' && req.method === 'POST') {
      readBody().then((b) => {
        const key = String(b.key || '');
        if (!/^[a-z0-9_.-]{1,64}$/i.test(key)) return jsend(400, { ok: false, error: 'bad_key' });
        const value = typeof b.value === 'string' ? b.value.slice(0, 1000) : b.value;
        try { projectStore.setSetting(key, value); return jsend(200, { ok: true, key }); }
        catch (e) { return jsend(500, { ok: false, error: String(e && e.message || e) }); }
      });
      return;
    }
    res.writeHead(404); res.end('{"error":"unknown_admin_op"}');
    return;
  }

  // ─── Estáticos: PWA em /app, web app na raiz (self-host: uma porta serve tudo)
  if ((url.pathname === '/app' || url.pathname.startsWith('/app/')) && PWA_DIR) {
    return void serveStatic(res, PWA_DIR, url.pathname.replace(/^\/app/, '') || '/', ['index.html', 'mobile.html']);
  }
  if (WEB_DIR && req.method === 'GET') {
    // O bundle web é buildado com base /web/ (layout do maestrus.cloud). No
    // self-host o webroot vive na RAIZ — sem este strip, /web/assets/*.js caía
    // no fallback SPA (text/html) e a página ficava em branco.
    const rel = url.pathname.startsWith('/web/') || url.pathname === '/web'
      ? (url.pathname.replace(/^\/web/, '') || '/')
      : (url.pathname === '/' ? '/' : url.pathname);
    return void serveStatic(res, WEB_DIR, rel, ['index.html', 'web.html']);
  }

  res.writeHead(404); res.end('{"error":"not_found"}');
});

// ─── WebSocket direto (/ws) — fase 2 pluga o bridge IPC completo aqui ───────
let WebSocketServer, WsClient;
try { const W = require('ws'); WebSocketServer = W.WebSocketServer; WsClient = W.WebSocket || W; } catch {}
if (WebSocketServer) {
  // noServer + roteamento manual do upgrade: /ws (RPC direto) e, no self-host,
  // /relay (proxy WS pro relay interno — assim UMA porta serve web+PWA+relay).
  const wss = new WebSocketServer({ noServer: true });
  const relayWss = selfhost.isEnabled() ? new WebSocketServer({ noServer: true }) : null;
  const RELAY_INTERNAL = process.env.MAESTRUS_RELAY_URL || 'ws://localhost:8790';
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, `http://x`).pathname; } catch {}
    if (pathname === '/ws') { wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)); return; }
    if (relayWss && (pathname === '/relay' || pathname.startsWith('/relay'))) {
      relayWss.handleUpgrade(req, socket, head, (ws) => {
        // Proxy transparente: liga o browser ao relay interno, encaminhando o
        // ?token=… da query. Bytes fluem nos dois sentidos.
        let upstream;
        try { upstream = new WsClient(RELAY_INTERNAL + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')); }
        catch { try { ws.close(); } catch {} return; }
        const q = [];
        // ws (Node) entrega TEXTO como Buffer; repassar o Buffer cru vira frame
        // BINÁRIO — o browser recebe Blob, o parseFrame descarta e o client
        // fica "surdo" (outbound ok, inbound nunca chega). Converte pra string
        // quando o frame original era texto.
        const asWire = (m, isBinary) => (isBinary ? m : m.toString('utf8'));
        upstream.on('open', () => { for (const m of q) { try { upstream.send(m); } catch {} } q.length = 0; });
        ws.on('message', (m, isBinary) => { const w = asWire(m, isBinary); if (upstream.readyState === 1) { try { upstream.send(w); } catch {} } else q.push(w); });
        upstream.on('message', (m, isBinary) => { try { ws.send(asWire(m, isBinary)); } catch {} });
        const bye = () => { try { ws.close(); } catch {} try { upstream.close(); } catch {} };
        ws.on('close', bye); ws.on('error', bye); upstream.on('close', bye); upstream.on('error', bye);
      });
      return;
    }
    socket.destroy();
  });
  wss.on('connection', (ws, req) => {
    log('info', 'ws:connect', req.socket.remoteAddress);
    wsClients.add(ws);
    ws.send(JSON.stringify({ v: 1, type: 'hello', userId: USER_ID, deviceId: DEVICE_ID }));
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      // RPC básico: { type:'rpc', id, method, params } → { type:'rpc-result', id, result|error }
      if (msg.type === 'rpc' && msg.id && msg.method) {
        const respond = (result, error) => {
          try { ws.send(JSON.stringify({ v: 1, type: 'rpc-result', id: msg.id, result, error })); } catch {}
        };
        try {
          switch (msg.method) {
            case 'projects.list': return respond(projectStore.list());
            case 'projects.get': return respond(projectStore.get(msg.params?.id));
            case 'claude.send': {
              const p = projectStore.get(msg.params?.projectId);
              if (!p) return respond(null, 'project_not_found');
              await ptyFor(p).send(p, String(msg.params?.message || ''));
              return respond({ ok: true });
            }
            case 'claude.stop': return respond(claudePty.kill(msg.params?.projectId) || codexPty.kill(msg.params?.projectId));
            // Fila de turno do container (mesma do desktop host).
            // Contas do Claude DO CONTAINER, gerenciadas pelo client (mesmo
            // conjunto que o desktop-host expõe em remote-host.js).
            case 'claudeProfiles.list': return respond(claudeProfiles.list());
            case 'claudeProfiles.status': return respond(await claudeProfiles.status(msg.params?.id));
            case 'claudeProfiles.setActive': return respond(claudeProfiles.setActive(msg.params?.id));
            case 'claudeProfiles.create': return respond(claudeProfiles.create(msg.params?.name));
            case 'claudeProfiles.remove': return respond(claudeProfiles.remove(msg.params?.id));
            case 'claudeProfiles.loginStart': return respond(await claudeProfiles.loginStart(msg.params?.id));
            case 'claudeProfiles.loginState': return respond(claudeProfiles.loginState());
            case 'claudeProfiles.loginCode': return respond(await claudeProfiles.loginCode(msg.params?.code));
            case 'claudeProfiles.loginCancel': return respond(claudeProfiles.loginCancel());
            case 'persona.get': return respond({ style: persona.getStyle(), options: persona.listStyles() });
            case 'persona.set': return respond({ style: persona.setStyle(msg.params?.style) });
            case 'queue.list': return respond(turnQueue.list(msg.params?.projectId));
            case 'queue.enqueue': return respond(turnQueue.enqueue(msg.params?.projectId, { text: msg.params?.text, attachments: msg.params?.attachments }));
            case 'queue.remove': return respond(turnQueue.remove(msg.params?.projectId, msg.params?.itemId));
            case 'queue.reorder': return respond(turnQueue.reorder(msg.params?.projectId, msg.params?.ids));
            case 'queue.clear': return respond(turnQueue.clear(msg.params?.projectId));
            // Watchdog do client: sem isso o WS direto (self-host) caía em
            // unknown_method e o "pensando" nunca destravava ao perder o 'done'.
            case 'claude.status': {
              const pid = msg.params?.projectId;
              return respond({ busy: !!(claudePty.isBusy(pid) || codexPty.isBusy(pid)), known: true });
            }
            case 'claude.loadHistory': {
              const p = projectStore.get(msg.params?.projectId);
              return respond(p ? await ptyFor(p).loadHistory(p) : []);
            }
            // Estado da conta Claude DO CONTAINER (o client não pode checar o
            // login da própria máquina — é aqui que o claude roda).
            case 'claude.authStatus': return respond(await claudeAuth.status().catch(() => ({ ok: false, loggedIn: false })));
            // Login do Codex CLI no container (device-auth), acionado pelo client.
            case 'codex.status': return respond(await codexAuth.status().catch(() => ({ ok: false, loggedIn: false })));
            case 'codex.loginStart': return respond(codexAuth.loginStart(msg.params || {}));
            case 'codex.loginState': return respond(codexAuth.loginState());
            case 'codex.loginCode': return respond(codexAuth.loginCode(msg.params?.code));
            case 'codex.loginCancel': return respond(codexAuth.loginCancel());
            case 'codex.logout': return respond(await codexAuth.logout().catch(() => ({ ok: false })));
            default: return respond(null, 'unknown_method: ' + msg.method);
          }
        } catch (e) { respond(null, String(e && e.message || e)); }
      }
    });
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => {});
  });
}

server.listen(PORT, () => log('info', `HTTP + WS on :${PORT}`));

// ─── Graceful shutdown ───────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown', reason);
  try { taskQueue.stop(); } catch {}
  try { remoteHost.stop(); } catch {}
  try { claudePty.killAll(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log('info', 'ready — container completo (host relay + kanban + orchestrate + voice BYOK)');
