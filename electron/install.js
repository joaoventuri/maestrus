// Instaladores inteligentes para os pré-requisitos do Maestrus.
// Cada install({id}) retorna uma Promise que resolve com { ok, error? } e,
// enquanto roda, emite eventos de log via `onLog` (cada linha do processo).
//
// Estratégia por plataforma:
//   - Claude Code (mac/linux/win):  usa o installer oficial do Anthropic
//     (curl https://claude.ai/install.sh | bash) quando há um shell. Falha
//     graciosamente para o método npm se npm estiver disponível.
//   - Node.js (mac):  baixa o .pkg oficial e abre com `open` (GUI Apple).
//   - Node.js (win):  baixa o .msi e abre.
//   - Node.js (linux):  abre a página de download (instalação varia por distro).
//   - Git (mac):  `xcode-select --install` (Apple dispara installer GUI).
//   - Git (win/linux):  abre a página oficial.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { shell } = require('electron');
const { shellPath, managedRuntimeDir, resetShellPath } = require('./requirements');
const runtime = require('./runtime'); // runtimes EMBUTIDOS no instalador

// Versão LTS do Node que instalamos quando o usuário não tem. Mantida em sincronia
// entre macOS (.pkg) e Windows (zip portátil).
const NODE_VERSION = 'v22.13.1';

// Roda um comando via shell de login do usuário (zsh -ic) pra herdar o PATH
// completo (brew, npm, nvm). No Windows usa cmd. Streama linhas via onLog.
function runShell(commandLine, onLog) {
  return new Promise(async (resolve) => {
    const env = { ...process.env };
    const PATH = await shellPath();
    if (PATH) env.PATH = PATH;
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = process.env.ComSpec || 'cmd.exe';
      args = ['/c', commandLine];
    } else {
      cmd = process.env.SHELL || '/bin/zsh';
      // -ic carrega rc files (PATH do brew/nvm/npm). -e não — queremos rc.
      args = ['-ic', commandLine];
    }
    onLog(`$ ${commandLine}\n`);
    const proc = spawn(cmd, args, { stdio: 'pipe', env });
    proc.stdout.on('data', (d) => onLog(d.toString()));
    proc.stderr.on('data', (d) => onLog(d.toString()));
    proc.on('close', (code) => {
      onLog(`\n[exit code ${code}]\n`);
      resolve({ ok: code === 0, code });
    });
    proc.on('error', (e) => {
      onLog(`\n[erro: ${e.message}]\n`);
      resolve({ ok: false, code: -1, error: e.message });
    });
  });
}

// Roda um comando PowerShell no Windows, streamando linhas via onLog. Usado pro
// installer nativo do Claude (irm | iex) e pra Expand-Archive do Node portátil.
function runPowerShell(psCommand, onLog) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand];
    onLog(`> powershell ${psCommand}\n`);
    const proc = spawn('powershell.exe', args, { stdio: 'pipe', windowsHide: true });
    proc.stdout.on('data', (d) => onLog(d.toString()));
    proc.stderr.on('data', (d) => onLog(d.toString()));
    proc.on('close', (code) => { onLog(`\n[exit code ${code}]\n`); resolve({ ok: code === 0, code }); });
    proc.on('error', (e) => { onLog(`\n[erro: ${e.message}]\n`); resolve({ ok: false, code: -1, error: e.message }); });
  });
}

// Baixa um arquivo pra um caminho local, com até 5 redirecionamentos.
function download(url, dest, onLog) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let total = 0;
    let downloaded = 0;
    let lastPct = -1;
    function get(u, redirectsLeft) {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Muitos redirecionamentos'));
          res.resume();
          return get(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`HTTP ${res.statusCode} em ${u}`));
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct;
              onLog(`Baixando... ${pct}%\n`);
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', (e) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(e);
      });
    }
    onLog(`Baixando ${url}\n`);
    get(url, 5);
  });
}

async function installClaude(onLog) {
  // Método 1 (preferido): installer NATIVO oficial do Anthropic. NÃO exige
  // Node/npm — baixa um binário nativo. Em mac/linux usa o install.sh; no
  // Windows usa o install.ps1 (PowerShell). Instala em ~/.local/bin (e
  // ~/.claude/local/bin), que o requirements/claude-pty já procuram.
  if (process.platform === 'win32') {
    onLog('Instalando o Claude Code (installer nativo, sem precisar de Node)…\n');
    const r = await runPowerShell('irm https://claude.ai/install.ps1 | iex', onLog);
    if (r.ok) return { ok: true };
    onLog('\n[fallback] Tentando via npm (precisa de Node)…\n');
    // npm pode estar no Node portátil que instalamos — runShell herda nosso PATH.
    const npm = await runShell('npm install -g @anthropic-ai/claude-code', onLog);
    if (npm.ok) return { ok: true };
    return { ok: false, error: 'Falha no installer nativo e no npm. Veja o log.' };
  }
  const r = await runShell('curl -fsSL https://claude.ai/install.sh | bash', onLog);
  if (r.ok) return { ok: true };
  onLog('\n[fallback] Tentando via npm...\n');
  const npm = await runShell('npm install -g @anthropic-ai/claude-code', onLog);
  if (npm.ok) return { ok: true };
  return { ok: false, error: 'Falha no install via installer oficial e via npm. Veja o log.' };
}

