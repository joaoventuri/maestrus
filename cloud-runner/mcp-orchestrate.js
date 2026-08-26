'use strict';
// ─── MCP de orquestração do Maestrus NA NUVEM ───────────────────────────────
// Roda DENTRO do sandbox do maestro (quando MAESTRUS_IS_ORCHESTRATOR=1). Dá ao
// Claude as tools pra conduzir os OUTROS projetos cloud do usuário:
//   claui_list_projects  → backend cloud_list (os projetos do usuário)
//   claui_dispatch        → liga o alvo (cloud_resume) e manda o prompt via relay
//   claui_dispatch_parallel
//
// Tudo via relay (peer-to-peer) + backend pra "ligar a máquina". Async por
// padrão (dispara e volta na hora; a resposta cai no chat do projeto-alvo).
// stdio JSON-RPC (protocolo MCP), sem deps externas além do relay/link.

const { RelayLink } = require('../relay/link');
let WebSocketImpl = null;
try { WebSocketImpl = require('ws'); } catch {}
if (!WebSocketImpl && typeof globalThis.WebSocket !== 'undefined') WebSocketImpl = globalThis.WebSocket;

const BACKEND = process.env.REFRESH_URL || process.env.BACKEND_URL || 'https://maestrus.cloud/api.php';
const LICENSE = process.env.LICENSE_KEY || '';
const RELAY_URL = process.env.RELAY_URL || 'wss://maestrus.cloud/relay';
const SELF_PID = process.env.PROJECT_ID || 'maestrus';

