// Gerência de conexões SSH/SFTP por projeto (arquitetura "SFTP sync").
// - Mantém um pool de clientes ssh2 vivos por projeto, com keepalive.
// - ensureConnected: reconecta se a conexão caiu (ex: standby).
// - listDir: navegação remota pro seletor de pastas.
// - pull: espelha a pasta remota numa cópia local (mirror).
// - pushChanges: envia de volta arquivos alterados localmente desde o último pull.
//
// Credenciais vêm do ssh-vault (descriptografadas em memória só na hora de conectar).

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const vault = require('./ssh-vault');

const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', 'vendor', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // não espelha arquivos gigantes

// projectId → { client, sftp, busy }
const pool = new Map();
// projectId → { [relPath]: mtimeMs } snapshot do último pull (pra detectar mudanças locais)
const snapshots = new Map();

function buildConnectConfig(sshMeta, secret) {
  const cfg = {
    host: sshMeta.host,
    port: sshMeta.port || 22,
    username: sshMeta.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };
  if (secret.authType === 'key') {
    // Conteúdo embutido (veio sincronizado de outra máquina) tem prioridade;
    // senão lê o arquivo local apontado por privateKeyPath.
    if (secret.privateKey) {
      cfg.privateKey = secret.privateKey;
    } else if (secret.privateKeyPath && fs.existsSync(secret.privateKeyPath)) {
      cfg.privateKey = fs.readFileSync(secret.privateKeyPath);
    } else {
      throw new Error(`Arquivo de chave não encontrado: ${secret.privateKeyPath}`);
    }
    if (secret.passphrase) cfg.passphrase = secret.passphrase;
  } else {
    cfg.password = secret.password || '';
  }
  return cfg;
}

function connectRaw(sshMeta, secret) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) { settled = true; return reject(err); }
        settled = true;
        resolve({ client, sftp });
      });
    });
    client.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    try {
      client.connect(buildConnectConfig(sshMeta, secret));
    } catch (e) {
      if (!settled) { settled = true; reject(e); }
    }
  });
}

function isAlive(entry) {
  return entry && entry.client && entry.sftp && entry.client._sock && !entry.client._sock.destroyed;
}

// Conecta usando creds do vault (a partir do projectId) — ou creds explícitas (no cadastro).
async function ensureConnected(project, explicitSecret) {
  const existing = pool.get(project.id);
  if (isAlive(existing)) return existing;
  if (existing) { try { existing.client.end(); } catch {} pool.delete(project.id); }

  const sshMeta = project.ssh;
  if (!sshMeta) throw new Error('Projeto não tem config SSH.');
  const secret = explicitSecret || vault.get(project.id);
  if (!secret) throw new Error('Credenciais SSH não encontradas no cofre. Reabra o projeto e informe de novo.');

  const conn = await connectRaw(sshMeta, secret);
  pool.set(project.id, conn);
  return conn;
}

// Testa conexão com creds explícitas (usado no cadastro). Não guarda no pool.
async function testConnection(sshMeta, secret) {
  const conn = await connectRaw(sshMeta, secret);
  try { conn.client.end(); } catch {}
  return { ok: true };
}

function sftpReaddir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)));
  });
}

// Lista um diretório remoto (só pastas + arquivos, pro navegador).
async function listDir(sshMeta, secret, remotePath) {
  const conn = await connectRaw(sshMeta, secret);
  try {
    const dir = remotePath || '.';
    const list = await sftpReaddir(conn.sftp, dir);
    const entries = list
      .map((e) => ({
        name: e.filename,
        isDir: (e.attrs.mode & 0o040000) !== 0 || e.longname.startsWith('d'),
      }))
      .filter((e) => !e.name.startsWith('.') || e.isDir)
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    // resolve o path absoluto pra navegação consistente
    const abs = await realpath(conn.sftp, dir);
    return { ok: true, path: abs, entries };
  } finally {
    try { conn.client.end(); } catch {}
  }
}

function realpath(sftp, p) {
  return new Promise((resolve) => {
    sftp.realpath(p, (err, abs) => resolve(err ? p : abs));
  });
}

