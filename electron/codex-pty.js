// codex-pty.js — engine "Codex" (OpenAI). Irmão do claude-pty.js: roda o Codex
// CLI em modo headless (`codex exec --json`) e traduz o stream JSON-lines do
// Codex para os MESMOS eventos que o renderer já entende (assistant-text,
// tool-use, tool-result, thinking, usage, result, done). Assim o chat, o
// histórico e o fan-out remoto funcionam sem tocar na UI.
//
// Duas engines usam este módulo (espelhando claude/cloud):
//   - 'codex'      → assinatura ChatGPT via `codex login` (~/.codex/auth.json)
//   - 'codex-api'  → BYOK: chave OpenAI (CODEX_API_KEY) — reusa o cofre openai-key
//
// Docs do formato: `codex exec --json` emite JSON-lines com eventos
//   thread.started {thread_id} · turn.started · item.started/completed {item} ·
//   turn.completed {usage} · error {message}
// item.type ∈ agent_message | reasoning | command_execution | file_change |
//            mcp_tool_call | web_search | todo_list
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const projectStore = require('./project-store');
const runtime = require('./runtime'); // pathDirs() pro PATH do processo filho
const claudePty = require('./claude-pty'); // barramento de eventos compartilhado
const openaiKey = require('./openai-key'); // BYOK OpenAI (engine 'codex-api')
const codexAuth = require('./codex-auth'); // resolução do binário + status de login
const { killTree, SPAWN_OPTS } = require('./kill-tree'); // mata o turno inteiro (sub-agents junto)

const emit = claudePty.emit; // MESMOS canais (janela + listeners do remote-host)

const procs = new Map();   // projectId → ChildProcess
const _cancelled = new Set(); // turnos que o usuário mandou parar (ver claude-pty)
const _turnText = new Map(); // projectId → texto acumulado do turno (memória futura)

// ─── Resolução da invocação do Codex (compartilhada com codex-auth.js) ──────
// codex-auth.getInvocation() já resolve embutido→instalado→sistema via node+js
// (determinístico, cross-platform — ver comentário lá). Aqui só reusamos.
async function resolveCodex() { return codexAuth.getInvocation(); }
function resetCodexBin() { try { codexAuth.resetBin(); } catch {} }

// Cache curto do status de login — evita spawnar `codex login status` a cada
// mensagem (custa ~200ms-1s), mas expira rápido pra não ficar bloqueando o
// usuário logo após conectar.
let _authCache = { loggedIn: null, ts: 0 };
async function isCodexLoggedIn() {
  if (_authCache.loggedIn !== null && Date.now() - _authCache.ts < 10000) return _authCache.loggedIn;
  let st = null;
  try { st = await codexAuth.status(); } catch {}
  _authCache = { loggedIn: !!(st && st.loggedIn), ts: Date.now() };
  return _authCache.loggedIn;
}
function resetAuthCache() { _authCache = { loggedIn: null, ts: 0 }; }

// ─── Ambiente do processo filho ─────────────────────────────────────────────
function buildEnv(project) {
  const env = { ...process.env };
  // Runtimes embutidos (node/git/codex) primeiro no PATH.
  try {
    const dirs = runtime.pathDirs();
    if (dirs && dirs.length) env.PATH = dirs.join(path.delimiter) + path.delimiter + (env.PATH || '');
  } catch {}
  // Engine 'codex-api' → injeta a chave OpenAI como CODEX_API_KEY (só vale no
  // `codex exec`). Engine 'codex' (assinatura) usa ~/.codex/auth.json do login.
  if (project.engine === 'codex-api') {
    const k = openaiKey.getCachedKey && openaiKey.getCachedKey();
    if (k) { env.CODEX_API_KEY = k; env.OPENAI_API_KEY = k; }
  }
  return env;
}

function effectiveModel(project) {
  const m = project.model;
  if (!m || m === 'codex-default' || m === 'default') return null; // deixa o Codex escolher
  return m;
}

