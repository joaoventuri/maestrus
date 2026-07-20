#!/usr/bin/env node
'use strict';
// Pós-build: extrai o app.asar do bundle gerado e publica em
// maestrus.cloud/downloads/asar/<platform>/<version>/app.asar + atualiza
// latest.json. Roda no CI depois do electron-builder.
//
// Uso: node scripts/publish-asar.js [--upload]
//   --upload : faz scp + atualiza latest.json no servidor (precisa $DEPLOY_KEY,
//              $DEPLOY_HOST, $DEPLOY_PORT no ambiente).
// Sem --upload: só gera dist-asar/<platform>/{version}/app.asar e
// dist-asar/<platform>/latest.json (útil pra testar local).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');
const pkg = require('../package.json');

const VERSION = pkg.version;
const ELECTRON = require('electron/package.json').version;

const ROOT = path.resolve(__dirname, '..');
const DIST_APP = path.join(ROOT, 'dist-app');
const OUT_DIR = path.join(ROOT, 'dist-asar');

// Descobre o app.asar gerado para o platform/arch atual.
function findBuiltAsar() {
  const candidates = [];
  const items = fs.readdirSync(DIST_APP, { withFileTypes: true });
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const dir = path.join(DIST_APP, it.name);
    if (process.platform === 'darwin' || it.name.startsWith('mac')) {
      // Mac: dist-app/mac-arm64/Maestrus.app/Contents/Resources/app.asar
      const apps = fs.readdirSync(dir).filter((f) => f.endsWith('.app'));
      for (const a of apps) {
        const p = path.join(dir, a, 'Contents', 'Resources', 'app.asar');
        if (fs.existsSync(p)) candidates.push({ platform: it.name.includes('arm') ? 'mac-arm64' : 'mac-x64', path: p });
      }
    }
    if (it.name.startsWith('win-')) {
      // Win: dist-app/win-unpacked/resources/app.asar
      const p = path.join(dir, 'resources', 'app.asar');
      if (fs.existsSync(p)) candidates.push({ platform: 'win-x64', path: p });
    }
  }
  return candidates;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function publishLocally(platform, asarFile) {
  const outVerDir = path.join(OUT_DIR, platform, VERSION);
  fs.mkdirSync(outVerDir, { recursive: true });
  const dest = path.join(outVerDir, 'app.asar');
  fs.copyFileSync(asarFile, dest);
  const hash = sha256(dest);
  const size = fs.statSync(dest).size;
  const manifest = {
    version: VERSION,
    electron: ELECTRON,
    sha256: hash,
    size,
    url: `${VERSION}/app.asar`,
    publishedAt: new Date().toISOString(),
  };
  const latestPath = path.join(OUT_DIR, platform, 'latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[asar] ${platform} ${VERSION}: ${(size / 1e6).toFixed(2)} MB, sha256=${hash.slice(0, 12)}…`);
  return { platform, manifest, asarLocal: dest, latestLocal: latestPath };
}

function uploadViaSsh(items) {
  const host = process.env.DEPLOY_HOST;
  const port = process.env.DEPLOY_PORT || '22';
  const keyPath = process.env.DEPLOY_KEY_PATH || `${process.env.HOME}/.ssh/deploy_key`;
  if (!host || !fs.existsSync(keyPath)) {
    console.warn('[asar] skip upload — DEPLOY_HOST ou DEPLOY_KEY_PATH faltando.');
    return;
  }
  const ssh = ['-p', port, '-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new'];
  for (const item of items) {
    const remoteDir = `/opt/maestrus/data/downloads/asar/${item.platform}/${VERSION}`;
    // Cria o dir remoto + envia
    execSync(`ssh ${ssh.join(' ')} root@${host} 'mkdir -p ${remoteDir}'`, { stdio: 'inherit' });
    execSync(`scp ${ssh.join(' ')} ${item.asarLocal} root@${host}:${remoteDir}/app.asar`, { stdio: 'inherit' });
    execSync(`scp ${ssh.join(' ')} ${item.latestLocal} root@${host}:/opt/maestrus/data/downloads/asar/${item.platform}/latest.json`, { stdio: 'inherit' });
    console.log(`[asar] upload ${item.platform} ${VERSION} OK`);
  }
}

function main() {
  if (!fs.existsSync(DIST_APP)) {
    console.error(`[asar] ${DIST_APP} não existe — rode npm run build antes.`);
    process.exit(1);
  }
  const builds = findBuiltAsar();
  if (builds.length === 0) {
    console.error('[asar] nenhum app.asar encontrado em', DIST_APP);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = builds.map((b) => publishLocally(b.platform, b.path));
  if (process.argv.includes('--upload')) uploadViaSsh(out);
}

main();