function fastGet(sftp, remote, local) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remote, local, (err) => (err ? reject(err) : resolve()));
  });
}
function fastPut(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
  });
}
function mkdirRemote(sftp, dir) {
  return new Promise((resolve) => {
    sftp.mkdir(dir, (err) => resolve(!err));
  });
}

// Espelha recursivamente remotePath → localDir. Retorna contagem de arquivos.
async function pull(project, onProgress) {
  const conn = await ensureConnected(project);
  const { sftp } = conn;
  const remoteRoot = project.ssh.remotePath;
  const localRoot = project.codeDir;
  fs.mkdirSync(localRoot, { recursive: true });
  const snapshot = {};
  let count = 0;

  async function walk(remoteDir, localDir, rel) {
    let list;
    try { list = await sftpReaddir(sftp, remoteDir); } catch { return; }
    for (const e of list) {
      const name = e.filename;
      if (IGNORE.has(name)) continue;
      const rPath = remoteDir + '/' + name;
      const lPath = path.join(localDir, name);
      const relPath = rel ? rel + '/' + name : name;
      const isDir = (e.attrs.mode & 0o040000) !== 0 || (e.longname && e.longname.startsWith('d'));
      if (isDir) {
        fs.mkdirSync(lPath, { recursive: true });
        await walk(rPath, lPath, relPath);
      } else {
        if (e.attrs.size != null && e.attrs.size > MAX_FILE_BYTES) continue;
        try {
          await fastGet(sftp, rPath, lPath);
          const st = fs.statSync(lPath);
          snapshot[relPath] = st.mtimeMs;
          count++;
          if (onProgress && count % 25 === 0) onProgress(count);
        } catch { /* arquivo ilegível, ignora */ }
      }
    }
  }

  await walk(remoteRoot, localRoot, '');
  snapshots.set(project.id, snapshot);
  return { ok: true, files: count };
}

// Detecta arquivos alterados/criados localmente desde o último pull e envia de volta.
async function pushChanges(project) {
  const conn = await ensureConnected(project);
  const { sftp } = conn;
  const localRoot = project.codeDir;
  const remoteRoot = project.ssh.remotePath;
  const snapshot = snapshots.get(project.id) || {};
  const changed = [];

  function walkLocal(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (IGNORE.has(ent.name)) continue;
      const lPath = path.join(dir, ent.name);
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        walkLocal(lPath, relPath);
      } else if (ent.isFile()) {
        let st;
        try { st = fs.statSync(lPath); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        const prev = snapshot[relPath];
        if (prev == null || st.mtimeMs > prev + 1) {
          changed.push({ relPath, lPath, mtimeMs: st.mtimeMs });
        }
      }
    }
  }
  walkLocal(localRoot, '');

  // garante diretórios remotos e envia
  const ensuredDirs = new Set();
  async function ensureRemoteDir(relDir) {
    if (!relDir || ensuredDirs.has(relDir)) return;
    const parts = relDir.split('/');
    let cur = remoteRoot;
    for (const part of parts) {
      cur += '/' + part;
      await mkdirRemote(sftp, cur);
    }
    ensuredDirs.add(relDir);
  }

  for (const f of changed) {
    const relDir = path.posix.dirname(f.relPath);
    if (relDir && relDir !== '.') await ensureRemoteDir(relDir);
    const remotePath = remoteRoot + '/' + f.relPath;
    try {
      await fastPut(sftp, f.lPath, remotePath);
      snapshot[f.relPath] = f.mtimeMs;
    } catch (e) { /* segue tentando os outros */ }
  }
  snapshots.set(project.id, snapshot);
  return { ok: true, pushed: changed.length };
}

// Status rápido: tem conexão viva?
function status(project) {
  return { connected: isAlive(pool.get(project.id)) };
}

function disconnect(projectId) {
  const entry = pool.get(projectId);
  if (entry) { try { entry.client.end(); } catch {} pool.delete(projectId); }
  snapshots.delete(projectId);
}

function disconnectAll() {
  for (const [, entry] of pool) { try { entry.client.end(); } catch {} }
  pool.clear();
  snapshots.clear();
}

module.exports = {
  testConnection, listDir, ensureConnected, pull, pushChanges, status, disconnect, disconnectAll,
};
