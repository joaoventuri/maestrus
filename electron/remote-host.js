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
// ─── SEGUNDA SALA (equipe por convite) ──────────────────────────────────────
// O host precisa viver em DUAS salas ao mesmo tempo: a da conta (os devices do
// dono, descoberta automática) e a do convite (a equipe). Antes era uma só —
// criar a sala da equipe DERRUBAVA a conexão dos devices do dono e vice-versa;
// era o "demorou pra carregar e deu erro" ao gerar o link de acesso.
let teamLink = null;
let teamRoomUrl = null;
// De qual sala cada device fala conosco — o fan-out de eventos responde pela
// mesma porta em que o device bateu.
const linkOf = new Map();
let unsub = null;
// deviceId -> { pids: Set<string>|null, write: bool }. pids=null → acesso total
// (device do próprio dono / membro full). pids=Set → guest de share, só recebe
// eventos e RPC dos projetos permitidos. Antes era um Set cru: QUALQUER guest
// virava assinante de TODOS os projetos (vazava streaming/tool-results de
// projetos não compartilhados). Agora o push é filtrado por projeto.
const subscribers = new Map();

// ─── EQUIPE com escopo (convite v2) ─────────────────────────────────────────
// O host é o único juiz do que cada device pode ver. O relay não sabe nada;
// a prova de acesso é o `team.hello`: FULL prova que conhece o segredo da
// sala (fullMac amarrado ao deviceId), SCOPED apresenta o grant assinado com
// a chave derivada do segredo. O binding ganha um `sid` aleatório que TODA
// chamada seguinte precisa ecoar — se alguém derrubar a conexão de um colega
// e assumir o deviceId dele no relay, não herda o acesso: não tem o sid.
const inviteLib = require('./invite');
const nodeCrypto = require('crypto');
let teamSecret = null;                 // segredo da sala do convite (setado pelo main)
let _ensureTeamRoomFn = null;          // main injeta: cria/abre a sala e devolve {secret, relayUrl}
function setEnsureTeamRoom(fn) { _ensureTeamRoomFn = fn; }
function setTeamSecret(s) { teamSecret = s || null; if (!teamSecret) teamBindings.clear(); }
const teamBindings = new Map();        // did → { pids:Set|null, write, name, sid, grantId? }
function activeGrants() {
  try {
    const all = projectStore.getSetting('invite_grants') || [];
    return all.filter((g) => g && !g.revoked && (!g.e || Date.now() < g.e));
  } catch { return []; }
}
// ─── IA por PARTICIPANTE: cada membro da equipe pode plugar a PRÓPRIA conta
// do Claude. O turno que ELE dispara roda num perfil (claude-profiles) só
// dele — mesma conversa, mesmo transcript, contas separadas. A chave é o
// grant (estável entre devices da mesma pessoa) ou o deviceId.
function teamAiKeyFor(from) {
  const bnd = teamBindings.get(from);
  return bnd && bnd.grantId ? 'g:' + bnd.grantId : 'd:' + from;
}
function teamAiMap() { try { return projectStore.getSetting('team_ai_profiles') || {}; } catch { return {}; } }
// Valor do mapa: string (legado, uma conta) ou array (pool). Sempre lê como lista.
function teamAiPool(key) {
  const v = teamAiMap()[key];
  return Array.isArray(v) ? v.filter(Boolean) : (v ? [String(v)] : []);
}
function teamAiSetPool(key, pool) {
  const m = teamAiMap();
  if (pool && pool.length) m[key] = pool.length === 1 ? pool[0] : pool; else delete m[key];
  try { projectStore.setSetting('team_ai_profiles', m); } catch {}
}
// Uso oficial (5h/semana) por perfil, com cache curto: a escolha da conta do
// turno não pode custar uma chamada de rede a cada mensagem.
const _usageCache = new Map();       // profileId → { pct, at, loggedIn }
const USAGE_TTL = 3 * 60 * 1000;
function refreshUsage(pid) {
  const hit = _usageCache.get(pid);
  if (hit && Date.now() - hit.at < USAGE_TTL) return;
  _usageCache.set(pid, { pct: hit ? hit.pct : 0, at: Date.now(), loggedIn: hit ? hit.loggedIn : true });
  (async () => {
    let pct = 0; let loggedIn = true;
    try {
      const u = await require('./usage').real(pid);
      if (u && u.ok === false && /no_credentials|auth_expired/.test(String(u.error || ''))) loggedIn = false;
      for (const l of (u && u.limits) || []) pct = Math.max(pct, Number(l.percent) || 0);
    } catch {}
    _usageCache.set(pid, { pct, at: Date.now(), loggedIn });
  })();
}
let _rr = 0;
// A conta que roda o turno de um device da equipe: SEMPRE a que o dono fixou
// no acesso (grant). Com mais de uma no pool, a menos consumida no momento —
// invisível pra quem usa. Sem pool → conta ativa do host (null).
function teamAiProfileFor(from) {
  const bnd = teamBindings.get(from);
  const pool = bnd && bnd.grantId ? teamAiPool('g:' + bnd.grantId) : [];
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];
  for (const pid of pool) refreshUsage(pid);
  const live = pool.filter((pid) => { const c = _usageCache.get(pid); return !c || c.loggedIn !== false; });
  const cands = live.length ? live : pool;
  let best = null; let bestPct = Infinity;
  for (const pid of cands) {
    const c = _usageCache.get(pid); const pct = c ? c.pct : 0;
    if (pct < bestPct) { best = pid; bestPct = pct; }
  }
  // Empate (ninguém consumiu ainda): alterna, pra não viciar numa só.
  if (cands.every((pid) => { const c = _usageCache.get(pid); return !c || c.pct === bestPct; })) return cands[(_rr++) % cands.length];
  return best;
}
// Recriar o acesso do MESMO e-mail (revogou e gerou de novo) não pode
// perder a conta do Claude configurada: o pool do acesso anterior desse
// e-mail passa pro novo. Sem isso o time caía silenciosamente na conta do host.
function inheritTeamAi(newGrantId, email, grants) {
  if (!email) return;
  const prev = (grants || []).filter((g) => g && g.id !== newGrantId && g.email === email && teamAiPool('g:' + g.id).length)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (!prev) return;
  const pool = teamAiPool('g:' + prev.id);
  teamAiSetPool('g:' + newGrantId, pool);
  if (prev.revoked) teamAiSetPool('g:' + prev.id, []);
}
function teamAiBind(from, profileId) {
  const key = teamAiKeyFor(from);
  teamAiSetPool(key, profileId ? [profileId] : []);
}