// ─── Envio de um turno ──────────────────────────────────────────────────────
async function send(project, message) {
  if (procs.has(project.id)) {
    const old = procs.get(project.id);
    try { old.kill('SIGKILL'); } catch {}
    procs.delete(project.id);
  }
  if (!project.codeDir || !fs.existsSync(project.codeDir)) {
    throw new Error(`codeDir não existe ou não foi configurado: ${project.codeDir}`);
  }
  // Aquece a chave OpenAI (cache pode estar frio logo após o login em outro device).
  if (project.engine === 'codex-api' && openaiKey.getCachedKey && !openaiKey.getCachedKey()) {
    try { await openaiKey.getKey(); } catch {}
  }

  // ── Pré-checagem de auth (evita o bug do CLI: sem credencial, `codex exec`
  //    NÃO falha rápido — entra num loop de reconexão contra a API ("Reconnecting
  //    ... N/5", 401 Unauthorized) que trava o turno por minutos. Corta ANTES
  //    de spawnar, com uma mensagem clara de como conectar. ────────────────────
  if (project.engine === 'codex-api') {
    const k = openaiKey.getCachedKey && openaiKey.getCachedKey();
    if (!k) {
      emit({ projectId: project.id, type: 'error', text: 'Chave OpenAI ausente. Configure em Ajustes → Codex API.', timestamp: Date.now() });
      emit({ projectId: project.id, type: 'done', exitCode: -1, timestamp: Date.now() });
      return { ok: false };
    }
  } else if (project.engine === 'codex') {
    const logged = await isCodexLoggedIn();
    if (!logged) {
      emit({ projectId: project.id, type: 'error', text: 'Codex não autenticado. Conecte em Ajustes → Codex CLI (ou envie de novo pra abrir a conexão).', timestamp: Date.now() });
      emit({ projectId: project.id, type: 'done', exitCode: -1, timestamp: Date.now() });
      return { ok: false };
    }
  }

  const { cmd: bin, args: prefixArgs } = await resolveCodex();
  const useShell = prefixArgs.length === 0 && /\.(cmd|bat|ps1)$/i.test(bin);

  // codex exec [resume <id>] --json --sandbox workspace-write --skip-git-repo-check
  //            --cd <dir> [--model <m>] "<prompt>"
  const cliArgs = ['exec'];
  if (project.codexThreadId) cliArgs.push('resume', project.codexThreadId);
  cliArgs.push('--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', project.codeDir);
  { const em = effectiveModel(project); if (em) cliArgs.push('--model', em); }
  // Modo voz: o Codex CLI não tem --append-system-prompt, então a diretriz vai
  // como prefixo do prompt (o balão na UI segue mostrando só a fala do usuário).
  // O estilo global vale aqui também — o Codex não tem --append-system-prompt,
  // então vai como preâmbulo entre colchetes na própria mensagem.
  const styleTxt = (() => { try { return require('./persona').styleDirective().trim(); } catch { return ''; } })();
  const preamble = [styleTxt, project.voiceMode ? claudePty.VOICE_DIRECTIVE.trim() + claudePty.MAESTRUS_PERSONA.trim() : '']
    .filter(Boolean).join(' ');
  cliArgs.push(preamble ? `[${preamble}]\n\n${message}` : message);
  const args = [...prefixArgs, ...cliArgs];

  console.log(`[maestrus][codex] spawn ${bin} ${args.slice(0, 8).join(' ')} …`);
  emit({ projectId: project.id, type: 'user', text: message, timestamp: Date.now() });
  _turnText.set(project.id, '');

  _cancelled.delete(project.id); // turno novo começa "não cancelado"

  const proc = spawn(bin, args, {
    cwd: project.codeDir,
    shell: useShell,
    env: buildEnv(project),
    stdio: ['pipe', 'pipe', 'pipe'],
    ...SPAWN_OPTS, // process group próprio: dá pra matar os sub-agents junto
  });
  try { proc.stdin.end(); } catch {}
  procs.set(project.id, proc);

  // Watchdog: cobre qualquer travamento imprevisto (ex.: um retry loop que o
  // filtro de stderr abaixo não reconheça) — mata o turno em vez de deixar o
  // usuário esperando pra sempre.
  const watchdog = setTimeout(() => {
    if (procs.get(project.id) === proc) { try { proc.kill('SIGKILL'); } catch {} }
  }, 6 * 60 * 1000);

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    if (_cancelled.has(project.id)) return; // parado pelo usuário: não fala mais
    try { handleEvent(project, JSON.parse(line)); }
    catch { emit({ projectId: project.id, type: 'raw', text: line, timestamp: Date.now() }); }
  });

  let stderrBuffer = '';
  let killedForAuth = false;
  proc.stderr.on('data', (d) => {
    const chunk = d.toString();
    stderrBuffer += chunk;
    // O Codex manda o PROGRESSO (não-JSON) por stderr — não é erro. Só emite se
    // parecer erro de verdade.
    const t = chunk.trim();
    if (t && /error|panic|failed|unauthorized|invalid|not found|missing/i.test(t)) {
      console.warn(`[maestrus][codex stderr] ${t}`);
    }
    // Bug conhecido do CLI: sem credencial válida ele fica RETENTANDO contra a
    // API pra sempre ("Reconnecting... N/5" + 401 Unauthorized) em vez de
    // desistir. Não adianta esperar — mata assim que detecta.
    if (!killedForAuth && /401\s+Unauthorized/i.test(chunk)) {
      killedForAuth = true;
      resetAuthCache(); // a credencial que achávamos válida não é mais
      try { proc.kill('SIGKILL'); } catch {}
    }
  });

  proc.on('close', (code) => {
    clearTimeout(watchdog);
    if (procs.get(project.id) === proc) procs.delete(project.id);
    const cancelled = _cancelled.delete(project.id);
    console.log(`[maestrus][codex] close exit=${code} cancelled=${cancelled}`);
    if (cancelled) {
      // Parada pedida pelo usuário: código != 0 aqui é o sinal, não erro. Sem
      // esse atalho o stderr de progresso do Codex viraria um balão de erro.
      emit({ projectId: project.id, type: 'done', exitCode: code, cancelled: true, timestamp: Date.now() });
      _turnText.delete(project.id);
      return;
    }
    if (code !== 0) {
      // Mensagem de erro amigável — a causa comum é falta de auth/chave.
      let hint = stderrBuffer.trim().split('\n').filter(Boolean).slice(-3).join('\n');
      if (killedForAuth || /unauthor|401|api key|login|auth/i.test(stderrBuffer)) {
        hint = project.engine === 'codex-api'
          ? 'Chave OpenAI ausente ou inválida. Configure em Ajustes → Codex API.'
          : 'Codex não autenticado (ou a sessão expirou). Reconecte em Ajustes → Codex CLI.';
      }
      emit({ projectId: project.id, type: 'error', text: hint || `codex saiu com código ${code}`, timestamp: Date.now() });
    }
    emit({ projectId: project.id, type: 'done', exitCode: code, timestamp: Date.now() });
    _turnText.delete(project.id);
  });
  proc.on('error', (err) => {
    clearTimeout(watchdog);
    procs.delete(project.id);
    emit({ projectId: project.id, type: 'error', text: `Erro ao spawnar codex: ${err.message}`, timestamp: Date.now() });
    emit({ projectId: project.id, type: 'done', exitCode: -1, timestamp: Date.now() });
  });

  return { ok: true };
}

