'use strict';
// ─── Maestrus Cloud (storage por GCS) — DESLIGADO no pivô de 2026-06 ─────────
//
// O modelo antigo replicava código/sessão/memória/manifesto no Google Cloud
// Storage pra ter os projetos em vários dispositivos. Isso foi REMOVIDO: gerava
// confusão de memória cross-device (a conversa referenciava localhost/runtime
// que não existem na outra máquina) e custo de GCS.
//
// O cross-device agora é o MODO SERVER (relay): uma conta = um servidor (host),
// e os outros dispositivos conectam nele (electron/remote-host.js +
// remote-client.js). Fonte única, sem peer-sync.
//
// Este módulo virou uma casca: mantém a API pública como NO-OP pra não quebrar
// os call-sites, e só `syncState` reporta o estado local. O Maestrus AI (proxy
// metered) vive em cloud.js e não é afetado. Todo o maquinário pesado (file
// walk, git bundle, hashing, api GCS, merge de .jsonl, manifesto, tombstones,
// push/pull de memória e settings) foi removido daqui.

const cloud = require('./cloud');

const STORAGE_ENABLED = false;
function storageEnabled() { return STORAGE_ENABLED; }

const OFF = { ok: true, localOnly: true };
const noop = async () => {};

// Estado pra UI: logado? sim/não. Sem nuvem de storage → sem dots de sync.
function syncState() {
  let loggedIn = false;
  try { loggedIn = !!cloud.getAccount(); } catch {}
  return { loggedIn, cloud: false, states: {} };
}

// API pública (no-op). Mantida pra compatibilidade com os call-sites em main.js.
async function pushProject() { return OFF; }
async function pushManifest() { return OFF; }
async function syncAll() { return OFF; }
async function pullAll() { return OFF; }
async function pushAll() { return OFF; }
async function mergeSyncSessions() { return { ok: true, changed: false }; }
async function pullManifestLight() { return { ok: true, changed: false }; }
async function pushMemory() {}
async function pullMemory() {}
async function pushSettings() { return OFF; }
async function pullSettings() { return OFF; }
function setSettingsAppliedHook() {}
async function deleteProjectCloud() { return OFF; }

module.exports = {
  pushProject, pushManifest, pullAll, pushAll, syncAll, mergeSyncSessions,
  pullManifestLight, pushMemory, pullMemory, pushSettings, pullSettings,
  setSettingsAppliedHook, syncState, deleteProjectCloud, storageEnabled,
};