// Admin da IA de um GRANT: o dono configura a conta do Claude que o TIME
// daquele acesso vai gastar (ex.: 5 pessoas na conta tecnologia@ → 1 grant →
// 1 perfil "Equipe"). Mesmo mapa do fluxo self (g:<grantId>), então tanto faz
// quem plugou — dono por aqui ou o convidado pelos ajustes do chat.
// Revogação de verdade: marcar o grant como revogado não bastava — o device
// já conectado tinha um binding (sid) vivo e continuava lendo e escrevendo até
// o host reiniciar. Derrubar o binding fecha a porta na hora: o próximo RPC
// exige hello, e o hello do grant revogado é recusado.
function dropGrantBindings(grantId) {
  let n = 0;
  for (const [did, b] of teamBindings) {
    if (b && b.grantId === String(grantId)) {
      teamBindings.delete(did);
      subscribers.delete(did);
      linkOf.delete(did);
      peers.delete(did);
      n++;
    }
  }
  if (n) { try { onState && onState(getState()); } catch {} }
  return n;
}

async function teamAiAdmin(op, grantId, code) {
  const key = 'g:' + String(grantId || '');
  if (!grantId) return { ok: false, error: 'grant_required' };
  const pool = teamAiPool(key);
  // Fluxo de login em andamento pertence ao perfil "Equipe" mais recente do pool.
  let prof = pool.length ? pool[pool.length - 1] : null;
  const isTeamProfile = (pid) => { try { return (claudeProfiles.list().profiles.find((x) => x.id === pid) || {}).name?.startsWith('Equipe:'); } catch { return false; } };
  const statusOf = async () => {
    const accounts = [];
    for (const pid of teamAiPool(key)) {
      const st = await claudeProfiles.status(pid).catch(() => null);
      accounts.push({ id: pid, email: (st && st.email) || null, loggedIn: !!(st && st.loggedIn) });
    }
    const first = accounts.find((a) => a.loggedIn) || accounts[0] || null;
    return { ok: true, bound: accounts.length > 0, accounts, email: first ? first.email : null, loggedIn: accounts.some((a) => a.loggedIn) };
  };
  switch (op) {
    case 'status': return statusOf();
    case 'loginStart': {
      // Conta NOVA no pool: cria um perfil "Equipe" e loga nele. Um perfil
      // Equipe ainda não logado (login abandonado) é reaproveitado.
      let target = pool.find((pid) => isTeamProfile(pid) && !claudeProfilesLoggedSync(pid));
      if (!target) {
        const c = claudeProfiles.create(`Equipe: ${String(grantId).slice(0, 8)}`);
        if (!c || !c.ok) return { ok: false, error: 'profile_create_failed' };
        target = c.id;
        teamAiSetPool(key, [...pool, target]);
      }
      prof = target;
      return claudeProfiles.loginStart(prof);
    }
    case 'loginState': {
      const st = claudeProfiles.loginState();
      if (!prof || !st || st.profileId !== prof) return { active: false };
      return st;
    }
    case 'loginCode': {
      const st = claudeProfiles.loginState();
      if (!prof || !st || st.profileId !== prof) return { ok: false, error: 'no_login_flow' };
      return claudeProfiles.loginCode(String(code || ''));
    }
    case 'loginCancel': {
      const st = claudeProfiles.loginState();
      if (prof && st && st.profileId === prof) claudeProfiles.loginCancel();
      return { ok: true };
    }
    case 'bindExisting': {
      // Reaproveita uma conta JÁ logada nesta máquina como a conta do time.
      // Se ela era a ativa do dono, sai da ativa na hora ("bloqueia no meu").
      const pid = String(code || '');           // 3º arg carrega o profileId
      const all = claudeProfiles.list();
      if (!all.profiles.some((x) => x.id === pid)) return { ok: false, error: 'profile_not_found' };
      if (!pool.includes(pid)) teamAiSetPool(key, [...pool, pid]);
      try { if (claudeProfiles.getActive() === pid) claudeProfiles.setActive('default', { force: true }); } catch {}
      return statusOf();
    }
    case 'listProfiles': {
      // Contas desta máquina, pra UI oferecer o reaproveitamento.
      const all = claudeProfiles.list();
      return { ok: true, active: all.active, profiles: all.profiles };
    }
    case 'unbind': {
      // 3º arg = profileId a tirar do pool; vazio = esvazia. Só APAGA o perfil
      // se ele nasceu para a equipe ("Equipe: …") — uma conta do dono
      // reaproveitada volta a ser dele, não some da máquina.
      const one = String(code || '');
      const drop = one ? pool.filter((pid) => pid === one) : pool;
      teamAiSetPool(key, one ? pool.filter((pid) => pid !== one) : []);
      for (const pid of drop) { if (isTeamProfile(pid)) { try { claudeProfiles.remove(pid); } catch {} } }
      return statusOf();
    }
    default: return { ok: false, error: 'bad_op' };
  }
}

