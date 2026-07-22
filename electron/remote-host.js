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
const claudeProfiles = require('./claude-profiles');
const claudePowers = require('./claude-powers');
const path = require('path');
const fs = require('fs');
let usageMod = null; try { usageMod = require('./usage'); } catch {}

let link = null;
let unsub = null;
const subscribers = new Set(); // deviceIds de clients ativos (recebem eventos)
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

function safeProjects() {
  try {
    return projectStore.list()
      // O orquestrador 'maestrus' e o 'starter' (Inicializador) NÃO são sessões
      // remotas: o client já tem o próprio Maestrus e o Inicializador só existe
      // na tela dedicada. Anunciá-los criava entradas duplicadas/indevidas na
      // lista de projetos do client.
      .filter((p) => p.id !== 'maestrus' && p.id !== 'starter')
      .map((p) => ({
        id: p.id, name: p.name, source: p.source, branch: p.ssh ? p.ssh.host : null,
        model: p.model || 'default', thinkingMode: p.thinkingMode || 'medium',
        permissionMode: p.permissionMode || 'default', engine: p.engine || 'claude',
        sessionId: p.sessionId || null,
        conversations: (p.conversations || []).map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt })),
      }));
  } catch { return []; }
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
  subscribers.add(from); // qualquer client que fala vira "assinante" de eventos

  // Aplica restrições de sharing: filtra projetos e bloqueia canais não permitidos.
  if (shareClaims) {
    const allowedPids = Array.isArray(shareClaims.pids) && shareClaims.pids.length > 0
      ? new Set(shareClaims.pids) : null; // null = all projects

    if (channel === 'projects.list') {
      const all = safeProjects();
      return reply(allowedPids ? all.filter((p) => allowedPids.has(p.id)) : all);
    }

    // Canais que operam sobre um projeto específico: verifica se está na lista.
    const targetPid = (payload && (payload.projectId || payload.id)) || null;
    if (targetPid && allowedPids && !allowedPids.has(targetPid)) {
      return fail('acesso-negado');
    }
    // Ações de escrita requerem permissão 'write'.
    if ((channel === 'claude.send' || channel === 'projects.patch') && shareClaims.p !== 'write') {
      return fail('permissao-negada');
    }
  }

  try {
    switch (channel) {
      case 'projects.list': return reply(safeProjects());
      case 'projects.get': return reply(projectStore.get(payload.id) || null);
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
        const full = await claudePty.loadHistory(p);
        // O relay corta frames > 1MB → fecha a conexão. Mando só a cauda
        // (que é o que a UI mostra de cara) + trunco textos absurdos.
        // O client tem janela de 200; mando 400 pra dar respiro do "carregar mais".
        const TAIL = 400;
        const MAX_TEXT = 40_000;        // ~40KB por bloco
        const MAX_INPUT_JSON = 20_000;  // ~20KB de input por tool
        const tail = full.length > TAIL ? full.slice(full.length - TAIL) : full;
        const clipped = tail.map((m) => {
          const c = { ...m };
          if (typeof c.text === 'string' && c.text.length > MAX_TEXT) {
            c.text = c.text.slice(0, MAX_TEXT) + `\n…[truncado: +${c.text.length - MAX_TEXT} chars]`;
          }
          if (c.input && typeof c.input === 'object') {
            // Mata input gigante (ex: Bash com 100KB de heredoc) pra não estourar frame.
            try {
              const s = JSON.stringify(c.input);
              if (s.length > MAX_INPUT_JSON) {
                c.input = { __truncated: true, __originalSize: s.length, preview: s.slice(0, MAX_INPUT_JSON) + '…' };
              }
            } catch { c.input = null; }
          }
          return c;
        });
        return reply(clipped);
      }
      case 'claude.send': {
        const p = projectStore.get(payload.projectId);
        if (!p) return fail('Projeto não encontrado');
        await claudePty.send(clampForRemote(p), String(payload.message || ''));
        return reply({ ok: true });
      }
      case 'claude.stop': return reply(claudePty.kill(payload.projectId));
      case 'projects.patch': {
        // permite o client remoto trocar modelo/thinking/engine/permissão/nome
        const allowed = {};
        for (const k of ['model', 'thinkingMode', 'permissionMode', 'engine', 'name']) {
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
          if (buf.length > 25 * 1024 * 1024) return reply({ ok: false, error: 'too_big' });
          const safeName = String(payload.name || 'arquivo').split(/[\\/]/).pop().replace(/[^\w.\-()\[\] ]+/g, '_').slice(0, 120) || 'arquivo';
          const baseDir = proj && proj.codeDir && fs.existsSync(proj.codeDir)
            ? path.join(proj.codeDir, '.maestrus', 'uploads')
            : path.join(os.tmpdir(), 'maestrus-uploads');
          fs.mkdirSync(baseDir, { recursive: true });
          let dest = path.join(baseDir, safeName);
          if (fs.existsSync(dest)) {
            const ext = path.extname(safeName);
            dest = path.join(baseDir, path.basename(safeName, ext) + '-' + Date.now().toString(36) + ext);
          }
          fs.writeFileSync(dest, buf);
          return reply({ ok: true, path: dest, size: buf.length });
        } catch (e) { return reply({ ok: false, error: String(e && e.message || e) }); }
      }
      // ─── Claude Powers (agents/comandos/regras do host) — web/PWA ─────────
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
    for (const did of subscribers) {
      try { link.sendEvent(did, 'claude', p); } catch {}
    }
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
  for (const did of subscribers) {
    try { link.sendEvent(did, 'claude', { type: 'project.updated', project: updated }); } catch {}
  }
}

function getState() { return { ...state }; }
function isHealthy(maxAgeMs = 30000) { return !!(link && link.isHealthy && link.isHealthy(maxAgeMs)); }
function setOnState(fn) { onState = fn; }

module.exports = { start, stop, refreshProjects, updateToken, getState, isHealthy, setOnState, broadcastProjectPatch };
