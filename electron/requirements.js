const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const runtime = require('./runtime'); // runtimes EMBUTIDOS no instalador

// Pasta onde o Maestrus instala runtimes portáteis (Node) quando o usuário não
// tem — fica em %LOCALAPPDATA%\Maestrus\runtime (Windows) ou ~/.maestrus/runtime.
// Sem admin, sem UAC: o app controla esse dir e o injeta no PATH dos spawns.
function managedRuntimeDir() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Maestrus', 'runtime');
  }
  return path.join(os.homedir(), '.maestrus', 'runtime');
}

// Retorna a pasta do Node portátil instalado (a que contém node.exe/npm.cmd no
// Windows, ou bin/ no unix), ou null se não houver. Escaneia node-*-win-*.
function managedNodeDir() {
  const runtime = managedRuntimeDir();
  try {
    const entries = fs.readdirSync(runtime).filter((n) => /^node-v/i.test(n));
    // Maior versão primeiro
    entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const e of entries) {
      const dir = path.join(runtime, e);
      const binDir = process.platform === 'win32' ? dir : path.join(dir, 'bin');
      const nodeBin = path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
      if (fs.existsSync(nodeBin)) return binDir;
    }
  } catch {}
  return null;
}

// PATH do shell de login resolvido na primeira chamada. Em apps Electron lançados
// pelo Finder do macOS o process.env.PATH é o mínimo (/usr/bin:/bin:/usr/sbin:/sbin)
// — não inclui /opt/homebrew/bin, ~/.npm-global/bin etc., que é onde costuma
// estar o `claude`, `node`, e binários do brew. Esse helper roda o login shell
// uma vez e cacheia o PATH dele pra reusar.
let _shellPathCache = null;
// Limpa o cache do PATH — usado depois de instalar o Node portátil pra que o
// próximo spawn (ex: npm) já enxergue o runtime recém-instalado.
function resetShellPath() { _shellPathCache = null; }
function shellPath() {
  if (_shellPathCache !== null) return Promise.resolve(_shellPathCache);
  if (process.platform === 'win32') {
    let p = process.env.PATH || process.env.Path || '';
    // Prepend o Node portátil que instalamos (se houver) pra `node`/`npm`
    // ficarem disponíveis aos spawns mesmo sem estar no PATH do sistema.
    const managedNode = managedNodeDir();
    if (managedNode && !p.toLowerCase().includes(managedNode.toLowerCase())) {
      p = `${managedNode};${p}`;
    }
    // Prepend os runtimes EMBUTIDOS (node/git/claude) — prioridade máxima.
    for (const d of runtime.pathDirs().reverse()) {
      if (!p.toLowerCase().includes(d.toLowerCase())) p = `${d};${p}`;
    }
    _shellPathCache = p;
    return Promise.resolve(_shellPathCache);
  }
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    const proc = spawn(shell, ['-ilc', 'printf "%s\\n" "$PATH"'], { stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('close', () => {
      // Pega a ÚLTIMA linha não-vazia — alguns dotfiles imprimem stuff antes
      // (banners, mensagens). O echo do PATH é o último output do -ilc.
      const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
      let p = lines.length ? lines[lines.length - 1] : (process.env.PATH || '');
      for (const d of runtime.pathDirs().reverse()) {
        if (!p.split(':').includes(d)) p = `${d}:${p}`;
      }
      _shellPathCache = p;
      resolve(_shellPathCache);
    });
    proc.on('error', () => {
      _shellPathCache = process.env.PATH || '';
      resolve(_shellPathCache);
    });
    // Defesa contra shells que travam (raro)
    setTimeout(() => {
      try { proc.kill(); } catch {}
    }, 2500);
  });
}

