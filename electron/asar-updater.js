'use strict';
// Updater de patch via ASAR. Em vez de baixar o instalador inteiro (.dmg/.exe),
// baixa só o app.asar (~5 MB) e troca dentro do bundle existente. O binário
// do Electron, o Info.plist e a ASSINATURA do bundle externo não mudam → o OS
// (Gatekeeper/SmartScreen) continua reconhecendo como o mesmo app → permissões
// (mic, screen, accessibility, UAC) persistem.
//
// Quando NÃO usar: se o Electron foi bumpado (versão muda) ou native modules
// foram trocados. Nesses casos cai pro electron-updater (instalador completo).
//
// Fluxo:
//  1. checkForUpdate(): GET maestrus.cloud/downloads/asar/{platform}/latest.json
//     { version, electron, sha256, size, url }
//  2. Se version > app.getVersion() e electron === process.versions.electron:
//     emite 'update-available' { kind: 'asar', version, size }
//  3. downloadUpdate(): baixa o asar para app.asar.pending ao lado do app.asar
//     atual, verifica sha256, emite 'update-downloaded'
//  4. quitAndApply(): spawn detached helper que:
//       - aguarda 0.5s (libera handle no Windows)
//       - move app.asar.pending → app.asar
//       - relança o app (open/start)
//     Quita o app principal. OS vê o mesmo bundle → permissões preservadas.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const { BASE } = require('./config');

const FEED_BASE = `${BASE}/downloads/asar`;

let win = null;
let pendingMeta = null;       // { version, sha256, electron, url }
let downloading = false;
let timer = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) try { win.webContents.send(channel, payload); } catch {}
}

// Resolve o asar atual e o pending ao lado dele. Cobre Mac (.app/Contents/Resources)
// e Windows (resources/). Em dev (não-packaged), não tem app.asar — devolve null.
function asarPaths() {
  if (!app.isPackaged) return null;
  // process.resourcesPath aponta direto pra .../Contents/Resources (mac) ou
  // .../resources (win) — onde o electron-builder coloca o app.asar.
  const dir = process.resourcesPath;
  return {
    current: path.join(dir, 'app.asar'),
    pending: path.join(dir, 'app.asar.pending'),
  };
}

function platformKey() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return 'win-x64';
  return null;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'cache-control': 'no-cache' } }, (res) => {
      if (res.statusCode === 404) return resolve(null);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

function downloadTo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { return reject(new Error('cleanup_tmp: ' + e.message)); }
    let out;
    try { out = fs.createWriteStream(tmp); } catch (e) { return reject(new Error('open_tmp: ' + e.message)); }
    const hash = crypto.createHash('sha256');
    let total = 0;
    let received = 0;
    let settled = false;
    let stallTimer = null;
    const settle = (fn) => { if (settled) return; settled = true; if (stallTimer) clearTimeout(stallTimer); fn(); };
    const fail = (err) => settle(() => {
      try { out.destroy(); } catch {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      reject(err);
    });

    const req = https.get(url, (res) => {
      console.log('[asar-updater] downloadTo: status', res.statusCode, 'len', res.headers['content-length']);
      // Suporta redirect 301/302/307/308 (Cloudflare/edge proxies).
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return downloadTo(res.headers.location, dest, onProgress).then((r) => settle(() => resolve(r)), fail);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error('http ' + res.statusCode));
      }
      total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      // Stall detector: se ficar 30s sem receber bytes, considera morto.
      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => fail(new Error('download stalled (sem dados por 30s)')), 30000);
      };
      resetStall();
      res.on('data', (chunk) => {
        if (settled) return;
        received += chunk.length;
        hash.update(chunk);
        out.write(chunk);
        if (total && onProgress) onProgress({ percent: Math.round((received / total) * 100), bytes: received, total });
        resetStall();
      });
      res.on('end', () => {
        if (settled) return;
        out.end(() => settle(() => {
          try { fs.renameSync(tmp, dest); resolve({ sha256: hash.digest('hex'), size: received }); }
          catch (e) { try { fs.unlinkSync(tmp); } catch {} reject(new Error('rename_dest: ' + e.message)); }
        }));
      });
      res.on('error', (e) => fail(new Error('res_error: ' + e.message)));
    });
    req.on('error', (e) => fail(new Error('req_error: ' + e.message)));
    req.setTimeout(120000, () => req.destroy(new Error('connect_timeout')));
    out.on('error', (e) => fail(new Error('write_error: ' + e.message)));
  });
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdate() {
  const paths = asarPaths();
  if (!paths) { console.log('[asar-updater] check: not_packaged'); return { ok: false, reason: 'not_packaged' }; }
  const plat = platformKey();
  if (!plat) return { ok: false, reason: 'unsupported_platform' };
  try {
    const meta = await httpJson(`${FEED_BASE}/${plat}/latest.json?t=${Date.now()}`);
    if (!meta || !meta.version || !meta.sha256 || !meta.url) { console.log('[asar-updater] check: no_manifest'); return { ok: false, reason: 'no_manifest' }; }
    const cur = app.getVersion();
    console.log('[asar-updater] check: current=' + cur + ' remote=' + meta.version);
    if (cmpVer(meta.version, cur) <= 0) return { ok: true, hasUpdate: false, version: cur };
    // Se a versão do Electron mudou, o asar antigo seria incompatível — usuário cai
    // no instalador completo (electron-updater) em vez do patch.
    if (meta.electron && meta.electron !== process.versions.electron) {
      return { ok: true, hasUpdate: false, reason: 'electron_bump_needs_installer', requiresInstaller: true, version: meta.version };
    }
    pendingMeta = meta;
    // Self-heal: se o download já terminou numa sessão anterior (eventos
    // perdidos, app fechado antes de aplicar), o .pending válido pula direto
    // pro estado "pronto pra reiniciar" em vez de baixar de novo.
    try {
      if (fs.existsSync(paths.pending)) {
        const sha = crypto.createHash('sha256').update(fs.readFileSync(paths.pending)).digest('hex');
        if (sha === meta.sha256) {
          send('asar-update:downloaded', { version: meta.version });
          return { ok: true, hasUpdate: true, downloaded: true, version: meta.version, size: meta.size || 0 };
        }
        fs.unlinkSync(paths.pending); // pending velho/corrompido — limpa
      }
    } catch {}
    send('asar-update:available', { version: meta.version, size: meta.size || 0 });
    return { ok: true, hasUpdate: true, version: meta.version, size: meta.size || 0 };
  } catch (e) {
    return { ok: false, reason: 'network', error: String(e && e.message || e) };
  }
}