// Perfil já tem credencial gravada? (síncrono, sem rede) — pra reaproveitar um
// perfil Equipe cujo login foi abandonado em vez de criar outro.
function claudeProfilesLoggedSync(pid) {
  try { return !!(claudeProfiles.hasCredentials && claudeProfiles.hasCredentials(pid)); } catch { return false; }
}
function timingEq(a, b) {
  const ba = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && nodeCrypto.timingSafeEqual(ba, bb);
}
const _histCache = new Map(); // projectId → { mtime, size, payload } — reabrir conversa sem re-parsear
let state = { running: false, status: 'idle', error: null };
// Equipe: devices de OUTRAS pessoas presentes na sala (via presence do relay).
const peers = new Map();
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
  // Compartilhamento com escopo: criar/revogar acesso é poder de dono. Um
  // convidado (de share OU de grant) jamais emite convites da sala.
  'team.createScoped', 'team.grants', 'team.revokeGrant',
  'team.ai.adminStatus', 'team.ai.adminLoginStart', 'team.ai.adminLoginState',
  'team.ai.adminLoginCode', 'team.ai.adminLoginCancel', 'team.ai.adminUnbind',
  'team.ai.adminBindExisting', 'team.ai.adminListProfiles',
  // Contas do Claude do host: trocar/criar/remover afeta TODAS as conversas
  // da máquina e mexe no OAuth do dono. Nunca para um convidado de share.
  'claudeProfiles.list', 'claudeProfiles.status', 'claudeProfiles.setActive',
  'claudeProfiles.create', 'claudeProfiles.remove',
  'claudeProfiles.loginStart', 'claudeProfiles.loginState',
  'claudeProfiles.loginCode', 'claudeProfiles.loginCancel',
]);

