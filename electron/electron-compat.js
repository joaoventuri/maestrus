'use strict';
// Camada de compatibilidade Electron ↔ headless (maestrus-server).
//
// Os módulos do backend usam só DUAS coisas do Electron: app.getPath('userData')
// e safeStorage.{isEncryptionAvailable,encryptString,decryptString}. Este shim
// devolve o Electron real quando o processo roda dentro dele, e implementações
// headless equivalentes quando roda no maestrus-server (container).
//
// Uso nos módulos:  const { app, safeStorage } = require('./electron-compat');
// (em vez de require('electron') direto)

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let electron = null;
try {
  // process.versions.electron só existe dentro do Electron de verdade.
  if (process.versions && process.versions.electron) electron = require('electron');
} catch {}

// ─── app ────────────────────────────────────────────────────────────────────
const appShim = electron ? electron.app : {
  getPath(name) {
    const base = process.env.MAESTRUS_DATA_DIR || path.join(os.homedir(), '.maestrus-server');
    const map = {
      userData: path.join(base, 'userData'),
      home: base,
      temp: os.tmpdir(),
      logs: path.join(base, 'logs'),
    };
    const dir = map[name] || path.join(base, name);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  },
  getVersion() {
    try { return require('../maestrus-server/package.json').version; } catch { return '0.0.0'; }
  },
  isPackaged: false,
};

// ─── safeStorage ────────────────────────────────────────────────────────────
// Headless: AES-256-GCM com chave derivada de MAESTRUS_VAULT_KEY (env) ou de um
// keyfile persistente no data dir (gerado no primeiro uso). Não é o keychain do
// SO, mas o container é single-tenant e o volume é isolado por user — o vetor de
// ataque relevante (outro tenant lendo) não existe.
function headlessKey() {
  const envKey = process.env.MAESTRUS_VAULT_KEY;
  if (envKey && envKey.length >= 32) return crypto.createHash('sha256').update(envKey).digest();
  const base = process.env.MAESTRUS_DATA_DIR || path.join(os.homedir(), '.maestrus-server');
  const keyFile = path.join(base, '.vault-key');
  try {
    if (fs.existsSync(keyFile)) return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    const k = crypto.randomBytes(32);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(keyFile, k.toString('hex'), { mode: 0o600 });
    return k;
  } catch (e) {
    // Último recurso: chave derivada do hostname (fraca, mas não quebra o boot).
    return crypto.createHash('sha256').update('maestrus-fallback:' + os.hostname()).digest();
  }
}

const safeStorageShim = electron ? electron.safeStorage : {
  isEncryptionAvailable() { return true; },
  encryptString(plaintext) {
    const key = headlessKey();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
    return Buffer.concat([iv, enc, c.getAuthTag()]);
  },
  decryptString(buf) {
    const key = headlessKey();
    const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  },
};

// ─── Store (electron-store compat) ──────────────────────────────────────────
// electron-store faz require('electron') internamente → quebra no headless.
// Este shim replica a API que o Maestrus usa (get, set, delete, store getter)
// com um JSON file simples usando get/set por path pontuado ("a.b.c").
// No Electron real devolvemos o electron-store de verdade.
function getStoreClass() {
  if (electron) {
    try { return require('electron-store'); } catch {}
  }
  // Headless: implementação própria compatível.
  return class HeadlessStore {
    constructor(opts = {}) {
      const name = opts.name || 'config';
      const dir = appShim.getPath('userData');
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      this._file = path.join(dir, name + '.json');
      this._data = null;
      this._defaults = opts.defaults || {};
      this._load();
    }
    _load() {
      try {
        this._data = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      } catch { this._data = JSON.parse(JSON.stringify(this._defaults)); }
    }
    _save() {
      try { fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2)); } catch {}
    }
    get(key, def) {
      if (key === undefined) return this._data;
      const parts = String(key).split('.');
      let cur = this._data;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return def;
        cur = cur[p];
      }
      return cur === undefined ? def : cur;
    }
    set(key, value) {
      // set(obj) — merge no root
      if (typeof key === 'object' && key !== null) {
        Object.assign(this._data, key);
        this._save();
        return;
      }
      const parts = String(key).split('.');
      let cur = this._data;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
      }
      cur[parts[parts.length - 1]] = value;
      this._save();
    }
    delete(key) {
      const parts = String(key).split('.');
      let cur = this._data;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] == null) return;
        cur = cur[p];
      }
      delete cur[parts[parts.length - 1]];
      this._save();
    }
    get store() { return this._data; }
    clear() { this._data = JSON.parse(JSON.stringify(this._defaults)); this._save(); }
  };
}

module.exports = { app: appShim, safeStorage: safeStorageShim, Store: getStoreClass(), isElectron: !!electron };
