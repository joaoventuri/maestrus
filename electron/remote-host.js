'use strict';
// Modo HOST do Maestrus remoto. Liga via RelayLink (mesma classe testada),
// anuncia os projetos e atende RPC dos clients, rodando o Claude CLI local e
// streamando os eventos de volta. OFF por padrão — só liga quando o usuário
// habilita "permitir controle remoto" nas Settings.
//
// Segurança: clampa o permission-mode das sessões remotas (nunca bypassa por
// controle remoto), expõe só projetos permitidos e loga o que chega.

const os = require('os');
const { RelayLink } = require('../relay/link');
let WebSocketImpl = null;
try { WebSocketImpl = require('ws'); } catch {}

const projectStore = require('./project-store');
const claudePty = require('./claude-pty');
const codexPty = require('./codex-pty'); // engine Codex (dispatch por engine no host)
const codexAuth = require('./codex-auth'); // login do Codex CLI (device-auth) pelo client
const claudeAuth = require('./claude-auth'); // estado da conta Claude DO HOST (client pergunta)
function ptyForRH(p) { const e = p && p.engine; return (e === 'codex' || e === 'codex-api') ? codexPty : claudePty; }
const claudeProfiles = require('./claude-profiles');
const claudePowers = require('./claude-powers');
const turnQueue = require('./turn-queue');
const runStore = require('./run-store'); // fila de turno (host é o dono)
const persona = require('./persona');     // estilo de resposta global
const path = require('path');
const fs = require('fs');
let usageMod = null; try { usageMod = require('./usage'); } catch {}
const fileAccess = require('./file-access');
let cloudMod = null; try { cloudMod = require('./cloud'); } catch {}

