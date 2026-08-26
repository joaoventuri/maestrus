'use strict';
// Overlay "Maestrus está no controle": moldura laranja em volta da tela enquanto
// o agente dirige o computador (clica, digita, abre apps).
//
// Por que existe: quando um agente move o SEU mouse e digita na SUA máquina,
// você precisa ver isso acontecendo — é transparência e segurança, não enfeite.
// Sem sinal na tela, o usuário não sabe se aquele clique foi ele ou o agente.
//
// Como funciona: uma janela sem moldura, transparente, SEMPRE no topo e que
// IGNORA cliques (setIgnoreMouseEvents) — ela nunca atrapalha o que está
// acontecendo embaixo. Aparece no primeiro comando de controle e some sozinha
// depois de um tempo sem comando (o agente terminou).

const path = require('path');

let win = null;
let hideTimer = null;
const IDLE_HIDE_MS = 2500;   // sem comando por este tempo → some

function overlayHtml(label) {
  // Inline (data URL) pra não depender de arquivo empacotado.
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font-family:'Space Grotesk',system-ui,-apple-system,sans-serif;-webkit-user-select:none}
  .frame{position:fixed;inset:0;border:3px solid #ff8a3d;border-radius:10px;
    box-shadow:inset 0 0 42px rgba(255,138,61,.35),0 0 22px rgba(255,138,61,.25);
    animation:breathe 2.4s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:.95}50%{opacity:.55}}
  .pill{position:fixed;top:14px;left:50%;transform:translateX(-50%);
    display:flex;align-items:center;gap:9px;padding:9px 16px;border-radius:999px;
    background:rgba(12,12,14,.92);border:1px solid rgba(255,138,61,.55);
    color:#ededf0;font-size:13.5px;font-weight:600;letter-spacing:.01em;
    box-shadow:0 8px 28px rgba(0,0,0,.45);backdrop-filter:blur(8px)}
  .dot{width:9px;height:9px;border-radius:50%;background:#ff8a3d;
    box-shadow:0 0 10px #ff8a3d;animation:pulse 1.1s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.65);opacity:.55}}
</style></head><body>
  <div class="frame"></div>
  <div class="pill"><span class="dot"></span><span>${label}</span></div>
</body></html>`)}`;
}

// Cria (ou reaproveita) a janela do overlay cobrindo a tela onde está o cursor.
function ensureWindow(label) {
  const { BrowserWindow, screen } = require('electron');
  if (win && !win.isDestroyed()) return win;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.bounds;
  win = new BrowserWindow({
    x, y, width, height,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, closable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, show: false,
    // alwaysOnTop no nível de screen-saver: fica acima de apps em tela cheia.
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: false },
  });
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenUI: true }); } catch {}
  // NUNCA rouba clique: tudo passa direto pro que está embaixo.
  try { win.setIgnoreMouseEvents(true, { forward: true }); } catch {}
  win.loadURL(overlayHtml(label));
  win.on('closed', () => { win = null; });
  return win;
}

/** Chamado a CADA comando de controle. Mostra o overlay e adia o auto-hide. */
function ping(label) {
  try {
    const w = ensureWindow(label || 'Maestrus is orchestrating');
    if (!w.isVisible()) w.showInactive();   // showInactive: não rouba foco
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, IDLE_HIDE_MS);
  } catch {}
}

function hide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  try { if (win && !win.isDestroyed()) win.hide(); } catch {}
}

function destroy() {
  hide();
  try { if (win && !win.isDestroyed()) { win.destroy(); } } catch {}
  win = null;
}

module.exports = { ping, hide, destroy };
