'use strict';
// Detecta os navegadores disponíveis na máquina e qual "backend" o agente usa.
//   - maestrus (nativo): o navegador embutido (webview do painel). Sempre
//     disponível, isolado, sessão persistente (logins ficam salvos). Default.
//   - chrome / edge / firefox / brave: o navegador REAL do usuário, dirigido
//     via Playwright MCP — usa o perfil/logins dele. Beta (1º uso baixa o MCP).
//
// O usuário escolhe nas Configurações. writeMaestrusMcpConfig (main.js) lê o
// backend e monta o .mcp.json: nativo → tools browser_* do orquestrate; real →
// Playwright MCP + desliga as browser_* nativas (evita colisão de nomes).

const fs = require('fs');
const os = require('os');
const path = require('path');
const projectStore = require('./project-store');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function firstExisting(paths) {
  for (const p of paths) { try { if (p && fs.existsSync(p)) return p; } catch {} }
  return null;
}

// Caminhos conhecidos por SO. Retorna o executável (Win/Linux) ou o .app (Mac).
function detectBrowser(id) {
  const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
  const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const LOCAL = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  const M = {
    chrome: {
      win: [path.join(PF, 'Google/Chrome/Application/chrome.exe'), path.join(PF86, 'Google/Chrome/Application/chrome.exe'), path.join(LOCAL, 'Google/Chrome/Application/chrome.exe')],
      mac: ['/Applications/Google Chrome.app'],
      linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
      channel: 'chrome',
    },
    edge: {
      win: [path.join(PF86, 'Microsoft/Edge/Application/msedge.exe'), path.join(PF, 'Microsoft/Edge/Application/msedge.exe')],
      mac: ['/Applications/Microsoft Edge.app'],
      linux: ['/usr/bin/microsoft-edge'],
      channel: 'msedge',
    },
    firefox: {
      win: [path.join(PF, 'Mozilla Firefox/firefox.exe'), path.join(PF86, 'Mozilla Firefox/firefox.exe')],
      mac: ['/Applications/Firefox.app'],
      linux: ['/usr/bin/firefox'],
      channel: 'firefox',
    },
    brave: {
      win: [path.join(LOCAL, 'BraveSoftware/Brave-Browser/Application/brave.exe'), path.join(PF, 'BraveSoftware/Brave-Browser/Application/brave.exe')],
      mac: ['/Applications/Brave Browser.app'],
      linux: ['/usr/bin/brave-browser'],
      channel: 'chromium',
    },
  };
  const def = M[id];
  if (!def) return null;
  const found = firstExisting(isWin ? def.win : isMac ? def.mac : def.linux);
  return found ? { path: found, channel: def.channel } : null;
}

// Lista os backends pra UI. Sempre inclui o nativo; inclui os navegadores reais
// que existirem na máquina.
function list() {
  const current = projectStore.getSetting('browser_backend') || 'maestrus';
  const out = [
    { id: 'maestrus', label: 'Maestrus Browser (nativo)', desc: 'Navegador embutido, isolado, sessão persistente. Sempre funciona.', available: true, beta: false },
  ];
  const real = [
    { id: 'chrome', label: 'Google Chrome (real)' },
    { id: 'edge', label: 'Microsoft Edge (real)' },
    { id: 'firefox', label: 'Mozilla Firefox (real)' },
    { id: 'brave', label: 'Brave (real)' },
  ];
  for (const r of real) {
    const d = detectBrowser(r.id);
    if (d) out.push({ id: r.id, label: r.label, desc: 'Usa seu navegador real com seus logins (via Playwright). Beta.', available: true, beta: true, path: d.path, channel: d.channel });
  }
  return { backends: out, current };
}

function get() { return projectStore.getSetting('browser_backend') || 'maestrus'; }
function set(id) {
  const valid = new Set(['maestrus', ...list().backends.map((b) => b.id)]);
  const next = valid.has(id) ? id : 'maestrus';
  projectStore.setSetting('browser_backend', next);
  return next;
}

// Config do Playwright MCP pro backend escolhido (ou null se nativo).
function playwrightMcp(backendId) {
  if (!backendId || backendId === 'maestrus') return null;
  const d = detectBrowser(backendId);
  if (!d) return null;
  const args = ['-y', '@playwright/mcp@latest', '--browser', d.channel];
  if (backendId === 'brave' && d.path) { args.push('--executable-path', d.path); }
  return {
    command: isWin ? 'npx.cmd' : 'npx',
    args,
  };
}

module.exports = { list, get, set, detectBrowser, playwrightMcp };
