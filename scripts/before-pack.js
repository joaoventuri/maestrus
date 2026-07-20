'use strict';
// electron-builder beforePack hook: baixa e prepara os runtimes que serão
// EMBUTIDOS no instalador do Maestrus, em vendor/runtime/ (copiado pro app via
// build.extraResources). Roda no runner NATIVO da plataforma-alvo (CI: windows-
// latest / macos), então o npm install do Claude pega o binário nativo certo.
//
// Embute:
//   - Node.js portátil (node + npm)            → vendor/runtime/node/
//   - Git (MinGit, só Windows)                 → vendor/runtime/git/
//   - Claude CLI (binário nativo, npm install) → vendor/runtime/claude/
//
// Pode pular itens com env: SKIP_BUNDLE_NODE / SKIP_BUNDLE_GIT / SKIP_BUNDLE_CLAUDE
// (ou SKIP_BUNDLE=1 pra pular tudo — usado quando não se quer instalador gordo).

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const NODE_VERSION = 'v22.13.1';
const MINGIT_VERSION = '2.47.1';
const MINGIT_TAG = `v${MINGIT_VERSION}.windows.1`;

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'runtime');

function log(...a) { console.log('[before-pack]', ...a); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function download(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    log('baixando', url);
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); file.close(); rmrf(dest);
        if (redirects <= 0) return reject(new Error('muitos redirects: ' + url));
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume(); file.close(); rmrf(dest);
        return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (e) => { file.close(); rmrf(dest); reject(e); });
  });
}