// Um subscriber (entry do Map) pode receber evento/RPC deste projeto?
// Sub-conversa (fork) chega como `<pid>#<convId>` — o escopo é do PROJETO:
// quem vê o projeto vê todas as conversas dele. Comparar o id exato negava
// qualquer fork pro convidado (e a negativa virava timeout na tela).
function basePid(pid) { const s = String(pid || ''); const i = s.indexOf('#'); return i > 0 ? s.slice(0, i) : s; }
function subCanSeePid(entry, pid) {
  if (!entry) return false;
  if (entry.pids === null) return true;        // acesso total (dono/membro)
  if (!pid || pid === '*') return false;       // evento global → só acesso total
  return entry.pids.has(basePid(pid));
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

async function handleRpc(f, reply, fail, viaTeamRoom = false) {
  const { channel, payload, from, shareClaims } = f;

  // Registra/atualiza o subscriber COM escopo. shareClaims presente = guest de
  // share (escopo por pids + papel); ausente = device do próprio dono / membro
  // full (acesso total). O escopo é reavaliado a cada RPC (o token pode ter
  // mudado). Antes: subscribers.add(from) cru → guest recebia tudo.
  const isShare = !!shareClaims;
  const isMember = isShare && shareClaims.member === true;   // membro de workspace
  const isGuest = isShare && !isMember;                       // guest de share por-projeto

  // ─── EQUIPE: hello + binding por sid ──────────────────────────────────────
  if (!isShare && channel === 'team.hello') {
    if (!teamSecret) return reply({ ok: false, error: 'no_room' });
    const name = String((payload && payload.name) || '').slice(0, 40);
    // Da casa: prova que conhece o segredo, amarrada a ESTE deviceId.
    if (payload && payload.full && timingEq(payload.full, inviteLib.fullMac(teamSecret, from))) {
      const sid = nodeCrypto.randomBytes(12).toString('base64url');
      teamBindings.set(from, { pids: null, write: true, name, sid });
      subscribers.set(from, { pids: null, write: true });
      return reply({ ok: true, sid, full: true });
    }
    // Convidado com escopo: grant assinado + ainda listado (revogável) na loja.
    if (payload && payload.grant && inviteLib.verifyGrant(teamSecret, payload.grant, payload.grantSig)) {
      const g = payload.grant;
      const rec = activeGrants().find((x) => x.id === g.id);
      if (!rec) return reply({ ok: false, error: 'revoked' });
      const sid = nodeCrypto.randomBytes(12).toString('base64url');
      const pids = new Set(g.p.map(String));
      teamBindings.set(from, { pids, write: !!g.w, name, sid, grantId: g.id });
      subscribers.set(from, { pids, write: !!g.w });
      return reply({ ok: true, sid, pids: [...pids], write: !!g.w });
    }
    return reply({ ok: false, error: 'invalid' });
  }
  if (!isShare && teamSecret) {
    const bound = teamBindings.get(from);
    const sidOk = !!(bound && payload && payload.__sid === bound.sid);
    if (bound && sidOk) {
      subscribers.set(from, { pids: bound.pids, write: bound.write });
      if (bound.pids !== null) {
        // Convidado com escopo: MESMA régua default-deny do share guest.
        if (OWNER_ONLY_CHANNELS.has(channel)) return fail('acesso-negado');
        // Exceção deliberada: team.ai.* mexe SÓ no perfil de Claude do próprio
        // convidado (plugar a conta dele) — nunca na conta do host. Os canais
        // admin (dono configura a conta de QUALQUER grant) ficam de fora.
        const teamAiSelf = channel.startsWith('team.ai.') && !channel.startsWith('team.ai.admin');
        const allow = bound.write ? SHARE_WRITE_CHANNELS : SHARE_READ_CHANNELS;
        if (!teamAiSelf && !allow.has(channel)) return fail('acesso-negado');
        const targetPid = (payload && (payload.projectId || payload.id)) || null;
        if (channel !== 'projects.list' && targetPid && !bound.pids.has(basePid(targetPid))) return fail('acesso-negado');
        if (channel === 'projects.list') return reply(safeProjects().filter((p) => bound.pids.has(p.id)));
      }
    } else if (!viaTeamRoom) {
      // Sala da CONTA: o relay só aceita device com token da conta do dono —
      // é a autenticação de sempre, anterior ao convite. A régua do hello vale
      // SÓ para a sala do convite (room+proof circulam com os convidados);
      // exigi-la aqui cegava o próprio desktop do dono, que não tem o segredo
      // do convite e portanto não tem como provar fullMac.
      subscribers.set(from, { pids: null, write: true });
    } else if (activeGrants().length > 0) {
      // A sala do CONVITE tem grants com escopo → device sem hello verificado
      // não é tratado como "da casa". ping passa (health-check), o resto exige
      // hello — inclusive os devices do dono, que provam com o fullMac.
      if (channel === 'ping') return reply({ ok: true, helloRequired: true });
      if (channel === 'projects.list') return reply([]);
      return fail('team-hello-required');
    } else {
      subscribers.set(from, { pids: null, write: true });   // sala sem escopos: como sempre
    }
  }

  // Escopo de projetos: membro = todos (null); guest com pids = subset; guest
  // sem pids = nenhum (Set vazio); dono (sem claim) = todos (null).
  const allowedPids = isGuest
    ? (Array.isArray(shareClaims.pids) && shareClaims.pids.length > 0 ? new Set(shareClaims.pids) : new Set())
    : null;
  const canWrite = !isShare || shareClaims.p === 'write';
  if (isShare || !teamSecret) subscribers.set(from, { pids: allowedPids, write: canWrite });

  // Canais globais da conta: negados a QUALQUER não-dono (guest E membro).
  if (isShare && OWNER_ONLY_CHANNELS.has(channel)) return fail('acesso-negado');

  // GUEST: default-deny — canal na allowlist do papel + projeto-alvo no escopo.
  if (isGuest) {
    const allow = canWrite ? SHARE_WRITE_CHANNELS : SHARE_READ_CHANNELS;
    if (!allow.has(channel)) return fail('acesso-negado');
    const targetPid = (payload && (payload.projectId || payload.id)) || null;
    if (channel !== 'projects.list' && targetPid && !allowedPids.has(basePid(targetPid))) {
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
      // ─── IA por participante: plugar/usar a PRÓPRIA conta do Claude ─────
      case 'team.ai.status': {
        // Só informativo: a conta é a que o DONO fixou no acesso. O convidado
        // não pluga conta própria (o modelo é "quem entra usa a conta do dono").
        const prof = teamAiProfileFor(from);
        if (!prof) return reply({ ok: true, bound: false, ownerManaged: true });
        const st = await claudeProfiles.status(prof).catch(() => null);
        return reply({ ok: true, bound: true, ownerManaged: true, loggedIn: !!(st && st.loggedIn), email: (st && st.email) || null });
      }
      case 'team.ai.loginStart': {
        let prof = teamAiProfileFor(from);
        if (!prof) {
          const bnd = teamBindings.get(from);
          const c = claudeProfiles.create(`Equipe: ${(bnd && bnd.name) || String(from).slice(0, 8)}`);
          if (!c || !c.ok) return fail('profile_create_failed');
          prof = c.id;
          teamAiBind(from, prof);
        }
        return reply(claudeProfiles.loginStart(prof));
      }
      case 'team.ai.loginState': {
        // Privacidade: cada um só enxerga o PRÓPRIO fluxo de login.
        const prof = teamAiProfileFor(from);
        const st = claudeProfiles.loginState();
        if (!prof || !st || st.profileId !== prof) return reply({ active: false });
        return reply(st);
      }
      case 'team.ai.loginCode': {
        const prof = teamAiProfileFor(from);
        const st = claudeProfiles.loginState();
        if (!prof || !st || st.profileId !== prof) return fail('no_login_flow');
        return reply(claudeProfiles.loginCode(String(payload.code || '')));
      }
      case 'team.ai.loginCancel': {
        const prof = teamAiProfileFor(from);
        const st = claudeProfiles.loginState();
        if (prof && st && st.profileId === prof) claudeProfiles.loginCancel();
        return reply({ ok: true });
      }
      case 'team.ai.unbind': {
        const prof = teamAiProfileFor(from);
        teamAiBind(from, null);
        if (prof) { try { claudeProfiles.remove(prof); } catch {} }  // perfil era da equipe
        return reply({ ok: true });
      }

      case 'team.ai.adminStatus': return reply(await teamAiAdmin('status', payload.grantId));
      case 'team.ai.adminLoginStart': return reply(await teamAiAdmin('loginStart', payload.grantId));
      case 'team.ai.adminLoginState': return reply(await teamAiAdmin('loginState', payload.grantId));
      case 'team.ai.adminLoginCode': return reply(await teamAiAdmin('loginCode', payload.grantId, payload.code));
      case 'team.ai.adminLoginCancel': return reply(await teamAiAdmin('loginCancel', payload.grantId));
      case 'team.ai.adminUnbind': return reply(await teamAiAdmin('unbind', payload.grantId));
      case 'team.ai.adminBindExisting': return reply(await teamAiAdmin('bindExisting', payload.grantId, payload.code));
      case 'team.ai.adminListProfiles': return reply(await teamAiAdmin('listProfiles', payload.grantId || 'x'));

      // ─── Compartilhamento com ESCOPO, criado REMOTAMENTE pelo dono ──────
      // O caso real: as conversas vivem NESTA máquina (host), mas o dono está
      // no notebook (client). O grant precisa ser assinado com o segredo DESTA
      // sala e referenciar projetos DESTA máquina — então quem cria é o host,
      // a pedido. (Gerar no client produzia link com ids remote:<host>:<pid>
      // que o host nunca reconheceria — convidado entrava e via o vazio.)
      case 'team.createScoped': {
        let hostInv = (() => { try { return projectStore.getSetting('invite_host') || null; } catch { return null; } })();
        // Dono pediu grant e a sala nem existe ainda → cria na hora (o main
        // injeta o criador). Zero passos manuais no host.
        if ((!hostInv || !hostInv.secret) && _ensureTeamRoomFn) {
          try { hostInv = _ensureTeamRoomFn(); } catch {}
        }
        if (!hostInv || !hostInv.secret) return fail('no_room');
        const projects = (Array.isArray(payload.projects) ? payload.projects : [])
          .map(String).filter((pid) => !!projectStore.get(pid));
        if (!projects.length) return fail('projects_required');
        let sc;
        try {
          sc = inviteLib.createScoped({
            relayUrl: hostInv.relayUrl || require('./config').RELAY_URL,
            secret: hostInv.secret,
            hostName: os.hostname(),
            projects,
            write: payload.write !== false,
            ttlMs: Number(payload.ttlMs) > 0 ? Number(payload.ttlMs) : undefined,
          });
        } catch (e) { return fail(String(e && e.message || e)); }
        try {
          const all = projectStore.getSetting('invite_grants') || [];
          const email = String(payload.email || '').slice(0, 190) || undefined;
          all.push({ id: sc.grantId, p: projects, w: payload.write !== false, e: sc.expiresAt, email, createdAt: Date.now() });
          projectStore.setSetting('invite_grants', all);
          inheritTeamAi(sc.grantId, email, all);
        } catch {}
        return reply({ ok: true, code: sc.code, grantId: sc.grantId, expiresAt: sc.expiresAt, url: `${require('./config').BASE}/app#c=${sc.code}` });
      }
      case 'team.grants': {
        const all = (projectStore.getSetting('invite_grants') || [])
          .filter((g) => g && !g.revoked)
          .map((g) => ({ ...g, aiBound: teamAiPool('g:' + g.id).length > 0, aiCount: teamAiPool('g:' + g.id).length }));
        return reply({ ok: true, grants: all });
      }
      case 'team.revokeGrant': {
        try {
          const all = projectStore.getSetting('invite_grants') || [];
          for (const g of all) if (g && g.id === String(payload.id)) g.revoked = true;
          projectStore.setSetting('invite_grants', all);
        } catch {}
        dropGrantBindings(payload.id);   // corta quem JÁ está dentro, agora
        return reply({ ok: true });
      }

      case 'claude.send': {
        const p = projectStore.get(payload.projectId);
        if (!p) return fail('Projeto não encontrado');
        // EQUIPE: quem escreveu viaja com a mensagem e vira prefixo "Nome: ".
        // Prefixar AQUI (e não no client) garante consistência: o transcript, o
        // modelo e todos os devices da sala veem o mesmo autor — e o modelo
        // passa a saber COM QUEM está falando numa conversa de várias pessoas.
        let msg = String(payload.message || '');
        const author = String(payload.author || '').trim().slice(0, 40);
        if (author && !msg.trimStart().startsWith('/')) msg = `${author}: ${msg}`;
        // Conta do AUTOR: se este device plugou a própria conta do Claude, o
        // turno roda no perfil dele — mesma conversa, gasto separado.
        const prof = teamAiProfileFor(from);
        await ptyForRH(p).send(clampForRemote(p), msg, prof ? { profileId: prof } : {});
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
      case 'queue.enqueue': {
        let qt = String(payload.text || '');
        const qa = String(payload.author || '').trim().slice(0, 40);
        if (qa && !qt.trimStart().startsWith('/')) qt = `${qa}: ${qt}`;
        return reply(turnQueue.enqueue(payload.projectId, { text: qt, attachments: payload.attachments, author: qa || undefined, profileId: teamAiProfileFor(from) || undefined }));
      }
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
        // permite o client remoto trocar modelo/thinking/engine/permissão/nome.
        // CONVIDADO (grant com escopo ou share): só o que é "como o modelo
        // responde" (modelo, thinking). Engine é "de quem é a conta" — trocar
        // pra Codex/API rodaria na conta do DONO, ignorando a do acesso; e
        // permissão/nome/voz são administração do projeto. Ficam do dono.
        const bndP = teamBindings.get(from);
        const guestOnly = isGuest || !!(bndP && bndP.pids !== null);
        const keys = guestOnly ? ['model', 'thinkingMode'] : ['model', 'thinkingMode', 'permissionMode', 'engine', 'name', 'voiceMode'];
        const allowed = {};
        for (const k of keys) {
          if (payload.patch && payload.patch[k] !== undefined) allowed[k] = payload.patch[k];
        }
        if (!Object.keys(allowed).length) return reply(safeProject(projectStore.get(payload.id)) || null);
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
    onRpcRequest: (f, reply, fail) => { if (f && f.from) linkOf.set(f.from, link); return handleRpc(f, reply, fail); },
    refreshTokenFn: opts.refreshTokenFn,
    onIdentityConflict: opts.onIdentityConflict,
    // Presence: quando um client cai, remove do set de subscribers. Sem isso,
    // o host continua tentando enviar eventos a deviceIds mortos (swallow
    // silencioso). Bug #2 do remote control diagnosticado anteriormente.
    onPresence: (f) => {
      if (!f || !f.deviceId) return;
      if (f.online === false) {
        subscribers.delete(f.deviceId);
        peers.delete(f.deviceId);
        teamBindings.delete(f.deviceId);
      } else if (f.role === 'client') {
        // Roster da equipe: colega entrou na sala. Alimenta o "quem está aqui"
        // do dono sem nenhuma chamada extra.
        peers.set(f.deviceId, { deviceId: f.deviceId, name: f.name || null, since: Date.now() });
      }
      onState && onState(getState());
    },
    onStatus: (s) => { state.status = s; onState && onState({ ...state }); },
  });
  ensureEventPipe();
  link.connect();
  state = { running: true, status: 'connecting', error: null };
  onState && onState({ ...state });
  return { ok: true };
}

// Envia um evento pro device pela SALA em que ele fala conosco.
function sendTo(did, channel, payload) {
  const l = linkOf.get(did) || link || teamLink;
  if (l) l.sendEvent(did, channel, payload);
}

// Repassa TODOS os eventos do claude pros clients assinantes. Vive fora do
// start() porque um host pode existir SÓ na sala da equipe (sem conta).
// Limite: relay corta frames > 1MB. Um tool-result com 5MB de output
// (saída de Bash, dump SQL, etc.) fechava a conexão. Tronco aqui.
function ensureEventPipe() {
  if (unsub) return;
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
      try { sendTo(did, 'claude', p); } catch {}
    }
    try { maybeWebPush(p); } catch {}
  });
}

