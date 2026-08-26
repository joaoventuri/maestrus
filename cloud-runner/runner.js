'use strict';
// ─── Maestrus Cloud Runner (headless) ───────────────────────────────────────
// Roda DENTRO de um sandbox (container/microVM) na nuvem. É a versão headless
// do electron/remote-host.js: liga no relay como "host", roda o Claude CLI no
// repo do projeto e streama os eventos de volta — então o desktop/PWA conecta
// nele EXATAMENTE como conecta na sua máquina (reusa todo o transporte).
//
// É o tijolo do "Maestrus on Cloud": o runtime vive aqui, persistente. PC off?
// o sandbox continua (ou snapshota e restaura). Sem Electron — só Node + Claude.
//
// Env esperado (setado pelo orquestrador ao criar o sandbox):
//   RELAY_URL, RELAY_TOKEN, DEVICE_ID  → conexão no relay (mesmo do desktop)
//   PROJECT_ID, PROJECT_NAME           → identidade do projeto cloud
//   WORKDIR                            → pasta do repo (default /workspace)
//   CLAUDE_BIN                         → binário do claude (default 'claude')
//   MODEL                              → modelo (opcional)
//   REFRESH_URL, LICENSE_KEY           → renovar relay_token (opcional)
//   (+ auth do Claude: ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN p/ Maestrus AI,
//      ou ANTHROPIC_API_KEY, ou CLAUDE_CODE_OAUTH_TOKEN — herdados no spawn)

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { RelayLink } = require('../relay/link');
let WebSocketImpl = null;
try { WebSocketImpl = require('ws'); } catch {}
// Node 22+ tem WebSocket NATIVO (global) → dispensa o pacote `ws` (e o lento/
// frágil `npm install ws` no boot do sandbox). Cai nele se o pacote faltar.
if (!WebSocketImpl && typeof globalThis.WebSocket !== 'undefined') WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) { console.error('[runner] sem WebSocket (nem pacote ws nem nativo)'); process.exit(1); }

const RELAY_URL = process.env.RELAY_URL;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const DEVICE_ID = process.env.DEVICE_ID || ('cloud-' + (process.env.PROJECT_ID || 'proj'));
const PROJECT_ID = process.env.PROJECT_ID || 'cloud';
const PROJECT_NAME = process.env.PROJECT_NAME || 'Cloud Project';
const WORKDIR = process.env.WORKDIR || '/workspace';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

if (!RELAY_URL || !RELAY_TOKEN) { console.error('[runner] RELAY_URL e RELAY_TOKEN são obrigatórios'); process.exit(1); }

let link = null;
let sessionId = null;
let current = null;                 // processo do claude rodando agora (1 por vez)
const subscribers = new Set();      // deviceIds de clients ativos

function project() {
  return {
    id: PROJECT_ID, name: PROJECT_NAME, source: 'maestrus',
    model: process.env.MODEL || 'default', thinkingMode: 'medium',
    permissionMode: 'bypassPermissions', engine: 'claude', sessionId,
    remoteHostId: null,
  };
}

// Envia um evento (mesmo formato do claude-pty.emit) pra todos os clients.
function send(payload) {
  for (const did of subscribers) { try { link.sendEvent(did, 'claude', payload); } catch {} }
}