// ─── Tradução Codex JSON-lines → eventos Maestrus ───────────────────────────
function toolNameForItem(item) {
  switch (item.type) {
    case 'command_execution': return 'Bash';
    case 'file_change': case 'file_changes': return 'Edit';
    case 'mcp_tool_call': case 'mcp_tool_calls': return item.tool || item.name || 'MCP';
    case 'web_search': case 'web_searches': return 'WebSearch';
    case 'todo_list': case 'plan_updates': return 'TodoWrite';
    default: return item.type || 'Tool';
  }
}
function toolInputForItem(item) {
  if (item.type === 'command_execution') return { command: item.command };
  if (item.type === 'file_change' || item.type === 'file_changes') return { changes: item.changes || item.files };
  if (item.type === 'web_search' || item.type === 'web_searches') return { query: item.query };
  return item;
}

function handleEvent(project, evt) {
  const t = evt.type;

  // Novo formato (thread/item). ----------------------------------------------
  if (t === 'thread.started' && evt.thread_id) {
    if (project.codexThreadId !== evt.thread_id) {
      project.codexThreadId = evt.thread_id;
      try { projectStore.save(project); } catch {}
    }
    emit({ projectId: project.id, type: 'system', subtype: 'init', sessionId: evt.thread_id });
    return;
  }
  if (t === 'item.started' && evt.item) {
    const it = evt.item;
    if (it.type === 'command_execution' || it.type === 'mcp_tool_call' || it.type === 'web_search') {
      emit({ projectId: project.id, type: 'tool-use', name: toolNameForItem(it), input: toolInputForItem(it), id: it.id, timestamp: Date.now() });
    }
    return;
  }
  if (t === 'item.completed' && evt.item) {
    const it = evt.item;
    if (it.type === 'agent_message') {
      const text = it.text || it.message || '';
      if (text) {
        _turnText.set(project.id, (_turnText.get(project.id) || '') + text);
        emit({ projectId: project.id, type: 'assistant-text', text, timestamp: Date.now() });
      }
    } else if (it.type === 'reasoning') {
      const text = it.text || it.summary || '';
      if (text) emit({ projectId: project.id, type: 'thinking', text, timestamp: Date.now() });
    } else if (it.type === 'command_execution') {
      const out = it.aggregated_output || it.output || '';
      emit({ projectId: project.id, type: 'tool-result', toolUseId: it.id, text: out, isError: (it.exit_code ?? 0) !== 0, timestamp: Date.now() });
    } else if (it.type === 'file_change' || it.type === 'file_changes') {
      // Marca a edição como tool-use (a UI mostra o arquivo mexido).
      emit({ projectId: project.id, type: 'tool-use', name: 'Edit', input: toolInputForItem(it), id: it.id, timestamp: Date.now() });
    } else if (it.type === 'todo_list' || it.type === 'plan_updates') {
      emit({ projectId: project.id, type: 'tool-use', name: 'TodoWrite', input: it, id: it.id, timestamp: Date.now() });
    } else if (it.type === 'mcp_tool_call' || it.type === 'web_search') {
      emit({ projectId: project.id, type: 'tool-result', toolUseId: it.id, text: JSON.stringify(it.result || it.results || {}), isError: false, timestamp: Date.now() });
    }
    return;
  }
  if (t === 'turn.completed' && evt.usage) {
    const u = evt.usage;
    emit({ projectId: project.id, type: 'usage', usage: {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_input_tokens: u.cached_input_tokens || 0,
    }, timestamp: Date.now() });
    return;
  }
  if (t === 'error') {
    emit({ projectId: project.id, type: 'error', text: evt.message || 'Codex error', timestamp: Date.now() });
    return;
  }

  // Formato ANTIGO (msg-based): {id, msg:{type, ...}} — fallback defensivo. ----
  if (evt.msg && evt.msg.type) {
    const m = evt.msg;
    if (m.type === 'session_configured' && m.session_id) {
      project.codexThreadId = m.session_id; try { projectStore.save(project); } catch {}
      emit({ projectId: project.id, type: 'system', subtype: 'init', sessionId: m.session_id });
    } else if (m.type === 'agent_message' && (m.message || m.text)) {
      const text = m.message || m.text;
      _turnText.set(project.id, (_turnText.get(project.id) || '') + text);
      emit({ projectId: project.id, type: 'assistant-text', text, timestamp: Date.now() });
    } else if (m.type === 'agent_reasoning' && (m.text || m.reasoning)) {
      emit({ projectId: project.id, type: 'thinking', text: m.text || m.reasoning, timestamp: Date.now() });
    } else if (m.type === 'exec_command_begin') {
      emit({ projectId: project.id, type: 'tool-use', name: 'Bash', input: { command: (m.command || []).join(' ') }, id: m.call_id, timestamp: Date.now() });
    } else if (m.type === 'exec_command_end') {
      emit({ projectId: project.id, type: 'tool-result', toolUseId: m.call_id, text: m.stdout || m.stderr || '', isError: (m.exit_code ?? 0) !== 0, timestamp: Date.now() });
    } else if (m.type === 'token_count' && m.info) {
      emit({ projectId: project.id, type: 'usage', usage: {
        input_tokens: m.info.input_tokens || 0, output_tokens: m.info.output_tokens || 0,
        cache_read_input_tokens: m.info.cached_input_tokens || 0,
      }, timestamp: Date.now() });
    }
    return;
  }
}

function kill(projectId) {
  const proc = procs.get(projectId);
  if (!proc) return false;
  // Marca antes de matar e deixa o 'close' limpar o mapa — igual ao claude-pty.
  _cancelled.add(projectId);
  try { killTree(proc); } catch (e) { console.warn('[maestrus][codex] kill falhou:', e.message); }
  return true;
}
function isBusy(projectId) { return procs.has(projectId); }
function killAll() {
  for (const [projectId, p] of procs) {
    _cancelled.add(projectId);
    try { killTree(p, 300); } catch {}
  }
  procs.clear();
}

// Histórico persistente: o Codex grava rollouts em ~/.codex/sessions, mas o
// formato ainda não é lido aqui — v1 mostra o transcrito ao vivo do turno. O
// reload do histórico do Codex é um follow-up (equivalente ao loadHistory do Claude).
async function loadHistory(_project) { return []; }

module.exports = { send, kill, killAll, isBusy, loadHistory, resolveCodex, resetCodexBin };