/**
 * Entra (também) na sala do CONVITE, sem tocar na sala da conta. Idempotente
 * por URL; girar o segredo muda a URL e o link antigo é fechado.
 */
function startTeamRoom(url) {
  if (!url) return { ok: false, error: 'url_required' };
  if (teamLink && teamRoomUrl === url) return { ok: true, already: true };
  try { teamLink && teamLink.close(); } catch {}
  const tl = new RelayLink({
    url, token: '',
    deviceId: url.match(/[?&]did=([^&]+)/) ? decodeURIComponent(url.match(/[?&]did=([^&]+)/)[1]) : 'host',
    role: 'host',
    WebSocketImpl,
    hostInfo: hostInfo(),
    onRpcRequest: (f, reply, fail) => { if (f && f.from) linkOf.set(f.from, tl); return handleRpc(f, reply, fail, true); },
    onPresence: (f) => {
      if (!f || !f.deviceId) return;
      if (f.online === false) {
        subscribers.delete(f.deviceId);
        peers.delete(f.deviceId);
        teamBindings.delete(f.deviceId);
        linkOf.delete(f.deviceId);
      } else if (f.role === 'client') {
        peers.set(f.deviceId, { deviceId: f.deviceId, name: f.name || null, since: Date.now() });
      }
      onState && onState(getState());
    },
  });
  teamLink = tl;
  teamRoomUrl = url;
  ensureEventPipe();
  tl.connect();
  onState && onState(getState());
  return { ok: true };
}
function stopTeamRoom() {
  try { teamLink && teamLink.close(); } catch {}
  teamLink = null; teamRoomUrl = null;
  onState && onState(getState());
  return { ok: true };
}
function teamRoomActive() { return !!(teamLink && teamLink.isHealthy ? teamLink.isHealthy(45000) : teamLink); }