// Extrai zip/tar.gz/tar.xz. No Windows usa o tar NATIVO do System32 (bsdtar/
// libarchive) — o `tar` do git-bash (GNU) interpreta "C:\..." como host:path e
// quebra ("Cannot connect to C:"). Fallback pro Expand-Archive do PowerShell.
function extract(archive, destDir) {
  mkdirp(destDir);
  if (process.platform === 'win32') {
    const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const tarBin = fs.existsSync(sysTar) ? sysTar : 'tar';
    let r = spawnSync(tarBin, ['-xf', archive, '-C', destDir], { stdio: 'inherit' });
    if (r.status === 0) return;
    const ps = `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`;
    r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('falha ao extrair ' + archive);
    return;
  }
  const r = spawnSync('tar', ['-xf', archive, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('falha ao extrair ' + archive);
}

// Move o ÚNICO subdiretório de `parent` pra `target` (renomeia). Usado quando o
// arquivo extrai numa pasta versionada tipo node-v22-win-x64/.
function promoteSingleChild(parent, target) {
  const kids = fs.readdirSync(parent).map((n) => path.join(parent, n));
  const dirs = kids.filter((p) => fs.statSync(p).isDirectory());
  if (dirs.length === 1 && kids.length === 1) {
    fs.renameSync(dirs[0], target);
  } else {
    // já está "flat" (ex.: MinGit) — move tudo pra target
    mkdirp(target);
    for (const k of kids) fs.renameSync(k, path.join(target, path.basename(k)));
  }
}

function npmCmd() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }

async function bundleNode(platform, arch) {
  const dest = path.join(VENDOR, 'node');
  if (fs.existsSync(dest)) { log('node já presente, pulando'); return; }
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  let file, isZip;
  if (platform === 'win32') { file = `node-${NODE_VERSION}-win-${a}.zip`; isZip = true; }
  else if (platform === 'darwin') { file = `node-${NODE_VERSION}-darwin-${a}.tar.gz`; }
  else { file = `node-${NODE_VERSION}-linux-${a}.tar.xz`; }
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${file}`;
  // temp NO MESMO DRIVE do projeto (rename cross-device dá EXDEV no Windows).
  const tmp = fs.mkdtempSync(path.join(VENDOR, '.extract-node-'));
  const arc = path.join(tmp, file);
  await download(url, arc);
  extract(arc, tmp);
  // limpa o arquivo pra promoteSingleChild ver só a pasta extraída
  rmrf(arc);
  promoteSingleChild(tmp, dest);
  rmrf(tmp);
  pruneNode(dest);
  log('node embutido em', dest);
}

async function bundleGit(platform) {
  if (platform !== 'win32') { log('git: só Windows, pulando'); return; }
  const dest = path.join(VENDOR, 'git');
  if (fs.existsSync(dest)) { log('git já presente, pulando'); return; }
  const file = `MinGit-${MINGIT_VERSION}-64-bit.zip`;
  const url = `https://github.com/git-for-windows/git/releases/download/${MINGIT_TAG}/${file}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-git-'));
  const arc = path.join(tmp, file);
  await download(url, arc);
  rmrf(dest); mkdirp(dest);
  extract(arc, dest); // MinGit extrai "flat" (cmd/, mingw64/, ...) direto
  rmrf(tmp);
  pruneGit(dest);
  log('git (MinGit) embutido em', dest);
}

// Poda do MinGit: remove o que o agente Claude NUNCA usa. Os maiores são o
// scalar.exe (14MB — gestor de monorepos gigantes) e o git-gui/gitk em Tcl/Tk.
// MANTÉM: git.exe, bash, perl (git add -p depende), coreutils, libcrypto e o
// git-credential-manager (+ Skia/ANGLE) pra não quebrar auth HTTPS.
function pruneGit(root) {
  const trash = [
    'mingw64/bin/scalar.exe',                         // 14MB — monorepos gigantes
    'mingw64/libexec/git-core/scalar.exe',
    'mingw64/share/gitk', 'mingw64/share/git-gui', 'mingw64/share/gitweb',
    'mingw64/libexec/git-core/git-gui', 'mingw64/libexec/git-core/gitk',
    'mingw64/libexec/git-core/git-citool',
    'mingw64/lib/tcl8.6', 'mingw64/lib/tk8.6', 'mingw64/lib/tk8.6.13',
    'mingw64/bin/wish.exe', 'mingw64/bin/tclsh.exe',
    'mingw64/share/doc', 'mingw64/share/man', 'usr/share/doc', 'usr/share/man', 'usr/share/info',
  ];
  let freed = 0;
  for (const rel of trash) {
    const p = path.join(root, rel);
    try { if (fs.existsSync(p)) { freed++; rmrf(p); } } catch {}
  }
  log(`git podado (${freed} alvos: scalar, gitk/gui, tcl/tk, docs)`);
}

// Poda do Node: remove docs do npm e ferramentas que não rodamos (npx docs,
// corepack). MANTÉM node.exe + npm (o agente roda npm install). ~5-10MB.
function pruneNode(root) {
  const trash = [
    'node_modules/npm/docs', 'node_modules/npm/man',
    'node_modules/npm/node_modules/node-gyp/test',
    'CHANGELOG.md', 'README.md',
  ];
  for (const rel of trash) { try { const p = path.join(root, rel); if (fs.existsSync(p)) rmrf(p); } catch {} }
}

function bundleClaude(platform) {
  const dest = path.join(VENDOR, 'claude');
  const marker = path.join(dest, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
  if (fs.existsSync(marker)) { log('claude já presente, pulando'); return; }
  mkdirp(dest);
  // package.json mínimo pra npm não subir procurando no projeto.
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
    name: 'maestrus-claude-bundle', version: '0.0.0', private: true,
  }) + '\n');
  // Cross-compilação: quando buildando Windows no Mac, força npm a baixar os
  // binários opcionais do Windows em vez dos do host (darwin-arm64).
  const cross = platform === 'win32' && process.platform !== 'win32';
  const env = cross ? { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' } : process.env;
  if (cross) log('cross-compiling claude: npm_config_platform=win32 npm_config_arch=x64');
  else log('npm install @anthropic-ai/claude-code (binário nativo da plataforma)...');
  const r = spawnSync(npmCmd(), [
    'install', '@anthropic-ai/claude-code@latest',
    '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error',
  ], { cwd: dest, stdio: 'inherit', shell: process.platform === 'win32', env });
  if (r.status !== 0) throw new Error('npm install do claude-code falhou');
  if (!fs.existsSync(marker)) throw new Error('claude-code instalado mas pacote não encontrado');
  log('claude embutido em', dest);
}

module.exports = async function beforePack(context) {
  mkdirp(VENDOR); // garante o diretório pro extraResources mesmo se pular tudo
  if (process.env.SKIP_BUNDLE === '1') { log('SKIP_BUNDLE=1 — não embute nada'); return; }
  const platform = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
  // context.arch: enum builder-util (0 ia32, 1 x64, 2 armv7l, 3 arm64, 4 universal)
  const archName = ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'x64' })[context.arch] || 'x64';
  log(`preparando runtimes embutidos: platform=${platform} arch=${archName}`);
  mkdirp(VENDOR);
  try {
    if (process.env.SKIP_BUNDLE_NODE !== '1') await bundleNode(platform, archName);
    if (process.env.SKIP_BUNDLE_GIT !== '1') await bundleGit(platform);
    if (process.env.SKIP_BUNDLE_CLAUDE !== '1') bundleClaude(platform);
  } catch (e) {
    console.error('[before-pack] ERRO ao preparar runtimes:', e && e.message);
    throw e; // falha o build — melhor build vermelho do que instalador quebrado
  }
  log('runtimes embutidos prontos em', VENDOR);
};