async function installNode(onLog) {
  // Mac: baixa o .pkg arm64 (Apple Silicon) ou x64, abre o instalador da Apple.
  if (process.platform === 'darwin') {
    const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}.pkg`;
    const dest = path.join(os.tmpdir(), `node-${NODE_VERSION}.pkg`);
    try {
      await download(url, dest, onLog);
      onLog(`Abrindo instalador da Apple — siga as instruções na tela.\n`);
      await shell.openPath(dest);
      return { ok: true, manual: true };
    } catch (e) {
      onLog(`\n[erro] ${e.message}\n`);
      // Fallback: abre a página de download
      await shell.openExternal('https://nodejs.org/');
      return { ok: false, error: e.message };
    }
  }
  // Windows: instala o Node PORTÁTIL (zip) numa pasta gerenciada pelo Maestrus.
  // Sem UAC, sem admin, sem navegador — o usuário leigo não toca em nada. O
  // requirements/claude-pty já procuram esse dir, então o `node`/`npm` ficam
  // disponíveis pro app na hora.
  if (process.platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const base = `node-${NODE_VERSION}-win-${arch}`;
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${base}.zip`;
    const zip = path.join(os.tmpdir(), `${base}.zip`);
    const runtime = managedRuntimeDir();
    try {
      fs.mkdirSync(runtime, { recursive: true });
      await download(url, zip, onLog);
      onLog(`Extraindo o Node.js para ${runtime}…\n`);
      // -Force sobrescreve uma extração anterior incompleta.
      const ps = `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${runtime}' -Force`;
      const r = await runPowerShell(ps, onLog);
      try { fs.unlinkSync(zip); } catch {}
      const nodeExe = path.join(runtime, base, 'node.exe');
      if (r.ok && fs.existsSync(nodeExe)) {
        try { resetShellPath(); } catch {}   // próximo npm já enxerga o Node novo
        onLog(`\nNode.js instalado em ${path.join(runtime, base)}\n`);
        return { ok: true };
      }
      throw new Error('extração falhou ou node.exe não encontrado');
    } catch (e) {
      onLog(`\n[erro] ${e.message}\n`);
      onLog('Abrindo a página oficial do Node.js como alternativa.\n');
      await shell.openExternal('https://nodejs.org/');
      return { ok: false, error: e.message };
    }
  }
  // Linux: package manager varia (apt/dnf/pacman). Abre a doc oficial.
  onLog('Abrindo guia de instalação do Node.js no navegador.\n');
  await shell.openExternal('https://nodejs.org/en/download/package-manager');
  return { ok: true, manual: true };
}

async function installGit(onLog) {
  if (process.platform === 'darwin') {
    // xcode-select --install pop a um GUI installer da Apple. O processo do
    // próprio xcode-select retorna rápido — quem espera é o usuário no GUI.
    const r = await runShell('xcode-select --install', onLog);
    if (r.ok || r.code === 1) {
      onLog('\nUma janela do instalador da Apple deve ter aparecido. Siga as instruções.\n');
      return { ok: true, manual: true };
    }
    return { ok: false, error: 'Falha ao iniciar xcode-select --install.' };
  }
  if (process.platform === 'win32') {
    onLog('Abrindo página de download do Git for Windows.\n');
    await shell.openExternal('https://git-scm.com/download/win');
    return { ok: true, manual: true };
  }
  onLog('Abrindo guia de instalação do Git no navegador.\n');
  await shell.openExternal('https://git-scm.com/download/linux');
  return { ok: true, manual: true };
}

async function install(id, onLog) {
  // Se o runtime já vem EMBUTIDO no instalador do Maestrus, não há o que baixar.
  try {
    const bundled = (id === 'claude' && runtime.claudeBin())
      || (id === 'node' && runtime.nodeBin())
      || (id === 'git' && runtime.gitBin());
    if (bundled) {
      onLog(`Já incluído no Maestrus: ${bundled}\n`);
      return { ok: true, bundled: true };
    }
  } catch {}
  switch (id) {
    case 'claude': return installClaude(onLog);
    case 'node':   return installNode(onLog);
    case 'git':    return installGit(onLog);
    default:       return { ok: false, error: `Desconhecido: ${id}` };
  }
}

module.exports = { install };