// Lista de pastas extras que SEMPRE checamos, mesmo que não estejam no PATH.
// Cobre os principais locais de instalação de Claude Code, Node, Git, e
// gerenciadores (nvm, brew, asdf) no macOS, Linux e Windows.
function extraSearchDirs() {
  const home = os.homedir();
  const bundled = runtime.pathDirs(); // node/git/claude EMBUTIDOS, prioridade máxima
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roam = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const dirs = [
      path.join(home, '.local', 'bin'),        // installer nativo do Claude Code
      path.join(local, 'Programs', 'claude', 'bin'),
      path.join(roam, 'npm'),
      path.join(local, 'Programs', 'nodejs'),
      'C:\\Program Files\\nodejs',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\cmd',
    ];
    const managedNode = managedNodeDir();    // Node portátil instalado por nós
    if (managedNode) dirs.unshift(managedNode);
    return [...bundled, ...dirs];
  }
  const dirs = [
    '/opt/homebrew/bin',          // Apple Silicon brew
    '/usr/local/bin',             // Intel brew / instaladores oficiais
    '/usr/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.claude', 'local', 'bin'),    // installer oficial do claude code
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
  ];
  // nvm — escaneia versões instaladas e prepara o bin de cada
  try {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmRoot)) {
      for (const v of fs.readdirSync(nvmRoot)) dirs.push(path.join(nvmRoot, v, 'bin'));
    }
  } catch {}
  // asdf
  try {
    const asdfShim = path.join(home, '.asdf', 'shims');
    if (fs.existsSync(asdfShim)) dirs.push(asdfShim);
  } catch {}
  // n (node manager)
  dirs.push('/usr/local/n/versions/node');
  return [...bundled, ...dirs];
}

function isExecutableSync(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Acha todos os caminhos onde `cmd` está disponível, escaneando o PATH do shell
// de login + os diretórios extras conhecidos. Retorna em ordem de prioridade
// (shell PATH primeiro, extras depois), deduplicado por caminho real.
async function findAll(cmd) {
  const sp = await shellPath();
  const sep = process.platform === 'win32' ? ';' : ':';
  const fromPath = sp.split(sep).filter(Boolean);
  const all = [...fromPath, ...extraSearchDirs()];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const seen = new Set();
  const found = [];
  for (const dir of all) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        const real = fs.realpathSync(candidate);
        if (seen.has(real)) continue;
        if (!isExecutableSync(real)) continue;
        seen.add(real);
        found.push(candidate);
      } catch {}
    }
  }
  return found;
}

function runCapture(cmd, args = ['--version'], envExtra = {}) {
  return new Promise(async (resolve) => {
    const env = { ...process.env, ...envExtra };
    // Inclui o PATH resolvido pra que `node`, `git`, `claude` consigam achar
    // dependências quando spawned do Electron Finder-launched.
    env.PATH = await shellPath();
    const proc = spawn(cmd, args, {
      stdio: 'pipe',
      shell: process.platform === 'win32',
      env,
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (out += d.toString()));
    proc.on('close', (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] : null));
    proc.on('error', () => resolve(null));
  });
}

async function checkBinary(cmd, versionArgs = ['--version']) {
  const found = await findAll(cmd);
  if (found.length === 0) return { ok: false, found: [] };
  // Usa o primeiro caminho (prioridade do shell PATH) pra extrair a versão
  const version = await runCapture(found[0], versionArgs);
  return { ok: true, path: found[0], version, found };
}

async function checkClaude() {
  const r = await checkBinary('claude');
  if (!r.ok) {
    return {
      ok: false,
      hint: 'Clique em "Instalar Claude Code" para fazermos isso pra você — ou rode `npm install -g @anthropic-ai/claude-code` no terminal.',
      installable: true,
    };
  }
  return { ...r, installable: false };
}

async function checkGit() {
  const r = await checkBinary('git');
  if (!r.ok) {
    return {
      ok: false,
      hint: process.platform === 'darwin'
        ? 'Clique em "Instalar Git" para abrir o instalador oficial da Apple (Xcode Command Line Tools).'
        : 'Instale o git: https://git-scm.com',
      installable: process.platform === 'darwin',
    };
  }
  return { ...r, installable: false };
}

async function checkNode() {
  const r = await checkBinary('node', ['--version']);
  if (!r.ok) {
    return {
      ok: false,
      hint: 'Clique em "Instalar Node.js" para baixar e abrir o instalador oficial.',
      installable: true,
    };
  }
  return { ...r, installable: false };
}

async function checkAll() {
  // Aquece o cache do shell PATH em paralelo às checagens
  shellPath().catch(() => {});
  const [claude, git, node] = await Promise.all([checkClaude(), checkGit(), checkNode()]);
  return {
    platform: process.platform,
    items: [
      { id: 'node',   label: 'Node.js 18+',     required: true, ...node },
      { id: 'claude', label: 'Claude Code CLI', required: true, ...claude },
      { id: 'git',    label: 'Git',             required: true, ...git },
    ],
  };
}

module.exports = { checkAll, shellPath, findAll, managedRuntimeDir, managedNodeDir, resetShellPath };
