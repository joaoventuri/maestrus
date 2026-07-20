// Auto-update via electron-updater (provider genérico → teu próprio servidor).
// O cliente baixa latest.yml + instalador de UPDATE_FEED, aplica e preserva
// os dados do usuário (userData não é tocado). Só roda em app empacotado.

const { autoUpdater } = require('electron-updater');
const { UPDATE_FEED } = require('./config');

let win = null;
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function init(mainWindow, isPackaged) {
  win = mainWindow;
  if (!isPackaged) return; // em dev não há o que atualizar
  // electron-updater (download+instala sozinho) só roda no Windows. No macOS
  // exige app assinado/notarizado; lá usamos o banner de download (version API).
  if (process.platform !== 'win32') return;

  autoUpdater.autoDownload = false;        // só baixa quando o usuário clicar
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED });

  autoUpdater.on('update-available', (info) => send('update:available', { version: info.version, notes: info.releaseNotes }));
  autoUpdater.on('update-not-available', () => send('update:none', {}));
  autoUpdater.on('error', (err) => send('update:error', { message: String(err && err.message || err) }));
  autoUpdater.on('download-progress', (p) => send('update:progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update:downloaded', { version: info.version }));

  const safeCheck = () => autoUpdater.checkForUpdates().catch(() => {});
  // checa no boot, a cada 30 min, e quando a janela volta ao foco (sem reiniciar).
  setTimeout(safeCheck, 4000);
  setInterval(safeCheck, 30 * 60 * 1000);
  let lastFocusCheck = 0;
  win.on('focus', () => {
    const now = Date.now();
    if (now - lastFocusCheck > 3 * 60 * 1000) { lastFocusCheck = now; safeCheck(); }
  });
}

function check() { return autoUpdater.checkForUpdates().catch((e) => ({ error: String(e) })); }
function download() { return autoUpdater.downloadUpdate().catch((e) => ({ error: String(e) })); }
function install() { autoUpdater.quitAndInstall(false, true); }

module.exports = { init, check, download, install };