// ─── Web Push do HOST DESKTOP: avisa o celular quando um turno termina e
// NINGUÉM está olhando (mesmo padrão do container). Antes só o container cloud
// disparava → projetos no seu PC como host não notificavam. Debounce 60s/projeto.
const PUSH_API_BASE = process.env.MAESTRUS_API_BASE || 'https://maestrus.cloud';
let _pushLastClientAt = Date.now();
const _pushLastAt = new Map();
function maybeWebPush(payload) {
  try {
    if (!payload || (payload.type !== 'done' && payload.type !== 'ask-user-question')) return;
    if (typeof fetch !== 'function') return;
    if (process.env.MAESTRUS_USER_ID) return; // no CONTAINER, quem dispara é o index.js — evita duplicar
    const acc = cloudMod && cloudMod.getAccount && cloudMod.getAccount();
    const lic = acc && (acc.licenseKey || acc.license_key);
    if (!lic) return;                       // sem conta cloud → sem push
    // SEM gate de presença: o host não sabe de verdade se você está olhando
    // (presença tem grace + a PWA no mobile não fecha limpa → suprimia justo
    // quando o agente terminava com você fora). Quem decide MOSTRAR é o service
    // worker no device (checa janela visível). Aqui só um debounce anti-spam.
    const pid = payload.projectId || 'unknown';
    if (Date.now() - (_pushLastAt.get(pid) || 0) < 15 * 1000) return;
    _pushLastAt.set(pid, Date.now());
    let title = 'Maestrus';
    try { const p = projectStore.get(pid); if (p && p.name) title = p.name; } catch {}
    const body = payload.type === 'done' ? 'Resposta pronta' : 'O agente fez uma pergunta';
    fetch(`${PUSH_API_BASE}/api.php?action=push_notify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ license_key: lic, title, body, tag: `maestrus-${pid}`, url: '/app' }),
    }).catch(() => {});
  } catch {}
}

let link = null;
let unsub = null;
// deviceId -> { pids: Set<string>|null, write: bool }. pids=null → acesso total
// (device do próprio dono / membro full). pids=Set → guest de share, só recebe
// eventos e RPC dos projetos permitidos. Antes era um Set cru: QUALQUER guest
// virava assinante de TODOS os projetos (vazava streaming/tool-results de
// projetos não compartilhados). Agora o push é filtrado por projeto.
const subscribers = new Map();
const _histCache = new Map(); // projectId → { mtime, size, payload } — reabrir conversa sem re-parsear
let state = { running: false, status: 'idle', error: null };
let onState = null;
let allowBypass = false; // por segurança, controle remoto não bypassa permissões

function hostInfo() {
  return {
    name: os.hostname() || 'Host',
    os: process.platform,
    projects: safeProjects(),
  };
}

// Shape ENXUTO de um projeto pro client: nunca vaza codeDir/localPath/ssh/token.
// Usado na lista, no projects.get e no broadcast de patch (antes o patch mandava
// o objeto CRU do projectStore, vazando caminhos e config ssh).
function safeProject(p) {
  if (!p) return null;
  return {
    id: p.id, name: p.name, source: p.source, branch: p.ssh ? p.ssh.host : null,
    model: p.model || 'default', thinkingMode: p.thinkingMode || 'medium',
    permissionMode: p.permissionMode || 'default', engine: p.engine || 'claude',
    sessionId: p.sessionId || null,
    conversations: (p.conversations || []).map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt })),
  };
}

function safeProjects() {
  try {
    return projectStore.list()
      // O orquestrador 'maestrus' e o 'starter' (Inicializador) NÃO são sessões
      // remotas: o client já tem o próprio Maestrus e o Inicializador só existe
      // na tela dedicada. Anunciá-los criava entradas duplicadas/indevidas na
      // lista de projetos do client.
      .filter((p) => p.id !== 'maestrus' && p.id !== 'starter')
      .map(safeProject);
  } catch { return []; }
}

// ── Enforcement de sharing: allowlist DEFAULT-DENY de canais por papel ────────
// Guest read-only só pode ler; guest write pode operar sobre os projetos do
// escopo. Canais que afetam a CONTA/HOST inteiro (delete, create, usage,
// version, logout) NUNCA são expostos a um GUEST — só ao dono.
const SHARE_READ_CHANNELS = new Set(['projects.list', 'projects.get', 'claude.loadHistory', 'ping', 'files.tree', 'files.read', 'files.readChunk', 'queue.list', 'runs.list', 'runs.get', 'runs.log']);
const SHARE_WRITE_CHANNELS = new Set([
  ...SHARE_READ_CHANNELS,
  'claude.send', 'claude.stop', 'projects.patch',
  'conversations.create', 'conversations.rename', 'conversations.delete',
  'sessions.uploadChunk', 'files.upload', 'files.uploadChunk', 'claude.compact', 'claude.compactRestore',
  'queue.list', 'queue.enqueue', 'queue.remove', 'queue.reorder', 'queue.clear', 'persona.get',
  // Execuções em segundo plano: ver é leitura; iniciar/parar mexe na máquina.
  'runs.list', 'runs.get', 'runs.log', 'runs.stop', 'runs.start', 'runs.activeCount',
]);
// Canais GLOBAIS da conta — negados a QUALQUER não-dono (guest E membro): mexem
// na conta Claude do host (logout desloga o OAuth do dono) ou vazam billing.
const OWNER_ONLY_CHANNELS = new Set([
  'claude.logout', 'claude.usage', 'claude.version', 'persona.set',
  // Contas do Claude do host: trocar/criar/remover afeta TODAS as conversas
  // da máquina e mexe no OAuth do dono. Nunca para um convidado de share.
  'claudeProfiles.list', 'claudeProfiles.status', 'claudeProfiles.setActive',
  'claudeProfiles.create', 'claudeProfiles.remove',
  'claudeProfiles.loginStart', 'claudeProfiles.loginState',
  'claudeProfiles.loginCode', 'claudeProfiles.loginCancel',
]);

// Um subscriber (entry do Map) pode receber evento/RPC deste projeto?
function subCanSeePid(entry, pid) {
  if (!entry) return false;
  if (entry.pids === null) return true;        // acesso total (dono/membro)
  if (!pid || pid === '*') return false;       // evento global → só acesso total
  return entry.pids.has(pid);
}

// Caminho de destino de um anexo: dentro de .maestrus/uploads DO PROJETO (assim
// o Claude lê com @relativo e sem sair da raiz) e com nome SEGURO — só
// [A-Za-z0-9._-]. Espaço/acento/parênteses viram '_' porque a referência @ do
// Claude PARA no primeiro espaço (era a causa nº1 de "arquivo não encontrado").
function uploadDest(proj, name) {
  const raw = String(name || 'arquivo').split(/[\\/]/).pop() || 'arquivo';
  let safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'arquivo';
  if (!/\.[A-Za-z0-9]+$/.test(safe)) { /* mantém sem ext */ }
  // Pasta do projeto pode ser READ-ONLY (mount root/aapanel) → EACCES no mkdir.
  // Cai pro tmp em vez de estourar o upload (o @path vira absoluto do tmp).
  const tmpBase = path.join(os.tmpdir(), 'maestrus-uploads');
  let baseDir = proj && proj.codeDir && fs.existsSync(proj.codeDir)
    ? path.join(proj.codeDir, '.maestrus', 'uploads')
    : tmpBase;
  try { fs.mkdirSync(baseDir, { recursive: true }); }
  catch { baseDir = tmpBase; fs.mkdirSync(baseDir, { recursive: true }); }
  let dest = path.join(baseDir, safe);
  if (fs.existsSync(dest)) {
    const ext = path.extname(safe);
    dest = path.join(baseDir, path.basename(safe, ext) + '-' + Date.now().toString(36) + ext);
  }
  return dest;
}
// Caminho RELATIVO ao projeto (cwd do Claude) quando o anexo está dentro dele.
// Preferimos o relativo na referência @ porque o diretório do projeto pode ter
// ESPAÇO (ex.: "My Project") e o @absoluto quebraria no espaço.
function relOf(proj, dest) {
  try {
    if (proj && proj.codeDir) {
      const r = path.relative(proj.codeDir, dest);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
    }
  } catch {}
  return null;
}

// O Maestrus bypassa permissões por natureza (é a máquina/conta do próprio dono).
// Mantido como passthrough — o claude-pty já define bypassPermissions por padrão.
function clampForRemote(project) { return project; }

// Prompt do /compact — copiado do main.js pra o host servir clients remotos.
function buildCompactPrompt(focus) {
  const focusLine = focus ? ` Dê atenção especial a: ${focus}.` : '';
  return (
    'Resuma TODA a nossa conversa até aqui de forma densa e fiel, em tópicos, pra servir ' +
    'como contexto de continuação numa sessão compactada. Inclua: objetivo do trabalho, ' +
    'decisões tomadas, estado atual do código e das tarefas, pendências em aberto, arquivos ' +
    'relevantes e convenções combinadas. NÃO use ferramentas nem execute ações — produza só o resumo.' +
    focusLine
  );
}

async function handleRpc(f, reply, fail) {
  const { channel, payload, from, shareClaims } = f;

  // Registra/atualiza o subscriber COM escopo. shareClaims presente = guest de
  // share (escopo por pids + papel); ausente = device do próprio dono / membro
  // full (acesso total). O escopo é reavaliado a cada RPC (o token pode ter
  // mudado). Antes: subscribers.add(from) cru → guest recebia tudo.
  const isShare = !!shareClaims;
  const isMember = isShare && shareClaims.member === true;   // membro de workspace
  const isGuest = isShare && !isMember;                       // guest de share por-projeto
  // Escopo de projetos: membro = todos (null); guest com pids = subset; guest
  // sem pids = nenhum (Set vazio); dono (sem claim) = todos (null).
  const allowedPids = isGuest
    ? (Array.isArray(shareClaims.pids) && shareClaims.pids.length > 0 ? new Set(shareClaims.pids) : new Set())
    : null;
  const canWrite = !isShare || shareClaims.p === 'write';
  subscribers.set(from, { pids: allowedPids, write: canWrite });

  // Canais globais da conta: negados a QUALQUER não-dono (guest E membro).
  if (isShare && OWNER_ONLY_CHANNELS.has(channel)) return fail('acesso-negado');

  // GUEST: default-deny — canal na allowlist do papel + projeto-alvo no escopo.
  if (isGuest) {
    const allow = canWrite ? SHARE_WRITE_CHANNELS : SHARE_READ_CHANNELS;
    if (!allow.has(channel)) return fail('acesso-negado');
    const targetPid = (payload && (payload.projectId || payload.id)) || null;
    if (channel !== 'projects.list' && targetPid && !allowedPids.has(targetPid)) {
      return fail('acesso-negado');
    }
    if (channel === 'projects.list') {
      const all = safeProjects();
      return reply(all.filter((p) => allowedPids.has(p.id)));
    }
  }
  // MEMBRO VIEWER (read-only): vê TODOS os projetos, mas só canais de leitura —
  // não envia prompt, não deleta, não mexe em conversas. Editor cai no switch
  // normal (só OWNER_ONLY_CHANNELS bloqueado acima).
  if (isMember && !canWrite && !SHARE_READ_CHANNELS.has(channel)) {
    return fail('permissao-negada-viewer');
  }

  try {
    switch (channel) {
      case 'projects.list': return reply(safeProjects());
      case 'projects.get': return reply(safeProject(projectStore.get(payload.id)) || null);
      // Cria um projeto DENTRO deste host (container/máquina). github → clona;
      // empty → pasta vazia. É o caminho de "novo projeto" do web quando
      // conectado no container do usuário (substitui o sandbox cloud legado).
      case 'projects.create': {
        try {
          const input = payload || {};
          if (!input.name) return reply({ ok: false, error: 'name_required' });
          const proj = projectStore.createDraft(input);
          const os = require('os');
          const base = path.join(os.homedir(), '.maestrus', 'projects', proj.id, 'code');
          fs.mkdirSync(path.dirname(base), { recursive: true });
          if (input.source === 'github' && input.repoUrl) {
            const cp = require('child_process');
            const url = String(input.repoUrl);
            // Repo privado: o token vira credencial git SALVA deste host
            // (credential.helper store) — o clone funciona e as conversas do
            // Maestrus (o Claude rodando aqui) ganham acesso ao git também,
            // em todos os projetos, daqui pra frente.
            if (input.gitToken) {
              try {
                let ghost = 'github.com';
                try { ghost = new URL(url).host || 'github.com'; } catch {}
                const tok = String(input.gitToken).trim();
                const line = `https://x-access-token:${encodeURIComponent(tok)}@${ghost}`;
                const credFile = path.join(os.homedir(), '.git-credentials');
                let cur = ''; try { cur = fs.readFileSync(credFile, 'utf8'); } catch {}
                // uma credencial por host git: substitui a antiga (token trocado)
                const kept = cur.split('\n').filter((l) => l.trim() && !l.includes('@' + ghost));
                kept.push(line);
                fs.writeFileSync(credFile, kept.join('\n') + '\n', { mode: 0o600 });
                cp.execFileSync('git', ['config', '--global', 'credential.helper', 'store'], { stdio: 'pipe' });
              } catch {}
            }
            try {
              cp.execFileSync('git', ['clone', '--depth', '1', url, base], {
                stdio: 'pipe', timeout: 240000,
                // sem terminal: falha rápido em vez de travar pedindo usuário
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
              });
            } catch (e) {
              const msg = (e && (e.stderr ? e.stderr.toString() : e.message)) || 'clone_failed';
              // Repo privado sem credencial (ou token inválido) → a UI pede o token.
              if (/could not read Username|Authentication failed|Invalid username or (token|password)|terminal prompts disabled|Repository not found/i.test(msg)) {
                return reply({ ok: false, error: 'repo_auth_required' });
              }
              return reply({ ok: false, error: 'clone_failed: ' + msg.slice(0, 240) });
            }
          } else {
            fs.mkdirSync(base, { recursive: true });
          }
          proj.codeDir = base;
          const saved = projectStore.save(proj);
          try { broadcastProjectPatch(saved); } catch {}
          return reply(saved);
        } catch (e) { return reply({ ok: false, error: String(e && e.message || e) }); }
      }
      case 'claude.loadHistory': {
        const p = projectStore.get(payload.projectId);
        if (!p) return reply([]);
        // CACHE por mtime: reabrir a MESMA conversa sem mudança devolve na hora,
        // sem re-ler nem re-parsear o .jsonl (era caro e, com o host ocupado num
        // turno, ficava LENTÍSSIMO — o usuário reiniciava o host pra "acelerar").
        let meta = null; try { meta = claudePty.sessionMeta ? claudePty.sessionMeta(p) : null; } catch {}
        const cacheKey = payload.projectId;
        const hit = _histCache.get(cacheKey);
        if (hit && meta && hit.mtime === meta.mtime && hit.size === meta.size) return reply(hit.payload);

        const full = await claudePty.loadHistory(p);
        // Payload ENXUTO: a resposta antiga (400 msgs × 40KB) chegava a ~16MB e
        // ENTUPIA o buffer de saída do host no relay → backlog → tudo lento (só
        // reiniciar o host limpava). Agora ~150 msgs com textos menores = frame
        // pequeno e rápido. "Carregar mais" busca o resto sob demanda.
        const TAIL = 150;
        const MAX_TEXT = 10_000;
        const MAX_INPUT_JSON = 6_000;
        const tail = full.length > TAIL ? full.slice(full.length - TAIL) : full;
        const clipped = tail.map((m) => {
          const c = { ...m };
          if (typeof c.text === 'string' && c.text.length > MAX_TEXT) {
            c.text = c.text.slice(0, MAX_TEXT) + `\n…[truncado: +${c.text.length - MAX_TEXT} chars]`;
          }
          if (c.input && typeof c.input === 'object') {
            try {
              const s = JSON.stringify(c.input);
              if (s.length > MAX_INPUT_JSON) c.input = { __truncated: true, __originalSize: s.length, preview: s.slice(0, MAX_INPUT_JSON) + '…' };
            } catch { c.input = null; }
          }
          return c;
        });
        if (meta) { _histCache.set(cacheKey, { mtime: meta.mtime, size: meta.size, payload: clipped }); if (_histCache.size > 40) _histCache.delete(_histCache.keys().next().value); }
        return reply(clipped);
      }
      case 'claude.send': {
        const p = projectStore.get(payload.projectId);
        if (!p) return fail('Projeto não encontrado');
        await ptyForRH(p).send(clampForRemote(p), String(payload.message || ''));
        return reply({ ok: true });
      }
      case 'claude.stop': return reply(claudePty.kill(payload.projectId) || codexPty.kill(payload.projectId));
      // Fila de turno do host: é a MESMA pra todos os clients conectados.
      // Estilo de resposta global: o client (web/PWA) lê e muda pelo host, que
      // é quem monta o system prompt.
      // ─── Contas do Claude DO HOST, gerenciadas pelo client ──────────────
      // O client já chamava estes canais (main.js profilesCall), mas o host
      // NUNCA os respondia — o fallback silencioso caía pro local e a pessoa
      // via as contas da própria máquina achando que eram as do host. Fora de
      // casa, com o limite estourado, não havia como trocar a conta que roda
      // de verdade sem acessar a máquina remotamente.
      case 'claudeProfiles.list': return reply(claudeProfiles.list());
      case 'claudeProfiles.status': return reply(await claudeProfiles.status(payload.id));
      case 'claudeProfiles.setActive': return reply(claudeProfiles.setActive(payload.id));
      case 'claudeProfiles.create': return reply(claudeProfiles.create(payload.name));
      case 'claudeProfiles.remove': return reply(claudeProfiles.remove(payload.id));
      case 'claudeProfiles.loginStart': return reply(await claudeProfiles.loginStart(payload.id));
      case 'claudeProfiles.loginState': return reply(claudeProfiles.loginState());
      case 'claudeProfiles.loginCode': return reply(await claudeProfiles.loginCode(payload.code));
      case 'claudeProfiles.loginCancel': return reply(claudeProfiles.loginCancel());
      case 'persona.get': return reply({ style: persona.getStyle(), options: persona.listStyles() });
      case 'persona.set': return reply({ style: persona.setStyle(payload.style) });
      case 'runs.list': return reply(runStore.list(payload.projectId));
      case 'runs.get': return reply(runStore.get(payload.runId));
      case 'runs.log': return reply(runStore.readLog(payload.runId));
      case 'runs.stop': return reply(runStore.stop(payload.runId));
      case 'runs.activeCount': return reply(runStore.activeCount(payload.projectId));
      case 'runs.start': return reply(runStore.start({ projectId: payload.projectId, command: payload.command, cwd: payload.cwd, label: payload.label }));
      case 'queue.list': return reply(turnQueue.list(payload.projectId));
      case 'queue.enqueue': return reply(turnQueue.enqueue(payload.projectId, { text: payload.text, attachments: payload.attachments }));
      case 'queue.remove': return reply(turnQueue.remove(payload.projectId, payload.itemId));
      case 'queue.reorder': return reply(turnQueue.reorder(payload.projectId, payload.ids));
      case 'queue.clear': return reply(turnQueue.clear(payload.projectId));
      // O 'done' do processo morto já chega nos outros clients pelo fan-out de
      // eventos — quem parou foi um deles, mas todos precisam sair do "pensando".
      // Verdade sobre "ainda pensando?": o host sabe se o processo do turno segue
      // vivo. O client usa isso como watchdog quando perde o evento 'done' (relay
      // caiu no meio, minimizou, etc.) e o "pensando" ficaria preso pra sempre.
      // Checa as DUAS engines: só o claude aqui fazia um projeto Codex parecer
      // livre no meio do turno, e o watchdog do client tirava o "pensando".
      case 'claude.status': return reply({ busy: !!(claudePty.isBusy(payload.projectId) || codexPty.isBusy(payload.projectId)), known: true });
      // Upload em pedaços do .jsonl de uma sessão importada do client → grava no
      // dir de sessões do Claude DESTE host (o relay corta frames > 1MB, por isso
      // chunk). No último pedaço, promove .part → .jsonl e aponta o projeto pra ela.
      case 'sessions.uploadChunk': {
        try {
          const { projectId, sessionId, index, total, dataB64 } = payload || {};
          const p = projectStore.get(projectId);
          if (!p || !p.codeDir) return reply({ ok: false, error: 'project_not_found' });
          if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) return reply({ ok: false, error: 'bad_session_id' });
          const enc = path.resolve(p.codeDir).replace(/[^A-Za-z0-9]/g, '-');
          const dir = path.join(os.homedir(), '.claude', 'projects', enc);
          fs.mkdirSync(dir, { recursive: true });
          const part = path.join(dir, sessionId + '.jsonl.part');
          if ((index | 0) === 0) { try { fs.unlinkSync(part); } catch {} }
          if (dataB64) fs.appendFileSync(part, Buffer.from(dataB64, 'base64'));
          if ((index | 0) + 1 >= (total | 0)) {
            fs.renameSync(part, path.join(dir, sessionId + '.jsonl'));
            const up = projectStore.patch(projectId, { sessionId });
            try { broadcastProjectPatch(up || projectStore.get(projectId)); } catch {}
            return reply({ ok: true, done: true, received: (index | 0) + 1, total });
          }
          return reply({ ok: true, done: false, received: (index | 0) + 1, total });
        } catch (e) { return reply({ ok: false, error: String(e && e.message || e) }); }
      }
      case 'projects.delete': {
        // Client remoto (inclui container cloud) pede pra APAGAR o projeto NO
        // host: mata o processo, remove do projectStore, apaga os arquivos de
        // sessão do Claude e o código clonado, e avisa os clients.
        const pid = payload && (payload.id || payload.projectId);
        const p = projectStore.get(pid);
        if (!p) return reply({ ok: false, error: 'project_not_found' });
        if (pid === projectStore.MAESTRUS_ID) return reply({ ok: false, error: 'cant_delete_maestrus' });
        try { claudePty.kill(pid); } catch {}
        try {
          if (p.codeDir) {
            const enc = path.resolve(p.codeDir).replace(/[^A-Za-z0-9]/g, '-');
            fs.rmSync(path.join(os.homedir(), '.claude', 'projects', enc), { recursive: true, force: true });
            fs.rmSync(path.resolve(p.codeDir), { recursive: true, force: true });
          }
        } catch (e) { /* best-effort: some o registro mesmo que os arquivos resistam */ }
        const ok = projectStore.remove(pid);
        try { broadcastProjectRemoved(pid); } catch {}
        return reply({ ok: !!ok });
      }
      case 'projects.patch': {
        // permite o client remoto trocar modelo/thinking/engine/permissão/nome
        const allowed = {};
        for (const k of ['model', 'thinkingMode', 'permissionMode', 'engine', 'name', 'voiceMode']) {
          if (payload.patch && payload.patch[k] !== undefined) allowed[k] = payload.patch[k];
        }
        const updated = projectStore.patch(payload.id, allowed);
        if (updated) broadcastProjectPatch(updated);
        return reply(updated);
      }
      // ─── Conversas (forks) por projeto — espelham conversations:* do main ──
      case 'conversations.create': {
        const p = projectStore.get(payload.projectId);
        if (!p) return fail('Projeto não encontrado');
        let forkFrom = null;
        if (payload.forkFromConvId === 'main') forkFrom = p.sessionId || null;
        else if (payload.forkFromConvId) {
          const src = (projectStore.listConversations(payload.projectId) || []).find((c) => c.id === payload.forkFromConvId);
          forkFrom = (src && (src.sessionId || src.forkFrom)) || null;
        }
        const conv = projectStore.createConversation(payload.projectId, { title: payload.title, forkFrom });
        const next = projectStore.get(payload.projectId);
        if (next) broadcastProjectPatch(next);
        return reply(conv);
      }
      case 'conversations.rename': {
        const conv = projectStore.patchConversation(payload.projectId, payload.convId, { title: payload.title });
        const next = projectStore.get(payload.projectId);
        if (next) broadcastProjectPatch(next);
        return reply(conv);
      }
      case 'conversations.delete': {
        claudePty.kill(payload.projectId + projectStore.CONV_SEP + payload.convId);
        const conv = projectStore.deleteConversation(payload.projectId, payload.convId);
        try {
          const p = projectStore.get(payload.projectId);
          if (p && conv && conv.sessionId) claudePty.deleteSessionFile(p, conv.sessionId);
        } catch {}
        const next = projectStore.get(payload.projectId);
        if (next) broadcastProjectPatch(next);
        return reply(!!conv);
      }
      case 'ping': return reply({ ok: true, t: Date.now() });

      // ─── Slash commands remotos (Maestrus client → host) ──────────────────
      // Espelham os handlers claude:* do main.js; usados quando o cliente é
      // remoto e o comando (/compact, /usage, /version, /agents, /memories,
      // /logout) precisa rodar NO host onde o CLI + sessão realmente moram.
      case 'claude.compact': {
        const p = projectStore.get(payload.projectId);
        if (!p) return fail('Projeto não encontrado');
        if (!p.sessionId) return reply({ ok: false, error: 'A sessão ainda não começou — nada pra compactar.' });
        claudePty.backupSessionFile(p);
        let res;
        try { res = await claudePty.dispatchOneShot(p, buildCompactPrompt(payload.focus), { forkSession: true }); }
        catch (e) { return reply({ ok: false, error: `Falha ao gerar resumo: ${e && e.message || e}. Sessão preservada (backup .bak salvo).` }); }
        const summary = (res.text || '').trim();
        if (!summary) return reply({ ok: false, error: 'Não consegui gerar o resumo. Sessão preservada (backup .bak).' });
        try { if (res.sessionId && res.sessionId !== p.sessionId) claudePty.deleteSessionFile(p, res.sessionId); } catch {}
        try { claudePty.compactSessionFile(p, summary); } catch (e) { return reply({ ok: false, error: `Falha ao reescrever a sessão: ${e && e.message}` }); }
        try { claudePty.clearMemBlock(p.id); } catch {}
        return reply({ ok: true, summary });
      }
      case 'claude.compactRestore': {
        const p = projectStore.get(payload.projectId);
        if (!p) return fail('Projeto não encontrado');
        const ok = claudePty.restoreSessionFile(p);
        if (ok) try { claudePty.clearMemBlock(p.id); } catch {}
        return reply({ ok, error: ok ? undefined : 'Nenhum backup (.bak) encontrado para este projeto.' });
      }
      case 'claude.usage': {
        // Uso REAL da conta Claude deste host (endpoint OAuth oficial).
        if (!usageMod || !usageMod.real) return reply({ ok: false, error: 'usage_indisponivel' });
        return usageMod.real().then((r) => reply(r)).catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
      }
      case 'claude.version': {
        return new Promise((resolvePromise) => {
          const { spawn } = require('child_process');
          const proc = spawn(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['--version'], { shell: process.platform === 'win32' });
          let out = '';
          proc.stdout.on('data', (d) => (out += d.toString()));
          proc.stderr.on('data', (d) => (out += d.toString()));
          proc.on('close', () => { reply(out.trim()); resolvePromise(); });
          proc.on('error', (e) => { reply('erro: ' + e.message); resolvePromise(); });
        });
      }
      case 'claude.logout': {
        return new Promise((resolvePromise) => {
          const { spawn } = require('child_process');
          const proc = spawn(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['logout'], { shell: process.platform === 'win32' });
          let out = '';
          proc.stdout.on('data', (d) => (out += d.toString()));
          proc.stderr.on('data', (d) => (out += d.toString()));
          proc.on('close', (code) => { reply({ code, output: out.trim() }); resolvePromise(); });
          proc.on('error', (e) => { reply({ code: -1, output: e.message }); resolvePromise(); });
        });
      }
      // ─── Upload de anexo do CLIENT pro host ────────────────────────────────
      // O client manda o CONTEÚDO (base64); o host grava em .maestrus/uploads/
      // do projeto e devolve o path local — o @path no prompt passa a apontar
      // pra um arquivo que o CLI consegue ler (antes vinha o path da máquina
      // do client, inacessível aqui).
      case 'files.upload': {
        try {
          const proj = projectStore.get(payload.projectId);
          const dataB64 = String(payload.dataB64 || '');
          if (!dataB64) return reply({ ok: false, error: 'empty' });
          const buf = Buffer.from(dataB64, 'base64');
          if (buf.length > 50 * 1024 * 1024) return reply({ ok: false, error: 'too_big' });
          const dest = uploadDest(proj, payload.name);
          fs.writeFileSync(dest, buf);
          return reply({ ok: true, path: dest, rel: relOf(proj, dest), size: buf.length });
        } catch (e) { return reply({ ok: false, error: String(e && e.message || e) }); }
      }
      // Upload EM PEDAÇOS (arquivo grande não cabe num frame do relay). O client
      // manda chunks; no último, o host junta e devolve o path final — nome
      // sempre SEGURO (sem espaços/acentos) pra a referência @ do Claude funcionar.
      case 'files.uploadChunk': {
        try {
          const { uploadId, name, index, total, dataB64 } = payload || {};
          const proj = projectStore.get(payload.projectId);
          if (!uploadId || !/^[A-Za-z0-9._-]+$/.test(String(uploadId))) return reply({ ok: false, error: 'bad_upload_id' });
          const tmp = path.join(os.tmpdir(), 'maestrus-uploads', '.part-' + uploadId);
          fs.mkdirSync(path.dirname(tmp), { recursive: true });
          if ((index | 0) === 0) { try { fs.unlinkSync(tmp); } catch {} }
          if (dataB64) fs.appendFileSync(tmp, Buffer.from(dataB64, 'base64'));
          if ((index | 0) + 1 >= (total | 0)) {
            const dest = uploadDest(proj, name);
            try { fs.renameSync(tmp, dest); }
            catch { fs.copyFileSync(tmp, dest); try { fs.unlinkSync(tmp); } catch {} } // cross-device
            const size = (() => { try { return fs.statSync(dest).size; } catch { return 0; } })();
            return reply({ ok: true, done: true, path: dest, rel: relOf(proj, dest), size });
          }
          return reply({ ok: true, done: false, received: (index | 0) + 1, total });
        } catch (e) { return reply({ ok: false, error: String(e && e.message || e) }); }
      }
      // ─── DOWNLOAD universal (host → client): espelho do upload ────────────
      // Resolve o "arquivo fica no host e o client não acessa": o client lista a
      // árvore do workspace e baixa/preview qualquer arquivo (chunked se grande).
      // Toda resolução de path é SEGURA (dentro do codeDir) — ver file-access.js.
      case 'files.tree': {
        const proj = projectStore.get(payload.projectId);
        return reply(fileAccess.tree(proj && proj.codeDir, payload.dir));
      }
      case 'files.read': {
        const proj = projectStore.get(payload.projectId);
        return reply(fileAccess.readFile(proj && proj.codeDir, payload.rel));
      }
      case 'files.readChunk': {
        const proj = projectStore.get(payload.projectId);
        return reply(fileAccess.readChunk(proj && proj.codeDir, payload.rel, payload.offset, payload.length));
      }
      // ─── Powers (agents/comandos/regras do host) — web/PWA ─────────
      case 'claudePowers.agentsList': return reply(claudePowers.agents.list());
      case 'claudePowers.agentsGet': return reply(claudePowers.agents.get(payload.id));
      case 'claudePowers.agentsSave': return reply(claudePowers.agents.save(payload));
      case 'claudePowers.agentsDelete': return reply(claudePowers.agents.remove(payload.id));
      case 'claudePowers.commandsList': return reply(claudePowers.commands.list());
      case 'claudePowers.commandsGet': return reply(claudePowers.commands.get(payload.id));
      case 'claudePowers.commandsSave': return reply(claudePowers.commands.save(payload));
      case 'claudePowers.commandsDelete': return reply(claudePowers.commands.remove(payload.id));
      case 'claudePowers.globalMdGet': return reply(claudePowers.globalMd.get());
      case 'claudePowers.globalMdSet': return reply(claudePowers.globalMd.set(payload.content));
      case 'claudePowers.skillsList': return claudePowers.skills.list().then(reply);
      case 'claudePowers.skillsGet': return claudePowers.skills.get(payload.id).then(reply);
      case 'claudePowers.skillsSave': return claudePowers.skills.save(payload).then(reply);
      case 'claudePowers.skillsDelete': return claudePowers.skills.remove(payload.id).then(reply);
      case 'claudePowers.mcpList': return claudePowers.mcp.list().then(reply);
      case 'claudePowers.mcpRemove': return claudePowers.mcp.remove(payload.name).then(reply);
      // ─── Multi-conta do Claude CLI (perfis) — controlável do web/PWA ───────
      case 'claudeProfiles.list': return reply(claudeProfiles.list());
      case 'claudeProfiles.setActive': return reply(claudeProfiles.setActive(payload.id));
      case 'claudeProfiles.create': return reply(claudeProfiles.create(payload.name));
      case 'claudeProfiles.remove': return reply(claudeProfiles.remove(payload.id));
      case 'claudeProfiles.status': {
        return claudeProfiles.status(payload.id).then((r) => reply(r)).catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
      }
      case 'claudeProfiles.loginStart': return reply(claudeProfiles.loginStart(payload.id));
      case 'claudeProfiles.loginState': return reply(claudeProfiles.loginState());
      case 'claudeProfiles.loginCode': return reply(claudeProfiles.loginCode(payload.code));
      case 'claudeProfiles.loginCancel': return reply(claudeProfiles.loginCancel());
      // Estado da conta Claude DO HOST. Sem isto o client checava o login da
      // PRÓPRIA máquina e concluía "sem Claude, só Codex" mesmo com o host
      // logado — as telas ficavam dessincronizadas.
      case 'claude.authStatus':
        return claudeProfiles.status(payload && payload.id)
          .then((r) => reply(r))
          .catch(() => claudeAuth.status().then((r) => reply(r)).catch((e) => reply({ ok: false, loggedIn: false, error: String(e && e.message || e) })));
      // Login do Codex CLI pelo client (web/mobile) — device-auth, por polling.
      case 'codex.status': return codexAuth.status().then((r) => reply(r)).catch((e) => reply({ ok: false, loggedIn: false, error: String(e && e.message || e) }));
      case 'codex.loginStart': return reply(codexAuth.loginStart(payload || {}));
      case 'codex.loginState': return reply(codexAuth.loginState());
      case 'codex.loginCode': return reply(codexAuth.loginCode(payload.code));
      case 'codex.loginCancel': return reply(codexAuth.loginCancel());
      case 'codex.logout': return codexAuth.logout().then((r) => reply(r)).catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
      case 'claude.listAgents': {
        const dirs = [path.join(os.homedir(), '.claude', 'agents')];
        if (payload.projectId) {
          const p = projectStore.get(payload.projectId);
          if (p?.codeDir) dirs.push(path.join(p.codeDir, '.claude', 'agents'));
        }
        const agents = [];
        for (const dir of dirs) {
          if (!fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
            try {
              const content = fs.readFileSync(path.join(dir, f), 'utf8');
              const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
              let name = f.replace(/\.md$/, '');
              let description = '';
              if (m) {
                const nameLine = m[1].match(/^name:\s*(.+)$/m);
                const descLine = m[1].match(/^description:\s*(.+)$/m);
                if (nameLine) name = nameLine[1].trim();
                if (descLine) description = descLine[1].trim();
              }
              agents.push({ name, description, path: path.join(dir, f) });
            } catch {}
          }
        }
        return reply(agents);
      }
      case 'claude.listMemories': {
        const homeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        const memories = [];
        if (fs.existsSync(homeMd)) memories.push({ scope: 'user', path: homeMd, size: fs.statSync(homeMd).size });
        return reply(memories);
      }

      default: return fail('canal-desconhecido: ' + channel);
    }
  } catch (e) { fail(e && e.message ? e.message : String(e)); }
}