// ─── Parsing do stream-json → eventos (fiel ao claude-pty.handleEvent) ───────
const askToolIds = new Set();
function handleEvent(evt) {
  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id) sessionId = evt.session_id;
    send({ projectId: PROJECT_ID, type: 'system', subtype: 'init', sessionId: evt.session_id });
    return;
  }
  if (evt.type === 'assistant' && evt.message) {
    if (evt.message.usage) send({ projectId: PROJECT_ID, type: 'usage', usage: evt.message.usage, timestamp: Date.now() });
    for (const block of (evt.message.content || [])) {
      if (block.type === 'text') {
        send({ projectId: PROJECT_ID, type: 'assistant-text', text: block.text, timestamp: Date.now() });
      } else if (block.type === 'tool_use') {
        if (/AskUserQuestion/i.test(block.name || '') && block.id) askToolIds.add(block.id);
        send({ projectId: PROJECT_ID, type: 'tool-use', name: block.name, input: block.input, id: block.id, timestamp: Date.now() });
      } else if (block.type === 'thinking') {
        send({ projectId: PROJECT_ID, type: 'thinking', text: block.thinking, timestamp: Date.now() });
      }
    }
    return;
  }
  if (evt.type === 'user' && evt.message) {
    for (const block of (evt.message.content || [])) {
      if (block.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
          : typeof block.content === 'string' ? block.content : '';
        if (askToolIds.has(block.tool_use_id)) { askToolIds.delete(block.tool_use_id); continue; }
        if (block.is_error && /answer questions|not enabled|no such tool|AskUserQuestion/i.test((text || '').trim())) continue;
        send({ projectId: PROJECT_ID, type: 'tool-result', toolUseId: block.tool_use_id, text, isError: !!block.is_error, timestamp: Date.now() });
      }
    }
    return;
  }
  if (evt.type === 'stream_event' && evt.event) {
    const ev = evt.event;
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      send({ projectId: PROJECT_ID, type: 'delta', text: ev.delta.text, timestamp: Date.now() });
    }
    return;
  }
  if (evt.type === 'result') { send({ projectId: PROJECT_ID, type: 'result', evt, timestamp: Date.now() }); return; }
}

// ─── Histórico: lê o .jsonl da sessão do claude (preserva a conversa) ────────
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
  return '';
}
function historyPath() {
  if (!sessionId) return null;
  const home = process.env.HOME || os.homedir();
  const enc = WORKDIR.replace(/[^a-zA-Z0-9]/g, '-'); // /home/user/workspace → -home-user-workspace
  return `${home}/.claude/projects/${enc}/${sessionId}.jsonl`;
}
// Acha a sessão mais recente do projeto (pra --resume + histórico sobreviverem
// a restart do runner, mesmo sem RESUME_SESSION_ID).
function discoverSession() {
  try {
    const home = process.env.HOME || os.homedir();
    const enc = WORKDIR.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = `${home}/.claude/projects/${enc}`;
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) return null;
    files.sort((a, b) => fs.statSync(`${dir}/${b}`).mtimeMs - fs.statSync(`${dir}/${a}`).mtimeMs);
    return files[0].replace(/\.jsonl$/, '');
  } catch { return null; }
}
function readHistory() {
  const p = historyPath();
  if (!p || !fs.existsSync(p)) return [];
  const out = [];
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const msg = e.message || e;
      const role = msg.role || e.type;
      const ts = e.timestamp ? (Date.parse(e.timestamp) || Date.now()) : Date.now();
      if (role === 'user' || role === 'assistant') {
        const text = extractText(msg.content);
        if (text) out.push({ role, text, timestamp: ts });
      }
    }
  } catch (err) { console.error('[runner] readHistory', err && err.message); }
  return out;
}

