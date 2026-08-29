// Integração com o Maestrus Cloud (api.php):
// login (activate), validação de licença e checagem de update.
// A conta logada fica no electron-store (local).

const crypto = require('crypto');
const os = require('os');
const projectStore = require('./project-store');
const { GH_API, API_BASE, BASE } = require('./config');

// Fingerprint barato da máquina — só pra detectar quando a config do Maestrus
// foi CLONADA pra outro computador (copiar ~/Library/Application Support/maestrus,
// restaurar backup, clonar VM…). Duas máquinas com o MESMO cloud_device_id viram
// dois hosts com o mesmo `did` no relay → guerra de 'replaced' (uma derruba a
// outra em loop) → flap infinito → os RPCs do web (projects.list/loadHistory)
// caem no meio e nunca estabilizam ("conectado no host mas não puxa conversas").
function machineTag() {
  try { return `${os.hostname()}|${os.platform()}|${os.arch()}`; } catch { return 'unknown'; }
}
function getDeviceId() {
  // Container cloud / self-host têm identidade FIXA pelo env (cloud-u{id} /
  // selfhost-main). Retorna direto — sem store, sem clone-detect, sem regenerar.
  // CRÍTICO: o hostname do Docker muda a CADA recriação do container → o
  // clone-detect abaixo achava que era "outra máquina" e regenerava o id pra um
  // UUID aleatório → o container passava a registrar no relay como um id
  // FANTASMA (além do cloud-u{id}) → "N máquinas conectadas" a mais.
  if (process.env.MAESTRUS_DEVICE_ID) return process.env.MAESTRUS_DEVICE_ID;
  let id = projectStore.getSetting('cloud_device_id');
  const tag = machineTag();
  const savedTag = projectStore.getSetting('cloud_device_host');
  // Config clonada: o id existe mas foi criado em OUTRA máquina → regenera um
  // id único pra esta, senão os dois hosts colidem no relay pra sempre.
  if (id && savedTag && savedTag !== tag) {
    try { console.warn('[cloud] cloud_device_id veio de outra máquina (' + savedTag + ' → ' + tag + ') — regenerando pra evitar colisão de host no relay'); } catch {}
    id = null;
  }
  if (!id) {
    id = crypto.randomUUID();
    projectStore.setSetting('cloud_device_id', id);
  }
  if (savedTag !== tag) projectStore.setSetting('cloud_device_host', tag);
  return id;
}

// Força um deviceId novo — chamado quando o relay reporta colisão de did
// (3x 'replaced' em 20s = outra máquina com o mesmo id). Cura o caso da config
// já clonada ANTES do fingerprint existir (getDeviceId sozinho não pega, porque
// o savedTag passa a bater com a máquina no 1º boot pós-update).
function regenerateDeviceId() {
  // Identidade fixa por env (container/self-host) NUNCA regenera.
  if (process.env.MAESTRUS_DEVICE_ID) return process.env.MAESTRUS_DEVICE_ID;
  const id = crypto.randomUUID();
  projectStore.setSetting('cloud_device_id', id);
  try { projectStore.setSetting('cloud_device_host', machineTag()); } catch {}
  return id;
}

function getAccount() {
  return projectStore.getSetting('cloud_account') || null;
}
function setAccount(acc) {
  projectStore.setSetting('cloud_account', acc);
  return acc;
}
// É Pro? (destrava multi-dispositivo / modo server + Maestrus AI incluído).
// Admin nunca trava. Lê o entitlement que o backend manda no activate/validate.
/**
 * Há um provedor de nuvem gerenciada configurado? Os recursos de sandbox
 * remoto dependem de infraestrutura de terceiro; quem self-hospeda usa o
 * próprio host e nunca passa por aqui. Não é trava de plano.
 */
function isConfigured() {
  try { return !!(getAccount && getAccount()); } catch { return false; }
}