// Inicia o modo host. opts: { url, token, deviceId, allowBypass?, refreshTokenFn? }
function start(opts) {
  if (link) stop();
  allowBypass = !!opts.allowBypass;
  link = new RelayLink({
    url: opts.url,
    token: opts.token,
    deviceId: opts.deviceId,
    role: 'host',
    WebSocketImpl,
    hostInfo: hostInfo(),
    onRpcRequest: handleRpc,
    refreshTokenFn: opts.refreshTokenFn,
    onIdentityConflict: opts.onIdentityConflict,
    // Presence: quando um client cai, remove do set de subscribers. Sem isso,
    // o host continua tentando enviar eventos a deviceIds mortos (swallow
    // silencioso). Bug #2 do remote control diagnosticado anteriormente.
    onPresence: (f) => { if (f && f.online === false && f.deviceId) subscribers.delete(f.deviceId); },
    onStatus: (s) => { state.status = s; onState && onState({ ...state }); },
  });
  // Repassa TODOS os eventos do claude pros clients assinantes.
  // Limite: relay corta frames > 1MB. Um tool-result com 5MB de output
  // (saída de Bash, dump SQL, etc.) fechava a conexão. Tronco aqui.
  const MAX_EVENT_TEXT = 200_000; // ~200KB por evento — cobre output normal
  const MAX_EVENT_INPUT = 50_000;
  unsub = claudePty.onEvent((payload) => {
    let p = payload;
    if (p && typeof p === 'object') {
      let needsClone = false;
      if (typeof p.text === 'string' && p.text.length > MAX_EVENT_TEXT) needsClone = true;
      if (p.input && typeof p.input === 'object') {
        try { if (JSON.stringify(p.input).length > MAX_EVENT_INPUT) needsClone = true; } catch {}
      }
      if (needsClone) {
        p = { ...payload };
        if (typeof p.text === 'string' && p.text.length > MAX_EVENT_TEXT) {
          p.text = p.text.slice(0, MAX_EVENT_TEXT) + `\n…[truncado: +${payload.text.length - MAX_EVENT_TEXT} chars]`;
        }
        if (p.input && typeof p.input === 'object') {
          try {
            const s = JSON.stringify(p.input);
            if (s.length > MAX_EVENT_INPUT) {
              p.input = { __truncated: true, __originalSize: s.length, preview: s.slice(0, MAX_EVENT_INPUT) + '…' };
            }
          } catch { p.input = null; }
        }
      }
    }
    // Fan-out FILTRADO por projeto: um guest de share só recebe eventos dos
    // projetos no seu escopo. Eventos sem projectId (ou '*') só vão pros devices
    // com acesso total. Antes ia pra todo mundo → vazamento entre contas.
    const evPid = (p && (p.projectId || (p.project && p.project.id))) || null;
    for (const [did, entry] of subscribers) {
      if (!subCanSeePid(entry, evPid)) continue;
      try { link.sendEvent(did, 'claude', p); } catch {}
    }
    try { maybeWebPush(p); } catch {}
  });
  link.connect();
  state = { running: true, status: 'connecting', error: null };
  onState && onState({ ...state });
  return { ok: true };
}

