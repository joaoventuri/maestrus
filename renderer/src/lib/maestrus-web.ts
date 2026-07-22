// Implementação de window.maestrus para o NAVEGADOR (PWA mobile). Sem Electron:
// fala direto com o maestrus.cloud (fetch) e com o relay (WebSocket nativo).
// Caso de uso mobile = REMOTO: loga na cloud, conecta num host e opera o CLI
// dele. Tudo o que não se aplica no mobile vira no-op seguro.

const API_BASE = 'https://maestrus.cloud/api.php';
// SELF-HOST: quando o web é servido pelo próprio maestrus-server (não pelo
// maestrus.cloud), tudo passa pela MESMA origem — inclusive o relay (proxy
// /relay). Detectado via GET /selfhost/config na origem atual.
const SELF_ORIGIN = (typeof location !== 'undefined' && location.origin && !/maestrus\.(cloud|io)$/.test(location.hostname)) ? location.origin : '';
let selfhostCfg: any = null; // { selfhost, hostName, hostDeviceId } quando detectado
const LS_SELFHOST_SECRET = 'maestrus_selfhost_secret';
const LS_ACCOUNT = 'maestrus_account';
const LS_DEVICE = 'maestrus_device_id';
const LS_REMOTE = 'maestrus_remote';            // pareamento salvo (15 dias)
const REMOTE_TTL = 15 * 24 * 3600 * 1000;