function isPro() {
  const a = getAccount();
  if (!a) return false;
  if (a.isAdmin) return true;
  // Conta cacheada ANTES do backend mandar entitlement → não trava até revalidar
  // (o validate() seguinte preenche entitled com o valor real).
  if (typeof a.entitled === 'undefined') return true;
  return !!a.entitled;
}

async function apiPost(action, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000); // não pendura pra sempre
  try {
    const res = await fetch(`${API_BASE}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { httpOk: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Maestrus on Cloud (runtime na nuvem por projeto) ──────────────────────
// cloud_start pode demorar (cria sandbox + instala deps) → timeout longo.
async function apiPostLong(action, body, timeoutMs = 480000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}?action=${encodeURIComponent(action)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), signal: ctrl.signal,
    });
    return await res.json().catch(() => ({ ok: false, error: 'bad_response' }));
  } catch (e) { return { ok: false, error: (e && e.message) || 'network' }; }
  finally { clearTimeout(timer); }
}
async function cloudList() {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in', sessions: [] };
  const { data } = await apiPost('cloud_list', { license_key: acc.licenseKey });
  return data || { ok: false, sessions: [] };
}
async function cloudStart({ projectId, name, repoUrl, model, autoSetup, codeTarGz, sessionJsonl, memoryJson, sessionId } = {}) {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  return apiPostLong('cloud_start', {
    license_key: acc.licenseKey, project_id: projectId, name, repo_url: repoUrl || null,
    model: model || 'default', auto_setup: autoSetup ? 1 : 0, session_id: sessionId || null,
    code_tar_gz: codeTarGz || null, session_jsonl: sessionJsonl || null, memory_json: memoryJson || null,
  });
}
async function cloudStop(projectId) {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  const { data } = await apiPost('cloud_stop', { license_key: acc.licenseKey, project_id: projectId });
  return data || { ok: false };
}
async function cloudPause(projectId) {
  const acc = getAccount(); if (!acc) return { ok: false };
  const { data } = await apiPost('cloud_pause', { license_key: acc.licenseKey, project_id: projectId });
  return data || { ok: false };
}
async function cloudDelete(projectId) {
  const acc = getAccount(); if (!acc) return { ok: false, error: 'not_logged_in' };
  const { data } = await apiPost('cloud_delete', { license_key: acc.licenseKey, project_id: projectId });
  return data || { ok: false };
}
async function cloudResume(projectId) {
  const acc = getAccount(); if (!acc) return { ok: false };
  return apiPostLong('cloud_resume', { license_key: acc.licenseKey, project_id: projectId }, 120000);
}
async function devices() {
  const acc = getAccount(); if (!acc) return { ok: false, devices: [] };
  const { data } = await apiPost('devices', { license_key: acc.licenseKey });
  return data || { ok: false, devices: [] };
}
async function deviceDelete(deviceId) {
  const acc = getAccount(); if (!acc) return { ok: false };
  const { data } = await apiPost('devices', { license_key: acc.licenseKey, op: 'delete', device_id: deviceId });
  return data || { ok: false };
}
// Heartbeat: mantém o last_seen do banco fresco enquanto a máquina está como
// host ligada, pra ela não aparecer "offline" na lista (last_seen < 2min).
async function devicePing() {
  const acc = getAccount(); if (!acc) return { ok: false };
  try { const { data } = await apiPost('devices', { license_key: acc.licenseKey, op: 'ping', device_id: getDeviceId(), device_name: require('os').hostname() }); return data || { ok: false }; }
  catch { return { ok: false }; }
}

async function activate(email, password) {
  let data;
  try {
    ({ data } = await apiPost('activate', {
      email, password,
      device_id: getDeviceId(),
      device_name: os.hostname(),
    }));
  } catch (e) {
    return { ok: false, error: 'network', message: (e && e.message) || String(e) };
  }
  if (!data.ok) {
    return { ok: false, error: data.error || 'invalid_credentials' };
  }
  const acc = {
    email: data.user?.email || email,
    name: data.user?.name || null,
    licenseKey: data.license_key,
    plan: data.plan || null,
    entitled: !!data.entitled,   // Pro: multi-dispositivo + Maestrus AI incluído
    isAdmin: !!data.is_admin,
    usedBytes: data.used_bytes || 0,
    capBytes: data.cap_bytes || 0,
    overageCentsPerGb: data.overage_cents_per_gb || 0,
    loggedAt: Date.now(),
  };
  setAccount(acc);
  return { ok: true, account: acc };
}

async function validate() {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  const { data } = await apiPost('validate', {
    license_key: acc.licenseKey,
    device_id: getDeviceId(),
    device_name: os.hostname(),
  });
  if (data.ok) {
    acc.plan = data.plan || acc.plan;
    acc.entitled = !!data.entitled;
    acc.isAdmin = !!data.is_admin;
    acc.usedBytes = data.used_bytes ?? acc.usedBytes;
    acc.capBytes = data.cap_bytes ?? acc.capBytes;
    acc.overageCentsPerGb = data.overage_cents_per_gb ?? acc.overageCentsPerGb;
    acc.ai = data.ai ?? acc.ai;
    setAccount(acc);
  }
  return { ok: !!data.ok, status: data.status, account: acc };
}

function logout() {
  projectStore.setSetting('cloud_account', null);
  return { ok: true };
}

// URL do painel web. Pede um token SSO de uso único (curto) pra entrar já
// logado; se falhar, cai no painel/login normal. BASE vem do config (dinâmico).
async function panelUrl() {
  const acc = getAccount();
  if (!acc) return BASE;
  try {
    const { data } = await apiPost('sso', { license_key: acc.licenseKey });
    if (data && data.ok && data.token) {
      return `${BASE}/login.php?sso=${encodeURIComponent(data.token)}`;
    }
  } catch { /* sem SSO → painel normal */ }
  return `${BASE}/dashboard.php`;
}

/**
 * Há versão nova? Lê o GitHub Releases, não um servidor próprio: o projeto é
 * aberto e a distribuição precisa funcionar para qualquer fork sem infra.
 * Se o GitHub falhar (rede, rate limit), cai no endpoint antigo para não
 * deixar quem já usa sem aviso de atualização.
 */
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

async function checkUpdate(currentVersion) {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(GH_API, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'maestrus-updater' },
    });
    clearTimeout(timer);
    if (res.ok) {
      const rel = await res.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      const wanted = { win: /\.exe$/i, mac: /\.dmg$/i, linux: /\.AppImage$/i }[platform];
      const asset = (rel.assets || []).find((a) => wanted.test(a.name || ''));
      if (latest) {
        return {
          ok: true,
          update_available: cmpVer(latest, currentVersion) > 0,
          latest,
          url: asset ? asset.browser_download_url : (rel.html_url || null),
          notes: rel.body || null,
          mandatory: false,
        };
      }
    }
  } catch {}
  // Fallback: instalações antigas continuam recebendo aviso pelo caminho legado.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`${API_BASE}?action=version&platform=${platform}&current=${encodeURIComponent(currentVersion)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function aiStatus() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`${API_BASE}?action=ai_status`, { signal: ctrl.signal });
    clearTimeout(timer);
    return await res.json();
  } catch (e) {
    return { ok: false, enabled: false, error: e.message };
  }
}

