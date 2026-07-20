// Cofre local de credenciais SSH. Guarda senha / passphrase / caminho da chave
// criptografados com o safeStorage do Electron (chave do keychain do SO).
// NUNCA vai pro Google Drive — fica só em userData/ssh-vault.json.
//
// Formato no disco: { [projectId]: { enc: "<base64 do blob criptografado>" } }
// O blob descriptografado é um JSON: { authType, password?, privateKeyPath?, passphrase? }

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('./electron-compat');

function vaultPath() {
  return path.join(app.getPath('userData'), 'ssh-vault.json');
}

function readRaw() {
  try {
    const p = vaultPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeRaw(obj) {
  const p = vaultPath();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function available() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

// secret = { authType: 'password'|'key', password?, privateKeyPath?, passphrase? }
function save(projectId, secret) {
  if (!available()) {
    throw new Error('Criptografia do SO indisponível — não dá pra guardar credenciais com segurança.');
  }
  const all = readRaw();
  const blob = safeStorage.encryptString(JSON.stringify(secret));
  all[projectId] = { enc: blob.toString('base64') };
  writeRaw(all);
  return true;
}

function get(projectId) {
  const all = readRaw();
  const entry = all[projectId];
  if (!entry || !entry.enc) return null;
  try {
    const buf = Buffer.from(entry.enc, 'base64');
    const json = safeStorage.decryptString(buf);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function has(projectId) {
  const all = readRaw();
  return !!(all[projectId] && all[projectId].enc);
}

function remove(projectId) {
  const all = readRaw();
  if (all[projectId]) {
    delete all[projectId];
    writeRaw(all);
  }
  return true;
}

module.exports = { save, get, has, remove, available };