async function downloadUpdate() {
  if (downloading) return { ok: false, reason: 'already_downloading' };
  const paths = asarPaths();
  if (!paths) {
    console.log('[asar-updater] download: not_packaged');
    send('asar-update:error', { message: 'not_packaged' });
    return { ok: false, reason: 'not_packaged' };
  }
  if (!pendingMeta) {
    await checkForUpdate().catch((e) => console.log('[asar-updater] check pre-download failed:', e && e.message));
    if (!pendingMeta) {
      console.log('[asar-updater] download: no_update_available');
      send('asar-update:error', { message: 'no_update_available' });
      return { ok: false, reason: 'no_pending' };
    }
  }
  console.log('[asar-updater] downloadUpdate called for', pendingMeta.version, '→', paths.pending);
  downloading = true;
  send('asar-update:progress', { percent: 0 });
  try {
    const url = pendingMeta.url.startsWith('http') ? pendingMeta.url : `${FEED_BASE}/${platformKey()}/${pendingMeta.url}`;
    const r = await downloadTo(url, paths.pending, (p) => send('asar-update:progress', p));
    if (r.sha256 !== pendingMeta.sha256) {
      try { fs.unlinkSync(paths.pending); } catch {}
      throw new Error('checksum mismatch');
    }
    send('asar-update:downloaded', { version: pendingMeta.version });
    return { ok: true, version: pendingMeta.version };
  } catch (e) {
    const msg = String(e && e.message || e);
    send('asar-update:error', { message: msg });
    return { ok: false, error: msg };
  } finally {
    downloading = false;
  }
}

// Spawna um helper detached que:
//   - espera o app fechar (libera handle do app.asar no Windows)
//   - move pending → current
//   - relança o app
// Depois quita o app principal. Permissões do OS sobrevivem porque o bundle
// externo (assinatura, Info.plist, executável) não muda.
function quitAndApply() {
  const paths = asarPaths();
  if (!paths) return { ok: false, reason: 'not_packaged' };
  if (!fs.existsSync(paths.pending)) return { ok: false, reason: 'no_pending_asar' };

  const exe = process.execPath;
  if (process.platform === 'darwin') {
    // exec é .../Maestrus.app/Contents/MacOS/Maestrus → bundle .app = 3 níveis acima
    const appBundle = path.resolve(path.dirname(exe), '..', '..');
    // Helper bash com retries (Mac geralmente libera o asar instantâneo, mas
    // dá margem).
    const script = `#!/bin/bash
set -e
for i in 1 2 3 4 5 6 7 8; do
  if [ ! -f "${paths.pending}" ]; then break; fi
  sleep 0.4
  mv -f "${paths.pending}" "${paths.current}" 2>/dev/null && break
done
sleep 0.3
open "${appBundle}"
`;
    const tmp = path.join(app.getPath('temp'), `maestrus-apply-${Date.now()}.sh`);
    fs.writeFileSync(tmp, script, { mode: 0o755 });
    spawn('/bin/bash', [tmp], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    // PowerShell tolera handle locked com retries.
    const script = `
$pending = '${paths.pending.replace(/'/g, "''")}'
$current = '${paths.current.replace(/'/g, "''")}'
$exe = '${exe.replace(/'/g, "''")}'
for ($i=0; $i -lt 30; $i++) {
  if (-not (Test-Path $pending)) { break }
  Start-Sleep -Milliseconds 400
  try { Move-Item -Force $pending $current -ErrorAction Stop; break } catch {}
}
Start-Sleep -Milliseconds 300
Start-Process -FilePath $exe
`;
    const tmp = path.join(app.getPath('temp'), `maestrus-apply-${Date.now()}.ps1`);
    fs.writeFileSync(tmp, script, 'utf8');
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    return { ok: false, reason: 'unsupported_platform' };
  }

  // Quita após pequeno delay pra o helper já estar rodando.
  setTimeout(() => { try { app.quit(); } catch {} }, 200);
  return { ok: true };
}

function init(mainWindow) {
  win = mainWindow;
  if (!app.isPackaged) return;
  // Check no boot (depois de 6s pra não atrapalhar o startup) e periódico (1h).
  setTimeout(() => { checkForUpdate().catch(() => {}); }, 6000);
  timer = setInterval(() => { checkForUpdate().catch(() => {}); }, 60 * 60 * 1000);
  timer.unref?.();
}

function getPending() { return pendingMeta; }

module.exports = { init, checkForUpdate, downloadUpdate, quitAndApply, getPending };
