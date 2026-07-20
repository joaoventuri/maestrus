const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const projectStore = require('./project-store');
const { shellPath, findAll } = require('./requirements');
const runtime = require('./runtime'); // runtimes EMBUTIDOS no instalador
const { AI_PROXY } = require('./config');
const cloud = require('./cloud');
const memory = require('./memory'); // memória RAG local (cross-sessão)
const claudeProfiles = require('./claude-profiles'); // multi-conta do Claude CLI
const anthropicKey = require('./anthropic-key');     // BYOK da engine "Claude API"

function encodeProjectPath(absPath) {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

function canonicalSessionDir(codeDir) {
  if (!codeDir) return null;
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(path.resolve(codeDir)));
}

function resolveSessionDirs(project) {
  const dirs = [];
  const canonical = canonicalSessionDir(project.codeDir);
  if (canonical && fs.existsSync(canonical)) dirs.push(canonical);
  if (project.sessionDir && fs.existsSync(project.sessionDir)) {
    if (!dirs.some((d) => path.resolve(d) === path.resolve(project.sessionDir))) {
      dirs.push(project.sessionDir);
    }
  }
  return dirs;
}

function findSessionFile(project) {
  const dirs = resolveSessionDirs(project);
  if (dirs.length === 0) return null;

  if (project.sessionId) {
    for (const dir of dirs) {
      const p = path.join(dir, `${project.sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  }

  let newest = null;
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (stat.size < 100) continue;
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { path: fp, mtime: stat.mtimeMs, sessionId: f.replace(/\.jsonl$/, '') };
      }
    }
  }
  return newest ? newest.path : null;
}

// Maestrus roda o Claude de forma não-interativa: o usuário responde na PRÓXIMA
// mensagem, não no meio do turno. O Maestrus transforma as opções em botões
// clicáveis (a partir do tool_use da AskUserQuestion ou de uma lista no texto).
// Então: faça a pergunta, apresente as opções, e PARE — sem assumir resposta.
const ASK_GUIDANCE = [
  'You run inside Maestrus, where the user replies in the NEXT message (not mid-turn).',
  'When you need the user to choose between options, present them with the AskUserQuestion tool (or a numbered list 1., 2., 3.), then STOP your turn and wait.',
  'CRITICAL: in Maestrus the AskUserQuestion tool always returns an error such as "Answer questions?". This is EXPECTED and simply means Maestrus has shown the options to the user as clickable buttons. Do NOT interpret that error as the user closing, cancelling or declining; do NOT apologize, do NOT pick an answer yourself, and do NOT re-ask.',
  'After presenting the options, end your turn quietly (a short line like "Escolha uma opção acima 👇" is fine). The user will click a button or type, and you continue then.',
  // ANTI-AMNESIA — diagnóstico real de uma sessão que perdeu o contexto:
  // o modelo ignorou um /compact summary de 3779 chars QUE ESTAVA NO PROMPT,
  // foi correr `Glob` + `cat MEMORY.md` num path inventado, deu vazio, e
  // concluiu "essa é uma nova sessão". Esta regra existe pra impedir que
  // isso aconteça de novo.
  'CRITICAL CONTEXT RULE: this is a CONTINUED conversation. The history above (including any `[isCompactSummary]` / "session continued from a previous conversation" block) is the CANONICAL record of what happened. Do NOT use exploratory tools (Glob, find, ls, git log, cat MEMORY.md, etc.) to "verify" whether you have prior context — if there is history, you HAVE context. The workspace can be a partially synced mirror (Maestrus Cloud syncs files file-by-file; git pack files do NOT sync, so `git log` may show only 1 commit even on a long-history repo). NEVER conclude "fresh project", "new session", "no memory", or "no prior context" because tools returned empty/short results. If the filesystem appears to contradict the conversation history, ASK the user before assuming a reset.',
  // CAPACIDADES — você é o JARVIS do usuário. Falha real: pediram "acesse meu
  // WhatsApp" e o modelo respondeu "não tenho integração de WhatsApp" em vez de
  // abrir web.whatsapp.com no navegador embutido. Esta regra mata isso.
  'CAPABILITIES — YOU ARE AN ALL-CAPABLE ASSISTANT. You have a REAL embedded web browser and FULL control of this computer. NEVER say you "lack access", "have no integration", or "can\'t" for anything that has a website or runs on this machine. HOW TO OPEN THINGS (critical): to open ANY program, site, file or play music, use computer_open({target}) — it LAUNCHES the process directly. e.g. "abre o Mobirise" → computer_open({target:"Mobirise"}); "abre o YouTube" → computer_open({target:"https://youtube.com"}); "toca tal playlist no Spotify" → computer_open({target:"spotify:playlist:ID"}). DO NOT simulate keyboard (Win key, Win+R, Start menu) to open apps — those keystrokes go to the Maestrus window itself and fail. computer_type and computer_key only affect the window that currently has focus, so they are for interacting INSIDE an app AFTER it is open and focused. TWO cases: (a) app NOT open yet → computer_open to launch it; (b) app ALREADY open (the user says "the window I have open", "my Notepad", etc.) → DO NOT computer_open (new empty instance) — use computer_list_windows then computer_focus({target}) to bring that exact window to front. ON WINDOWS AND MACOS, PREFER UI-AUTOMATION over blind coordinate clicks (much more reliable; Windows uses .NET UIAutomation, macOS uses the Accessibility API): computer_uia_tree({window}) lists the real UI elements BY NAME (buttons, fields, menus); then computer_click_element({window, name}) clicks an element by its name, computer_set_value({window, name, text}) fills a field by name, and computer_get_text({window}) READS the window content (e.g. "read what is written in my Notepad"). On macOS this needs the Accessibility permission — if a call returns a "Permissão de Acessibilidade" error, tell the user to enable Maestrus under System Settings → Privacy & Security → Accessibility, then retry. Use computer_screenshot + computer_click(x,y) only as a last resort when an element has no name in the UIA tree. Always focus the target window before acting so input does not land in the Maestrus window. For web tasks prefer the embedded browser: browser_navigate / browser_read / browser_snapshot / browser_click / browser_type — "acessa meu WhatsApp" → browser_navigate("https://web.whatsapp.com"), screenshot for the QR if needed, then act. When the user asks to open/access/read/watch/send/reply, DO IT right away with these tools — never ask for an API you don\'t need. Act first, narrate briefly.',
].join(' ');

// Auto-confia o codeDir em ~/.claude.json para suprimir o aviso
// "Ignoring permissions.allow entries: workspace not trusted". O Claude CLI
// exige o accept interativo, mas no Maestrus o usuário já aceitou ao criar o projeto.
function ensureTrusted(codeDir) {
  if (!codeDir) return;
  // Respeita o perfil de conta ativo: o CLI lê o .claude.json do CLAUDE_CONFIG_DIR.
  let claudeJson;
  try { claudeJson = claudeProfiles.claudeJsonPath(); }
  catch { claudeJson = path.join(os.homedir(), '.claude.json'); }
  try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(claudeJson, 'utf8')); } catch {}
    if (!data.projects) data.projects = {};
    const abs = path.resolve(codeDir);
    if (!data.projects[abs] || !data.projects[abs].hasTrustDialogAccepted) {
      if (!data.projects[abs]) data.projects[abs] = {};
      data.projects[abs].hasTrustDialogAccepted = true;
      fs.writeFileSync(claudeJson, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
  } catch {}
}

// Identidade da máquina atual (pra detectar migração entre dispositivos).
function currentHostId() { return `${process.platform}:${os.hostname()}`; }
function osLabel(fp) {
  const p = String(fp || '').split(':')[0];
  return p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : (p || 'another OS');
}
// Aviso de MIGRAÇÃO: a sessão sincroniza entre máquinas, mas o histórico carrega
// suposições do ambiente antigo (servidor em localhost:PORT, paths, OS). Quando a
// sessão é retomada em outra máquina/OS, avisamos a IA pra não assumir estado local
// anterior (servidores/portas/processos/paths) — re-verificar neste dispositivo.
function migrationNote(project, curHost) {
  const prev = project.lastRunHost;
  if (!prev || prev === curHost) return '';
  const prevName = prev.split(':').slice(1).join(':') || 'another machine';
  return ' [MAESTRUS ENVIRONMENT CHANGE] This conversation previously ran on ' + osLabel(prev) + ' (' + prevName +
    ') and is NOW running on ' + osLabel(curHost) + ' (' + os.hostname() + '). The working directory IS a freshly synced mirror (Maestrus Cloud) of the project from the previous machine — file CONTENTS are the same, but absolute paths differ. IMPORTANT about git in synced mirrors: the .git/objects/pack/ files do NOT sync (cloud syncs file-by-file, pack files are skipped), so `git log` here may show only the most recent commit OR even just 1 commit ("Initial") instead of the real history. This does NOT mean the project is empty/new — the working tree IS complete, only the git history walking is broken. DO NOT use `git log` count to conclude "fresh project" or "lost context". NO local processes carried over (dev servers, watchers, builds). To re-orient: (1) `git status` shows the working tree honestly; (2) `netstat`/`lsof -i` to check ports; (3) treat OS-specific commands and absolute paths as needing re-verification. The user did NOT start a new conversation — keep working on the same task.';
}

const procs = new Map(); // projectId → ChildProcess
const askToolIds = new Set(); // ids de tool_use AskUserQuestion (pra suprimir o resultado)
const _turnText = new Map(); // projectId → texto acumulado do assistant (pra memória)
const _turnUser = new Map(); // projectId → mensagem do usuário no turno (pra memória)
const __retryingStale = new Set(); // projectId → tentando recover de sessionId stale (evita loop)
// Bloco de memória RAG injetado no system prompt. ESTÁVEL por sessão pra não
// quebrar o prompt cache do Claude: computa uma vez (quando há memória relevante)
// e trava; recomputa só quando limpo (após /compact). String vazia = sem append
// (idêntico ao comportamento antigo → cache hit).
const _memBlock = new Map(); // projectId → string (bloco travado)
function clearMemBlock(projectId) { _memBlock.delete(projectId); }
let mainWindow = null;
let orchestrateInfo = null; // { port, token, url } — setado pelo main quando o HTTP server sobe

function setMainWindow(win) {
  mainWindow = win;
}

function setOrchestrateInfo(info) {
  orchestrateInfo = info || null;
}

let postTurnHook = null;
function setPostTurnHook(fn) {
  postTurnHook = typeof fn === 'function' ? fn : null;
}

// Hook chamado quando um lock é ADQUIRIDO ou LIBERADO. O main usa pra pushar
// o manifesto imediatamente, assim a outra máquina vê o lock antes de bater
// no próximo fastTick (em vez de esperar até 15s).
let lockChangeHook = null;
function setLockChangeHook(fn) {
  lockChangeHook = typeof fn === 'function' ? fn : null;
}

const LOCK_TTL_MS = 5 * 60 * 1000;
function isLockActive(lock) {
  if (!lock || !lock.at) return false;
  return (Date.now() - lock.at) < LOCK_TTL_MS;
}
function acquireLock(project, curHost) {
  project.lock = { hostId: curHost, hostName: os.hostname() || 'Host', at: Date.now() };
  try { projectStore.save(project); } catch {}
  if (lockChangeHook) { try { Promise.resolve(lockChangeHook(project)).catch(() => {}); } catch {} }
}
function releaseLock(project) {
  project.lock = null;
  try { projectStore.save(project); } catch {}
  if (lockChangeHook) { try { Promise.resolve(lockChangeHook(project)).catch(() => {}); } catch {} }
}

function isMaestrus(project) {
  return project && project.id === 'maestrus';
}

// Listeners extras do stream de eventos (além da janela). O modo host (remote-
// host.js) assina aqui pra repassar os mesmos eventos aos clients remotos.
const _eventListeners = new Set();
function onEvent(fn) { _eventListeners.add(fn); return () => _eventListeners.delete(fn); }

function emit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude:event', payload);
  }
  for (const fn of _eventListeners) { try { fn(payload); } catch {} }
}

let _cachedBin = null;

// PATH do shell de login, resolvido async pelo requirements.js. Kick off no
// load do módulo; buildEnv() usa o valor cacheado quando estiver pronto. Em
// apps Electron lançados pelo Finder do macOS, process.env.PATH é o mínimo
// (/usr/bin:/bin:...) — sem isso o spawn do claude não acharia node/git/etc.
let _resolvedShellPath = null;
shellPath().then((p) => { _resolvedShellPath = p; }).catch(() => {});

// Busca síncrona do binário do claude em locais comuns no macOS/Linux. Usada
// no findClaudeBin pra evitar tornar a função assíncrona. Cobre brew, npm
// global, ~/.claude/local/bin (installer oficial), nvm, asdf, ~/bin etc.
function findClaudeBinSyncUnix() {
  const home = os.homedir();
  const dirs = [
    ...(((process.env.PATH || '').split(':')).filter(Boolean)),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.claude', 'local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
  ];
  try {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmRoot)) {
      for (const v of fs.readdirSync(nvmRoot)) dirs.push(path.join(nvmRoot, v, 'bin'));
    }
  } catch {}
  try {
    const asdfShim = path.join(home, '.asdf', 'shims');
    if (fs.existsSync(asdfShim)) dirs.push(asdfShim);
  } catch {}
  for (const dir of dirs) {
    const candidate = path.join(dir, 'claude');
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return null;
}

function findClaudeBin() {
  if (_cachedBin) return _cachedBin;

  // 0) Binário EMBUTIDO no instalador do Maestrus — prioridade máxima (o usuário
  //    leigo não instalou nada à parte; o Claude veio junto).
  try {
    const bundled = runtime.claudeBin();
    if (bundled) {
      _cachedBin = bundled;
      console.log(`[maestrus] claude binary (embutido): ${_cachedBin}`);
      return _cachedBin;
    }
  } catch {}

  if (process.platform !== 'win32') {
    const found = findClaudeBinSyncUnix();
    _cachedBin = found || 'claude';
    if (found) console.log(`[maestrus] claude binary: ${_cachedBin}`);
    else console.warn('[maestrus] não achei claude em locais conhecidos, fallback pro PATH');
    return _cachedBin;
  }

  // Procura o claude.exe REAL em vários locais. O wrapper claude.cmd do npm
  // exige um base dir em %APPDATA%\Claude\claude-code que pode não existir
  // quando a instalação primária é a versão UWP da Microsoft Store.
  const candidates = [];
  const home = os.homedir();

  // 0) Installer NATIVO oficial (irm install.ps1) — instala em ~/.local/bin.
  //    É o método que o Maestrus usa pra auto-instalar (não precisa de Node).
  for (const exe of [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude', 'bin', 'claude.exe'),
  ]) {
    try { if (fs.existsSync(exe)) candidates.push(exe); } catch {}
  }

  // 1) Versão UWP Store (mais comum em quem usa Claude Desktop)
  const uwpRoot = path.join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  // 2) Versão npm regular
  const regularRoot = path.join(home, 'AppData', 'Roaming', 'Claude', 'claude-code');

  for (const root of [uwpRoot, regularRoot]) {
    if (!fs.existsSync(root)) continue;
    try {
      const versions = fs.readdirSync(root)
        .filter((v) => /^\d/.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) {
        const exe = path.join(root, v, 'claude.exe');
        if (fs.existsSync(exe)) candidates.push(exe);
      }
    } catch {}
  }

  if (candidates.length > 0) {
    _cachedBin = candidates[0];
    console.log(`[maestrus] claude binary: ${_cachedBin}`);
    return _cachedBin;
  }

  // Último fallback — pelo PATH
  _cachedBin = 'claude.cmd';
  console.warn(`[maestrus] não achei claude.exe direto, fallback pro PATH (${_cachedBin})`);
  return _cachedBin;
}

// Modelo efetivo passado ao `--model`. No engine "cloud" (medido) nunca cai em
// Opus por acidente: se o modelo está em "default"/vazio, usa Sonnet (5x mais
// barato que Opus). Escolha explícita (Opus/Haiku) é respeitada. No Claude CLI
// (plano fixo do usuário) não mexe — "default" deixa o CLI decidir.
function effectiveModel(project) {
  const m = project.model;
  if (project.engine === 'cloud' && (!m || m === 'default')) return 'sonnet';
  return m && m !== 'default' ? m : null;
}

// Maestrus orquestra em modo headless (claude -p): o modo "default" (perguntar)
// FICA PRESO — não há como aprovar prompts ali → trava edições/bash. Por isso o
// Maestrus BYPASSA permissões por natureza: sem modo explícito (ou "default"),
// usa bypassPermissions. Quem quiser cautela escolhe acceptEdits/plan no picker.
function effectivePermissionMode(project) {
  const pm = project.permissionMode;
  return (pm && pm !== 'default') ? pm : 'bypassPermissions';
}

function buildEnv(project) {
  const env = { ...process.env };
  // Perfil de conta ativo (multi-conta): aponta o CLI pro CLAUDE_CONFIG_DIR do
  // perfil. As sessões (projects/) são compartilhadas via link — mesma conversa.
  try { Object.assign(env, claudeProfiles.envVars()); } catch {}
  if (process.platform === 'win32') {
    // Garante que sort.exe / find.exe / etc. do Windows venham antes
    // dos equivalentes GNU do git-bash (que quebram com flags estilo "/r").
    const sys = 'C:\\Windows\\System32';
    const winDir = 'C:\\Windows';
    const wbem = 'C:\\Windows\\System32\\Wbem';
    const prefix = [sys, winDir, wbem].join(';');
    let currentPath = env.PATH || env.Path || '';
    if (!currentPath.toLowerCase().startsWith(sys.toLowerCase())) {
      currentPath = `${prefix};${currentPath}`;
    }
    // Prepend node/git/claude EMBUTIDOS pra que o agente (bash) e o git os achem.
    for (const d of runtime.pathDirs().reverse()) {
      if (!currentPath.toLowerCase().includes(d.toLowerCase())) currentPath = `${d};${currentPath}`;
    }
    env.PATH = currentPath;
  } else {
    // Usa o PATH resolvido do shell de login do usuário (zsh -ilc) — assim
    // o claude spawned acha node/git/brew/etc. mesmo lançado pelo Finder.
    let p = _resolvedShellPath || env.PATH || '';
    for (const d of runtime.pathDirs().reverse()) {
      if (!p.split(':').includes(d)) p = `${d}:${p}`;
    }
    if (p) env.PATH = p;
  }
  // Injeta URL+token do HTTP orquestrador. Agora vale pra TODOS os projetos —
  // o MCP expõe o navegador embutido (browser_*) em qualquer projeto. As tools
  // de orquestração (claui_dispatch) só aparecem quando MAESTRUS_IS_ORCHESTRATOR=1,
  // setado só pro Maestrus.
  if (orchestrateInfo) {
    env.CLAUI_ORCHESTRATE_URL = orchestrateInfo.url;
    env.CLAUI_ORCHESTRATE_TOKEN = orchestrateInfo.token;
    env.MAESTRUS_ORCHESTRATE_URL = orchestrateInfo.url;
    env.MAESTRUS_ORCHESTRATE_TOKEN = orchestrateInfo.token;
    if (isMaestrus(project)) env.MAESTRUS_IS_ORCHESTRATOR = '1';
  }
  // Engine "Claude API" (id interno 'cloud', por compat): usa a API KEY DA
  // ANTHROPIC do próprio usuário (BYOK, cofre cifrado) direto contra
  // api.anthropic.com — sem proxy, sem medição, sem billing do Maestrus.
  // Nesse modo NÃO precisa de `claude auth` (API key em vez de OAuth).
  if (project.engine === 'cloud') {
    const k = anthropicKey.getCachedKey();
    if (k) {
      env.ANTHROPIC_API_KEY = k;
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;            // evita usar a assinatura OAuth
    }
  }
  return env;
}

async function send(project, message) {
  if (procs.has(project.id)) {
    // Mata o processo travado antes de aceitar nova mensagem (evita órfãos)
    const old = procs.get(project.id);
    try { old.kill('SIGKILL'); } catch {}
    procs.delete(project.id);
    console.warn(`[maestrus] mataram proc órfão pra projeto ${project.id}`);
  }

  if (!project.codeDir || !fs.existsSync(project.codeDir)) {
    throw new Error(`codeDir não existe ou não foi configurado: ${project.codeDir}`);
  }

  // Detecção de MIGRAÇÃO de máquina: computa o aviso ANTES de atualizar o host,
  // e persiste o host atual (sincroniza no manifesto → o outro device sabe).
  const curHost = currentHostId();
  // Memória de longo prazo: recupera fatos/preferências/decisões relevantes e
  // injeta no system prompt. Best-effort (timeout 1.5s, nunca trava o turno) e
  // ESTÁVEL por sessão (cache-safe): só computa enquanto não há bloco travado;
  // assim que acha algo relevante, trava — turnos seguintes reusam o MESMO
  // texto → preserva o prompt cache do Claude. /compact limpa via clearMemBlock.
  let memBlock = _memBlock.get(project.id);
  if (memBlock === undefined) {
    let computed = '';
    try {
      computed = await Promise.race([
        memory.recallBlock(message, 4),
        new Promise((res) => setTimeout(() => res(''), 1500)),
      ]);
    } catch {}
    memBlock = computed || '';
    if (memBlock) _memBlock.set(project.id, memBlock); // trava só quando há conteúdo
  }
  const sysAppend = ASK_GUIDANCE + migrationNote(project, curHost) + (memBlock || '');
  // Guarda o que o usuário disse pra, no fim do turno, memorizar o par.
  _turnUser.set(project.id, String(message || ''));
  _turnText.set(project.id, '');
  if (project.lastRunHost !== curHost) {
    project.lastRunHost = curHost;
    try { projectStore.save(project); } catch {}
  }

  // Adquire o lock ANTES do spawn e pusha manifesto na hora. Outras máquinas
  // vão ver o lock e desabilitar o input com banner "Rodando em <nome>".
  acquireLock(project, curHost);

  const args = [
    '-p',
    message,
    '--output-format', 'stream-json',
    '--input-format', 'text',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt', sysAppend,
  ];
  { const em = effectiveModel(project); if (em) args.push('--model', em); }
  args.push('--permission-mode', effectivePermissionMode(project));
  const thinkingBudgets = { none: 0, low: 4000, medium: 16000, high: 64000 };
  const budget = thinkingBudgets[project.thinkingMode ?? 'medium'] ?? 16000;
  // SEMPRE passa — inclusive 0 (none) pra DESLIGAR o thinking de verdade. Antes,
  // omitir o flag deixava o CLI cair no default (thinking ligado).
  args.push('--max-thinking-tokens', String(budget));
  // Carrega o MCP do Maestrus (orquestração + navegador embutido) explicitamente
  // em TODOS os projetos — o .mcp.json fica no codeDir do Maestrus. Isso evita o
  // prompt de aprovação em modo headless e dá browser_* a qualquer projeto.
  try {
    const maestrus = projectStore.get(projectStore.MAESTRUS_ID || 'maestrus');
    const mcpConfig = maestrus && maestrus.codeDir ? path.join(maestrus.codeDir, '.mcp.json') : null;
    if (mcpConfig && fs.existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig);
  } catch {}
  if (project.sessionId) args.push('--resume', project.sessionId);

  ensureTrusted(project.codeDir);

  const bin = findClaudeBin();
  const useShell = bin.endsWith('.cmd');  // .exe direto não precisa de shell
  console.log(`[maestrus] spawn ${bin}`);
  console.log(`[maestrus]   args: ${args.map((a) => /\s/.test(a) ? `"${a.slice(0, 60)}"` : a).join(' ').slice(0, 400)}`);
  console.log(`[maestrus]   cwd: ${project.codeDir}`);
  console.log(`[maestrus]   shell: ${useShell}`);

  emit({ projectId: project.id, type: 'user', text: message, timestamp: Date.now() });

  const proc = spawn(bin, args, {
    cwd: project.codeDir,
    shell: useShell,
    env: buildEnv(project),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Fecha stdin imediatamente — claude -p espera 3s por stdin caso fique aberto.
  try { proc.stdin.end(); } catch (e) { console.warn('[maestrus] stdin.end falhou:', e.message); }

  procs.set(project.id, proc);

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const evt = JSON.parse(line);
      handleEvent(project, evt);
    } catch {
      emit({ projectId: project.id, type: 'raw', text: line, timestamp: Date.now() });
    }
  });

  let stderrBuffer = '';
  proc.stderr.on('data', (d) => {
    const chunk = d.toString();
    stderrBuffer += chunk;
    // Filtra o warning conhecido do stdin que não é fatal
    const filtered = chunk
      .split('\n')
      .filter((l) => l.trim() && !l.includes('no stdin data received') && !l.includes('redirect stdin'))
      .join('\n');
    if (filtered.trim()) {
      console.warn(`[maestrus][claude stderr] ${filtered.trim()}`);
      emit({ projectId: project.id, type: 'error', text: filtered.trim(), timestamp: Date.now() });
    }
  });

  proc.on('close', (code) => {
    procs.delete(project.id);
    console.log(`[maestrus] proc close exit=${code} stderr.length=${stderrBuffer.length}`);

    // Auto-recovery: sessionId stale (Claude CLI limpou o .jsonl da conversa).
    // Detecta pelos erros conhecidos do CLI, limpa o sessionId no projeto e
    // re-spawna o turno SEM --resume. Idempotente — só faz isso uma vez por turno.
    const staleSession = code !== 0 && project.sessionId && !__retryingStale.has(project.id) && (
      /No conversation found with session ID/i.test(stderrBuffer) ||
      /Conversation not found/i.test(stderrBuffer)
    );
    if (staleSession) {
      console.log(`[maestrus] sessionId ${project.sessionId} sumiu — limpando e re-tentando sem --resume`);
      const staleId = project.sessionId;
      project.sessionId = null;
      try { projectStore.save(project); } catch {}
      __retryingStale.add(project.id);
      releaseLock(project);
      emit({ projectId: project.id, type: 'system', subtype: 'session-recovered', text: `Sessão ${staleId.slice(0, 8)} sumiu — iniciando nova conversa.`, timestamp: Date.now() });
      // Não emite 'done' nem 'error' — re-spawna no próximo tick.
      setTimeout(() => {
        __retryingStale.delete(project.id);
        send(project, message).catch(() => {});
      }, 50);
      return;
    }

    if (code !== 0 && stderrBuffer && !stderrBuffer.includes('no stdin data received')) {
      // já foi emitido em tempo real, mas garante mensagem final
      emit({
        projectId: project.id,
        type: 'error',
        text: `claude saiu com código ${code}`,
        timestamp: Date.now(),
      });
    }
    // Libera o lock: o post-turn hook já vai pushar o manifesto. Em código != 0
    // (Claude morreu/errou) também liberamos pra não travar o projeto em outra
    // máquina indefinidamente.
    releaseLock(project);
    emit({ projectId: project.id, type: 'done', exitCode: code, timestamp: Date.now() });
    // Memória de longo prazo: guarda o par (pergunta → resposta) do turno.
    // Pula comandos slash (/team, /ask…) — não são Q&A que valha memorizar.
    if (code === 0) {
      const uMsg = _turnUser.get(project.id);
      const aTxt = _turnText.get(project.id);
      if (uMsg && aTxt && !uMsg.trim().startsWith('/')) {
        try { memory.remember(project.id, uMsg, aTxt).catch(() => {}); } catch {}
      }
    }
    _turnUser.delete(project.id); _turnText.delete(project.id);
    // Pós-turno: deixa o main sincronizar mudanças (ex: push SSH).
    if (code === 0 && postTurnHook) {
      try { Promise.resolve(postTurnHook(project)).catch(() => {}); } catch {}
    }
  });

  proc.on('error', (err) => {
    procs.delete(project.id);
    console.error(`[maestrus] proc error:`, err);
    emit({ projectId: project.id, type: 'error', text: `Erro ao spawnar claude: ${err.message}`, timestamp: Date.now() });
  });

  return { ok: true };
}

function handleEvent(project, evt) {
  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id && project.sessionId !== evt.session_id) {
      project.sessionId = evt.session_id;
      projectStore.save(project);
    }
    emit({ projectId: project.id, type: 'system', subtype: 'init', sessionId: evt.session_id });
    return;
  }

  if (evt.type === 'assistant' && evt.message) {
    if (evt.message.usage) {
      emit({ projectId: project.id, type: 'usage', usage: evt.message.usage, timestamp: Date.now() });
    }
    const blocks = evt.message.content || [];
    // Quando o assistant usa AskUserQuestion, fundimos texto + perguntas num
    // único evento — o renderer cria um único bubble com botões clicáveis.
    // Sem isso, surgiam dois bubbles separados (texto + tool accordion).
    const askBlock = blocks.find((b) => b.type === 'tool_use' && /AskUserQuestion/i.test(b.name || ''));
    if (askBlock && askBlock.id) {
      askToolIds.add(askBlock.id); // suprime o tool_result automático de erro
      const textContent = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (textContent && _turnText.has(project.id)) {
        _turnText.set(project.id, (_turnText.get(project.id) || '') + textContent);
      }
      emit({
        projectId: project.id,
        type: 'ask-user-question',
        text: textContent,
        questions: askBlock.input?.questions || [],
        id: askBlock.id,
        timestamp: Date.now(),
      });
      // Outros tool_use (não AskUserQuestion) desta mensagem continuam normais
      for (const block of blocks) {
        if (block.type === 'tool_use' && !/AskUserQuestion/i.test(block.name || '')) {
          emit({ projectId: project.id, type: 'tool-use', name: block.name, input: block.input, id: block.id, timestamp: Date.now() });
        }
      }
      return;
    }
    for (const block of blocks) {
      if (block.type === 'text') {
        if (_turnText.has(project.id)) _turnText.set(project.id, (_turnText.get(project.id) || '') + block.text);
        emit({ projectId: project.id, type: 'assistant-text', text: block.text, timestamp: Date.now() });
      } else if (block.type === 'tool_use') {
        if (/AskUserQuestion/i.test(block.name || '') && block.id) askToolIds.add(block.id);
        emit({ projectId: project.id, type: 'tool-use', name: block.name, input: block.input, id: block.id, timestamp: Date.now() });
      } else if (block.type === 'thinking') {
        emit({ projectId: project.id, type: 'thinking', text: block.thinking, timestamp: Date.now() });
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message) {
    const blocks = evt.message.content || [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
          : typeof block.content === 'string' ? block.content : '';
        // Suprime o resultado da AskUserQuestion (auto-falha "Answer questions?"
        // ou "not enabled"). A pergunta vem em texto e os botões saem da heurística.
        if (askToolIds.has(block.tool_use_id)) { askToolIds.delete(block.tool_use_id); continue; }
        if (block.is_error && /answer questions|not enabled|no such tool|AskUserQuestion/i.test((text || '').trim())) continue;
        emit({
          projectId: project.id,
          type: 'tool-result',
          toolUseId: block.tool_use_id,
          text,
          isError: !!block.is_error,
          timestamp: Date.now(),
        });
      }
    }
    return;
  }

  if (evt.type === 'stream_event' && evt.event) {
    const ev = evt.event;
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta') {
        emit({ projectId: project.id, type: 'delta', text: ev.delta.text, timestamp: Date.now() });
      }
    }
    return;
  }

  if (evt.type === 'result') {
    emit({ projectId: project.id, type: 'result', evt, timestamp: Date.now() });
    return;
  }
}

function kill(projectId) {
  const proc = procs.get(projectId);
  if (proc) {
    proc.kill();
    procs.delete(projectId);
    return true;
  }
  return false;
}

function isBusy(projectId) {
  return procs.has(projectId);
}

function killAll() {
  for (const proc of procs.values()) {
    try { proc.kill(); } catch {}
  }
  procs.clear();
}

// Lê as últimas N linhas de um arquivo grande sem carregar tudo em memória.
// Lê blocos de 512KB de trás pra frente até ter maxLines OU chegar no início.
// Necessário porque sessões longas do Claude Code viram .jsonl de 20-50MB; ler
// tudo bloqueia o event loop por segundos e o RPC "claude.loadHistory" atrasa
// o carregamento na tela do client remoto.
function readTailLines(filePath, maxLines) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const total = st.size;
    if (total === 0) return [];
    const BLOCK = 512 * 1024;
    let pos = total;
    let leftover = ''; // fragmento da última linha (incompleta) do bloco anterior
    const collected = [];
    while (pos > 0 && collected.length < maxLines) {
      const readLen = Math.min(BLOCK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, pos);
      const chunk = buf.toString('utf8') + leftover;
      const lines = chunk.split(/\r?\n/);
      // A primeira linha do split pode estar incompleta (bloco parte no meio) —
      // guarda pra concatenar com o próximo bloco (que virá antes no arquivo).
      leftover = pos > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (ln && ln.trim()) collected.push(ln);
        if (collected.length >= maxLines) break;
      }
    }
    if (pos === 0 && leftover && leftover.trim()) collected.push(leftover);
    // collected está em ordem reversa (última linha primeiro) — inverte pra ordem cronológica.
    return collected.reverse();
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function loadHistory(project) {
  const jsonlPath = findSessionFile(project);
  if (!jsonlPath) return [];

  // Se achamos um JSONL diferente do sessionId salvo (porque o salvo sumiu/é fork),
  // adota o sessionId desse arquivo pra próxima chamada continuar nele.
  const foundId = path.basename(jsonlPath, '.jsonl');
  if (foundId && foundId !== project.sessionId) {
    project.sessionId = foundId;
    projectStore.save(project);
  }

  // Cauda: 800 linhas cobre com folga o TAIL=400 mensagens do host+client
  // (cada mensagem pode virar 2+ entradas do .jsonl: user + assistant + tool_use…).
  const lines = readTailLines(jsonlPath, 800);
  const messages = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    // Boundary de compactação: o CLI só considera daqui pra frente, mas a UI
    // mantém a LINHA CONTÍNUA — nada de apagar o que veio antes (o histórico
    // segue no .jsonl). Um divisor marca onde o contexto ativo recomeça.
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      messages.push({ role: 'system', compactBoundary: true, text: '── Conversa compactada — o contexto ativo do Claude recomeça aqui (o histórico acima é seu, preservado) ──', timestamp: entry.timestamp });
      continue;
    }
    // Resumo injetado pela compactação → nota de sistema, não bolha de user.
    if (entry.isCompactSummary && entry.message) {
      const c = typeof entry.message.content === 'string' ? entry.message.content : '';
      const clean = c.replace(/^This session is being continued[^\n]*\n+/i, '');
      messages.push({ role: 'system', text: '↻ Resumo do contexto anterior (o que o Claude "lembra" daqui pra frente):\n\n' + clean, timestamp: entry.timestamp });
      continue;
    }
    if (entry.type === 'user' && entry.message) {
      const blocks = entry.message.content;
      if (typeof blocks === 'string') {
        messages.push({ role: 'user', text: blocks, timestamp: entry.timestamp });
      } else if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'text') {
            messages.push({ role: 'user', text: b.text, timestamp: entry.timestamp });
          } else if (b.type === 'tool_result') {
            const text = Array.isArray(b.content)
              ? b.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
              : typeof b.content === 'string' ? b.content : '';
            messages.push({
              role: 'tool-result',
              toolUseId: b.tool_use_id,
              text,
              isError: !!b.is_error,
              timestamp: entry.timestamp,
            });
          }
        }
      }
    } else if (entry.type === 'assistant' && entry.message) {
      const blocks = entry.message.content || [];
      for (const b of blocks) {
        if (b.type === 'text') {
          messages.push({ role: 'assistant', text: b.text, timestamp: entry.timestamp });
        } else if (b.type === 'tool_use') {
          messages.push({
            role: 'tool-use',
            name: b.name,
            input: b.input,
            id: b.id,
            timestamp: entry.timestamp,
          });
        } else if (b.type === 'thinking') {
          // Claude Code grava só a assinatura por privacidade/tamanho — pula
          // os blocos sem texto pra não poluir o chat com bubbles vazias.
          if (!b.thinking || !String(b.thinking).trim()) continue;
          messages.push({ role: 'thinking', text: b.thinking, timestamp: entry.timestamp });
        }
      }
    } else if (entry.type === 'summary' && entry.summary) {
      messages.push({
        role: 'system',
        text: `(compactação) ${entry.summary}`,
        timestamp: entry.timestamp,
      });
    }
  }

  // Ordena por timestamp (entradas sem ts mantêm ordem relativa do arquivo).
  messages.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) || 0 : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) || 0 : 0;
    return ta - tb;
  });

  return messages;
}

// Roda claude -p contra um projeto sem emitir events pro chat principal.
// Retorna Promise com { text, usage, cost, sessionId, durationMs }.
// Usado pelo Maestrus pra orquestrar prompts em outros projetos.
function dispatchOneShot(project, message, { timeoutMs = 300_000, forkSession = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!project.codeDir || !fs.existsSync(project.codeDir)) {
      return reject(new Error(`codeDir não existe: ${project.codeDir}`));
    }

    const args = [
      '-p', message,
      '--output-format', 'stream-json',
      '--input-format', 'text',
      '--verbose',
      '--append-system-prompt', ASK_GUIDANCE,
    ];
    { const em = effectiveModel(project); if (em) args.push('--model', em); }
    args.push('--permission-mode', effectivePermissionMode(project));
    if (project.sessionId) args.push('--resume', project.sessionId);
    // forkSession: lê o contexto atual mas grava numa sessão NOVA, deixando a
    // original intacta (usado pelo /compact pra gerar o resumo sem poluir).
    if (forkSession && project.sessionId) args.push('--fork-session');

    const bin = findClaudeBin();
    const useShell = bin.endsWith('.cmd');
    console.log(`[maestrus dispatch] → ${project.name} (${project.id}) prompt="${message.slice(0, 60)}…"`);

    const proc = spawn(bin, args, {
      cwd: project.codeDir,
      shell: useShell,
      env: buildEnv(project),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try { proc.stdin.end(); } catch {}

    let assistantText = '';
    let lastUsage = null;
    let cost = null;
    let newSessionId = null;
    let stderrBuf = '';
    let resolved = false;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let evt;
      try { evt = JSON.parse(line); } catch { return; }
      if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
        newSessionId = evt.session_id;
      }
      if (evt.type === 'assistant' && evt.message) {
        for (const b of evt.message.content || []) {
          if (b.type === 'text') assistantText += b.text;
        }
        if (evt.message.usage) lastUsage = evt.message.usage;
      }
      if (evt.type === 'result') {
        if (typeof evt.total_cost_usd === 'number') cost = evt.total_cost_usd;
        if (evt.usage) lastUsage = evt.usage;
      }
    });

    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { proc.kill(); } catch {}
      reject(new Error(`Timeout após ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      if (resolved) return;
      // Auto-recovery: sessionId stale no dispatch (orquestrador). Limpa e re-roda
      // SEM --resume. Idempotente — só uma retry por chamada.
      const staleSession = code !== 0 && project.sessionId && !__retryingStale.has(project.id + ':dispatch') && (
        /No conversation found with session ID/i.test(stderrBuf) ||
        /Conversation not found/i.test(stderrBuf)
      );
      if (staleSession) {
        resolved = true;
        clearTimeout(timer);
        console.log(`[maestrus][dispatch] sessionId ${project.sessionId} sumiu — re-tentando sem --resume`);
        project.sessionId = null;
        try { projectStore.save(project); } catch {}
        __retryingStale.add(project.id + ':dispatch');
        dispatchOneShot(project, message, { timeoutMs, forkSession })
          .then((r) => { __retryingStale.delete(project.id + ':dispatch'); resolve(r); })
          .catch((e) => { __retryingStale.delete(project.id + ':dispatch'); reject(e); });
        return;
      }
      resolved = true;
      clearTimeout(timer);
      if (code !== 0 && !assistantText) {
        return reject(new Error(`claude saiu com código ${code}: ${stderrBuf.trim().slice(0, 500)}`));
      }
      // Atualiza sessionId no projeto-alvo se mudou — mas NÃO quando é fork
      // (o fork tem id próprio descartável e não deve substituir a sessão real).
      if (!forkSession && newSessionId && newSessionId !== project.sessionId) {
        project.sessionId = newSessionId;
        projectStore.save(project);
      }
      resolve({
        text: assistantText.trim(),
        usage: lastUsage,
        cost,
        sessionId: newSessionId,
      });
    });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Faz backup preventivo da sessão antes de qualquer operação destrutiva.
// Retorna o caminho do .bak, ou null se não houver sessão.
function backupSessionFile(project) {
  const jsonlPath = findSessionFile(project);
  if (!jsonlPath) return null;
  const bakPath = jsonlPath + '.bak';
  try { fs.copyFileSync(jsonlPath, bakPath); return bakPath; } catch { return null; }
}

// Restaura sessão do .bak (usado após compact falho).
function restoreSessionFile(project) {
  const jsonlPath = findSessionFile(project);
  if (!jsonlPath) return false;
  const bakPath = jsonlPath + '.bak';
  if (!fs.existsSync(bakPath)) return false;
  try { fs.copyFileSync(bakPath, jsonlPath); return true; } catch { return false; }
}

// Apaga o arquivo JSONL de uma sessão (usado pra descartar o fork do /compact).
function deleteSessionFile(project, sessionId) {
  if (!sessionId) return false;
  const dirs = resolveSessionDirs(project);
  const canonical = canonicalSessionDir(project.codeDir);
  if (canonical && !dirs.some((d) => path.resolve(d) === path.resolve(canonical))) dirs.push(canonical);
  for (const dir of dirs) {
    const p = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); return true; } catch {}
    }
  }
  return false;
}

