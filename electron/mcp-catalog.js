'use strict';
// Biblioteca de conectores MCP do Maestrus — TELA ÚNICA.
//
// Três fontes, um modelo:
//   1) "Populares": catálogo curado (cards bonitos com campos de auth).
//   2) "Explorar": busca na MCP Registry oficial (registry.modelcontextprotocol.io)
//      — milhares de servidores. Deriva a instalação automática:
//        • pacote npm  → stdio via `npx -y <pkg>` (Node já vem bundlado)
//        • remote http/sse → entrada {type:'http'|'sse', url, headers} (sem runtime)
//        • pypi (uvx) / oci (docker) → mostrados, exigem uv/Docker.
//   3) "Personalizado": command/args/env manuais.
//
// O usuário só preenche a autenticação; o Maestrus mescla os ATIVOS no .mcp.json
// de todo projeto (writeMaestrusMcpConfig). Tokens → cofre cifrado (safeStorage),
// NUNCA texto puro. (Conectores vivem na máquina; cross-device é via modo server.)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('./electron-compat');
const projectStore = require('./project-store');
const cloud = require('./cloud');

const isWin = process.platform === 'win32';
const NPX = isWin ? 'npx.cmd' : 'npx';
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';

function npx(pkg, extra) { return { command: NPX, args: ['-y', pkg, ...(extra || [])] }; }

