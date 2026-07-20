'use strict';
// Cliente SELF-HOST do desktop — conecta o app nativo (Win/Mac/Linux) num
// servidor Maestrus self-host do próprio usuário, por URL + SECRET. Sem
// maestrus.cloud, sem conta, sem billing. Espelha o fluxo do web:
//   GET  {url}/selfhost/config  → { hostName, deviceId(host) }
//   POST {url}/selfhost/token   → { token }  (prova o secret)
//   relay = {url}/relay (proxy WS do próprio servidor — uma porta só)
//
// A config (url + secret) fica salva localmente (electron-store) pra reconectar
// no boot. O secret nunca sai daqui a não ser pro próprio servidor do usuário.

const projectStore = require('./project-store');

const KEY = 'selfhost_server'; // { url, secret, hostDeviceId, hostName }

function normalizeUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}
function wsFromHttp(u) { return u.replace(/^http/i, 'ws'); }

function getConfig() {
  try { return projectStore.getSetting(KEY) || null; } catch { return null; }
}
function setConfig(cfg) { try { projectStore.setSetting(KEY, cfg); } catch {} }
function clearConfig() { try { projectStore.setSetting(KEY, null); } catch {} }
function isConfigured() { return !!getConfig(); }

async function fetchConfig(url) {
  const base = normalizeUrl(url);
  const r = await fetch(`${base}/selfhost/config`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!j || !j.selfhost) throw new Error('not_selfhost');
  return { hostDeviceId: j.deviceId, hostName: j.hostName };
}

// Pede um token de client provando o secret. Retorna { token, url(relay ws) }.
async function fetchToken(url, secret) {
  const base = normalizeUrl(url);
  const r = await fetch(`${base}/selfhost/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, deviceId: deviceId() }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!j || !j.ok || !j.token) throw new Error(j && j.error || 'bad_secret');
  return { token: j.token, relayUrl: wsFromHttp(base) + '/relay', hostDeviceId: j.hostDeviceId, hostName: j.hostName };
}

function deviceId() {
  let id = projectStore.getSetting('cloud_device_id');
  if (!id) { const crypto = require('crypto'); id = crypto.randomUUID(); projectStore.setSetting('cloud_device_id', id); }
  return id;
}

// Valida url+secret e (se ok) persiste a config. Não conecta — quem conecta é
// o main via startSelfhostClient (reusa o remoteClient).
async function connect(url, secret) {
  const base = normalizeUrl(url);
  if (!base) return { ok: false, error: 'invalid_url' };
  try {
    const cfg = await fetchConfig(base);           // confirma que é self-host
    const t = await fetchToken(base, secret);       // confirma o secret
    setConfig({ url: base, secret, hostDeviceId: t.hostDeviceId || cfg.hostDeviceId, hostName: t.hostName || cfg.hostName || 'Meu Maestrus' });
    return { ok: true, hostDeviceId: t.hostDeviceId || cfg.hostDeviceId, hostName: t.hostName || cfg.hostName, relayUrl: t.relayUrl, token: t.token };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Emite um token fresco pra reconexão (refreshTokenFn do relay client).
async function freshToken() {
  const cfg = getConfig(); if (!cfg) return null;
  try { const t = await fetchToken(cfg.url, cfg.secret); return t.token; } catch { return null; }
}

module.exports = { getConfig, setConfig, clearConfig, isConfigured, connect, freshToken, fetchConfig, fetchToken, normalizeUrl, wsFromHttp, deviceId };
