'use strict';
// BYOK do OpenAI Realtime.
// A chave (sk-…) é cifrada com PBKDF2(license, 'maestrus-mcp-v1', 100k, 32B) +
// AES-256-GCM (mesmo formato base64(iv[12] || ct || tag[16]) usado pra MCP).
// Backend só guarda o blob — nunca vê plaintext.
//
// Cache local: ~/Library/Application Support/Maestrus/openai-key.json
//   { enc, decryptedAt, decryptedSha256 }
// O servidor é a fonte da verdade — checa a cada N segundos se o enc mudou
// (updated_at) e re-decifra. Sem rede, usa o cache.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('./electron-compat');
const { API_BASE } = require('./config');
const cloud = require('./cloud');

function vaultPath() { return path.join(app.getPath('userData'), 'openai-key.json'); }

function deriveKey(license) {
  return crypto.pbkdf2Sync(String(license || ''), 'maestrus-mcp-v1', 100000, 32, 'sha256');
}

function encryptKey(plaintext, license) {
  const key = deriveKey(license);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]).toString('base64');
}

function decryptKey(encB64, license) {
  try {
    const raw = Buffer.from(String(encB64 || ''), 'base64');
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(license), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}

let _cache = null; // { plaintext, enc, updatedAt }

function loadCache() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(vaultPath())) {
      const j = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
      _cache = j && typeof j === 'object' ? j : null;
    }
  } catch {}
  return _cache;
}

function saveCache(obj) {
  try {
    fs.mkdirSync(path.dirname(vaultPath()), { recursive: true });
    fs.writeFileSync(vaultPath(), JSON.stringify(obj || {}, null, 2));
    _cache = obj;
  } catch {}
}

async function api(action, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${API_BASE}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    return await res.json().catch(() => ({ ok: false, error: 'bad_response' }));
  } catch (e) { return { ok: false, error: e && e.message || 'network' }; }
  finally { clearTimeout(timer); }
}

function license() {
  const acc = cloud.getAccount && cloud.getAccount();
  return acc && acc.licenseKey ? acc.licenseKey : null;
}

// Busca o enc no servidor; se mudou (updatedAt diferente do cache), re-decifra.
// Em offline ou sem licença, devolve o que tem em cache.
async function fetchAndCache() {
  const lic = license();
  if (!lic) return loadCache(); // não logado — usa cache se existe
  const r = await api('openai_key_get', { license_key: lic });
  if (!r || !r.ok) return loadCache();
  if (!r.has_key) { saveCache({}); return _cache; }
  const cur = loadCache() || {};
  if (cur.enc === r.enc && cur.plaintext) return cur;
  const pt = decryptKey(r.enc, lic);
  if (!pt) return loadCache();
  saveCache({ enc: r.enc, plaintext: pt, updatedAt: r.updated_at || null });
  return _cache;
}

async function getKey() {
  const c = await fetchAndCache();
  return c && c.plaintext ? c.plaintext : null;
}

function getCachedKey() {
  const c = loadCache();
  return c && c.plaintext ? c.plaintext : null;
}

async function hasKey() {
  const c = await fetchAndCache();
  return !!(c && c.plaintext);
}

async function setKey(plaintext) {
  const lic = license();
  if (!lic) return { ok: false, error: 'not_logged_in' };
  const k = String(plaintext || '').trim();
  if (!/^sk-[a-zA-Z0-9_-]{16,}$/.test(k)) return { ok: false, error: 'invalid_key_format' };
  const enc = encryptKey(k, lic);
  const r = await api('openai_key_set', { license_key: lic, enc });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'server' };
  saveCache({ enc, plaintext: k, updatedAt: new Date().toISOString() });
  return { ok: true };
}

async function deleteKey() {
  const lic = license();
  if (!lic) return { ok: false, error: 'not_logged_in' };
  const r = await api('openai_key_delete', { license_key: lic });
  saveCache({});
  return r || { ok: true };
}

// Auto-refresh periódico (a cada 5 min) caso o usuário troque a chave em outro device.
let _timer = null;
function startWatcher() {
  if (_timer) return;
  _timer = setInterval(() => { fetchAndCache().catch(() => {}); }, 5 * 60 * 1000);
  _timer.unref && _timer.unref();
}

module.exports = { getKey, getCachedKey, hasKey, setKey, deleteKey, fetchAndCache, startWatcher };