function refreshProjects() { if (link) link.registerHost(hostInfo()); }

// Atualiza o token (o relay_token expira em ~10min; main renova periodicamente
// pra reconexões continuarem autenticando).
function updateToken(token) { if (link && token) link.opts.token = token; }

function stop() {
  try { unsub && unsub(); } catch {}
  unsub = null;
  subscribers.clear();
  try { link && link.close(); } catch {}
  link = null;
  state = { running: false, status: 'idle', error: null };
  onState && onState({ ...state });
  return { ok: true };
}

function broadcastProjectPatch(updated) {
  if (!link || subscribers.size === 0 || !updated) return;
  // SANITIZA (safeProject) — antes mandava o objeto CRU do projectStore, vazando
  // codeDir/localPath/ssh que a lista inicial deliberadamente omite. E filtra por
  // escopo do subscriber.
  const safe = safeProject(updated);
  if (!safe) return;
  for (const [did, entry] of subscribers) {
    if (!subCanSeePid(entry, safe.id)) continue;
    try { link.sendEvent(did, 'claude', { type: 'project.updated', project: safe }); } catch {}
  }
}

function broadcastProjectRemoved(pid) {
  if (!link || subscribers.size === 0 || !pid) return;
  for (const [did, entry] of subscribers) {
    if (!subCanSeePid(entry, pid)) continue;
    try { link.sendEvent(did, 'claude', { type: 'project.removed', projectId: pid }); } catch {}
  }
}

function getState() { return { ...state }; }
function isHealthy(maxAgeMs = 30000) { return !!(link && link.isHealthy && link.isHealthy(maxAgeMs)); }
function setOnState(fn) { onState = fn; }
// Quantos clients ativos estão assinando eventos (usado pelo maestrus-server
// pra decidir se manda web push quando ninguém está olhando).
function subscriberCount() { return subscribers.size; }

module.exports = { start, stop, refreshProjects, updateToken, getState, isHealthy, setOnState, broadcastProjectPatch, subscriberCount };