// Compactação in-place "igual ao Claude": anexa um marcador system/compact_boundary
// (parentUuid:null → vira raiz do novo leaf chain, então o --resume só replica a
// partir daqui) seguido de uma mensagem user com isCompactSummary contendo o resumo.
// Faz backup .bak antes de tocar no arquivo.
function compactSessionFile(project, summaryText) {
  const jsonlPath = findSessionFile(project);
  if (!jsonlPath) throw new Error('Sessão não encontrada pra compactar.');
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) throw new Error('Sessão vazia — nada pra compactar.');

  // Backup de segurança (sobrescreve o anterior).
  fs.copyFileSync(jsonlPath, jsonlPath + '.bak');

  // Descobre o leaf (último uuid) e metadados de sessão pra herdar.
  let leafUuid = null;
  const meta = {};
  const wanted = ['cwd', 'sessionId', 'version', 'gitBranch', 'slug', 'entrypoint', 'userType'];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (!leafUuid && e.uuid) leafUuid = e.uuid;
    for (const k of wanted) if (meta[k] == null && e[k] != null) meta[k] = e[k];
    if (leafUuid && meta.sessionId) break;
  }

  const now = new Date().toISOString();
  const boundaryUuid = crypto.randomUUID();
  const sessionId = project.sessionId || meta.sessionId;
  const common = {
    userType: meta.userType || 'external',
    entrypoint: meta.entrypoint || 'maestrus',
    cwd: meta.cwd || project.codeDir,
    sessionId,
  };
  if (meta.version) common.version = meta.version;
  if (meta.gitBranch) common.gitBranch = meta.gitBranch;
  if (meta.slug) common.slug = meta.slug;

  const boundary = {
    parentUuid: null,
    logicalParentUuid: leafUuid,
    isSidechain: false,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: now,
    uuid: boundaryUuid,
    level: 'info',
    compactMetadata: { trigger: 'manual', preTokens: 0, postTokens: 0, durationMs: 0 },
    ...common,
  };

  const preamble = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n';
  const summaryEntry = {
    parentUuid: boundaryUuid,
    isSidechain: false,
    promptId: crypto.randomUUID(),
    type: 'user',
    message: { role: 'user', content: preamble + summaryText },
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    uuid: crypto.randomUUID(),
    timestamp: now,
    ...common,
  };

  fs.appendFileSync(jsonlPath, JSON.stringify(boundary) + '\n' + JSON.stringify(summaryEntry) + '\n', 'utf8');
  return { ok: true, file: jsonlPath };
}

// Caminho do .jsonl da sessão de um projeto (pra migrar pra nuvem).
function sessionFilePath(project) {
  if (!project || !project.sessionId || !project.codeDir) return null;
  const dir = canonicalSessionDir(project.codeDir);
  return dir ? path.join(dir, project.sessionId + '.jsonl') : null;
}

module.exports = {
  setMainWindow, setOrchestrateInfo, setPostTurnHook, setLockChangeHook,
  send, kill, killAll, loadHistory,
  dispatchOneShot, deleteSessionFile, compactSessionFile, backupSessionFile, restoreSessionFile, onEvent, findClaudeBin, isBusy,
  currentHostId, isLockActive, LOCK_TTL_MS, clearMemBlock, sessionFilePath,
};
