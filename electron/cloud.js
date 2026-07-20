// Integração com o Maestrus Cloud (api.php):
// login (activate), validação de licença e checagem de update.
// A conta logada fica no electron-store (local).

const crypto = require('crypto');
const os = require('os');
const projectStore = require('./project-store');
const { API_BASE, BASE } = require('./config');

function getDeviceId() {
  let id = projectStore.getSetting('cloud_device_id');
  if (!id) {
    id = crypto.randomUUID();
    projectStore.setSetting('cloud_device_id', id);
  }
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

async function checkUpdate(currentVersion) {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`${API_BASE}?action=version&platform=${platform}&current=${encodeURIComponent(currentVersion)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    return data;
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
async function relayToken(role) {
  // SELF-HOST: assina o token LOCALMENTE (sem maestrus.cloud). O relay do
  // usuário verifica com o mesmo SELFHOST_SECRET.
  try {
    const selfhost = require('./selfhost');
    if (selfhost.isEnabled()) {
      const token = selfhost.signRelayToken(getDeviceId(), role);
      const url = process.env.MAESTRUS_RELAY_URL || 'ws://localhost:8790';
      return token ? { ok: true, token, url } : { ok: false, error: 'selfhost_sign_failed' };
    }
  } catch {}
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPost('relay_token', { license_key: acc.licenseKey, device_id: getDeviceId(), role: role === 'host' ? 'host' : 'client' });
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
// Provisiona (ou reusa) o container. Idempotente. Retorna { ok, container, dispatched }.
async function containerProvision() {
  const acc = getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  try {
    const { data } = await apiPostLong('container_provision', { license_key: acc.licenseKey }, 60000);
    return data || { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

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

module.exports = { activate, validate, logout, getAccount, setAccount, isPro, getDeviceId, checkUpdate, panelUrl, aiStatus, relayToken, pairCreate, pairRedeem, cloudList, cloudStart, cloudStop, cloudPause, cloudResume, cloudDelete, devices, deviceDelete, devicePing, userApi, shareCreate, shareList, shareRevoke, shareAccept, shareRelayToken, containerStatus, containerProvision };