function deviceId(): string {
  let d = localStorage.getItem(LS_DEVICE);
  if (!d) { d = 'web-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(LS_DEVICE, d); }
  return d;
}
function getAccount(): any {
  // No self-host, "conta" = ter o secret salvo. Sem cloud, sem licença.
  if (selfhostCfg && selfhostCfg.selfhost) {
    const sec = localStorage.getItem(LS_SELFHOST_SECRET);
    return sec ? { selfhost: true, name: selfhostCfg.hostName || 'Meu Maestrus', licenseKey: 'selfhost', email: selfhostCfg.hostName || 'self-host' } : null;
  }
  try { return JSON.parse(localStorage.getItem(LS_ACCOUNT) || 'null'); } catch { return null; }
}
function setAccount(a: any) { localStorage.setItem(LS_ACCOUNT, JSON.stringify(a)); }

// Detecta se este web app está sendo servido por um servidor SELF-HOST.
async function detectSelfhost(): Promise<any> {
  if (!SELF_ORIGIN) return null;
  if (selfhostCfg) return selfhostCfg;
  try {
    const r = await fetch(`${SELF_ORIGIN}/selfhost/config`, { cache: 'no-store' });
    const j = await r.json();
    if (j && j.selfhost) {
      selfhostCfg = j;
      // Marca globalmente pra UI esconder tudo que é do serviço gerenciado
      // (aba Maestrus Cloud, billing, marketing) — self-host é só o Maestrus.
      try { (window as any).maestrus.isSelfhost = true; } catch {}
      return j;
    }
  } catch {}
  return null;
}

// Conecta ao servidor self-host com o secret: pega um token de client, salva o
// secret e liga direto no relay (proxy /relay da mesma origem).
async function selfhostConnect(secret: string): Promise<any> {
  const cfg = await detectSelfhost();
  if (!cfg) return { ok: false, error: 'not_selfhost' };
  try {
    const r = await fetch(`${SELF_ORIGIN}/selfhost/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, deviceId: deviceId() }),
    });
    const j = await r.json();
    if (!j || !j.ok || !j.token) return { ok: false, error: (j && j.error) || 'bad_secret' };
    localStorage.setItem(LS_SELFHOST_SECRET, secret);
    const relayUrl = SELF_ORIGIN.replace(/^http/, 'ws') + '/relay';
    hostId = j.hostDeviceId; hostName = j.hostName || 'Meu Maestrus'; cachedProjects = [];
    try { link?.close(); } catch {}
    startClientLink(relayUrl, j.token);
    return { ok: true, hostName };
  } catch (e: any) { return { ok: false, error: e?.message || 'network' }; }
}

// Reconecta no self-host usando o secret salvo (boot). freshClientToken também
// usa isso pra renovar o token quando o relay pede.
async function selfhostResume(): Promise<any> {
  const cfg = await detectSelfhost();
  if (!cfg) return { ok: false, error: 'not_selfhost' };
  const sec = localStorage.getItem(LS_SELFHOST_SECRET);
  if (!sec) return { ok: false, error: 'no_secret' };
  return selfhostConnect(sec);
}

async function api(action: string, body: any): Promise<any> {
  const r = await fetch(`${API_BASE}?action=${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

// ─── Cripto de auth de MCP (AES-256-GCM, chave derivada da licença) ──────────
// Mesmo modelo das credenciais SSH no manifest: o DB guarda só o ciphertext;
// a chave deriva da license_key (o orquestrador também a deriva no start do
// sandbox pra usar os MCP). WebCrypto sempre existe em https.
async function deriveMcpKey(licenseKey: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(licenseKey), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('maestrus-mcp-v1'), iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
function b64(buf: ArrayBuffer): string { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
async function encryptAuth(values: any, licenseKey: string): Promise<string> {
  const key = await deriveMcpKey(licenseKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(values || {})));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
  return b64(out.buffer);
}

// BYOK OpenAI: encrypt/decrypt da chave (string crua, não JSON) — mesmo formato
// AES-256-GCM(base64(iv12 || ct || tag16)) usado pra MCP e pro backend (api.php).
async function encryptOpenaiKey(plaintext: string, licenseKey: string): Promise<string> {
  const key = await deriveMcpKey(licenseKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
  return b64(out.buffer);
}
async function decryptOpenaiKey(encB64: string, licenseKey: string): Promise<string | null> {
  try {
    const raw = Uint8Array.from(atob(encB64), (c) => c.charCodeAt(0));
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12); // WebCrypto não separa tag — vem no final do ct
    const key = await deriveMcpKey(licenseKey);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

// Catálogo curado (metadados pra UI; o "como rodar" é aplicado no runtime do
// sandbox/desktop). Espelha electron/mcp-catalog.js.
const WEB_MCP_CURATED: any[] = [
  { id: 'github', label: 'GitHub', desc: 'Repositórios, issues, PRs e busca de código.', docs: 'https://github.com/settings/tokens', run: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }, fields: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal Access Token', placeholder: 'ghp_…', secret: true }] },
  { id: 'notion', label: 'Notion', desc: 'Páginas, bancos de dados e busca no Notion.', docs: 'https://www.notion.so/my-integrations', run: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] }, fields: [{ key: 'NOTION_TOKEN', label: 'Internal Integration Token', placeholder: 'ntn_… / secret_…', secret: true }] },
  { id: 'slack', label: 'Slack', desc: 'Ler/enviar mensagens, canais e usuários.', docs: 'https://api.slack.com/apps', run: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] }, fields: [{ key: 'SLACK_BOT_TOKEN', label: 'Bot Token', placeholder: 'xoxb-…', secret: true }, { key: 'SLACK_TEAM_ID', label: 'Team ID', placeholder: 'T01234567', secret: false }] },
  { id: 'linear', label: 'Linear', desc: 'Issues, projetos e ciclos.', docs: 'https://linear.app/settings/api', run: { command: 'npx', args: ['-y', '@tacticlaunch/mcp-linear'] }, fields: [{ key: 'LINEAR_API_TOKEN', label: 'API Key', placeholder: 'lin_api_…', secret: true }] },
  { id: 'stripe', label: 'Stripe', desc: 'Clientes, pagamentos, assinaturas, produtos.', docs: 'https://dashboard.stripe.com/apikeys', run: { command: 'npx', args: ['-y', '@stripe/mcp', '--tools=all'] }, fields: [{ key: 'STRIPE_API_KEY', label: 'Secret Key', placeholder: 'sk_live_… / sk_test_…', secret: true }] },
  { id: 'postgres', label: 'PostgreSQL', desc: 'Consultar seu banco PostgreSQL.', docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres', run: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] }, fields: [{ key: 'DATABASE_URL', label: 'Connection String', placeholder: 'postgresql://user:pass@host:5432/db', secret: true }] },
  { id: 'sentry', label: 'Sentry', desc: 'Issues e eventos de erro.', docs: 'https://sentry.io/settings/account/api/auth-tokens/', run: { command: 'npx', args: ['-y', '@sentry/mcp-server'] }, fields: [{ key: 'SENTRY_AUTH_TOKEN', label: 'Auth Token', placeholder: 'sntrys_…', secret: true }] },
  { id: 'brave', label: 'Brave Search', desc: 'Busca na web em tempo real.', docs: 'https://brave.com/search/api/', run: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] }, fields: [{ key: 'BRAVE_API_KEY', label: 'API Key', placeholder: 'BSA…', secret: true }] },
  { id: 'figma', label: 'Figma', desc: 'Frames, componentes e estilos.', docs: 'https://www.figma.com/developers/api#access-tokens', run: { command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'] }, fields: [{ key: 'FIGMA_API_KEY', label: 'Personal Access Token', placeholder: 'figd_…', secret: true }] },
  { id: 'supabase', label: 'Supabase', desc: 'Gerencie e consulte seus projetos.', docs: 'https://supabase.com/dashboard/account/tokens', run: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'] }, fields: [{ key: 'SUPABASE_ACCESS_TOKEN', label: 'Access Token', placeholder: 'sbp_…', secret: true }] },
  { id: 'airtable', label: 'Airtable', desc: 'Bases, tabelas e registros.', docs: 'https://airtable.com/create/tokens', run: { command: 'npx', args: ['-y', 'airtable-mcp-server'] }, fields: [{ key: 'AIRTABLE_API_KEY', label: 'Personal Access Token', placeholder: 'pat…', secret: true }] },
  { id: 'atlassian', label: 'Jira / Confluence', desc: 'Issues do Jira e páginas do Confluence.', docs: 'https://id.atlassian.com/manage-profile/security/api-tokens', run: { command: 'npx', args: ['-y', 'mcp-atlassian'] }, fields: [{ key: 'JIRA_URL', label: 'Site URL', placeholder: 'https://empresa.atlassian.net', secret: false }, { key: 'JIRA_USERNAME', label: 'E-mail', placeholder: 'voce@empresa.com', secret: false }, { key: 'JIRA_API_TOKEN', label: 'API Token', placeholder: 'ATATT…', secret: true }] },
];

// Busca na MCP Registry oficial direto do browser; degrada se CORS bloquear.
async function webMcpSearch(query: string): Promise<{ ok: boolean; items: any[]; error?: string }> {
  try {
    let url = 'https://registry.modelcontextprotocol.io/v0/servers?limit=30';
    if (query) url += `&search=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return { ok: false, items: [], error: 'registry HTTP ' + res.status };
    const json = await res.json();
    const items: any[] = [];
    const seen = new Set<string>();
    for (const entry of (json.servers || [])) {
      const sv = entry.server || entry;
      const meta = entry._meta && entry._meta['io.modelcontextprotocol.registry/official'];
      if (meta && meta.isLatest === false) continue;
      const pkgs = sv.packages || []; const remotes = sv.remotes || [];
      const npm = pkgs.find((p: any) => p.registryType === 'npm');
      const httpR = remotes.find((r: any) => r.type === 'streamable-http' || r.type === 'http');
      const sseR = remotes.find((r: any) => r.type === 'sse');
      const id = String((sv.name || '').split('/').pop() || sv.name || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
      if (!id || seen.has(id)) continue;
      let d: any = null;
      if (npm) {
        let args = (npm.runtimeArguments || []).map((a: any) => a && a.value).filter((x: any) => x != null).map(String);
        if (!args.length) args = ['-y'];
        args.push(npm.version ? `${npm.identifier}@${npm.version}` : npm.identifier);
        const fields = (npm.environmentVariables || []).map((e: any) => ({ key: e.name, label: e.description || e.name, secret: !!e.isSecret, required: !!e.isRequired, placeholder: e.default || '' }));
        d = { transport: 'stdio', command: 'npx', args, fields, requires: 'node' };
      } else if (httpR || sseR) {
        const r = httpR || sseR;
        const headerTemplates = (r.headers || []).map((h: any) => ({ name: h.name, value: h.value }));
        d = { transport: httpR ? 'http' : 'sse', url: r.url, headerTemplates, fields: [], requires: 'none' };
      } else continue;
      seen.add(id);
      items.push({ id, regName: sv.name, label: sv.title || id, description: sv.description || '', version: sv.version || '', ...d });
    }
    return { ok: true, items };
  } catch (e: any) { return { ok: false, items: [], error: 'A busca na registry exige conexão (pode estar bloqueada pelo navegador).' }; }
}

// ─── Protocolo do relay (idêntico ao relay/protocol.js) ──────────────────────
const FRAME = { REGISTER_HOST: 'register-host', HOST_LIST: 'host-list', RPC_REQUEST: 'rpc-request', RPC_RESPONSE: 'rpc-response', EVENT: 'event', PRESENCE: 'presence', ERROR: 'error' };
const frame = (type: string, fields: any = {}) => JSON.stringify({ v: 1, type, ...fields });
function parseFrame(raw: any): any { try { const f = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); return f && f.type ? f : null; } catch { return null; } }

// ─── RelayLink (cliente, browser) ────────────────────────────────────────────
class WebRelayLink {
  url: string; token: string; did: string; hostId: string;
  ws: WebSocket | null = null; pending = new Map<string, any>(); seq = 0; closed = false; backoff = 500;
  // hostList não carrega reqId na resposta do relay → fila de waiters (suporta
  // chamadas concorrentes sem um sobrescrever a pendência do outro).
  hlWaiters: Array<{ res: (v: any) => void; rej: (e: any) => void; t: any }> = [];
  refreshTokenFn?: () => Promise<string | null>;
  reconnTimer: any = null;   // único timer de reconexão pendente (evita 2 sockets)
  onEvent?: (f: any) => void; onStatus?: (s: string) => void; onPresence?: (f: any) => void;
  constructor(o: any) { this.url = o.url; this.token = o.token; this.did = o.deviceId; this.hostId = o.hostId; this.onEvent = o.onEvent; this.onStatus = o.onStatus; this.onPresence = o.onPresence; this.refreshTokenFn = o.refreshTokenFn; }
  connect() {
    if (this.closed) return;
    if (this.reconnTimer) { clearTimeout(this.reconnTimer); this.reconnTimer = null; }
    const full = `${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`;
    let ws: WebSocket;
    try { ws = new WebSocket(full); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => { this.backoff = 500; this.onStatus?.('online'); };
    ws.onmessage = (ev) => { const f = parseFrame(ev.data); if (f) this.onFrame(f); };
    ws.onclose = () => { this.onStatus?.('offline'); this.failAll('closed'); if (!this.closed) this.scheduleReconnect(); };
    ws.onerror = () => { this.onStatus?.('error'); };
  }
  scheduleReconnect() {
    if (this.closed || this.reconnTimer) return;   // já há uma reconexão agendada
    const d = Math.min(this.backoff, 15000);
    this.backoff = Math.min(this.backoff * 2, 15000);
    this.reconnTimer = setTimeout(async () => {
      this.reconnTimer = null;
      if (this.closed) return;
      // Token FRESCO antes de reconectar. O relay_token tem TTL de 5min
      // (relay/protocol.js); sem renovar, o resume após background longo
      // entrava em loop reconectando com um token já expirado → "deslogado".
      if (this.refreshTokenFn) { try { const nt = await this.refreshTokenFn(); if (nt) this.token = nt; } catch {} }
      this.connect();
    }, d);
  }
  // Reconexão IMEDIATA com token fresco (app voltou do background — o socket
  // pode ser um zumbi: readyState=OPEN mas morto do outro lado). Neutraliza o
  // ws antigo pra ele não disparar um scheduleReconnect concorrente.
  async forceReconnect() {
    if (this.closed) return;
    const old = this.ws;
    if (old) { try { old.onopen = null; old.onclose = null; old.onmessage = null; old.onerror = null; old.close(); } catch {} }
    this.ws = null;
    this.failAll('reconnecting');
    if (this.refreshTokenFn) { try { const nt = await this.refreshTokenFn(); if (nt) this.token = nt; } catch {} }
    this.backoff = 500;
    this.connect();
  }
  isOpen() { return !!this.ws && this.ws.readyState === 1; }
  send(type: string, fields: any) { try { this.ws!.send(frame(type, fields)); return true; } catch { return false; } }
  onFrame(f: any) {
    if (f.type === FRAME.RPC_RESPONSE) { const p = this.pending.get(f.reqId); if (p) { clearTimeout(p.t); this.pending.delete(f.reqId); p.res(f.payload); } }
    else if (f.type === FRAME.ERROR && f.reqId && this.pending.has(f.reqId)) { const p = this.pending.get(f.reqId); clearTimeout(p.t); this.pending.delete(f.reqId); p.rej(new Error(f.error || 'relay-error')); }
    else if (f.type === FRAME.EVENT) this.onEvent?.(f);
    else if (f.type === FRAME.PRESENCE) this.onPresence?.(f);
    else if (f.type === FRAME.HOST_LIST) { const hosts = f.payload?.hosts || []; const ws = this.hlWaiters.splice(0); for (const w of ws) { clearTimeout(w.t); w.res(hosts); } }
  }
  failAll(reason: string) {
    for (const [, p] of this.pending) { clearTimeout(p.t); p.rej(new Error(reason)); }
    this.pending.clear();
    const ws = this.hlWaiters.splice(0); for (const w of ws) { clearTimeout(w.t); w.rej(new Error(reason)); }
  }
  rpc(channel: string, payload: any, timeoutMs = 120000): Promise<any> {
    return new Promise((res, rej) => {
      const reqId = `${Date.now()}-${++this.seq}`;
      const t = setTimeout(() => { this.pending.delete(reqId); rej(new Error('rpc-timeout')); }, timeoutMs);
      this.pending.set(reqId, { res, rej, t });
      if (!this.send(FRAME.RPC_REQUEST, { to: this.hostId, reqId, channel, payload })) { clearTimeout(t); this.pending.delete(reqId); rej(new Error('send-failed')); }
    });
  }
  hostList(timeoutMs = 5000): Promise<any[]> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { const i = this.hlWaiters.findIndex((w) => w.t === t); if (i >= 0) this.hlWaiters.splice(i, 1); rej(new Error('timeout')); }, timeoutMs);
      this.hlWaiters.push({ res, rej, t });
      this.send(FRAME.HOST_LIST, {});
    });
  }
  close() { this.closed = true; if (this.reconnTimer) { clearTimeout(this.reconnTimer); this.reconnTimer = null; } this.failAll('closed'); try { this.ws?.close(); } catch {} }
}

// ─── estado remoto + eventos ─────────────────────────────────────────────────
let link: WebRelayLink | null = null;
let hostId: string | null = null;
let hostName: string | null = null;
// Host cloud que o usuário abriu DE PROPÓSITO (clicou num projeto do container).
// Enquanto fixado, preferMachine() não migra de volta pra máquina. Limpa ao
// abrir um projeto de máquina ou voltar pra lista.
let _pinnedCloudHost: string | null = null;
let cachedProjects: any[] = [];
// Projetos cloud do usuário (de cloud_list) como STUBS na sidebar, mesmo sem
// estar atachado. Abrir um stub faz resume+attach sob demanda (ensureHost).
let cachedStubs: any[] = [];
let stubsTs = 0;
function mapCloudSession(s: any) {
  const did = s.device_id || ('cloud-?-' + s.project_id);
  // O MAESTRO (project_id 'maestrus') é 1ª classe: id fixo 'maestrus',
  // source 'maestrus' (ícone de maestro), não um projeto cloud comum.
  if (s.project_id === 'maestrus') {
    return { id: 'maestrus', name: 'Maestrus', source: 'maestrus', cloud: true, orchestrator: true, cloudStatus: s.status || 'unknown', previewUrl: null, remoteHostId: did, remoteHostName: 'Maestrus', remoteProjectId: 'maestrus', model: 'default', thinkingMode: 'medium', permissionMode: 'bypassPermissions', engine: 'cloud', repoUrl: null, localPath: null, mountPath: null, sessionId: null, codeDir: null, driveDir: null, sessionDir: null, createdAt: 0, updatedAt: 0 };
  }
  return { id: `remote:${did}:${s.project_id}`, name: s.name || s.project_id, source: 'cloud', cloud: true, cloudStatus: s.status || 'unknown', previewUrl: s.preview_url || null, remoteHostId: did, remoteHostName: s.name || 'Cloud', remoteProjectId: s.project_id, model: 'default', thinkingMode: 'medium', permissionMode: 'bypassPermissions', engine: 'cloud', repoUrl: null, localPath: null, mountPath: null, sessionId: null, codeDir: null, driveDir: null, sessionDir: null, createdAt: 0, updatedAt: 0 };
}
// Stub sempre-visível do Maestrus (mesmo antes do 1º start). O maestro conduz
// os outros projetos cloud (e, se houver desktop pareado, usa o CLI dele).
const MAESTRO_STUB = { id: 'maestrus', name: 'Maestrus', source: 'maestrus', cloud: true, orchestrator: true, cloudStatus: 'stopped', previewUrl: null, remoteHostId: null, remoteHostName: 'Maestrus', remoteProjectId: 'maestrus', model: 'default', thinkingMode: 'medium', permissionMode: 'bypassPermissions', engine: 'cloud', repoUrl: null, localPath: null, mountPath: null, sessionId: null, codeDir: null, driveDir: null, sessionDir: null, createdAt: 0, updatedAt: 0 };
async function fetchCloudStubs(force = false): Promise<any[]> {
  const a = getAccount(); if (!a) { cachedStubs = []; return cachedStubs; }
  const now = Date.now();
  if (!force && now - stubsTs < 5000) return cachedStubs;
  stubsTs = now;
  try { const r = await api('cloud_list', { license_key: a.licenseKey }); if (r && r.ok) cachedStubs = (r.sessions || []).map(mapCloudSession); } catch {}
  return cachedStubs;
}
let clientState = { connected: false, status: 'idle', hostName: null as string | null };
const eventHandlers = new Set<(e: any) => void>();
const clientStateHandlers = new Set<(s: any) => void>();
const projectsChangedHandlers = new Set<(p?: any) => void>();
function emitClientState() { clientStateHandlers.forEach((h) => h({ ...clientState })); }
function emitProjectsChanged() { projectsChangedHandlers.forEach((h) => { try { h(); } catch {} }); }
// Poll de status (a cada 15s): re-busca cloud_list — que agora traz o estado
// REAL do container (docker inspect no provider local) — e re-renderiza a
// sidebar. Sincroniza nos dois sentidos: o projeto fica verde enquanto o
// container vive e cinza sozinho quando auto-suspende. Sem precisar de F5.
let _statusPoll: any = null;
function ensureStatusPoll() {
  if (_statusPoll || typeof setInterval === 'undefined') return;
  _statusPoll = setInterval(async () => {
    try { if (!getAccount()) return; await fetchCloudStubs(true); emitProjectsChanged(); } catch {}
  }, 10000);
}
// Projeto cloud (host device_id começa com 'cloud-') é 1ª classe: source='cloud'
// → a sidebar mostra ícone de NUVEM, não de servidor/máquina.
const isCloudHost = (did: string | null) => !!did && did.startsWith('cloud-');
// Engine respeita o PROJETO (não força mais 'cloud' pro container): o container
// tem o Claude CLI próprio (OAuth do onboarding) — Claude CLI × Claude API são
// ambos válidos lá. Relíquia da era do proxy removida.
function tag(p: any) { const cloud = isCloudHost(hostId); return { id: `remote:${hostId}:${p.id}`, name: p.name, source: cloud ? 'cloud' : (p.source || 'production'), realSource: p.source || 'local', cloud, remoteHostId: hostId, remoteHostName: hostName, remoteProjectId: p.id, model: p.model || 'default', thinkingMode: p.thinkingMode || 'medium', permissionMode: p.permissionMode || 'default', engine: p.engine || 'claude', repoUrl: null, localPath: null, mountPath: null, sessionId: p.sessionId || null, codeDir: null, driveDir: null, sessionDir: null, createdAt: 0, updatedAt: 0, conversations: Array.isArray(p.conversations) ? p.conversations : [] }; }
const parseId = (id: string) => { const m = /^remote:([^:]+):(.+)$/.exec(id || ''); return m ? { hostId: m[1], projectId: m[2] } : null; };

async function refreshProjects() {
  if (!link || !hostId) return [];
  const r = await link.rpc('projects.list', {}, 8000).catch(() => []);
  cachedProjects = (Array.isArray(r) ? r : []).map(tag);
  return cachedProjects;
}

// Cria o link do client pro host atual (hostId/hostName já setados).
function startClientLink(url: string, token: string) {
  link = new WebRelayLink({
    url, token, deviceId: deviceId(), hostId,
    // Renova o relay_token (TTL 5min) a cada reconexão — cura o "deslogado"
    // após background longo. Mesmo padrão já usado no host (relay/link.js).
    refreshTokenFn: freshClientToken,
    // O estado de conexão segue o WS DO CLIENTE (relay alcançável), não a
    // presença do host — senão um blip do host (renovação de token) deixava
    // "Disconnected" pra sempre mesmo respondendo.
    onStatus: (s) => { clientState = { connected: s === 'online', status: s, hostName }; emitClientState(); if (s === 'online') refreshProjects().then(() => emitProjectsChanged()); },
    onEvent: (f) => {
      if (f.channel === 'claude' && f.payload) {
        const p = { ...f.payload };
        // Atualiza cache e notifica UI quando o host muda modelo/settings de um projeto
        if (p.type === 'project.updated' && p.project) {
          const pid = p.project.id;
          cachedProjects = cachedProjects.map((cp) => {
            if (cp.remoteProjectId !== pid) return cp;
            // Mescla também nome e CONVERSAS (forks): mudanças feitas em outro
            // device (desktop/PWA) refletem aqui ao vivo, sem re-fetch.
            return { ...cp, name: p.project.name || cp.name, model: p.project.model || cp.model, thinkingMode: p.project.thinkingMode || cp.thinkingMode, permissionMode: p.project.permissionMode || cp.permissionMode, engine: p.project.engine || cp.engine, conversations: Array.isArray(p.project.conversations) ? p.project.conversations : (cp as any).conversations };
          });
          emitProjectsChanged();
        }
        if (p.projectId && p.projectId !== '*') p.projectId = (p.projectId === 'maestrus') ? 'maestrus' : `remote:${hostId}:${p.projectId}`;
        eventHandlers.forEach((h) => h(p));
      }
    },
    onPresence: (f) => { if (f.deviceId === hostId && f.online === true) refreshProjects(); }, // host voltou → recarrega projetos
  });
  link.connect();
  clientState = { connected: false, status: 'connecting', hostName }; emitClientState();
}
// SÓ persiste MÁQUINA como pareamento preferido. O container cloud é sempre
// reencontrável por discovery (está 24/7 online) — se ele fosse salvo aqui,
// virava o "preferido" e roubava toda reconexão futura, grudando no "Maestrus"
// e nunca mais voltando pra máquina (o bug clássico). Máquina > container.
function saveRemote() {
  try {
    if (!hostId || isCloudHost(hostId)) return;
    localStorage.setItem(LS_REMOTE, JSON.stringify({ hostDeviceId: hostId, hostName, ts: Date.now() }));
  } catch {}
}

// Conecta num host CONHECIDO por device_id (sem código de pareamento). Usado
// pelos projetos cloud (cada container é um host `cloud-{uid}-{pid}`) e por
// hosts já pareados. Pega um relay_token role=client e abre o link.
async function doConnectHost(hostDid: string, hostNameArg?: string): Promise<any> {
  const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
  const t = await api('relay_token', { license_key: a.licenseKey, device_id: deviceId(), role: 'client' });
  if (!t.ok || !t.token) return { ok: false, error: t.error || 'no_token' };
  try { link?.close(); } catch {}
  hostId = hostDid; hostName = hostNameArg || 'Cloud'; cachedProjects = [];
  startClientLink(t.url, t.token);
  saveRemote();
  return { ok: true, hostName };
}

// Garante que o host alvo (cloud ou máquina) esteja atachado. Se for um
// projeto cloud pausado/parado, faz resume antes de conectar. Usado no lazy
// attach: clicar num projeto cloud da sidebar atacha sob demanda.
// Espera o HOST (runner cloud) aparecer ONLINE no relay (presença real), não o
// status do banco que pode estar obsoleto. Resolve true quando o host responde.
async function waitHostOnline(hostDid: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (link) {
      try {
        const hosts = await link.hostList(4000);
        if (Array.isArray(hosts) && hosts.some((h: any) => (h && (h.deviceId || h.id || h.device_id)) === hostDid)) return true;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function ensureHost(hostDid: string): Promise<boolean> {
  // Fixa/solta a preferência: abrir projeto do container = usuário quer o cloud;
  // abrir projeto de máquina = solta o pin (preferMachine volta a valer).
  _pinnedCloudHost = isCloudHost(hostDid) ? hostDid : null;
  const stub = cachedStubs.find((s) => s.remoteHostId === hostDid);
  const pid = (stub && stub.remoteProjectId) || hostDid.replace(/^cloud-\d+-/, '');
  // 1) garante o CLIENTE atachado ao host alvo
  if (!(link && hostId === hostDid && clientState.connected)) {
    const r = await doConnectHost(hostDid, stub ? stub.name : undefined);
    if (!r || !r.ok) return false;
    const d = Date.now() + 12000;
    while (Date.now() < d && !clientState.connected) await new Promise((res) => setTimeout(res, 300));
  }
  // 2) para projeto cloud: confirma que o HOST está REALMENTE online (presença);
  //    se não, resume o sandbox e espera o runner reconectar.
  if (isCloudHost(hostDid)) {
    // Status real (cloud_list) é a fonte da verdade: se está RUNNING, dá uma
    // janela maior de probe ANTES de alarmar — evita "iniciando…" falso.
    const running = !!(stub && stub.cloudStatus === 'running');
    let online = await waitHostOnline(hostDid, running ? 9000 : 4000);
    if (!online) {
      // sandbox frio/pausado → mostra "iniciando instância…" e sobe o runner
      clientState = { ...clientState, status: 'starting' }; emitClientState();
      const a = getAccount();
      if (a && pid) { try { await api('cloud_resume', { license_key: a.licenseKey, project_id: pid }); } catch {} }
      online = await waitHostOnline(hostDid, 75000);
    }
    if (online) { clientState = { ...clientState, connected: true, status: 'online' }; emitClientState(); await refreshProjects().catch(() => {}); }
    else { clientState = { ...clientState, status: 'offline' }; emitClientState(); }
    return online;
  }
  await waitForFirstProject(25000);
  return true;
}

// Garante o host do MAESTRO (híbrido): se já estamos num desktop pareado
// (remote-control), usa o maestro DELE (CLI, de graça). Senão, sobe/usa o
// maestro na NUVEM (cloud_start project 'maestrus' com orchestrator). Resolve
// true quando o host do maestro está atachado e online.
async function ensureMaestroHost(): Promise<boolean> {
  // 1) desktop pareado já conectado → usa o maestro do desktop
  if (link && hostId && !isCloudHost(hostId) && clientState.connected) return true;
  const a = getAccount(); if (!a) return false;
  // 2) maestro na nuvem
  const cloudDid = (hostId && isCloudHost(hostId)) ? hostId : null;
  clientState = { connected: false, status: 'starting', hostName: 'Maestrus' }; emitClientState();
  let did: string | null = null;
  try {
    const r = await api('cloud_start', { license_key: a.licenseKey, project_id: 'maestrus', name: 'Maestrus', orchestrator: true, auto_setup: false });
    if (r && r.ok && r.device_id) did = r.device_id;
  } catch {}
  if (!did) return false;
  return ensureHost(did);
}

// Espera o host atual responder projects.list (o runner cloud popula
// cachedProjects logo após o WS ficar 'online'). Resolve o 1º projeto ou null.
function waitForFirstProject(timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (cachedProjects.length > 0) return resolve(cachedProjects[0]);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 400);
    };
    tick();
  });
}

// Cria um projeto CLOUD a partir de um nome (+ repo GitHub opcional). Sobe um
// sandbox via cloud_start, ataca como host e devolve o projeto já conectado.
// É o caminho de "novo projeto" do web (sem pasta local / sem desktop).
// Cria um projeto. No modelo atual (container por usuário), o web está
// conectado ao CONTAINER (host) — então cria o projeto DENTRO dele via RPC
// (clona o GitHub lá, aparece na sidebar). Se não há host conectado, cai no
// caminho legado do sandbox por projeto.
async function createOnHost(input: any): Promise<any> {
  const r: any = await link!.rpc('projects.create', input, 240000);
  if (r && r.ok === false) throw new Error(r.error || 'create_failed');
  if (r && (r.id || r.name)) {
    await refreshProjects().catch(() => {});
    const created = cachedProjects.find((p) => p.remoteProjectId === r.id);
    return created || tag(r);
  }
  throw new Error('create_failed');
}

async function doCreateProject(input: any): Promise<any> {
  // O clique em "criar" pode chegar antes do discovery do boot terminar de
  // conectar no container/máquina. Garante o host PRIMEIRO — sem isso caía no
  // sandbox legado (cloud_start), que exige plano pago e devolvia
  // cloud_required mesmo com o container da conta no ar.
  if (!(link && hostId && clientState.connected)) {
    try { await ensureConnected(); } catch {}
    const d = Date.now() + 15000;
    while (Date.now() < d && !clientState.connected) await new Promise((r) => setTimeout(r, 300));
  }
  if (link && hostId && clientState.connected) {
    try {
      return await createOnHost(input);
    } catch (e: any) {
      // Erro real de criação → propaga (não cai no sandbox legado silenciosamente).
      if (e && /clone_failed|name_required|create_failed|repo_auth_required/.test(String(e.message || ''))) throw e;
      // host caiu no meio → tenta o resgate do container abaixo
    }
  }
  // Conta TEM container mas o host não respondeu → acorda (container_status
  // auto-desperta instância suspensa) e tenta de novo, em vez de cair no
  // sandbox legado que responderia cloud_required.
  const a = getAccount();
  if (a) {
    let st: any = null;
    try { st = await api('container_status', { license_key: a.licenseKey }); } catch {}
    if (st && st.exists) {
      await autoConnectCloud().catch(() => {});
      const d2 = Date.now() + 25000;
      while (Date.now() < d2 && !clientState.connected) await new Promise((r) => setTimeout(r, 400));
      if (link && hostId && clientState.connected) return createOnHost(input);
      throw new Error('container_starting');
    }
  }
  return doCreateCloudProject(input);
}

async function doCreateCloudProject(input: any): Promise<any> {
  const a = getAccount(); if (!a) throw new Error('not_logged_in');
  const base = String(input?.name || 'projeto').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const pid = base || ('proj-' + Date.now().toString(36));
  const r = await api('cloud_start', { license_key: a.licenseKey, project_id: pid, name: input?.name || pid, repo_url: input?.repoUrl || '', auto_setup: 1 });
  if (!r || !r.ok) throw new Error((r && (r.message || r.error)) || 'cloud_start_failed');
  await doConnectHost(r.device_id, input?.name || pid);
  const proj = await waitForFirstProject(25000);
  if (!proj) throw new Error('cloud_attach_timeout');
  return proj;
}

// Lê o pareamento salvo (até 15 dias), validando o TTL. null = sem pareamento.
function loadSavedRemote(): any {
  let saved: any = null; try { saved = JSON.parse(localStorage.getItem(LS_REMOTE) || 'null'); } catch {}
  if (!saved || !saved.hostDeviceId) return null;
  if (Date.now() - (saved.ts || 0) > REMOTE_TTL) { try { localStorage.removeItem(LS_REMOTE); } catch {} return null; }
  return saved;
}
// Busca um relay_token role=client fresco (só o token — a url do relay é fixa).
async function freshClientToken(): Promise<string | null> {
  // Self-host: renova o token local com o secret salvo (sem maestrus.cloud).
  if (selfhostCfg && selfhostCfg.selfhost) {
    const sec = localStorage.getItem(LS_SELFHOST_SECRET); if (!sec) return null;
    try {
      const r = await fetch(`${SELF_ORIGIN}/selfhost/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: sec, deviceId: deviceId() }) });
      const j = await r.json(); return (j && j.ok && j.token) ? j.token : null;
    } catch { return null; }
  }
  const a = getAccount(); if (!a) return null;
  try { const t = await api('relay_token', { license_key: a.licenseKey, device_id: deviceId(), role: 'client' }); return (t && t.ok && t.token) ? t.token : null; } catch { return null; }
}

// Reconecta do pareamento salvo (até 15 dias) — não desloga ao fechar a aba.
async function doResume(): Promise<any> {
  const a = getAccount(); if (!a) return { ok: false };
  const saved = loadSavedRemote();
  if (!saved) return { ok: false };
  return doConnectHost(saved.hostDeviceId, saved.hostName);
}

// Descobre uma MÁQUINA online da conta (host não-cloud) e conecta nela, sem
// código de pareamento. Extraído pra ser reusado como fallback do resume.
async function doDiscover(): Promise<any> {
  const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
  // já atachado a uma máquina viva? nada a fazer.
  if (link && hostId && !isCloudHost(hostId) && clientState.connected) return { ok: true, already: true };
  const t = await api('relay_token', { license_key: a.licenseKey, device_id: deviceId(), role: 'client' });
  if (!t.ok || !t.token) return { ok: false, error: t.error || 'no_token' };
  // abre o link só pra listar os hosts da conta (hostId ainda null)
  try { link?.close(); } catch {}
  hostId = null; hostName = null;
  startClientLink(t.url, t.token);
  const d = Date.now() + 8000;
  while (Date.now() < d && !clientState.connected) await new Promise((r) => setTimeout(r, 250));
  let hosts: any[] = [];
  try { hosts = link ? await link.hostList(5000) : []; } catch {}
  const arr = Array.isArray(hosts) ? hosts : [];
  const didOf = (h: any) => h && (h.deviceId || h.id || h.device_id);
  // Prioridade: uma MÁQUINA online (host não-cloud). Se não há, conecta no
  // CONTAINER cloud da conta (cloud-u{id}) — o Maestrus completo 24/7 na nuvem.
  const machine = arr.find((h: any) => { const did = didOf(h); return did && !isCloudHost(did); });
  // Qualquer host 'cloud-*' é o container da conta (o relay só lista hosts da
  // própria licença) — mesma regra do isCloudHost, senão um DEVICE_ID que não
  // seja exatamente 'cloud-u<n>' nunca seria encontrado.
  const container = arr.find((h: any) => { const did = didOf(h); return isCloudHost(did); });
  const target = machine || container;
  if (!target) return { ok: true, found: 0 };
  const did = didOf(target);
  await doConnectHost(did, target.name || (machine ? 'Máquina' : 'Maestrus Cloud'));
  return { ok: true, found: 1, hostName: target.name, cloud: !machine };
}

// Descobre e conecta no container cloud do user (usado pós-onboarding no web app,
// quando o user acabou de criar a instância e não tem pareamento salvo).
async function autoConnectCloud(): Promise<any> {
  const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
  // Já numa MÁQUINA viva? não deixa o container roubar (preferência estável).
  if (link && hostId && !isCloudHost(hostId) && clientState.connected) return { ok: true, already: true };
  return doDiscover();
}

// Preferência HÍBRIDA (o comportamento "inteligente igual o desktop"): o link
// ATIVO deve ficar na MÁQUINA sempre que ela estiver online — os projetos do
// container aparecem de qualquer forma via stubs (cloud_list). Se estamos no
// container mas há uma máquina online, migra pra ela. Roda no boot e nos wakes
// (não durante um projeto cloud aberto — aí o usuário fixou o container à mão).
async function preferMachine(): Promise<any> {
  const a = getAccount(); if (!a) return { ok: false };
  if (_pinnedCloudHost) return { ok: true, pinned: true };       // usuário abriu projeto cloud de propósito
  if (link && hostId && !isCloudHost(hostId) && clientState.connected) return { ok: true, already: true };
  let hosts: any[] = [];
  try { hosts = link ? await link.hostList(4000) : []; } catch {}
  if (!Array.isArray(hosts) || !hosts.length) return doDiscover();  // sem lista → discovery normal
  const didOf = (h: any) => h && (h.deviceId || h.id || h.device_id);
  const machine = hosts.find((h: any) => { const d = didOf(h); return d && !isCloudHost(d); });
  if (!machine) return { ok: true, noMachine: true };            // só container disponível: fica nele
  const did = didOf(machine);
  if (did === hostId && clientState.connected) return { ok: true, already: true };
  await doConnectHost(did, machine.name || 'Máquina');
  return { ok: true, migrated: true, hostName: machine.name };
}

// Fluxo unificado de conexão (usado no boot e ao voltar do background): tenta o
// pareamento salvo e, se o host salvo não responder a tempo, cai pra discovery.
// Sem pareamento salvo → não força nada (a UI mostra a tela de conexão).
async function ensureConnected(): Promise<any> {
  const a = getAccount(); if (!a) return { ok: false };
  const saved = loadSavedRemote();
  // Sem pareamento salvo → tenta discovery direto (pega máquina online OU o
  // container cloud da conta). Antes retornava noSaved e caía na tela de código,
  // ignorando o container 24/7 que o usuário acabou de provisionar.
  if (!saved) return doDiscover();
  await doConnectHost(saved.hostDeviceId, saved.hostName);
  const d = Date.now() + 6000;
  while (Date.now() < d && !clientState.connected) await new Promise((r) => setTimeout(r, 200));
  if (clientState.connected) return { ok: true, via: 'resume' };
  // host salvo não respondeu (did mudou / estava offline) → descobre.
  return doDiscover();
}

// Verifica saúde da conexão e recupera. Chamado nos eventos de "acordar"
// (visibilitychange/online/focus/pageshow). Detecta socket zumbi via um
// hostList (respondido pelo próprio relay) e força reconexão com token novo.
let _ensuring = false;
async function ensureAlive(): Promise<void> {
  if (_ensuring) return;
  if (!getAccount()) return;
  _ensuring = true;
  try {
    if (link && !link.closed) {
      if (link.isOpen() && clientState.connected) {
        try {
          await link.hostList(4000);
          // Link vivo — mas se estamos grudados no container e a máquina voltou,
          // migra pra ela (a menos que o usuário tenha aberto um projeto cloud).
          if (hostId && isCloudHost(hostId) && !_pinnedCloudHost) { await preferMachine().catch(() => {}); }
          return;
        } catch { /* zumbi → reconecta */ }
      }
      await link.forceReconnect();
      return;
    }
    await ensureConnected();
  } finally { _ensuring = false; }
}

// Listeners de ciclo de vida do app — instalados uma única vez. Ao voltar pro
// foco / recuperar rede, revalida a sessão silenciosamente (sem cair pra login).
let _lifecycleInstalled = false;
function installLifecycle() {
  if (_lifecycleInstalled || typeof document === 'undefined') return;
  _lifecycleInstalled = true;
  const wake = () => { ensureAlive(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
}

export function installMaestrusWeb() {
  if ((window as any).maestrus) return;
  const noop = async () => ({ ok: false });
  (window as any).maestrus = {
    platform: 'web',
    isWeb: true,
    win: { minimize: noop, maximize: noop, close: noop, isMaximized: async () => false, onMaximizeChange: () => () => {} },
    app: {
      notify: noop,
      config: async () => ({ base: 'https://maestrus.cloud' }),
      openExternal: (url: string) => { try { window.open(url, '_blank'); } catch {} },
      // No web o usuário é sempre CLIENTE dos próprios containers cloud (e de
      // máquinas pareadas). Isso faz o App.tsx entrar no fluxo remoto e a
      // sidebar mostrar os projetos do host (remoteHostId).
      getMode: async () => ({ mode: 'client', host: null }),
      setMode: async () => ({ ok: true }),
      showWindow: async () => ({ ok: true }),
      // Preferências por-usuário (idioma/tema) no DB → seguem o usuário em todo device.
      getCloudSettings: async () => { const a = getAccount(); if (!a) return { settings: {} }; const r = await api('user_settings', { license_key: a.licenseKey, op: 'list' }).catch(() => ({})); return { settings: r.settings || {} }; },
      setCloudSetting: async (key: string, value: string) => { const a = getAccount(); if (!a) return { ok: false }; return api('user_settings', { license_key: a.licenseKey, op: 'set', key, value }).catch(() => ({ ok: false })); },
      relaunch: async () => { try { location.reload(); } catch {} return { ok: true }; },
      getGraphicsCompat: async () => ({ enabled: false }),
      setGraphicsCompat: noop,
      listBrowserBackends: async () => ({ ok: true, backends: [] }),
      setBrowserBackend: noop,
    },
    requirements: { check: async () => ({ platform: 'web', items: [] }), install: noop, onInstallLog: () => () => {} },
    claudeAuth: { status: async () => ({ ok: true, loggedIn: true }), login: noop, submitCode: noop, cancel: noop, onLog: () => () => {} },
    update: { check: noop, download: noop, install: noop, onEvent: () => () => {} },
    openaiKey: {
      has: async () => {
        const a = getAccount(); if (!a) return { ok: false, has: false };
        const r = await api('openai_key_get', { license_key: a.licenseKey }).catch(() => null);
        if (!r?.ok) return { ok: false, has: false };
        // Tenta decifrar (mas pra "has" basta saber se o blob existe)
        if (r.has_key && r.enc) {
          try {
            const pt = await decryptOpenaiKey(r.enc, a.licenseKey);
            if (pt) (window as any).__maestrusOpenaiKey = pt;
          } catch {}
        }
        return { ok: true, has: !!r.has_key };
      },
      set: async (plaintext: string) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        const k = String(plaintext || '').trim();
        if (!/^sk-[a-zA-Z0-9_-]{16,}$/.test(k)) return { ok: false, error: 'invalid_key_format' };
        const enc = await encryptOpenaiKey(k, a.licenseKey);
        const r = await api('openai_key_set', { license_key: a.licenseKey, enc }).catch(() => null);
        if (!r?.ok) return { ok: false, error: r?.error || 'server' };
        (window as any).__maestrusOpenaiKey = k;
        return { ok: true };
      },
      delete: async () => {
        const a = getAccount(); if (!a) return { ok: false };
        const r = await api('openai_key_delete', { license_key: a.licenseKey }).catch(() => ({ ok: false }));
        delete (window as any).__maestrusOpenaiKey;
        return r;
      },
      // Cached plaintext (após o primeiro has() que decifra com sucesso)
      getCached: () => (window as any).__maestrusOpenaiKey || null,
    },
    // BYOK Anthropic — engine "Claude API" (substituiu o Cloud AI metrado).
    // Mesmo cofre cifrado do OpenAI; o HOST/container consome a chave via
    // watcher próprio — aqui só gerenciamos (set/has/delete).
    anthropicKey: {
      has: async () => {
        const a = getAccount(); if (!a) return { ok: false, has: false };
        const r = await api('anthropic_key_get', { license_key: a.licenseKey }).catch(() => null);
        if (!r?.ok) return { ok: false, has: false };
        return { ok: true, has: !!r.has_key };
      },
      set: async (plaintext: string) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        const k = String(plaintext || '').trim();
        if (!/^sk-ant-[a-zA-Z0-9_-]{16,}$/.test(k)) return { ok: false, error: 'invalid_key_format' };
        const enc = await encryptOpenaiKey(k, a.licenseKey); // mesmo AES-GCM/derivação
        const r = await api('anthropic_key_set', { license_key: a.licenseKey, enc }).catch(() => null);
        if (!r?.ok) return { ok: false, error: r?.error || 'server' };
        return { ok: true };
      },
      delete: async () => {
        const a = getAccount(); if (!a) return { ok: false };
        return api('anthropic_key_delete', { license_key: a.licenseKey }).catch(() => ({ ok: false }));
      },
      refresh: async () => ({ ok: true }),
    },
    cloud: {
      account: async () => getAccount(),
      login: async (email: string, password: string) => {
        const data = await api('activate', { email, password, device_id: deviceId(), device_name: (navigator.userAgent || 'web').slice(0, 40) });
        if (!data.ok) return { ok: false, error: data.error || 'invalid_credentials' };
        const acc = {
          email: data.user?.email || email, name: data.user?.name || null,
          licenseKey: data.license_key, plan: data.plan || null,
          usedBytes: data.used_bytes || 0, capBytes: data.cap_bytes || 0,
          overageCentsPerGb: data.overage_cents_per_gb || 0, ai: data.ai || null, loggedAt: Date.now(),
        };
        setAccount(acc);
        return { ok: true, account: acc };
      },
      validate: async () => { const a = getAccount(); if (!a) return { ok: false }; const r = await api('validate', { license_key: a.licenseKey, device_id: deviceId() }); if (r.ok) { const na = { ...a, ...(r.account || {}), ai: r.ai ?? a.ai }; setAccount(na); return { ok: true, account: na }; } return { ok: false }; },
      logout: async () => { localStorage.removeItem(LS_ACCOUNT); return { ok: true }; },
      openPanel: async () => {
        const a = getAccount();
        if (a) { try { const r = await api('sso', { license_key: a.licenseKey }); if (r && r.ok && r.token) { window.open(`https://maestrus.cloud/login.php?sso=${encodeURIComponent(r.token)}`, '_blank'); return { ok: true }; } } catch {} }
        window.open('https://maestrus.cloud/dashboard.php', '_blank'); return { ok: true };
      },
      aiStatus: async () => fetch(`${API_BASE}?action=ai_status`).then((r) => r.json()).catch(() => ({ ok: false, enabled: false })),
      syncState: async () => ({ loggedIn: !!getAccount(), states: {} }),
      sync: noop, syncProject: noop, getSyncInterval: async () => ({ sec: 0 }), setSyncInterval: noop,
      checkUpdate: noop, listSessions: async () => ({ ok: true, sessions: [] }), importSession: noop,
      // Maestrus on Cloud: lista as sessões cloud do usuário (aparecem só por logar).
      cloudList: async () => { const a = getAccount(); if (!a) return { ok: false, sessions: [] }; return api('cloud_list', { license_key: a.licenseKey }); },
      cloudStart: async (projectId: string, autoSetup?: boolean) => { const a = getAccount(); if (!a) return { ok: false }; return api('cloud_start', { license_key: a.licenseKey, project_id: projectId, auto_setup: autoSetup ? 1 : 0 }); },
      cloudStop: async (projectId: string) => { const a = getAccount(); if (!a) return { ok: false }; return api('cloud_stop', { license_key: a.licenseKey, project_id: projectId }); },
      cloudResume: async (projectId: string) => { const a = getAccount(); if (!a) return { ok: false }; return api('cloud_resume', { license_key: a.licenseKey, project_id: projectId }); },
      cloudPause: async (projectId: string) => { const a = getAccount(); if (!a) return { ok: false }; return api('cloud_pause', { license_key: a.licenseKey, project_id: projectId }); },
      // Ataca um container cloud em execução (vira o host ativo no relay). É o
      // mesmo transporte do remote control: connectHost por device_id.
      openCloud: async (deviceId: string, name?: string) => doConnectHost(deviceId, name),
      devices: async () => { const a = getAccount(); if (!a) return { ok: false, devices: [] }; return api('devices', { license_key: a.licenseKey }); },
      // Container 24/7 do usuário (aba "Maestrus Cloud"). Faltavam no web →
      // a tela sempre mostrava erro mesmo com o container de pé.
      containerStatus: async () => { const a = getAccount(); if (!a) return { ok: false }; return api('container_status', { license_key: a.licenseKey }); },
      containerProvision: async () => { const a = getAccount(); if (!a) return { ok: false }; return api('container_provision', { license_key: a.licenseKey }); },
      containerConnect: async () => autoConnectCloud(),
    },
    remote: {
      clientState: async () => ({ ...clientState }),
      connect: async (code: string) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        const pr = await api('pair_redeem', { license_key: a.licenseKey, device_id: deviceId(), code });
        if (!pr.ok || !pr.host_device_id) return { ok: false, error: pr.error || 'pair_failed' };
        const t = await api('relay_token', { license_key: a.licenseKey, device_id: deviceId(), role: 'client' });
        if (!t.ok || !t.token) return { ok: false, error: t.error || 'no_token' };
        hostId = pr.host_device_id; hostName = pr.host_name; cachedProjects = [];
        startClientLink(t.url, t.token);
        saveRemote();
        return { ok: true, hostName };
      },
      // Conecta num host CONHECIDO (device_id) — sem código. Usado pelos
      // projetos cloud (aparecem só por logar) e por hosts já pareados.
      connectHost: async (hostDid: string, hostNameArg?: string) => doConnectHost(hostDid, hostNameArg),
      // Reconecta do pareamento salvo (até 15 dias) — não desloga ao fechar o app.
      resume: async () => doResume(),
      // Alias usado pelo App.tsx desktop no boot em modo cliente.
      reconnect: async () => doResume(),
      // Fluxo unificado boot/resume: pareamento salvo + fallback discovery.
      ensureConnected: async () => ensureConnected(),
      // Revalida a conexão ao acordar (chamável manualmente também).
      ensureAlive: async () => ensureAlive(),
      // Descoberta por login (web): acha uma MÁQUINA online da mesma conta no
      // relay (host não-cloud) e conecta nela — sem código de pareamento.
      discover: async () => doDiscover(),
      // Conecta no container cloud da conta (Maestrus 24/7). Usado pós-onboarding.
      autoConnectCloud: async () => autoConnectCloud(),
      // Self-host: detecção + conexão por secret (sem cloud/conta).
      selfhostInfo: async () => detectSelfhost(),
      selfhostConnect: async (secret: string) => selfhostConnect(secret),
      selfhostResume: async () => selfhostResume(),
      // Preferência híbrida: mantém o link ativo na MÁQUINA quando ela existe
      // (projetos do container continuam visíveis via stubs). Chamado no boot.
      preferMachine: async () => preferMachine(),
      // Web não roda CLI local → não pode ser HOST. Degrada com segurança.
      hostState: async () => ({ running: false, status: 'idle', unsupported: true }),
      hostEnable: async () => ({ ok: false, error: 'desktop_only' }),
      hostDisable: noop,
      pairCreate: async () => ({ ok: false, error: 'desktop_only' }),
      onHostState: () => () => {},
      disconnect: async () => { try { link?.close(); } catch {} link = null; hostId = null; _pinnedCloudHost = null; cachedProjects = []; try { localStorage.removeItem(LS_REMOTE); } catch {} clientState = { connected: false, status: 'idle', hostName: null }; emitClientState(); return { ok: true }; },
      refreshProjects: async () => refreshProjects(),
      onClientState: (h: any) => { clientStateHandlers.add(h); return () => clientStateHandlers.delete(h); },
    },
    // Anexos no web: o arquivo NUNCA existe no host — sobe o conteúdo (base64)
    // e o host devolve o path local de lá pro @ref do prompt.
    files: {
      uploadToHost: async (projectId: string, att: { name: string; dataB64?: string; path?: string }) => {
        if (!link) return { ok: false, error: 'not_connected' };
        if (!att?.dataB64) return { ok: false, error: 'no_content' };
        const r = parseId(projectId);
        const pid = r ? r.projectId : projectId;
        return link.rpc('files.upload', { projectId: pid, name: att.name, dataB64: att.dataB64 }, 60000);
      },
    },
    // Claude Powers: agents/comandos/regras globais DO HOST conectado.
    claudePowers: {
      agentsList: async () => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.agentsList', {}, 10000); },
      agentsGet: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.agentsGet', { id }, 10000); },
      agentsSave: async (def: any) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.agentsSave', def, 10000); },
      agentsDelete: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.agentsDelete', { id }, 10000); },
      commandsList: async () => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.commandsList', {}, 10000); },
      commandsGet: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.commandsGet', { id }, 10000); },
      commandsSave: async (def: any) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.commandsSave', def, 10000); },
      commandsDelete: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.commandsDelete', { id }, 10000); },
      globalMdGet: async () => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.globalMdGet', {}, 10000); },
      globalMdSet: async (content: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.globalMdSet', { content }, 10000); },
      mcpList: async () => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.mcpList', {}, 70000); },
      mcpRemove: async (name: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.mcpRemove', { name }, 40000); },
      skillsList: async () => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.skillsList', {}, 20000); },
      skillsGet: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.skillsGet', { id }, 15000); },
      skillsSave: async (def: any) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.skillsSave', def, 20000); },
      skillsDelete: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudePowers.skillsDelete', { id }, 20000); },
    },
    // Multi-conta do Claude CLI no HOST conectado (Mac/PC ou container) — o web
    // troca a conta ativa remotamente; a conversa continua a mesma.
    claudeProfiles: {
      list: async () => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.list', {}, 10000); },
      create: async (name: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.create', { name }, 10000); },
      remove: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.remove', { id }, 10000); },
      setActive: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.setActive', { id }, 10000); },
      status: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.status', { id }, 20000); },
      loginStart: async (id: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.loginStart', { id }, 15000); },
      loginState: async () => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.loginState', {}, 10000); },
      loginCode: async (code: string) => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.loginCode', { code }, 15000); },
      loginCancel: async () => { if (!link) return { ok: false, error: 'not_connected' }; return link.rpc('claudeProfiles.loginCancel', {}, 10000); },
    },
    projects: {
      // Sidebar = projetos cloud (de cloud_list) SEMPRE visíveis + o host vivo
      // atachado (que sobrescreve o stub correspondente). Some o "abrir Remote
      // Access pra ver" — os projetos cloud aparecem direto.
      list: async () => {
        ensureStatusPoll();
        const stubs = await fetchCloudStubs();
        const byId = new Map<string, any>();
        // Maestro SEMPRE no topo. Se o cloud_list já trouxe a sessão 'maestrus'
        // (mapeada p/ id 'maestrus'), ela vence o stub; senão usa o stub frio.
        byId.set('maestrus', MAESTRO_STUB);
        for (const s of stubs) byId.set(s.id, s);
        // host vivo vence o stub, MAS preserva o nome autoritativo do cloud_list
        // (runner antigo pode reportar o id como nome → não deixa trocar o nome).
        // host atachado = container LIGADO de fato (temos relay vivo nele) →
        // força cloudStatus 'running'. Sem isso o stub trazia o status, mas o
        // projeto do host (tag()) não tinha o campo → sidebar mostrava "desligado"
        // enquanto respondia.
        for (const p of cachedProjects) {
          // o maestro vivo (remote:...:maestrus) funde no stub 'maestrus' (sem duplicar)
          if (p.remoteProjectId === 'maestrus' || p.id === 'maestrus') { byId.set('maestrus', { ...MAESTRO_STUB, cloudStatus: 'running', remoteHostId: hostId }); continue; }
          const s = byId.get(p.id);
          byId.set(p.id, { ...p, name: (s && s.name) || p.name, cloudStatus: 'running', previewUrl: (s && s.previewUrl) || (p as any).previewUrl || null });
        }
        return [...byId.values()];
      },
      get: async (id: string) => (id === 'maestrus' ? (cachedProjects.find((p) => p.remoteProjectId === 'maestrus') ? { ...MAESTRO_STUB, cloudStatus: 'running' } : MAESTRO_STUB) : null) || cachedProjects.find((p) => p.id === id) || cachedStubs.find((p) => p.id === id) || null,
      // No web, "criar projeto" = criar um projeto CLOUD (sandbox), não pasta local.
      create: async (input: any) => doCreateProject(input),
      import: noop, exportConfig: async () => null,
      // Excluir projeto cloud = cloud_delete no backend (tombstone + remove
      // container/volume). Antes era no-op → o projeto "voltava". Tira dos caches
      // e re-renderiza na hora.
      delete: async (id: string) => {
        const a = getAccount(); const r = parseId(id);
        if (!a || !r) return { ok: false };
        try { await api('cloud_delete', { license_key: a.licenseKey, project_id: r.projectId }); } catch {}
        cachedStubs = cachedStubs.filter((p) => p.id !== id);
        cachedProjects = cachedProjects.filter((p) => p.id !== id);
        stubsTs = 0; // força refetch limpo no próximo list
        emitProjectsChanged();
        return { ok: true };
      },
      onChanged: (h: any) => { projectsChangedHandlers.add(h); return () => projectsChangedHandlers.delete(h); },
      patch: async (id: string, patch: any) => {
        const r = parseId(id); if (!r || !link) return { ...patch, id };
        const updated = await link.rpc('projects.patch', { id: r.projectId, patch }, 8000).catch(() => null);
        // atualiza o cache local
        cachedProjects = cachedProjects.map((p) => p.id === id ? { ...p, ...patch } : p);
        // NUNCA retorna undefined (senão handleProjectUpdate quebra): fallback p/ stub/patch
        return updated ? tag(updated) : (cachedProjects.find((p) => p.id === id) || cachedStubs.find((p) => p.id === id) || { ...patch, id });
      },
    },
    // Conversas (forks) por projeto — espelha o preload do desktop; roda no host.
    conversations: {
      create: async (projectId: string, title?: string, forkFromConvId?: string) => {
        const r = parseId(projectId); if (!r || !link) throw new Error('not_connected');
        const conv = await link.rpc('conversations.create', { projectId: r.projectId, title, forkFromConvId }, 15000);
        await refreshProjects().catch(() => {}); emitProjectsChanged();
        return conv;
      },
      rename: async (projectId: string, convId: string, title: string) => {
        const r = parseId(projectId); if (!r || !link) throw new Error('not_connected');
        const conv = await link.rpc('conversations.rename', { projectId: r.projectId, convId, title }, 15000);
        await refreshProjects().catch(() => {}); emitProjectsChanged();
        return conv;
      },
      delete: async (projectId: string, convId: string) => {
        const r = parseId(projectId); if (!r || !link) throw new Error('not_connected');
        const ok = await link.rpc('conversations.delete', { projectId: r.projectId, convId }, 15000);
        await refreshProjects().catch(() => {}); emitProjectsChanged();
        return ok;
      },
    },
    claude: {
      // ensureHost: clicar num projeto cloud da sidebar atacha (e resume) sob
      // demanda antes de enviar/carregar — sem passo manual de "conectar".
      send: async (projectId: string, message: string) => {
        // MAESTRO (id 'maestrus'): híbrido (desktop pareado → CLI; senão nuvem).
        if (projectId === 'maestrus') {
          const ok = await ensureMaestroHost();
          if (!ok || !link) throw new Error('host-starting');
          return link.rpc('claude.send', { projectId: 'maestrus', message });
        }
        const r = parseId(projectId); if (!r) throw new Error('sem conexão');
        const online = await ensureHost(r.hostId);
        if (!online || !link) throw new Error('host-starting'); // UI mostra "iniciando…", usuário reenvia
        try { return await link.rpc('claude.send', { projectId: r.projectId, message }); }
        catch (e: any) {
          // host caiu/expirou no meio → resume e tenta de novo uma vez
          if (String(e && e.message || '').includes('target-offline')) { const ok = await ensureHost(r.hostId); if (ok && link) return link.rpc('claude.send', { projectId: r.projectId, message }); throw new Error('host-starting'); }
          throw e;
        }
      },
      stop: async (projectId: string) => {
        if (projectId === 'maestrus') { if (!link) return false; return link.rpc('claude.stop', { projectId: 'maestrus' }, 8000).catch(() => false); }
        const r = parseId(projectId); if (!r) return false; await ensureHost(r.hostId); if (!link) return false; return link.rpc('claude.stop', { projectId: r.projectId }, 8000).catch(() => false);
      },
      loadHistory: async (projectId: string) => {
        if (projectId === 'maestrus') { const ok = await ensureMaestroHost(); if (!ok || !link) return []; return link.rpc('claude.loadHistory', { projectId: 'maestrus' }, 15000).catch(() => []); }
        const r = parseId(projectId); if (!r) return []; await ensureHost(r.hostId); if (!link) return []; return link.rpc('claude.loadHistory', { projectId: r.projectId }, 15000).catch(() => []);
      },
      usage: async () => ({}), version: async () => 'remote', logout: noop,
      listAgents: async () => [], listMemories: async () => [], dispatch: noop, compact: noop,
      onEvent: (h: any) => { eventHandlers.add(h); return () => eventHandlers.delete(h); },
    },
    // MCP no web: catálogo curado + busca na registry + auth cifrada (AES-GCM,
    // chave da licença) persistida no DB (user_mcps/user_mcp_auth). O sandbox
    // cloud carrega esses servidores do mesmo DB no start.
    mcp: {
      catalog: async () => {
        const a = getAccount(); if (!a) return { popular: [], installed: [], encAvailable: false };
        const r = await api('user_mcps', { license_key: a.licenseKey, op: 'list' }).catch(() => ({}));
        const recs: any[] = r.servers || [];
        const byId: Record<string, any> = {}; for (const s of recs) byId[s.server_id] = s;
        const popular = WEB_MCP_CURATED.map((c) => ({
          id: c.id, label: c.label, desc: c.desc, docs: c.docs, kind: 'curated',
          fields: c.fields.map((f: any) => ({ key: f.key, label: f.label, placeholder: f.placeholder || '', secret: !!f.secret })),
          enabled: byId[c.id]?.enabled === 1, configured: !!byId[c.id],
        }));
        const curatedIds = new Set(WEB_MCP_CURATED.map((c) => c.id));
        const installed = recs.filter((s) => !curatedIds.has(s.server_id)).map((s) => ({
          id: s.server_id, label: s.label || s.server_id, desc: '', transport: s.transport || 'stdio',
          requires: s.transport === 'http' || s.transport === 'sse' ? 'none' : 'node', source: s.source || 'custom',
          enabled: s.enabled === 1, configured: true, kind: 'installed',
          fields: [],
        }));
        return { popular, installed, encAvailable: true };
      },
      search: async (q: string) => webMcpSearch(q),
      setAuth: async (id: string, values: any) => {
        const a = getAccount(); if (!a) return { ok: false, configured: false };
        const cur = WEB_MCP_CURATED.find((c) => c.id === id);
        // garante registro do servidor (curado) pra aparecer como configurado
        if (cur) await api('user_mcps', { license_key: a.licenseKey, op: 'upsert', server_id: id, label: cur.label, transport: 'stdio', command: cur.run?.command || 'npx', args_json: JSON.stringify(cur.run?.args || []), source: 'curated', enabled: true }).catch(() => {});
        const auth_enc = await encryptAuth(values || {}, a.licenseKey);
        await api('user_mcp_auth', { license_key: a.licenseKey, op: 'set', server_id: id, auth_enc }).catch(() => {});
        return { ok: true, configured: true };
      },
      enable: async (id: string) => {
        const a = getAccount(); if (!a) return { ok: false };
        const cur = WEB_MCP_CURATED.find((c) => c.id === id);
        if (cur) await api('user_mcps', { license_key: a.licenseKey, op: 'upsert', server_id: id, label: cur.label, transport: 'stdio', command: cur.run?.command || 'npx', args_json: JSON.stringify(cur.run?.args || []), source: 'curated', enabled: true }).catch(() => {});
        else await api('user_mcps', { license_key: a.licenseKey, op: 'enable', server_id: id, enabled: true }).catch(() => {});
        return { ok: true };
      },
      disable: async (id: string) => {
        const a = getAccount(); if (!a) return { ok: false };
        await api('user_mcps', { license_key: a.licenseKey, op: 'enable', server_id: id, enabled: false }).catch(() => {});
        return { ok: true };
      },
      removeAuth: async (id: string) => {
        const a = getAccount(); if (!a) return { ok: false };
        await api('user_mcps', { license_key: a.licenseKey, op: 'delete', server_id: id }).catch(() => {});
        return { ok: true };
      },
      install: async (descriptor: any, values: any) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        const id = String(descriptor.id || descriptor.label || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || ('mcp_' + Date.now().toString(36));
        await api('user_mcps', {
          license_key: a.licenseKey, op: 'upsert', server_id: id, label: descriptor.label || id,
          transport: descriptor.transport || 'stdio', command: descriptor.command || null,
          args_json: descriptor.args ? JSON.stringify(Array.isArray(descriptor.args) ? descriptor.args : String(descriptor.args).split(' ').filter(Boolean)) : null,
          url: descriptor.url || null, headers_json: descriptor.headerTemplates ? JSON.stringify(descriptor.headerTemplates) : null,
          source: descriptor.source || 'registry', enabled: true,
        }).catch(() => {});
        if (values && Object.keys(values).length) {
          const auth_enc = await encryptAuth(values, a.licenseKey);
          await api('user_mcp_auth', { license_key: a.licenseKey, op: 'set', server_id: id, auth_enc }).catch(() => {});
        }
        return { ok: true, id };
      },
      uninstall: async (id: string) => {
        const a = getAccount(); if (!a) return { ok: false };
        await api('user_mcps', { license_key: a.licenseKey, op: 'delete', server_id: id }).catch(() => {});
        return { ok: true };
      },
      list: async () => { const a = getAccount(); if (!a) return { ok: true, servers: [] }; const r = await api('user_mcps', { license_key: a.licenseKey, op: 'list' }).catch(() => ({})); return { ok: true, servers: r.servers || [] }; },
      get: noop, add: noop, remove: noop,
    },
    // Skills globais persistidas no DB (user_skills) → o usuário gerencia de
    // qualquer device e elas valem em todo projeto (inclusive nos sandboxes
    // cloud, que carregam do mesmo DB no start).
    skills: {
      list: async () => {
        const a = getAccount(); if (!a) return { skills: [] };
        const r = await api('user_skills', { license_key: a.licenseKey, op: 'list' }).catch(() => ({}));
        const skills = (r.skills || []).map((s: any) => ({ id: s.skill_id, name: s.name || '', description: s.description || '', enabled: s.enabled !== 0 }));
        return { skills };
      },
      get: async (id: string) => {
        const a = getAccount(); if (!a) return null;
        const r = await api('user_skills', { license_key: a.licenseKey, op: 'list' }).catch(() => ({}));
        const s = (r.skills || []).find((x: any) => x.skill_id === id);
        return s ? { id: s.skill_id, name: s.name || '', description: s.description || '', body: s.body || '' } : null;
      },
      save: async (s: { id?: string; name: string; description: string; body: string }) => {
        const a = getAccount(); if (!a) return { ok: false };
        const sid = s.id || ('sk_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
        await api('user_skills', { license_key: a.licenseKey, op: 'save', skill_id: sid, name: s.name, description: s.description, body: s.body, enabled: true }).catch(() => {});
        return { ok: true, id: sid };
      },
      delete: async (id: string) => {
        const a = getAccount(); if (!a) return { ok: false };
        await api('user_skills', { license_key: a.licenseKey, op: 'delete', skill_id: id }).catch(() => {});
        return { ok: true };
      },
    },
    // CLAUDE.md por projeto cloud, persistido no DB (cloud_project_files) →
    // o editor funciona no web e fica igual em todos os devices.
    claudeMd: {
      read: async (id: string) => {
        const a = getAccount(); const r = parseId(id);
        if (!a || !r) return { exists: false, path: null, content: '' };
        const res = await api('cloud_file', { license_key: a.licenseKey, op: 'read', project_id: r.projectId, path: 'CLAUDE.md' }).catch(() => ({}));
        return { exists: !!res.exists, path: 'CLAUDE.md', content: res.content || '' };
      },
      write: async (id: string, content: string) => {
        const a = getAccount(); const r = parseId(id);
        if (!a || !r) return { exists: false, path: null, content };
        await api('cloud_file', { license_key: a.licenseKey, op: 'write', project_id: r.projectId, path: 'CLAUDE.md', content }).catch(() => {});
        return { exists: true, path: 'CLAUDE.md', content };
      },
      ensure: async (id: string) => {
        const a = getAccount(); const r = parseId(id);
        if (!a || !r) return { exists: false, path: null, content: '' };
        const res = await api('cloud_file', { license_key: a.licenseKey, op: 'read', project_id: r.projectId, path: 'CLAUDE.md' }).catch(() => ({}));
        if (res && res.exists) return { exists: true, path: 'CLAUDE.md', content: res.content || '' };
        const tpl = '# CLAUDE.md\n\nInstruções do projeto pra o Maestrus.\n';
        await api('cloud_file', { license_key: a.licenseKey, op: 'write', project_id: r.projectId, path: 'CLAUDE.md', content: tpl }).catch(() => {});
        return { exists: true, path: 'CLAUDE.md', content: tpl };
      },
    },
    dialog: { pickFolder: async () => null, pickFile: async () => null },
    shell: { openFolder: async () => '', openExternal: async (url: string) => { window.open(url, '_blank'); } },
    browser: { onOpen: () => () => {} },
    // Inicializador/wake word só existem no desktop. No web viram no-op seguro
    // (wake desligado → App.tsx não carrega o engine de voz).
    starter: {
      get: async () => ({ project: null, bat: '', flow: [], wakePhrase: 'Hello Maestrus', wakeEnabled: false }),
      saveBat: async () => ({ ok: false, error: 'desktop_only' }),
      setWake: async () => ({ ok: true, wakePhrase: 'Hello Maestrus', wakeEnabled: false }),
      run: async () => ({ ok: false, startVoice: false }),
      onOpenVoice: () => () => {},
    },
    ssh: {},
    tasks: {
      // No PWA, falamos direto com a API (sem Electron no meio). O dispatcher
      // mora num desktop conectado da mesma conta — aqui so editamos a fila.
      list:        async ()                 => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        return api('tasks', { op: 'list', license_key: a.licenseKey });
      },
      create:      async (t: any) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        const id = t && t.id ? t.id : ('t_' + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 7));
        const r = await api('tasks', { op: 'create', license_key: a.licenseKey, ...t, id });
        return { ...r, id };
      },
      update:      async (id: string, patch: any) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        return api('tasks', { op: 'update', license_key: a.licenseKey, id, ...patch });
      },
      delete:      async (id: string) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        return api('tasks', { op: 'delete', license_key: a.licenseKey, id });
      },
      reorder:     async (moves: any) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        return api('tasks', { op: 'reorder', license_key: a.licenseKey, moves });
      },
      settingsGet: async () => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        return api('tasks', { op: 'settings_get', license_key: a.licenseKey });
      },
      settingsSet: async (s: any) => {
        const a = getAccount(); if (!a) return { ok: false, error: 'not_logged_in' };
        return api('tasks', { op: 'settings_set', license_key: a.licenseKey, ...s });
      },
      newId:       async () => ('t_' + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 7)),
      onChanged:   (_h: any) => () => {}, // mobile: polling no componente
    },
  };
  // Detecta cedo se somos servidos por um servidor self-host (popula selfhostCfg
  // antes do App checar getAccount).
  detectSelfhost().catch(() => {});
  // Revalida a sessão remota ao voltar do background / recuperar rede.
  installLifecycle();
}