// ─── Roda um turno do Claude no repo ─────────────────────────────────────────
function runClaude(message, allowResume = true) {
  if (current) { send({ projectId: PROJECT_ID, type: 'error', text: 'Já tem um turno rodando.', timestamp: Date.now() }); return; }
  if (allowResume) send({ projectId: PROJECT_ID, type: 'user', text: message, timestamp: Date.now() }); // 1x só (retry não re-ecoa)
  const args = ['-p', message, '--output-format', 'stream-json', '--input-format', 'text', '--verbose', '--include-partial-messages', '--permission-mode', 'bypassPermissions'];
  if (process.env.MODEL) args.push('--model', process.env.MODEL);
  // --resume só com sessionId UUID válido E .jsonl presente. Id inválido/estranho
  // (migração antiga, fake) ou arquivo ausente → sessão nova, sem quebrar o turno
  // (o claude exige UUID no --resume; antes 1 id ruim derrubava a 1ª mensagem).
  const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
  let usedResume = false;
  if (allowResume && sessionId && isUuid(sessionId)) { const hp = historyPath(); if (hp && fs.existsSync(hp)) { args.push('--resume', sessionId); usedResume = true; } else sessionId = null; }
  else if (sessionId && !isUuid(sessionId)) sessionId = null; // descarta id inválido → claude cria um novo
  const proc = spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  // O prompt vai via -p (arg). Fecha o stdin já pra o claude não ficar esperando
  // entrada e cuspir "no stdin data received in 3s" antes de responder.
  try { proc.stdin.end(); } catch {}
  current = proc;
  turnStart = Date.now();
  let buf = '';
  let stderrBuf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let evt; try { evt = JSON.parse(line); } catch { send({ projectId: PROJECT_ID, type: 'raw', text: line, timestamp: Date.now() }); continue; }
      try { handleEvent(evt); } catch (e) { console.error('[runner] handleEvent', e && e.message); }
    }
  });
  // stderr é BUFFERIZADO (não cuspido como erro a cada linha): claude manda
  // erro real no evento `result` do stdout; o stderr aqui é quase só o launcher.
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  proc.on('close', (code) => {
    current = null; turnStart = 0;
    // Sessão migrada incompatível com este claude (outra versão, jsonl estranho)
    // → o --resume falha ("No conversation found"). Em vez de quebrar o turno,
    // recomeça SEM resume (sessão nova; o histórico antigo segue no loadHistory).
    if (code !== 0 && usedResume && /No conversation found|--resume|valid session/i.test(stderrBuf)) {
      sessionId = null;
      console.log('[runner] --resume falhou, recomeçando sem resume');
      return runClaude(message, false);
    }
    const err = stderrBuf.trim();
    if (code !== 0 && err) send({ projectId: PROJECT_ID, type: 'error', text: err.slice(0, 600), timestamp: Date.now() });
    send({ projectId: PROJECT_ID, type: 'done', exitCode: code, timestamp: Date.now() });
  });
  proc.on('error', (err) => { current = null; turnStart = 0; send({ projectId: PROJECT_ID, type: 'error', text: 'Erro ao spawnar claude: ' + err.message, timestamp: Date.now() }); });
}

// ─── Auto-suspend por inatividade (economia de CPU) ──────────────────────────
// Sem "movimentação" (mensagem/abertura) por 5 min → o runner pede pro backend
// pausar o sandbox (snapshot, scale-to-zero). Próxima msg faz resume.
let lastActivity = Date.now();
function touch() { lastActivity = Date.now(); }
const IDLE_MS = 5 * 60 * 1000;
const MAX_TURN_MS = 20 * 60 * 1000;   // teto por turno: turno pendurado > 20min → mata (anti-hang)
const HARD_IDLE_MS = 30 * 60 * 1000;  // ocioso extremo + pause falhando → auto-kill (fail-closed)
let turnStart = 0;                    // quando o turno atual começou (0 = sem turno)
let _pauseFails = 0;                  // falhas seguidas de auto-suspend
let _suspending = false;
function backend(action) {
  if (!process.env.REFRESH_URL || !process.env.LICENSE_KEY) return Promise.resolve();
  return fetch(`${process.env.REFRESH_URL}?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_key: process.env.LICENSE_KEY, project_id: PROJECT_ID }),
  });
}
// Tick (45s): (1) HEARTBEAT "estou vivo" → status REAL no banco (verde só com
// heartbeat fresco); (2) auto-suspend após 5min sem movimento. Para de bater ao
// suspender — sem heartbeat, o status vira cinza sozinho (status fiel).
setInterval(async () => {
  // (0) Teto por turno: um turno pendurado (claude travado) renovaria a atividade
  // pra sempre e o container nunca suspenderia. Passou de MAX_TURN_MS → mata o
  // processo (SIGTERM, SIGKILL de garantia) e libera o slot. NÃO conta como ativo.
  if (current && turnStart && (Date.now() - turnStart) > MAX_TURN_MS) {
    console.error('[runner] turno excedeu', MAX_TURN_MS / 60000, 'min → interrompendo');
    const p = current;
    try { p.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { p && !p.killed && p.kill('SIGKILL'); } catch {} }, 5000);
    send({ projectId: PROJECT_ID, type: 'error', text: 'Turno excedeu o tempo máximo e foi interrompido.', timestamp: Date.now() });
  }
  if (_suspending) return;
  if (current) touch();                              // turno rodando (dentro do teto) = ativo
  backend('cloud_heartbeat').catch(() => {});        // mantém verde enquanto vivo
  if (current) return;
  if (Date.now() - lastActivity < IDLE_MS) return;
  _suspending = true;
  try { await backend('cloud_pause'); _pauseFails = 0; console.log('[runner] auto-suspend por inatividade (5min)'); }
  catch (e) {
    _suspending = false; _pauseFails++;
    console.error('[runner] auto-suspend falhou', e && e.message);
    // Fail-closed: ocioso muito além do limite E o pause falhando seguidamente
    // (backend/rede fora) → o runner se mata. Como ele é o processo principal do
    // container, o container morre junto — nunca vira órfão consumindo recurso.
    if (_pauseFails >= 3 && (Date.now() - lastActivity) > HARD_IDLE_MS) {
      console.error('[runner] ocioso + pause-falho → auto-kill (fail-closed)');
      try { link && link.close(); } catch {}
      process.exit(0);
    }
  }
}, 45000);
backend('cloud_heartbeat').catch(() => {});           // primeiro heartbeat já no boot

// ─── RPC vindo dos clients (mesmo protocolo do remote-host) ──────────────────
async function handleRpc(f, reply, fail) {
  const { channel, payload, from } = f;
  if (from) subscribers.add(from);
  if (channel === 'claude.send' || channel === 'claude.loadHistory' || channel === 'claude.stop') touch();
  try {
    switch (channel) {
      case 'projects.list': return reply([project()]);
      case 'projects.get': return reply(project());
      case 'claude.loadHistory': return reply(readHistory()); // lê o .jsonl da sessão (preserva a conversa)
      case 'claude.send': touch(); runClaude(String((payload && payload.message) || '')); return reply({ ok: true });
      case 'claude.stop': if (current) { try { current.kill('SIGTERM'); } catch {} } return reply(true);
      case 'projects.patch': return reply(project());
      case 'ping': return reply({ ok: true, t: Date.now() });
      default: return fail('canal-desconhecido: ' + channel);
    }
  } catch (e) { fail(e && e.message ? e.message : String(e)); }
}

// Renova o relay_token (expira ~10min) chamando o backend, se configurado.
async function refreshToken() {
  if (!process.env.REFRESH_URL || !process.env.LICENSE_KEY) return null;
  try {
    const res = await fetch(`${process.env.REFRESH_URL}?action=relay_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: process.env.LICENSE_KEY, role: 'host', device_id: DEVICE_ID }),
    });
    const j = await res.json();
    return (j && j.ok && j.token) ? j.token : null;
  } catch { return null; }
}

