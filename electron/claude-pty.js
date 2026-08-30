const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const projectStore = require('./project-store');
const { shellPath, findAll } = require('./requirements');
const runtime = require('./runtime'); // runtimes EMBUTIDOS no instalador
const cloud = require('./cloud');
const memory = require('./memory'); // memória RAG local (cross-sessão)
const claudeProfiles = require('./claude-profiles'); // multi-conta do Claude CLI
const anthropicKey = require('./anthropic-key');     // BYOK da engine "Claude API"
const { killTree, SPAWN_OPTS } = require('./kill-tree');
const persona = require('./persona'); // estilo de resposta global (persistente) // mata o turno inteiro (sub-agents junto)

// Turnos que o usuário mandou parar. Matar o processo não é instantâneo: o que
// já estava no buffer do stdout continua sendo lido e viraria evento na tela
// depois do clique em parar. Enquanto o id estiver aqui, o turno é mudo.
const _cancelled = new Set();

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

  // Conversa (fork) sem sessão própria ainda: NÃO adota o .jsonl mais recente
  // do codeDir — seria a sessão da conversa principal do projeto.
  if (project.__noAdopt) return null;

  // A conversa PRINCIPAL também não pode adotar o .jsonl de um FORK. Todas as
  // conversas do projeto gravam no MESMO dir; se a principal está sem sessionId
  // (após /clear, recovery, ou projeto onde só se usou um fork), o "mais recente
  // por mtime" podia ser o arquivo de um fork → o histórico da principal virava
  // o do fork E ficava GRAVADO (loadHistory salva o sessionId). Exclui os
  // sessionIds já reivindicados pelas conversas/forks.
  const claimed = new Set();
  for (const c of (project.conversations || [])) {
    if (c && c.sessionId) claimed.add(String(c.sessionId));
    if (c && c.forkFrom) claimed.add(String(c.forkFrom));
  }

  let newest = null;
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.replace(/\.jsonl$/, '');
      if (claimed.has(sid)) continue; // é a sessão de um fork — não adota
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (stat.size < 100) continue;
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { path: fp, mtime: stat.mtimeMs, sessionId: sid };
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

// ─── Modo VOZ (Jarvis) ───────────────────────────────────────────────────────
// A resposta será LIDA em voz alta por um TTS. Markdown, listas, blocos de
// código e caminhos de arquivo soam péssimos falados — e resposta longa mata a
// sensação de conversa. Isto entra no --append-system-prompt só enquanto o modo
// voz está ligado (project.voiceMode), então NÃO polui o histórico da conversa.
const VOICE_DIRECTIVE = ' VOICE MODE IS ON: your reply will be spoken out loud by a text-to-speech engine, not read on screen.'
  + ' Reply in the SAME language the user spoke.'
  + ' Keep it to 1-3 short spoken sentences (under ~45 words) unless the user explicitly asks you to elaborate.'
  + ' Output must be PLAIN SPOKEN TEXT — literally what a person would say out loud.'
  + ' ABSOLUTELY NO markdown syntax of any kind: no asterisks, no underscores, no backticks, no #, no -, no |, no tables, no bullet or numbered lists, no headings, no code blocks, no links, no file paths, no emoji.'
  + ' If you catch yourself formatting, rewrite it as a sentence: instead of "1. faz X 2. faz Y", say "primeiro faz X, depois Y".'
  + ' Never read code or diffs aloud — say what you changed in one short phrase ("ajustei o parser do stream", not the code).'
  // Números e identificadores travam o TTS: ele soletra e perde o ritmo. Melhor
  // o AGENTE já falar como gente ("uns cinco arquivos") do que a voz tropeçar.
  + ' Avoid raw numbers, IDs, hashes, versions and file paths in speech: round them or describe them ("uns cinco arquivos", "a versão mais recente", "o arquivo do parser") instead of dictating exact values.'
  + ' If an exact value really matters, say it the way a person would, never digit by digit.'
  + ' Do not narrate every tool step; when you finish working, state the OUTCOME in one line.'
  + ' If the answer is genuinely long, speak a one-sentence summary and offer to detail it on screen.'
  + ' Sound like a sharp colleague talking, not like documentation.'
  // Sem esta linha, um template de saída definido no CLAUDE.md/skill do projeto
  // (blocos de status, cabeçalhos com emoji, tabela de resumo no fim do turno)
  // vencia a diretriz — e o usuário ouvia o TTS lendo "check, ENTREGUE, gráfico,
  // QUALIDADE" em voz alta.
  + ' This voice directive OVERRIDES any output template defined in project files'
  + ' (CLAUDE.md, AGENTS.md, skills, commands): while voice mode is on, never emit'
  + ' status blocks, section headers, banners, checklists or end-of-turn summary'
  + ' tables, even if a project file explicitly asks for them. Just talk.';