// ─── Catálogo curado (populares) ─────────────────────────────────────────────
const CATALOG = [
  { id: 'github', label: 'GitHub', cat: 'Dev', desc: 'Repositórios, issues, PRs e busca de código.', docs: 'https://github.com/settings/tokens', run: npx('@modelcontextprotocol/server-github'), fields: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal Access Token', placeholder: 'ghp_…', secret: true }] },
  { id: 'notion', label: 'Notion', cat: 'Produtividade', desc: 'Páginas, bancos de dados e busca no Notion.', docs: 'https://www.notion.so/my-integrations', run: npx('@notionhq/notion-mcp-server'), fields: [{ key: 'NOTION_TOKEN', label: 'Internal Integration Token', placeholder: 'ntn_… / secret_…', secret: true }], buildEnv: (v) => ({ OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: `Bearer ${v.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }) }) },
  { id: 'slack', label: 'Slack', cat: 'Comunicação', desc: 'Ler/enviar mensagens, canais e usuários.', docs: 'https://api.slack.com/apps', run: npx('@modelcontextprotocol/server-slack'), fields: [{ key: 'SLACK_BOT_TOKEN', label: 'Bot Token', placeholder: 'xoxb-…', secret: true }, { key: 'SLACK_TEAM_ID', label: 'Team ID', placeholder: 'T01234567', secret: false }] },
  { id: 'airtable', label: 'Airtable', cat: 'Produtividade', desc: 'Bases, tabelas e registros.', docs: 'https://airtable.com/create/tokens', run: npx('airtable-mcp-server'), fields: [{ key: 'AIRTABLE_API_KEY', label: 'Personal Access Token', placeholder: 'pat…', secret: true }] },
  { id: 'linear', label: 'Linear', cat: 'Dev', desc: 'Issues, projetos e ciclos.', docs: 'https://linear.app/settings/api', run: npx('@tacticlaunch/mcp-linear'), fields: [{ key: 'LINEAR_API_TOKEN', label: 'API Key', placeholder: 'lin_api_…', secret: true }] },
  { id: 'stripe', label: 'Stripe', cat: 'Negócios', desc: 'Clientes, pagamentos, assinaturas, produtos.', docs: 'https://dashboard.stripe.com/apikeys', run: npx('@stripe/mcp', ['--tools=all']), fields: [{ key: 'STRIPE_API_KEY', label: 'Secret Key', placeholder: 'sk_live_… / sk_test_…', secret: true }] },
  { id: 'postgres', label: 'PostgreSQL', cat: 'Dados', desc: 'Consultar seu banco PostgreSQL.', docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres', run: { command: NPX, args: ['-y', '@modelcontextprotocol/server-postgres'] }, fields: [{ key: 'DATABASE_URL', label: 'Connection String', placeholder: 'postgresql://user:pass@host:5432/db', secret: true }], asArg: 'DATABASE_URL' },
  { id: 'sentry', label: 'Sentry', cat: 'Dev', desc: 'Issues e eventos de erro.', docs: 'https://sentry.io/settings/account/api/auth-tokens/', run: npx('@sentry/mcp-server'), fields: [{ key: 'SENTRY_AUTH_TOKEN', label: 'Auth Token', placeholder: 'sntrys_…', secret: true }] },
  { id: 'brave', label: 'Brave Search', cat: 'Web', desc: 'Busca na web em tempo real.', docs: 'https://brave.com/search/api/', run: npx('@modelcontextprotocol/server-brave-search'), fields: [{ key: 'BRAVE_API_KEY', label: 'API Key', placeholder: 'BSA…', secret: true }] },
  { id: 'figma', label: 'Figma', cat: 'Design', desc: 'Frames, componentes e estilos.', docs: 'https://www.figma.com/developers/api#access-tokens', run: npx('figma-developer-mcp', ['--stdio']), fields: [{ key: 'FIGMA_API_KEY', label: 'Personal Access Token', placeholder: 'figd_…', secret: true }] },
  { id: 'atlassian', label: 'Jira / Confluence', cat: 'Produtividade', desc: 'Issues do Jira e páginas do Confluence.', docs: 'https://id.atlassian.com/manage-profile/security/api-tokens', run: npx('mcp-atlassian'), fields: [{ key: 'JIRA_URL', label: 'Site URL', placeholder: 'https://empresa.atlassian.net', secret: false }, { key: 'JIRA_USERNAME', label: 'E-mail', placeholder: 'voce@empresa.com', secret: false }, { key: 'JIRA_API_TOKEN', label: 'API Token', placeholder: 'ATATT…', secret: true }] },
  { id: 'supabase', label: 'Supabase', cat: 'Dados', desc: 'Gerencie e consulte seus projetos.', docs: 'https://supabase.com/dashboard/account/tokens', run: npx('@supabase/mcp-server-supabase@latest'), fields: [{ key: 'SUPABASE_ACCESS_TOKEN', label: 'Access Token', placeholder: 'sbp_…', secret: true }] },
  { id: 'hubspot', label: 'HubSpot', cat: 'Negócios', desc: 'Contatos, negócios e empresas.', docs: 'https://app.hubspot.com/private-apps', run: npx('@hubspot/mcp-server'), fields: [{ key: 'PRIVATE_APP_ACCESS_TOKEN', label: 'Private App Token', placeholder: 'pat-…', secret: true }] },
  { id: 'asana', label: 'Asana', cat: 'Produtividade', desc: 'Tarefas, projetos e workspaces.', docs: 'https://app.asana.com/0/my-apps', run: npx('@roychri/mcp-server-asana'), fields: [{ key: 'ASANA_ACCESS_TOKEN', label: 'Personal Access Token', placeholder: '1/1234…', secret: true }] },
  { id: 'discord', label: 'Discord', cat: 'Comunicação', desc: 'Ler/enviar mensagens nos servidores.', docs: 'https://discord.com/developers/applications', run: npx('mcp-discord'), fields: [{ key: 'DISCORD_TOKEN', label: 'Bot Token', placeholder: '…', secret: true }] },
  { id: 'telegram', label: 'Telegram', cat: 'Comunicação', desc: 'Enviar/ler mensagens via bot.', docs: 'https://core.telegram.org/bots#botfather', run: npx('@modelcontextprotocol/server-telegram'), fields: [{ key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', placeholder: '123456:ABC-…', secret: true }] },
  { id: 'cloudflare', label: 'Cloudflare', cat: 'Dev', desc: 'Workers, KV, R2 e DNS.', docs: 'https://dash.cloudflare.com/profile/api-tokens', run: npx('@cloudflare/mcp-server-cloudflare'), fields: [{ key: 'CLOUDFLARE_API_TOKEN', label: 'API Token', placeholder: '…', secret: true }, { key: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', placeholder: '…', secret: false }] },
  { id: 'meta', label: 'Meta (Facebook/Instagram)', cat: 'Marketing', desc: 'Páginas, posts e insights via Graph API.', docs: 'https://developers.facebook.com/tools/explorer/', run: npx('meta-ads-mcp'), fields: [{ key: 'META_ACCESS_TOKEN', label: 'Access Token', placeholder: 'EAAB…', secret: true }] },
  { id: 'gmail', label: 'Gmail', cat: 'Comunicação', desc: 'Ler, buscar e enviar e-mails (OAuth).', docs: 'https://github.com/GongRzhe/Gmail-MCP-Server', run: npx('@gongrzhe/server-gmail-autoauth-mcp'), fields: [{ key: 'GMAIL_CREDENTIALS_PATH', label: 'OAuth credentials.json (caminho)', placeholder: 'C:\\…\\gcp-oauth.keys.json', secret: false }] },
];

function vaultPath() { return path.join(app.getPath('userData'), 'mcp-vault.json'); }
function readVault() { try { const p = vaultPath(); if (!fs.existsSync(p)) return {}; return JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch { return {}; } }
function writeVault(o) { fs.writeFileSync(vaultPath(), JSON.stringify(o, null, 2), { encoding: 'utf8', mode: 0o600 }); }
function encAvailable() { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } }
function getValues(id) { const e = readVault()[id]; if (!e || !e.enc) return {}; try { return JSON.parse(safeStorage.decryptString(Buffer.from(e.enc, 'base64'))) || {}; } catch { return {}; } }
function setValues(id, values) { if (!encAvailable()) throw new Error('Criptografia do SO indisponível — não dá pra guardar tokens com segurança.'); const all = readVault(); all[id] = { enc: safeStorage.encryptString(JSON.stringify(values || {})).toString('base64') }; writeVault(all); }
// Variante sem-throw pra materializar auth vinda do DB no pull (se o safeStorage
// do SO estiver indisponível, só ignora — o servidor segue no DB, sem cache local).
function setValuesRaw(id, values) { try { if (!encAvailable()) return; const all = readVault(); all[id] = { enc: safeStorage.encryptString(JSON.stringify(values || {})).toString('base64') }; writeVault(all); } catch {} }
function clearValues(id) { const all = readVault(); if (all[id]) { delete all[id]; writeVault(all); } }

function enabledIds() { const v = projectStore.getSetting('mcp_enabled'); return Array.isArray(v) ? v : []; }
function setEnabledIds(ids) { projectStore.setSetting('mcp_enabled', Array.from(new Set(ids || []))); }

// ─── Cripto de auth de MCP (AES-256-GCM, chave da licença) ───────────────────
// IDÊNTICA à do web (maestrus-web.ts encryptAuth/deriveMcpKey) e à do backend
// (api.php mcp_derive_key / mcp_decrypt_auth) pra interoperar: o DB guarda só o
// ciphertext; chave = PBKDF2-SHA256(license, 'maestrus-mcp-v1', 100k, 32B).
// Formato do payload: base64( iv[12] || ciphertext || authTag[16] ).
function deriveMcpKey(license) { return crypto.pbkdf2Sync(String(license || ''), 'maestrus-mcp-v1', 100000, 32, 'sha256'); }
function encryptAuth(values, license) {
  const key = deriveMcpKey(license);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(values || {}), 'utf8'), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]).toString('base64');
}
function decryptAuth(encB64, license) {
  try {
    const raw = Buffer.from(String(encB64 || ''), 'base64');
    if (raw.length < 12 + 16 + 1) return {};
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', deriveMcpKey(license), iv);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    const j = JSON.parse(pt);
    return (j && typeof j === 'object') ? j : {};
  } catch { return {}; }
}

// ─── Sync com o DB (user_mcps / user_mcp_auth) ───────────────────────────────
// Logado → o DB é a fonte da verdade compartilhada (mesma config no web, no
// desktop e no sandbox cloud). Estratégia: o vault/records LOCAIS são um cache
// materializado do DB; toda mutação grava nos dois (DB + local) e o
// enabledServers() (síncrono) segue lendo o cache local sem mudança.
function isLogged() { try { return !!cloud.getAccount(); } catch { return false; } }
function licenseKey() { try { const a = cloud.getAccount(); return a ? a.licenseKey : null; } catch { return null; } }

// "Run" de um curado (command/args) pra mandar pro DB — assim o sandbox cloud
// sabe como subir o servidor. Não inclui env/segredos (vão cifrados na auth).
function curatedRun(id) {
  const def = findCurated(id);
  if (!def || !def.run) return { command: NPX, args: [] };
  return { command: def.run.command || NPX, args: (def.run.args || []).slice() };
}

// Monta o payload `upsert` (user_mcps) pra um id, a partir do que está local.
function upsertPayloadFor(id) {
  const def = findCurated(id);
  if (def) {
    const run = curatedRun(id);
    return { server_id: id, label: def.label, transport: 'stdio', command: run.command, args_json: JSON.stringify(run.args), url: null, headers_json: null, source: 'curated', enabled: enabledIds().includes(id) };
  }
  const r = installedRecords().find((x) => x.id === id);
  if (!r) return null;
  const isRemote = r.transport === 'http' || r.transport === 'sse';
  return {
    server_id: id, label: r.label || id, transport: r.transport || 'stdio',
    command: isRemote ? null : (r.command || null),
    args_json: isRemote ? null : JSON.stringify(r.args || []),
    url: isRemote ? (r.url || null) : null,
    headers_json: (r.headerTemplates && r.headerTemplates.length) ? JSON.stringify(r.headerTemplates) : null,
    source: r.source || 'registry', enabled: enabledIds().includes(id),
  };
}

async function pushUpsert(id) {
  if (!isLogged()) return;
  const p = upsertPayloadFor(id); if (!p) return;
  try { await cloud.userApi('user_mcps', { op: 'upsert', ...p }); } catch {}
}
async function pushEnable(id, on) {
  if (!isLogged()) return;
  try { await cloud.userApi('user_mcps', { op: 'enable', server_id: id, enabled: !!on }); } catch {}
}
async function pushDelete(id) {
  if (!isLogged()) return;
  try { await cloud.userApi('user_mcps', { op: 'delete', server_id: id }); } catch {}
}
async function pushAuth(id, values) {
  if (!isLogged()) return;
  const lic = licenseKey(); if (!lic) return;
  try { await cloud.userApi('user_mcp_auth', { op: 'set', server_id: id, auth_enc: encryptAuth(values || {}, lic) }); } catch {}
}

// Pull do DB → materializa local (installedRecords + enabled + vault cifrado).
// Roda no START quando logado (igual materializeCloudSkills) e antes de cada
// catalog() pra refletir mudanças feitas em outro device. Curados não viram
// installedRecords (vêm do CATALOG); só herdam enabled/auth.
let _lastPull = 0;
async function pullFromCloud(force) {
  if (!isLogged()) return false;
  const lic = licenseKey(); if (!lic) return false;
  const now = Date.now();
  if (!force && now - _lastPull < 4000) return false;
  _lastPull = now;
  let servers;
  try { const r = await cloud.userApi('user_mcps', { op: 'list' }); servers = (r && r.servers) || null; }
  catch { return false; }
  if (!Array.isArray(servers)) return false;

  const curatedIds = new Set(CATALOG.map((c) => c.id));
  const installed = [];
  const enabled = [];
  for (const s of servers) {
    const id = s.server_id; if (!id) continue;
    if (s.enabled === 1 || s.enabled === true) enabled.push(id);
    if (!curatedIds.has(id)) {
      const transport = s.transport || 'stdio';
      const isRemote = transport === 'http' || transport === 'sse';
      installed.push({
        id, label: s.label || id, regName: null, transport,
        source: s.source || 'registry',
        command: isRemote ? null : (s.command || null),
        args: parseJsonArr(s.args_json),
        url: isRemote ? (s.url || null) : null,
        headerTemplates: parseJsonArr(s.headers_json),
        fields: [], requires: isRemote ? 'none' : 'node',
      });
    }
    // auth cifrada → materializa no vault local pra o enabledServers() usar
    try {
      const ar = await cloud.userApi('user_mcp_auth', { op: 'get', server_id: id });
      if (ar && ar.auth_enc) { const vals = decryptAuth(ar.auth_enc, lic); if (vals && Object.keys(vals).length) setValuesRaw(id, vals); }
    } catch {}
  }
  setInstalledRecords(installed);
  setEnabledIds(enabled);
  return true;
}
function parseJsonArr(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

// Servidores instalados (registry/personalizado) — registros ricos. Migra do
// antigo 'mcp_custom' (só stdio) se existir.
function installedRecords() {
  let v = projectStore.getSetting('mcp_installed');
  if (!Array.isArray(v)) {
    const legacy = projectStore.getSetting('mcp_custom');
    v = Array.isArray(legacy) ? legacy.map((d) => ({ id: d.id, label: d.label, transport: 'stdio', command: d.command, args: d.args, source: 'custom' })) : [];
    if (v.length) projectStore.setSetting('mcp_installed', v);
  }
  return v;
}
function setInstalledRecords(recs) { projectStore.setSetting('mcp_installed', recs || []); }

function findCurated(id) { return CATALOG.find((c) => c.id === id) || null; }
function safeName(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'mcp'; }

// ─── Derivação de instalação a partir de um server da Registry ───────────────
function placeholders(str) { const out = []; const re = /\{([a-zA-Z0-9_]+)\}/g; let m; while ((m = re.exec(String(str || '')))) out.push(m[1]); return out; }

function deriveFromRegistry(sv) {
  const pkgs = sv.packages || [];
  const remotes = sv.remotes || [];
  const npm = pkgs.find((p) => p.registryType === 'npm');
  const httpR = remotes.find((r) => r.type === 'streamable-http' || r.type === 'http');
  const sseR = remotes.find((r) => r.type === 'sse');
  const pypi = pkgs.find((p) => p.registryType === 'pypi');
  const oci = pkgs.find((p) => p.registryType === 'oci');
  const baseId = safeName((sv.name || '').split('/').pop() || sv.name);
  const label = sv.title || (sv.name || '').split('/').pop() || sv.name;

  const argVals = (arr) => (arr || []).map((a) => a && a.value).filter((x) => x != null).map(String);

  if (npm) {
    let args = argVals(npm.runtimeArguments);
    if (!args.length) args = ['-y'];
    args.push(npm.version ? `${npm.identifier}@${npm.version}` : npm.identifier);
    args.push(...argVals(npm.packageArguments));
    const fields = (npm.environmentVariables || []).map((e) => ({ key: e.name, label: e.description || e.name, secret: !!e.isSecret, required: !!e.isRequired, placeholder: e.default || '' }));
    return { id: baseId, label, transport: 'stdio', command: NPX, args, fields, requires: 'node' };
  }
  if (httpR || sseR) {
    const r = httpR || sseR;
    const headerTemplates = (r.headers || []).map((h) => ({ name: h.name, value: h.value }));
    const ph = new Set();
    for (const h of headerTemplates) placeholders(h.value).forEach((p) => ph.add(p));
    placeholders(r.url).forEach((p) => ph.add(p));
    const meta = {};
    for (const h of (r.headers || [])) for (const p of placeholders(h.value)) meta[p] = { secret: h.isSecret, required: h.isRequired, label: h.description };
    const fields = [...ph].map((k) => ({ key: k, label: (meta[k] && meta[k].label) || k, secret: !!(meta[k] && meta[k].secret), required: !!(meta[k] && meta[k].required), placeholder: '' }));
    return { id: baseId, label, transport: httpR ? 'http' : 'sse', url: r.url, headerTemplates, fields, requires: 'none' };
  }
  if (pypi) {
    let args = argVals(pypi.runtimeArguments); args.push(pypi.identifier);
    const fields = (pypi.environmentVariables || []).map((e) => ({ key: e.name, label: e.description || e.name, secret: !!e.isSecret, required: !!e.isRequired, placeholder: e.default || '' }));
    return { id: baseId, label, transport: 'stdio', command: 'uvx', args, fields, requires: 'python' };
  }
  if (oci) {
    return { id: baseId, label, transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', oci.identifier], fields: [], requires: 'docker' };
  }
  return null;
}

// ─── Busca na Registry (paginada) ────────────────────────────────────────────
async function search(query, cursor) {
  let url = `${REGISTRY}?limit=30`;
  if (query) url += `&search=${encodeURIComponent(query)}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  let json;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Maestrus' } });
    if (!res.ok) throw new Error('registry HTTP ' + res.status);
    json = await res.json();
  } finally { clearTimeout(to); }
  const installed = new Set(installedRecords().map((r) => r.id));
  const seen = new Set();
  const items = [];
  for (const entry of (json.servers || [])) {
    const sv = entry.server || entry;
    const meta = entry._meta && entry._meta['io.modelcontextprotocol.registry/official'];
    if (meta && meta.isLatest === false) continue; // só a versão mais nova
    const d = deriveFromRegistry(sv);
    if (!d) continue;
    if (seen.has(d.id)) continue; seen.add(d.id);
    items.push({
      id: d.id, regName: sv.name, label: d.label, description: sv.description || '',
      version: sv.version || '', transport: d.transport, requires: d.requires,
      fields: d.fields, command: d.command, args: d.args, url: d.url, headerTemplates: d.headerTemplates,
      installed: installed.has(d.id),
    });
  }
  return { items, nextCursor: (json.metadata && json.metadata.nextCursor) || null };
}

// ─── Visão pra UI (sem segredos) ─────────────────────────────────────────────
function catalog() {
  const enabled = new Set(enabledIds());
  const popular = CATALOG.map((c) => ({
    id: c.id, label: c.label, desc: c.desc, docs: c.docs, cat: c.cat || 'Outros',
    fields: c.fields.map((f) => ({ key: f.key, label: f.label, placeholder: f.placeholder || '', secret: !!f.secret })),
    enabled: enabled.has(c.id), configured: !!readVault()[c.id], kind: 'curated',
  }));
  const installed = installedRecords().map((r) => ({
    id: r.id, label: r.label || r.id, desc: r.regName || '', transport: r.transport,
    requires: r.requires || (r.transport === 'stdio' ? 'node' : 'none'), source: r.source || 'registry',
    enabled: enabled.has(r.id), configured: !!readVault()[r.id], kind: 'installed',
    fields: (r.fields || []).map((f) => ({ key: f.key, label: f.label, placeholder: f.placeholder || '', secret: !!f.secret, required: !!f.required })),
  }));
  return { popular, installed, encAvailable: encAvailable() };
}

// Logado → puxa o estado do DB (materializa local) e devolve o catálogo já
// refletindo o que foi configurado em qualquer device. Deslogado → 100% local.
async function refresh() {
  try { await pullFromCloud(false); } catch {}
  return catalog();
}

// ─── Curados: auth/enable/disable/remove ─────────────────────────────────────
function setAuth(id, values) {
  const def = findCurated(id); if (!def) return setServerAuth(id, values);
  const clean = {}; for (const f of def.fields) if (values && values[f.key] != null && values[f.key] !== '') clean[f.key] = String(values[f.key]);
  setValues(id, clean);
  // Logado: garante o registro do curado no DB (pra aparecer/rodar no cloud) e
  // grava a auth cifrada. Fire-and-forget — o .mcp.json local já tem o valor.
  pushUpsert(id); pushAuth(id, clean);
  return { ok: true, configured: true };
}
function enable(id) { const s = new Set(enabledIds()); s.add(id); setEnabledIds([...s]); if (findCurated(id)) pushUpsert(id); else pushEnable(id, true); return { ok: true }; }
function disable(id) { const s = new Set(enabledIds()); s.delete(id); setEnabledIds([...s]); pushEnable(id, false); return { ok: true }; }
function removeAuth(id) { clearValues(id); disable(id); pushDelete(id); return { ok: true }; }

// ─── Instalados (registry/personalizado): auth, install, uninstall ───────────
function setServerAuth(id, values) {
  const r = installedRecords().find((x) => x.id === id);
  if (!r) throw new Error('servidor não instalado: ' + id);
  const clean = {}; for (const f of (r.fields || [])) if (values && values[f.key] != null && values[f.key] !== '') clean[f.key] = String(values[f.key]);
  setValues(id, clean); pushAuth(id, clean); return { ok: true };
}
// descriptor = { id, label, transport, command?, args?, url?, headerTemplates?, fields?, regName?, source? }
function installServer(descriptor, values) {
  if (!descriptor || !descriptor.transport) throw new Error('descriptor inválido');
  let id = safeName(descriptor.id || descriptor.label || descriptor.regName);
  const rec = {
    id, label: descriptor.label || id, regName: descriptor.regName || null,
    transport: descriptor.transport, source: descriptor.source || 'registry',
    command: descriptor.command || null, args: Array.isArray(descriptor.args) ? descriptor.args : (descriptor.args ? String(descriptor.args).split(' ').filter(Boolean) : []),
    url: descriptor.url || null, headerTemplates: descriptor.headerTemplates || [],
    fields: descriptor.fields || [], requires: descriptor.requires || (descriptor.transport === 'stdio' ? 'node' : 'none'),
  };
  const recs = installedRecords().filter((x) => x.id !== id); recs.push(rec); setInstalledRecords(recs);
  if (values && typeof values === 'object') { try { setValues(id, values); } catch {} }
  const wasEnabled = enabledIds().includes(id);
  const s = new Set(enabledIds()); s.add(id); setEnabledIds([...s]);
  // upsert insere o registro no DB (com enabled=true) — não dá pra usar
  // pushEnable aqui porque a linha ainda não existe.
  pushUpsert(id);
  if (values && typeof values === 'object' && Object.keys(values).length) pushAuth(id, values);
  return { ok: true, id, wasEnabled };
}
function uninstallServer(id) { setInstalledRecords(installedRecords().filter((x) => x.id !== id)); clearValues(id); disable(id); pushDelete(id); return { ok: true }; }

// ─── Monta os servidores ATIVOS pro .mcp.json ────────────────────────────────
function resolveHeaders(rec, values) {
  const out = {};
  for (const h of (rec.headerTemplates || [])) {
    let v = String(h.value || '');
    v = v.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) => (values[k] != null ? values[k] : ''));
    out[h.name] = v;
  }
  return out;
}
function enabledServers() {
  const out = {};
  const enabled = new Set(enabledIds());
  // curados
  for (const id of enabled) {
    const def = findCurated(id); if (!def) continue;
    const values = getValues(id);
    if (def.fields.some((f) => f.secret && !values[f.key])) continue;
    let env = def.buildEnv ? def.buildEnv(values) : { ...values };
    let args = (def.run.args || []).slice();
    if (def.asArg && values[def.asArg]) { args = args.concat([values[def.asArg]]); delete env[def.asArg]; }
    if (def.env) env = { ...def.env, ...env };
    out[id] = { type: 'stdio', command: def.run.command, args, env };
  }
  // instalados (registry/custom)
  for (const r of installedRecords()) {
    if (!enabled.has(r.id)) continue;
    const values = getValues(r.id);
    if ((r.fields || []).some((f) => f.required && !values[f.key])) continue;
    if (r.transport === 'http' || r.transport === 'sse') {
      out[r.id] = { type: r.transport, url: r.url, headers: resolveHeaders(r, values) };
    } else {
      out[r.id] = { type: 'stdio', command: r.command, args: r.args || [], env: values };
    }
  }
  return out;
}

module.exports = {
  catalog, refresh, pullFromCloud, search, setAuth, enable, disable, removeAuth,
  installServer, uninstallServer, setServerAuth,
  enabledServers, encAvailable,
};