// ─── Config via env (provedor LOCAL/Docker: o runner é auto-suficiente — clona
// o repo, materializa skills/MCP a partir dos envs, sem ninguém escrever de fora) ─
function applyEnvConfig() {
  const cp = require('child_process');
  // WORKDIR SEMPRE existe — o claude é spawnado com cwd=WORKDIR; se a pasta não
  // existir, o spawn falha com ENOENT (mesmo com o binário no PATH). Sem repo
  // nem MCP, ninguém criava a pasta → 1º claude.send quebrava. Cria sempre.
  try { fs.mkdirSync(WORKDIR, { recursive: true }); } catch {}
  if (process.env.REPO_URL) {
    try {
      const empty = !fs.existsSync(WORKDIR) || fs.readdirSync(WORKDIR).length === 0;
      if (empty) { fs.mkdirSync(WORKDIR, { recursive: true }); cp.execSync(`git clone --depth 1 ${JSON.stringify(process.env.REPO_URL)} ${JSON.stringify(WORKDIR)}`, { stdio: 'ignore', timeout: 300000 }); }
    } catch (e) { console.error('[runner] clone', e && e.message); }
  }
  if (process.env.SKILLS_JSON) {
    try {
      const home = process.env.HOME || os.homedir();
      for (const sk of (JSON.parse(process.env.SKILLS_JSON) || [])) {
        const slug = String(sk.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
        if (!slug) continue;
        const dir = `${home}/.claude/skills/${slug}`; fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}/SKILL.md`, `---\nname: ${sk.name}\ndescription: ${String(sk.description || '').replace(/\r?\n/g, ' ')}\n---\n\n${sk.body || ''}\n`);
      }
    } catch (e) { console.error('[runner] skills', e && e.message); }
  }
  // .mcp.json = MCP do usuário + (se for o maestro) o MCP de orquestração cloud.
  try {
    let cfg = { mcpServers: {} };
    if (process.env.MCP_JSON) { try { cfg = JSON.parse(process.env.MCP_JSON) || cfg; } catch {} }
    if (!cfg.mcpServers) cfg.mcpServers = {};
    if (process.env.MAESTRUS_IS_ORCHESTRATOR === '1') {
      cfg.mcpServers['maestrus-orchestrate'] = {
        command: 'node', args: ['/app/cloud-runner/mcp-orchestrate.js'],
        env: { REFRESH_URL: process.env.REFRESH_URL || '', LICENSE_KEY: process.env.LICENSE_KEY || '', RELAY_URL: process.env.RELAY_URL || '', PROJECT_ID: PROJECT_ID },
      };
    }
    if (Object.keys(cfg.mcpServers).length) { fs.mkdirSync(WORKDIR, { recursive: true }); fs.writeFileSync(`${WORKDIR}/.mcp.json`, JSON.stringify(cfg, null, 2)); }
  } catch (e) { console.error('[runner] mcp', e && e.message); }
  // CLAUDE.md do maestro (doutrina de orquestração async).
  if (process.env.MAESTRUS_IS_ORCHESTRATOR === '1') {
    try {
      fs.mkdirSync(WORKDIR, { recursive: true });
      fs.writeFileSync(`${WORKDIR}/CLAUDE.md`, MAESTRO_CLOUD_MD);
    } catch (e) { console.error('[runner] maestro md', e && e.message); }
  }
}

const MAESTRO_CLOUD_MD = `# Maestrus — o maestro (na nuvem)

Você é o **maestro**: conduz os OUTROS projetos cloud do usuário. Você não edita
código diretamente — você DELEGA pra cada projeto (que tem o contexto dele).

## Ferramentas (MCP maestrus-orchestrate)
- \`claui_list_projects\` — lista os projetos cloud do usuário. Use antes de despachar.
- \`claui_dispatch(project_id, prompt)\` — **ASSÍNCRONO por padrão**: liga o projeto
  (se desligado), manda o prompt e volta NA HORA. A resposta aparece no chat do
  projeto, não aqui. Use isso pra delegar e SEGUIR conversando, sem travar.
  Use \`wait:true\` só quando precisa da resposta agora pra encadear.
- \`claui_dispatch_parallel(project_ids[], prompt)\` — vários de uma vez (async).

## Doutrina
- Decomponha o pedido em subtarefas e dispare em PARALELO (async) pros projetos certos.
- Confirme o que disparou ("disparei pra A, B e C") e siga — não fique esperando.
- Só espere (wait:true) quando a saída de um alimenta o próximo (dependência).
- Seja direto e prático.
`;
applyEnvConfig();

link = new RelayLink({
  url: RELAY_URL, token: RELAY_TOKEN, deviceId: DEVICE_ID, role: 'host', WebSocketImpl,
  hostInfo: { name: PROJECT_NAME, os: 'cloud', projects: [project()] },
  onRpcRequest: handleRpc,
  onPresence: (f) => { if (f && f.online === false && f.deviceId) subscribers.delete(f.deviceId); },
  onStatus: (s) => console.log('[runner] relay status:', s),
  refreshTokenFn: refreshToken,
});

if (process.env.REFRESH_URL && process.env.LICENSE_KEY) {
  setInterval(async () => { const t = await refreshToken(); if (t) { link.opts.token = t; } }, 8 * 60 * 1000);
}

link.connect();
console.log(`[runner] Maestrus Cloud Runner ativo — projeto=${PROJECT_ID} workdir=${WORKDIR} device=${DEVICE_ID}`);

// Auto-setup: ao virar cloud, o agente entende o código, instala e sobe o app
// na porta de preview — sozinho, uma vez (o preview fica pronto sem o usuário).
if (process.env.SETUP_PROMPT) {
  setTimeout(() => { try { runClaude(process.env.SETUP_PROMPT); } catch (e) { console.error('[runner] setup', e && e.message); } }, 2000);
}
// Resume da sessão migrada (continua de onde parou na nuvem). Se não vier por
// env, redescobre a sessão mais recente no disco (sobrevive a restart do runner
// → --resume continua a conversa e loadHistory traz o histórico).
if (process.env.RESUME_SESSION_ID && !sessionId) sessionId = process.env.RESUME_SESSION_ID;
if (!sessionId) sessionId = discoverSession();

process.on('SIGTERM', () => { try { if (current) current.kill('SIGTERM'); link && link.close(); } catch {} process.exit(0); });
