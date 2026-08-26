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

// Versão FIXA do Claude Code embutido. Trocar aqui é decisão consciente (e o
// auto-bump do CI atualiza esta linha). Nunca voltar pra @latest: o CLI publica
// quase diariamente e a gente parseia o contrato do stream-json dele.
const CLAUDE_CLI_VERSION = process.env.MAESTRUS_CLAUDE_CLI_VERSION || '2.1.228';

function log(...a) { console.log('[before-pack]', ...a); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

/**
 * Baixa com retry e backoff.
 *
 * O build de macOS caiu inteiro porque UM GET ao nodejs.org falhou por rede
 * (AggregateError: todos os IPs recusaram). Baixar ~240MB de runtimes sem
 * nenhuma tentativa extra torna o release refém de qualquer soluço de conexão
 * — ainda mais no runner self-hosted, que usa a internet de casa.
 */
async function downloadWithRetry(url, dest, tries = 4) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      await download(url, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (i === tries) break;
      const waitMs = 1500 * Math.pow(2, i - 1); // 1.5s, 3s, 6s
      log(`falha ao baixar (tentativa ${i}/${tries}): ${e && e.message}. Nova tentativa em ${waitMs}ms`);
      try { rmrf(dest); } catch {}
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

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
    }).on('error', (e) => { file.close(); rmrf(dest); reject(e); })
      // Socket pendurado travaria o build sem nunca falhar nem tentar de novo.
      .setTimeout(120000, function () { this.destroy(new Error('timeout ao baixar ' + url)); });
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
  await downloadWithRetry(url, arc);
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
  await downloadWithRetry(url, arc);
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

function bundleClaude(platform, arch) {
  const dest = path.join(VENDOR, 'claude');
  const marker = path.join(dest, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
  if (fs.existsSync(marker)) { log('claude já presente, pulando'); return; }
  mkdirp(dest);
  // package.json mínimo pra npm não subir procurando no projeto.
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
    name: 'maestrus-claude-bundle', version: '0.0.0', private: true,
  }) + '\n');
  // Cross-compilação: força o npm a baixar o binário OPCIONAL do TARGET (não o
  // do host). Vale pra QUALQUER build cross — Windows, Linux ou macOS x64 no
  // host arm64 — senão o app leva o binário do host (ex.: darwin-arm64 num
  // AppImage Linux) e o Claude CLI não roda no destino.
  const npmPlat = platform === 'win32' ? 'win32' : (platform === 'darwin' ? 'darwin' : 'linux');
  const npmArch = arch === 'arm64' ? 'arm64' : 'x64';
  // Usa --os/--cpu do npm (10+) pra escolher o binário OPCIONAL do TARGET de
  // forma DETERMINÍSTICA. npm_config_platform/arch não filtra opcionais cross-arch
  // dentro da mesma plataforma (darwin-arm64 → darwin-x64 vinha errado); --os/--cpu
  // filtra certo. Vale pra Windows, Linux e macOS x64 buildados no host arm64.
  log(`bundleClaude: --os=${npmPlat} --cpu=${npmArch}`);
  // VERSÃO FIXA, não @latest. O Claude Code publica quase todo dia; com @latest
  // cada build adotava silenciosamente o que tivesse saído naquele dia — sem
  // escolha e sem teste do contrato do stream-json (que a gente parseia).
  // Subir daqui é decisão deliberada. A 2.1.228 traz dois fixes que nos afetam
  // direto: saída stream-json truncada / mensagem final sumindo em respostas
  // grandes, e a sessão morrendo com linhas em branco no padrão Windows.
  const r = spawnSync(npmCmd(), [
    'install', `@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}`,
    `--os=${npmPlat}`, `--cpu=${npmArch}`,
    '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error',
  ], { cwd: dest, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('npm install do claude-code falhou');
  if (!fs.existsSync(marker)) throw new Error('claude-code instalado mas pacote não encontrado');
  log('claude embutido em', dest);
}

function bundleCodex(platform, arch) {
  const dest = path.join(VENDOR, 'codex');
  const marker = path.join(dest, 'node_modules', '@openai', 'codex', 'package.json');
  if (fs.existsSync(marker)) { log('codex já presente, pulando'); return; }
  mkdirp(dest);
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
    name: 'maestrus-codex-bundle', version: '0.0.0', private: true,
  }) + '\n');
  const npmPlat = platform === 'win32' ? 'win32' : (platform === 'darwin' ? 'darwin' : 'linux');
  const npmArch = arch === 'arm64' ? 'arm64' : 'x64';
  log(`bundleCodex: --os=${npmPlat} --cpu=${npmArch}`);
  const r = spawnSync(npmCmd(), [
    'install', '@openai/codex@latest',
    `--os=${npmPlat}`, `--cpu=${npmArch}`,
    '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error',
  ], { cwd: dest, stdio: 'inherit', shell: process.platform === 'win32' });
  // Codex é opcional — se falhar (ex.: sem binário pro alvo), NÃO derruba o build.
  if (r.status !== 0 || !fs.existsSync(marker)) { log('AVISO: bundleCodex falhou — Codex CLI não embutido (usa o do PATH se instalado)'); return; }
  log('codex embutido em', dest);
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
    if (process.env.SKIP_BUNDLE_CLAUDE !== '1') bundleClaude(platform, archName);
    if (process.env.SKIP_BUNDLE_CODEX !== '1') bundleCodex(platform, archName);
  } catch (e) {
    console.error('[before-pack] ERRO ao preparar runtimes:', e && e.message);
    throw e; // falha o build — melhor build vermelho do que instalador quebrado
  }
  log('runtimes embutidos prontos em', VENDOR);
};