// Persona do MAESTRUS (só no orquestrador — a "voz" do produto). Ele é o maestro
// que rege os projetos do usuário; não se apresenta como Claude/modelo.
const MAESTRUS_PERSONA = ' You are MAESTRUS speaking in first person: the conductor of this user\'s projects.'
  + ' Personality: calm, sharp, dry wit, zero servility — you never grovel and never pad with filler like "claro!" or "com certeza!".'
  + ' You address the user directly and briefly, as a trusted chief of staff who already knows the projects.'
  + ' You may refer to the projects you orchestrate as your orchestra when it feels natural — sparingly, never corny.'
  + ' Never mention Claude, Anthropic, OpenAI or any underlying model: in voice you ARE Maestrus.';

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
/**
 * Monta o --append-system-prompt. Existe como função ÚNICA porque o prefixo do
 * system prompt é a chave do prompt cache do servidor: se dois caminhos que
 * usam a MESMA sessão montarem textos diferentes, cada alternância entre eles
 * refaz o cache e o turno custa como se o contexto fosse todo novo. Era o que
 * acontecia entre send() e dispatchOneShot().
 */
function buildSysAppend(project, migration, memBlock) {
  return ASK_GUIDANCE + (migration || '') + (memBlock || '')
    // Estilo de resposta GLOBAL, em todo turno de todo projeto. Vive aqui (e não
    // num CLAUDE.md) porque o --append-system-prompt é reinjetado a cada spawn:
    // sobrevive a reset de sessão, /compact e conversa nova.
    + persona.styleDirective()
    // Persona em TODOS os projetos (não só no orquestrador): em voz, quem fala é
    // sempre o Maestrus — mesmo caráter em qualquer conversa.
    + (project && project.voiceMode ? (VOICE_DIRECTIVE + MAESTRUS_PERSONA) : '');
}

/** Config MCP do Maestrus, usada por todos os caminhos que falam com o CLI. */
function maestrusMcpConfig() {
  try {
    const maestrus = projectStore.get(projectStore.MAESTRUS_ID || 'maestrus');
    const cfg = maestrus && maestrus.codeDir ? path.join(maestrus.codeDir, '.mcp.json') : null;
    if (cfg && fs.existsSync(cfg)) return cfg;
  } catch {}
  return null;
}

function migrationNote(project, curHost) {
  const prev = project.lastRunHost;
  if (!prev || prev === curHost) return '';
  const prevName = prev.split(':').slice(1).join(':') || 'another machine';
  return ' [MAESTRUS ENVIRONMENT CHANGE] This conversation previously ran on ' + osLabel(prev) + ' (' + prevName +
    ') and is NOW running on ' + osLabel(curHost) + ' (' + os.hostname() + '). The working directory IS a freshly synced mirror (Maestrus Cloud) of the project from the previous machine — file CONTENTS are the same, but absolute paths differ. IMPORTANT about git in synced mirrors: the .git/objects/pack/ files do NOT sync (cloud syncs file-by-file, pack files are skipped), so `git log` here may show only the most recent commit OR even just 1 commit ("Initial") instead of the real history. This does NOT mean the project is empty/new — the working tree IS complete, only the git history walking is broken. DO NOT use `git log` count to conclude "fresh project" or "lost context". NO local processes carried over (dev servers, watchers, builds). To re-orient: (1) `git status` shows the working tree honestly; (2) `netstat`/`lsof -i` to check ports; (3) treat OS-specific commands and absolute paths as needing re-verification. The user did NOT start a new conversation — keep working on the same task.';
}

let _oneShotCount = 0; // dispatchOneShot em voo (conta no cap do plano)
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