function backend(action, body) {
  return fetch(`${BACKEND}?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_key: LICENSE, ...body }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
}

async function listProjects() {
  const r = await backend('cloud_list', {});
  const sessions = (r && r.sessions) || [];
  return sessions
    .filter((s) => s.project_id !== SELF_PID && s.status !== 'deleted')
    .map((s) => ({ project_id: s.project_id, name: s.name || s.project_id, status: s.status, device_id: s.device_id }));
}

// Liga o alvo (resume-or-fresh) e devolve o device_id pra falar via relay.
async function ensureTarget(pid) {
  const r = await backend('cloud_resume', { project_id: pid });
  // cloud_resume devolve device_id; fallback pro padrão cloud-<uid>-<pid> não dá
  // (não sei o uid aqui) → confia no retorno.
  if (r && r.device_id) return r.device_id;
  // fallback: pega da lista
  const list = await listProjects();
  const f = list.find((p) => p.project_id === pid);
  return f ? f.device_id : null;
}

// Abre um link CLIENT efêmero no relay e manda claude.send pro host do alvo.
// async (wait=false): resolve assim que o host aceita (ok). wait=true: coleta o
// stream até 'done' e devolve o texto.
async function dispatchTo(pid, prompt, wait) {
  const deviceId = await ensureTarget(pid);
  if (!deviceId) return { ok: false, error: `não achei/não liguei o projeto ${pid}` };
  const tok = await backend('relay_token', { role: 'client', device_id: `maestro-${SELF_PID}-${pid}`.slice(0, 60) });
  if (!tok || !tok.ok || !tok.token) return { ok: false, error: 'relay_token falhou' };

  return new Promise((resolve) => {
    let settled = false;
    let acc = '';
    const link = new RelayLink({
      url: tok.url || RELAY_URL, token: tok.token, deviceId: `maestro-${SELF_PID}-${pid}`.slice(0, 60),
      role: 'client', WebSocketImpl,
      onEvent: (f) => {
        if (!wait) return;
        const p = (f && f.payload) || {};
        if (p.type === 'assistant-text' && p.text) acc = p.text;
        else if (p.type === 'delta' && p.text) acc += p.text;
        else if (p.type === 'done') { if (!settled) { settled = true; try { link.close(); } catch {} resolve({ ok: true, text: acc || '(sem texto)' }); } }
      },
      onStatus: async (s) => {
        if (s !== 'online' || settled) return;
        try {
          await link.rpc(deviceId, 'claude.send', { projectId: pid, message: prompt }, 15000);
          if (!wait) { settled = true; setTimeout(() => { try { link.close(); } catch {} }, 300); resolve({ ok: true, dispatched: true }); }
        } catch (e) { if (!settled) { settled = true; try { link.close(); } catch {} resolve({ ok: false, error: 'send falhou: ' + (e && e.message || e) }); } }
      },
    });
    link.connect();
    // timeout de segurança
    setTimeout(() => { if (!settled) { settled = true; try { link.close(); } catch {} resolve(wait ? { ok: true, text: acc || '(timeout aguardando resposta)' } : { ok: true, dispatched: true }); } }, wait ? 300000 : 20000);
  });
}

// ─── Tools MCP ───────────────────────────────────────────────────────────────
const TOOLS = [
  { name: 'claui_list_projects', description: 'Lista os projetos cloud do usuário (id, nome, status) — exceto o próprio maestro. Use antes de despachar.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'claui_dispatch', description: 'Delega um prompt a um projeto cloud. ASSÍNCRONO por padrão: liga o projeto (se desligado), manda o prompt e volta NA HORA — a resposta aparece no chat do projeto. Use wait:true só pra esperar a resposta e encadear.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, prompt: { type: 'string' }, wait: { type: 'boolean' } }, required: ['project_id', 'prompt'], additionalProperties: false } },
  { name: 'claui_dispatch_parallel', description: 'Mesmo prompt em vários projetos cloud de uma vez (async por padrão; wait:true espera todas).', inputSchema: { type: 'object', properties: { project_ids: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' }, wait: { type: 'boolean' } }, required: ['project_ids', 'prompt'], additionalProperties: false } },
];

async function callTool(name, args) {
  if (name === 'claui_list_projects') {
    const list = await listProjects();
    return { content: [{ type: 'text', text: JSON.stringify(list, null, 1) }] };
  }
  if (name === 'claui_dispatch') {
    const r = await dispatchTo(args.project_id, args.prompt, args.wait === true);
    if (!r.ok) return { content: [{ type: 'text', text: `(erro) ${r.error}` }], isError: true };
    const text = r.dispatched ? `✓ Disparado para "${args.project_id}" (ligou e rodando em segundo plano; resposta no chat do projeto).` : (r.text || '(sem texto)');
    return { content: [{ type: 'text', text }] };
  }
  if (name === 'claui_dispatch_parallel') {
    const ids = Array.isArray(args.project_ids) ? args.project_ids : [];
    const wait = args.wait === true;
    const results = await Promise.all(ids.map((pid) => dispatchTo(pid, args.prompt, wait).then((r) => ({ pid, r }))));
    const text = results.map(({ pid, r }) => r.r ? '' : (r.ok ? (r.dispatched ? `✓ ${pid} — disparado` : `--- ${pid} ---\n${r.text || ''}`) : `✗ ${pid}: ${r.error}`)).join('\n\n');
    return { content: [{ type: 'text', text: results.map(({ pid, r }) => r.ok ? (r.dispatched ? `✓ ${pid} — disparado (roda em segundo plano)` : `--- ${pid} ---\n${r.text || '(sem texto)'}`) : `✗ ${pid}: ${r.error}`).join('\n\n') }] };
  }
  throw new Error('unknown tool: ' + name);
}

// ─── Loop JSON-RPC (stdio) ───────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
let buf = '';
process.stdin.on('data', async (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    try {
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'maestrus-orchestrate-cloud', version: '1.0.0' } } });
      } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      } else if (msg.method === 'tools/call') {
        const result = await callTool(msg.params.name, msg.params.arguments || {});
        send({ jsonrpc: '2.0', id: msg.id, result });
      } else if (msg.method === 'notifications/initialized' || msg.method === 'ping') {
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      }
    } catch (e) {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message || e) } });
    }
  }
});
console.error('[mcp-orchestrate-cloud] pronto (maestro=' + SELF_PID + ')');