// ─── Maestrus remoto ─────────────────────────────────────────────────────────
// Token curto pro relay (role host|client). pairCreate: host gera código one-time.
// pairRedeem: client troca o código pelo host pareado.
async function relayToken(role, deviceIdOverride) {
  // O relay INDEXA a conexão pelo `did` do TOKEN (a query `device` é ignorada).
  // Como host e client de UMA MESMA máquina assinavam did=getDeviceId() igual, o
  // relay derrubava um pelo outro (4002 'replaced') num loop conecta/desconecta.
  // deviceIdOverride permite ao client usar um did distinto (ex.: X-c) e nunca
  // colidir com o host (X).
  try {
    const selfhost = require('./selfhost');
    if (selfhost.isEnabled()) {
      // HOST assina com o MAESTRUS_DEVICE_ID fixo (ex: selfhost-main) — é o
      // alvo que os clients usam nos RPCs. Com getDeviceId() (UUID aleatório)
      // o host registrava com outro id e todo RPC dava target-offline.
      const did = deviceIdOverride || (role === 'host' ? (process.env.MAESTRUS_DEVICE_ID || getDeviceId()) : getDeviceId());
      const token = selfhost.signRelayToken(did, role);
      const url = process.env.MAESTRUS_RELAY_URL || 'ws://localhost:8790';
      return token ? { ok: true, token, url } : { ok: false, error: 'selfhost_sign_failed' };
    }
  } catch {}
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPost('relay_token', { license_key: acc.licenseKey, device_id: deviceIdOverride || getDeviceId(), role: role === 'host' ? 'host' : 'client' });
    return data;
  } catch (e) { return { ok: false, error: e.message }; }
}
async function pairCreate() {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPost('pair_create', { license_key: acc.licenseKey, device_id: getDeviceId(), host_name: os.hostname() });
    return data;
  } catch (e) { return { ok: false, error: e.message }; }
}
async function pairRedeem(code) {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPost('pair_redeem', { license_key: acc.licenseKey, device_id: getDeviceId(), code: String(code || '').trim().toUpperCase() });
    return data;
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─── Cloud container (Maestrus completo 24/7 na nuvem) ─────────────────────
// Status do container do user (null se não provisionado).
async function containerStatus() {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPost('container_status', { license_key: acc.licenseKey });
    return data || { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Pausa manual do container (religa sozinho no próximo acesso).
async function containerPause() {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPost('container_pause', { license_key: acc.licenseKey });
    return data || { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Provisiona (ou reusa) o container. Idempotente. Retorna { ok, container, dispatched }.
async function containerProvision() {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPostLong('container_provision', { license_key: acc.licenseKey }, 60000);
    return data || { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─── Domínio próprio (plano Pro) da instância cloud ─────────────────────────
async function domainStatus() { return userApi('domain_status', {}); }
async function domainSet(domain) { return userApi('domain_set', { domain: String(domain || '') }); }
// verify pode demorar (DNS + agent Caddy + aviso ao container) → timeout longo.
async function domainVerify() {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPostLong('domain_verify', { license_key: acc.licenseKey }, 60000);
    return data || { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function domainRemove() { return userApi('domain_remove', {}); }

// Helper genérico p/ endpoints por-usuário (user_skills/user_mcps/user_settings/…).
// Injeta a license_key da conta logada e devolve o JSON cru ({ok, ...}).
async function userApi(action, body) {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try { const { data } = await apiPost(action, { ...(body || {}), license_key: acc.licenseKey }); return data || { ok: false }; }
  catch (e) { return { ok: false, error: (e && e.message) || 'network' }; }
}

// ─── Workspace Sharing ────────────────────────────────────────────────────────
async function shareCreate({ projectIds, guestEmail, permissions }) {
  return userApi('share_create', { project_ids: projectIds || [], guest_email: guestEmail, permissions: permissions || 'write' });
}
async function shareList() { return userApi('share_list', {}); }
async function shareRevoke(shareId) { return userApi('share_revoke', { share_id: shareId }); }
async function shareAccept(shareToken) { return userApi('share_accept', { share_token: shareToken }); }
async function shareRelayToken(shareId) {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPost('share_relay_token', { license_key: acc.licenseKey, share_id: shareId, device_id: getDeviceId() });
    return data;
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { isConfigured, activate, validate, logout, getAccount, setAccount, isPro, getDeviceId, regenerateDeviceId, checkUpdate, panelUrl, aiStatus, relayToken, pairCreate, pairRedeem, cloudList, cloudStart, cloudStop, cloudPause, cloudResume, cloudDelete, devices, deviceDelete, devicePing, userApi, shareCreate, shareList, shareRevoke, shareAccept, shareRelayToken, containerStatus, containerProvision, containerPause, domainStatus, domainSet, domainVerify, domainRemove };