// O CLI aceita `--effort`? Passar flag desconhecida é ERRO FATAL no Claude Code,
// então detectamos uma vez pelo --help em vez de chutar pela versão (hosts
// remotos podem estar em builds diferentes). Cacheado por processo.
let _effortSupport = null;
async function supportsEffort() {
  if (_effortSupport !== null) return _effortSupport;
  try {
    const bin = findClaudeBin();
    const r = spawnSync(bin, ['--help'], {
      timeout: 8000, encoding: 'utf8',
      shell: /\.(cmd|bat|ps1)$/i.test(bin),
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    _effortSupport = /--effort\b/.test(out);
  } catch { _effortSupport = false; }
  console.log('[maestrus] CLI suporta --effort:', _effortSupport);
  return _effortSupport;
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

// Confirma (SÍNCRONO) que o binário REALMENTE executa `--version`. No Windows um
// claude.exe embutido de arquitetura errada "existe" mas dá `spawn UNKNOWN` ao
// rodar → sem esta checagem o chat travava nele em vez de cair pro claude que o
// usuário instalou. `.cmd/.bat/.ps1` exigem shell pra rodar.
function binWorks(bin) {
  if (!bin) return false;
  try {
    const useShell = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(bin);
    // 4s (era 8s): cada candidato quebrado no Windows bloqueava o thread principal
    // por 8s; com vários candidatos a UI congelava ~24s no 1º envio. Aquecemos no
    // boot (warmClaudeBin) pra que send() nunca pague esse custo.
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 4000, shell: useShell, windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

// Invalida o cache do binário — chamado após instalar o Claude in-app (o bin novo
// não estava sendo pego até reiniciar o app).
function resetClaudeBin() { _cachedBin = null; }

// Resolve o binário FORA do turno (no boot), pra que a 1ª mensagem não pague o
// custo do spawnSync de verificação. findClaudeBin cacheia em _cachedBin.
let _warming = false;
function warmClaudeBin() {
  if (_cachedBin || _warming) return;
  _warming = true;
  setTimeout(() => { try { findClaudeBin(); } catch {} _warming = false; }, 1200);
}

function findClaudeBin() {
  if (_cachedBin) return _cachedBin;

  // 0) Binário EMBUTIDO no instalador do Maestrus — prioridade máxima (o usuário
  //    leigo não instalou nada à parte; o Claude veio junto). MAS só se ele de
  //    fato roda — no Windows um exe de arch errada dá `spawn UNKNOWN`.
  try {
    const bundled = runtime.claudeBin();
    if (bundled && binWorks(bundled)) {
      _cachedBin = bundled;
      console.log(`[maestrus] claude binary (embutido): ${_cachedBin}`);
      return _cachedBin;
    }
    if (bundled) console.warn(`[maestrus] claude embutido não executa (arch/deps?) — procurando no sistema: ${bundled}`);
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

  // 3) npm global (claude instalado com `npm i -g @anthropic-ai/claude-code`)
  //    → %APPDATA%\npm\claude.cmd. E qualquer claude.exe/.cmd no PATH.
  const npmDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm');
  for (const f of ['claude.exe', 'claude.cmd']) {
    const p = path.join(npmDir, f);
    try { if (fs.existsSync(p)) candidates.push(p); } catch {}
  }
  for (const dir of (process.env.PATH || '').split(';').filter(Boolean)) {
    for (const f of ['claude.exe', 'claude.cmd']) {
      const p = path.join(dir, f);
      try { if (fs.existsSync(p)) candidates.push(p); } catch {}
    }
  }

  // Escolhe o PRIMEIRO candidato que REALMENTE roda (evita `spawn UNKNOWN` de
  // um exe quebrado). Se nenhum verifica, usa o 1º achado; senão o PATH.
  for (const c of candidates) {
    if (binWorks(c)) { _cachedBin = c; console.log(`[maestrus] claude binary (verificado): ${_cachedBin}`); return _cachedBin; }
  }
  if (candidates.length > 0) {
    _cachedBin = candidates[0];
    console.warn(`[maestrus] nenhum claude verificou --version; usando o 1º achado: ${_cachedBin}`);
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

let _keychainSynced = false;
function buildEnv(project) {
  const env = { ...process.env };
  // "Nenhum" pensamento: nos modelos atuais o único jeito que AINDA desliga de
  // verdade é esta env var (o --effort só regula a intensidade, não desliga).
  if ((project.thinkingMode ?? 'medium') === 'none') env.MAX_THINKING_TOKENS = '0';
  // macOS: o token OAuth vem do Keychain (entrada única compartilhada). Migra
  // pro .credentials.json do perfil ATIVO uma vez por processo — assim cada
  // perfil passa a usar sua própria conta em vez de todos caírem numa só.
  if (process.platform === 'darwin' && !_keychainSynced) {
    _keychainSynced = true;
    try { claudeProfiles.reconcileKeychainToActive(); } catch {}
  }
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
    // O MCP precisa saber de qual projeto veio a chamada para registrar as
    // execuções em segundo plano no lugar certo (e aparecerem no painel dele).
    try { env.MAESTRUS_PROJECT_ID = String(project.id); } catch {}
  }
  // Engine "Claude API" (id interno 'cloud', por compat): usa a API KEY DA
  // ANTHROPIC do próprio usuário (BYOK, cofre cifrado) direto contra
  // api.anthropic.com — sem proxy, sem medição, sem billing do Maestrus.
  // Nesse modo NÃO precisa de `claude auth` (API key em vez de OAuth).
  if (project.engine === 'cloud') {
    const k = anthropicKey.getCachedKey();
    // SEMPRE remove os tokens de assinatura no modo "Claude API" — mesmo quando a
    // key ainda não está no cache. Antes, com cache frio, o bloco não fazia nada e
    // o CLAUDE_CODE_OAUTH_TOKEN sobrava → o turno rodava SILENCIOSAMENTE na
    // ASSINATURA OAuth do usuário (cobrança no lugar errado). Sem key, o CLI falha
    // com erro claro de auth (melhor que faturar a assinatura por engano).
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (k) env.ANTHROPIC_API_KEY = k;
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

  // Engine "Claude API": AQUECE a chave (async) antes do buildEnv síncrono. A
  // chave pode ter sido setada em outro device/ logo após o login (o cache local
  // enche em +3s); sem aquecer, o 1º turno via com cache frio → sem key.
  if (project.engine === 'cloud' && !anthropicKey.getCachedKey()) {
    try { await anthropicKey.getKey(); } catch {}
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
    // Trava SEMPRE, inclusive vazio. Travar só quando havia conteúdo tinha o
    // efeito oposto ao pretendido: enquanto a busca não achasse nada o bloco
    // era recalculado a cada turno e, no instante em que passasse a achar, o
    // texto mudava no meio da conversa e derrubava o prompt cache — o turno
    // seguinte reenviava o contexto inteiro como input novo.
    // Custo: se o 1º turno não recupera nada, a sessão segue sem memória até
    // um /compact (clearMemBlock). Barato perto de refazer o cache.
    _memBlock.set(project.id, memBlock);
  }
  // Modo VOZ: a resposta vai ser FALADA. Vai no SYSTEM PROMPT (não colado na
  // mensagem) pra não poluir o histórico da conversa. Muda o registro: curto,
  // conversado, sem markdown (que soa horrível lido em voz alta).
  const sysAppend = buildSysAppend(project, migrationNote(project, curHost), memBlock);
  // Instância cloud/self-host com URL pública: o Claude de TODA conversa desta
  // instância sabe o endereço (previews, links, webhooks). Domínio próprio
  // (plano Pro) sobrescreve via setting public_url — vale na hora pra todas
  // as conversas, sem tocar nas sessões.
  let sysAppendFull = sysAppend;
  try {
    const pub = (projectStore.getSetting && projectStore.getSetting('public_url')) || process.env.MAESTRUS_PUBLIC_URL || '';
    if (pub) sysAppendFull += ` This Maestrus instance is publicly reachable at ${pub} — apps/previews you serve on local ports may be exposed under this address.`;
  } catch {}

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
    '--append-system-prompt', sysAppendFull,
  ];
  { const em = effectiveModel(project); if (em) args.push('--model', em); }
  args.push('--permission-mode', effectivePermissionMode(project));
  // ─── Modo de pensamento ────────────────────────────────────────────────
  // `--max-thinking-tokens` VIROU LETRA MORTA: saiu do --help e, nos modelos
  // atuais, o parâmetro por trás (thinking.budget_tokens) é rejeitado — o
  // pensamento passou a ser adaptativo. Medido: 0 vs 64000 dava resposta
  // equivalente; quem move o modelo agora é `--effort`. Ou seja, o seletor de
  // thinking da UI não controlava NADA.
  // Mapeamento por intenção (não por tokens):
  //   none → low + MAX_THINKING_TOKENS=0 no env (o jeito que ainda desliga)
  //   low/medium/high → low/medium/high
  const mode = project.thinkingMode ?? 'medium';
  if (await supportsEffort()) {
    const effort = mode === 'none' ? 'low' : (mode === 'high' ? 'high' : mode === 'low' ? 'low' : 'medium');
    args.push('--effort', effort);
  } else {
    // CLI antigo (host remoto desatualizado): mantém o comportamento legado.
    const legacy = { none: 0, low: 4000, medium: 16000, high: 64000 };
    args.push('--max-thinking-tokens', String(legacy[mode] ?? 16000));
  }
  // Carrega o MCP do Maestrus (orquestração + navegador embutido) explicitamente
  // em TODOS os projetos — o .mcp.json fica no codeDir do Maestrus. Isso evita o
  // prompt de aprovação em modo headless e dá browser_* a qualquer projeto.
  { const mcpConfig = maestrusMcpConfig(); if (mcpConfig) args.push('--mcp-config', mcpConfig); }
  if (project.sessionId) args.push('--resume', project.sessionId);
  // Fork ainda não materializado: resume a sessão de origem mas grava numa
  // sessão NOVA — o session_id novo do init vira o sessionId da conversa.
  if (project.__forkPending && project.sessionId) args.push('--fork-session');

  ensureTrusted(project.codeDir);

  const bin = findClaudeBin();
  const useShell = /\.(cmd|bat|ps1)$/i.test(bin);  // scripts do Windows precisam de shell
  console.log(`[maestrus] spawn ${bin}`);
  console.log(`[maestrus]   args: ${args.map((a) => /\s/.test(a) ? `"${a.slice(0, 60)}"` : a).join(' ').slice(0, 400)}`);
  console.log(`[maestrus]   cwd: ${project.codeDir}`);
  console.log(`[maestrus]   shell: ${useShell}`);

  // Cap do plano (Maestrus Cloud): MAESTRUS_MAX_CONCURRENCY limita execuções
  // simultâneas TOTAIS (projetos + forks + dispatches). Sem env = sem limite
  // (desktop/self-host). Turno já ativo do mesmo chat não conta duas vezes.
  {
    const cap = parseInt(process.env.MAESTRUS_MAX_CONCURRENCY || '0', 10);
    const inFlight = procs.size + _oneShotCount;
    if (cap > 0 && !procs.has(project.id) && inFlight >= cap) {
      emit({ projectId: project.id, type: 'error', text: `Limite do plano atingido: ${cap} execuções simultâneas. Aguarde uma conversa terminar ou faça upgrade para rodar mais agentes em paralelo.`, timestamp: Date.now() });
      emit({ projectId: project.id, type: 'done', timestamp: Date.now() });
      return;
    }
  }

  emit({ projectId: project.id, type: 'user', text: message, timestamp: Date.now() });

  _cancelled.delete(project.id); // turno novo começa "não cancelado"

  const proc = spawn(bin, args, {
    cwd: project.codeDir,
    shell: useShell,
    env: buildEnv(project),
    stdio: ['pipe', 'pipe', 'pipe'],
    ...SPAWN_OPTS, // process group próprio: dá pra matar os sub-agents junto
  });

  // Fecha stdin imediatamente — claude -p espera 3s por stdin caso fique aberto.
  try { proc.stdin.end(); } catch (e) { console.warn('[maestrus] stdin.end falhou:', e.message); }

  procs.set(project.id, proc);

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    if (_cancelled.has(project.id)) return; // parado pelo usuário: não fala mais
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
    // Sessão OAuth morta: o CLI só descobre AO USAR — `claude auth status`
    // continua dizendo loggedIn:true porque lê a credencial guardada sem
    // validar contra o servidor. Por isso a tela de contas mostrava tudo certo
    // enquanto o turno falhava. Marca com um tipo próprio pra UI oferecer
    // reconectar em vez de exibir o erro cru.
    if (/OAuth session expired|could not be refreshed|Failed to authenticate/i.test(chunk)) {
      emit({
        projectId: project.id, type: 'auth-expired',
        profile: (() => { try { return claudeProfiles.getActive(); } catch { return null; } })(),
        text: 'A sessão da conta Claude expirou. Reconecte para continuar.',
        timestamp: Date.now(),
      });
    }
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
    // Só apaga do mapa se ainda for ESTE processo: parar e reenviar rápido faz
    // o close do turno antigo chegar depois do spawn do novo, e um delete cego
    // apagaria a entrada do turno em andamento (isBusy passaria a mentir).
    if (procs.get(project.id) === proc) procs.delete(project.id);
    const cancelled = _cancelled.delete(project.id);
    console.log(`[maestrus] proc close exit=${code} cancelled=${cancelled} stderr.length=${stderrBuffer.length}`);

    if (cancelled) {
      // Parada pedida pelo usuário: não é erro e não tem o que recuperar.
      releaseLock(project);
      emit({ projectId: project.id, type: 'done', exitCode: code, cancelled: true, timestamp: Date.now() });
      return;
    }

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

  // O CLI avisa a cada turno como está o limite de uso da conta (status, quando
  // reseta, se há crédito extra). Isso vinha sendo DESCARTADO — e é justamente
  // o sinal pra avisar você ANTES do turno morrer por limite.
  if (evt.type === 'rate_limit_event' && evt.rate_limit_info) {
    const i = evt.rate_limit_info;
    emit({
      projectId: project.id, type: 'rate-limit',
      status: i.status || null,                 // allowed | allowed_warning | rejected…
      resetsAt: i.resetsAt || null,             // epoch (s)
      limitType: i.rateLimitType || null,       // five_hour | weekly…
      overage: i.overageStatus || null,
      timestamp: Date.now(),
    });
    return;
  }

  if (evt.type === 'result') {
    emit({ projectId: project.id, type: 'result', evt, timestamp: Date.now() });
    return;
  }
}

function kill(projectId) {
  const proc = procs.get(projectId);
  if (!proc) return false;
  // Marca ANTES de matar: entre o sinal e o close ainda chegam linhas do buffer
  // do stdout, e elas não podem virar resposta na tela depois do "parar".
  _cancelled.add(projectId);
  try { killTree(proc); } catch (e) { console.warn('[maestrus] kill falhou:', e.message); }
  // Não remove do mapa aqui — quem remove é o 'close', que também emite o
  // 'done'. Tirar agora faria isBusy() dizer "livre" com o processo ainda vivo.
  return true;
}

function isBusy(projectId) {
  return procs.has(projectId);
}

function killAll() {
  for (const [projectId, proc] of procs) {
    _cancelled.add(projectId);
    try { killTree(proc, 300); } catch {} // no shutdown não dá pra esperar 1.5s
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

// Metadados baratos da sessão (mtime/size) — pro host cachear loadHistory sem
// re-ler o arquivo quando nada mudou.
function sessionMeta(project) {
  try {
    const jsonlPath = findSessionFile(project);
    if (!jsonlPath) return null;
    const st = fs.statSync(jsonlPath);
    return { path: jsonlPath, mtime: st.mtimeMs, size: st.size };
  } catch { return null; }
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

  // Sessão do Claude Code é uma ÁRVORE (cada entry tem uuid + parentUuid). Um
  // turno interrompido (fechar/reabrir o app, "session limit", kill) cria um
  // BRANCH novo a partir do mesmo ponto → a sessão acumula várias folhas. O
  // Claude Code renderiza só a LINHAGEM da folha atual (o branch ativo); se a
  // gente achatar tudo por timestamp, os branches órfãos vazam como respostas
  // DUPLICADAS na tela. Então linearizamos: seguimos parentUuid da última
  // entry (folha ativa) até a raiz e só mostramos entries dessa linhagem.
  const parsed = [];
  for (const line of lines) { try { parsed.push(JSON.parse(line)); } catch {} }
  const byUuid = new Map();
  for (const e of parsed) if (e && e.uuid) byUuid.set(e.uuid, e);
  // Folha ativa = última entry com uuid do branch PRINCIPAL. Se o .jsonl termina
  // numa entry de sidechain (subagente Task), seguir o parentUuid dela linearizava
  // sobre a linhagem do subagente e ESCONDIA o branch principal. Preferimos a
  // última entry não-sidechain; só caímos pra qualquer uuid se não houver.
  let leaf = null;
  for (let i = parsed.length - 1; i >= 0; i--) { if (parsed[i] && parsed[i].uuid && parsed[i].isSidechain !== true) { leaf = parsed[i]; break; } }
  if (!leaf) { for (let i = parsed.length - 1; i >= 0; i--) { if (parsed[i] && parsed[i].uuid) { leaf = parsed[i]; break; } } }
  const activeSet = new Set();
  { let cur = leaf; const seen = new Set();
    while (cur && cur.uuid && !seen.has(cur.uuid)) { activeSet.add(cur.uuid); seen.add(cur.uuid); cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null; } }

  const messages = [];
  // Verdade da ocupação de contexto: o ÚLTIMO turno assistant do .jsonl carrega
  // o usage real (input + cache) = quanto da janela está ocupado AGORA. E o
  // model do turno diz qual janela usar. Extraímos pra UI mostrar o % correto
  // já na ABERTURA da conversa (sem esperar um novo prompt).
  let lastUsage = null;
  let lastModel = null;

  for (const entry of parsed) {
    if (!entry) continue;
    // Fora do branch ativo → ignora (evita respostas duplicadas de branches
    // órfãos de turnos interrompidos). Entries meta sem uuid seguem normais.
    if (entry.uuid && activeSet.size && !activeSet.has(entry.uuid)) continue;
    // Boundary de compactação: o CLI só considera daqui pra frente, mas a UI
    // mantém a LINHA CONTÍNUA — nada de apagar o que veio antes (o histórico
    // segue no .jsonl). Um divisor marca onde o contexto ativo recomeça.
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      lastUsage = null; // a compactação reinicia a ocupação da janela
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
      // A compactação zera a ocupação: se um boundary/summary veio DEPOIS deste
      // usage, ele já não vale — por isso capturamos sempre o mais recente e um
      // boundary reseta lastUsage (abaixo, no branch do boundary).
      if (entry.message.usage) lastUsage = entry.message.usage;
      if (entry.message.model) lastModel = entry.message.model;
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

  // Teto de payload: o histórico trafega pelo relay (frame cap 16MB) e por
  // uplinks residenciais lentos (host num Mac mini). Trunca blocos gigantes e
  // derruba os mais ANTIGOS até caber num orçamento — o resto segue no .jsonl
  // (a paginação "carregar anteriores" é client-side). Evita frame dropado
  // ("histórico não carrega") em conversas com muito output de ferramenta.
  const MAX_BLOCK = 48 * 1024;
  for (const m of messages) { if (typeof m.text === 'string' && m.text.length > MAX_BLOCK) m.text = m.text.slice(0, MAX_BLOCK) + '\n… (truncado)'; }
  const BUDGET = 6 * 1024 * 1024;
  let _total = 0;
  for (const m of messages) _total += (m.text ? m.text.length : 0) + 200;
  while (messages.length > 30 && _total > BUDGET) { const d = messages.shift(); _total -= (d.text ? d.text.length : 0) + 200; }

  // Anexa a ocupação REAL do contexto (usage + model do último turno) numa
  // mensagem-portadora invisível no fim — a UI lê e mostra o % correto já na
  // abertura, sem esperar um novo prompt. Sobrevive ao clamp do relay (spread).
  if (lastUsage && messages.length) {
    messages[messages.length - 1].ctxUsage = {
      input_tokens: lastUsage.input_tokens || 0,
      cache_read_input_tokens: lastUsage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: lastUsage.cache_creation_input_tokens || 0,
      output_tokens: lastUsage.output_tokens || 0,
    };
    if (lastModel) messages[messages.length - 1].ctxModel = lastModel;
  }

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
    {
      const cap = parseInt(process.env.MAESTRUS_MAX_CONCURRENCY || '0', 10);
      if (cap > 0 && (procs.size + _oneShotCount) >= cap) {
        return reject(new Error(`Limite do plano: ${cap} execuções simultâneas. Aguarde uma execução terminar ou faça upgrade.`));
      }
    }
    _oneShotCount++;
    let _osDone = false;
    const _osEnd = () => { if (!_osDone) { _osDone = true; _oneShotCount = Math.max(0, _oneShotCount - 1); } };

    const args = [
      '-p', message,
      '--output-format', 'stream-json',
      '--input-format', 'text',
      '--verbose',
      // MESMO prefixo do send(): os dois rodam com --resume na mesma sessão, e
      // qualquer divergência aqui invalidava o prompt cache dela.
      '--append-system-prompt', buildSysAppend(project, '', _memBlock.get(project.id)),
    ];
    // Idem para as ferramentas: a lista de tools também compõe o prefixo, então
    // rodar sem o MCP que o send() carrega derrubava o cache do mesmo jeito.
    { const mcpConfig = maestrusMcpConfig(); if (mcpConfig) args.push('--mcp-config', mcpConfig); }
    { const em = effectiveModel(project); if (em) args.push('--model', em); }
    args.push('--permission-mode', effectivePermissionMode(project));
    if (project.sessionId) args.push('--resume', project.sessionId);
    // forkSession: lê o contexto atual mas grava numa sessão NOVA, deixando a
    // original intacta (usado pelo /compact pra gerar o resumo sem poluir).
    // __forkPending: conversa fork ainda não materializada — idem, mas o id
    // novo VIRA a sessão da conversa (salvo abaixo via projectStore.save).
    if ((forkSession || project.__forkPending) && project.sessionId) args.push('--fork-session');

    const bin = findClaudeBin();
    const useShell = /\.(cmd|bat|ps1)$/i.test(bin);  // scripts do Windows precisam de shell
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
      _osEnd();
      if (resolved) return;
      resolved = true;
      try { proc.kill(); } catch {}
      reject(new Error(`Timeout após ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      _osEnd();
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
      _osEnd();
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Faz backup preventivo da sessão antes de qualquer operação destrutiva.
// Retorna o caminho do .bak, ou null se não houver sessão.
// Quantos backups de sessão guardar por conversa. Compactar é destrutivo (a
// sessão é reescrita com o resumo), então o histórico anterior tem que
// sobreviver — inclusive depois de VÁRIAS compactações.
const SESSION_BAKS_KEEP = 10;

function backupSessionFile(project) {
  const jsonlPath = findSessionFile(project);
  if (!jsonlPath) return null;
  // Backup VERSIONADO (carimbo de tempo). Antes era um único ".bak": a segunda
  // compactação sobrescrevia o backup da primeira e o histórico original se
  // perdia pra sempre. Agora cada compactação guarda o seu.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakPath = `${jsonlPath}.${stamp}.bak`;
  try {
    fs.copyFileSync(jsonlPath, bakPath);
    // Mantém também o ".bak" simples apontando pro mais recente — é o que o
    // restore/undo usa (compatível com o que já existia).
    try { fs.copyFileSync(jsonlPath, jsonlPath + '.bak'); } catch {}
    pruneSessionBaks(jsonlPath);
    return bakPath;
  } catch { return null; }
}

// Retenção: guarda os N backups mais recentes desta conversa. Sessões longas
// viram arquivos de dezenas de MB — sem poda isso encheria o disco (que já nos
// derrubou uma vez).
function pruneSessionBaks(jsonlPath) {
  try {
    const dir = path.dirname(jsonlPath);
    const base = path.basename(jsonlPath);
    const baks = fs.readdirSync(dir)
      .filter((n) => n.startsWith(base + '.') && n.endsWith('.bak') && n !== base + '.bak')
      .sort();                                   // carimbo ISO ordena cronologicamente
    for (const old of baks.slice(0, Math.max(0, baks.length - SESSION_BAKS_KEEP))) {
      try { fs.unlinkSync(path.join(dir, old)); } catch {}
    }
  } catch {}
}

/** Backups desta conversa, do mais novo pro mais antigo. */
function listSessionBaks(project) {
  try {
    const jsonlPath = findSessionFile(project);
    if (!jsonlPath) return [];
    const dir = path.dirname(jsonlPath);
    const base = path.basename(jsonlPath);
    return fs.readdirSync(dir)
      .filter((n) => n.startsWith(base + '.') && n.endsWith('.bak') && n !== base + '.bak')
      .sort().reverse()
      .map((n) => {
        const full = path.join(dir, n);
        let size = 0, mtime = 0;
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
        return { file: full, name: n, size, mtime };
      });
  } catch { return []; }
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
  emit, // barramento compartilhado — o codex-pty emite pelos MESMOS canais
  VOICE_DIRECTIVE, MAESTRUS_PERSONA, // reusados pelo codex-pty (modo voz)
  send, kill, killAll, loadHistory,
  dispatchOneShot, deleteSessionFile, compactSessionFile, backupSessionFile, restoreSessionFile, listSessionBaks, onEvent, findClaudeBin, resetClaudeBin, warmClaudeBin, isBusy, sessionMeta,
  currentHostId, isLockActive, LOCK_TTL_MS, clearMemBlock, sessionFilePath,
  buildSysAppend, // exportado p/ teste: send e dispatchOneShot têm que casar
};