function refreshProjects() { if (link) link.registerHost(hostInfo()); if (teamLink) teamLink.registerHost(hostInfo()); }

// Atualiza o token (o relay_token expira em ~10min; main renova periodicamente
// pra reconexões continuarem autenticando).
function updateToken(token) { if (link && token) link.opts.token = token; }

function stop() {
  try { unsub && unsub(); } catch {}
  unsub = null;
  subscribers.clear();
  peers.clear();
  teamBindings.clear();
  try { link && link.close(); } catch {}
  link = null;
  try { teamLink && teamLink.close(); } catch {}
  teamLink = null; teamRoomUrl = null;
  linkOf.clear();
  state = { running: false, status: 'idle', error: null };
  onState && onState({ ...state });
  return { ok: true };
}

function broadcastProjectPatch(updated) {
  if ((!link && !teamLink) || subscribers.size === 0 || !updated) return;
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
  if ((!link && !teamLink) || subscribers.size === 0 || !pid) return;
  for (const [did, entry] of subscribers) {
    if (!subCanSeePid(entry, pid)) continue;
    try { link.sendEvent(did, 'claude', { type: 'project.removed', projectId: pid }); } catch {}
  }
}

function getState() { return { ...state, peers: Array.from(peers.values()) }; }
function isHealthy(maxAgeMs = 30000) { return !!(link && link.isHealthy && link.isHealthy(maxAgeMs)); }
function setOnState(fn) { onState = fn; }
// Quantos clients ativos estão assinando eventos (usado pelo maestrus-server
// pra decidir se manda web push quando ninguém está olhando).
function subscriberCount() { return subscribers.size; }

module.exports = {
  inheritTeamAi,
  setTeamSecret, teamAiAdmin, dropGrantBindings, startTeamRoom, stopTeamRoom, teamRoomActive, setEnsureTeamRoom, start, stop, refreshProjects, updateToken, getState, isHealthy, setOnState, broadcastProjectPatch, subscriberCount };
