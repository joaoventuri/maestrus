'use strict';
// Resolve os runtimes EMBUTIDOS no instalador do Maestrus (Node, Git, Claude CLI).
// Em produção ficam em <resources>/runtime/ (copiados via build.extraResources a
// partir de vendor/runtime/, populado pelo scripts/before-pack.js no momento do
// build). Em dev (electron .) não existe esse diretório → tudo retorna null e o
// app cai no fallback de detecção (requirements.js / claude-pty.js).
//
// Objetivo: o usuário leigo instala o Maestrus e SAI USANDO — sem precisar
// instalar Node, Git ou Claude CLI à parte, sem abrir navegador, sem internet.

const path = require('path');
const fs = require('fs');

let _rootCache; // undefined = não resolvido; null = não existe; string = caminho

function runtimeRoot() {
  if (_rootCache !== undefined) return _rootCache;
  try {
    const base = process.resourcesPath; // setado pelo Electron em produção
    if (base) {
      const dir = path.join(base, 'runtime');
      if (fs.existsSync(dir)) { _rootCache = dir; return _rootCache; }
    }
  } catch {}
  // Dev / build local sem bundle: tenta vendor/runtime na raiz do projeto.
  try {
    const dev = path.join(__dirname, '..', 'vendor', 'runtime');
    if (fs.existsSync(dev)) { _rootCache = dev; return _rootCache; }
  } catch {}
  _rootCache = null;
  return _rootCache;
}

function firstExisting(cands) {
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

const isWin = process.platform === 'win32';

// Diretório do Node embutido (a pasta que contém node/npm executáveis).
function nodeDir() {
  const root = runtimeRoot();
  if (!root) return null;
  if (isWin) {
    const d = path.join(root, 'node');
    return fs.existsSync(path.join(d, 'node.exe')) ? d : null;
  }
  const d = path.join(root, 'node', 'bin');
  return fs.existsSync(path.join(d, 'node')) ? d : null;
}

function nodeBin() {
  const d = nodeDir();
  if (!d) return null;
  return path.join(d, isWin ? 'node.exe' : 'node');
}

// Diretório do git embutido (onde está o git executável). Só no Windows
// (MinGit). No mac/linux usa o git do sistema (xcode / package manager).
function gitDir() {
  const root = runtimeRoot();
  if (!root || !isWin) return null;
  const cmd = path.join(root, 'git', 'cmd');
  return fs.existsSync(path.join(cmd, 'git.exe')) ? cmd : null;
}

function gitBin() {
  const d = gitDir();
  return d ? path.join(d, 'git.exe') : null;
}

// Binário nativo do Claude CLI embutido.
function claudeBin() {
  const root = runtimeRoot();
  if (!root) return null;
  const exe = isWin ? 'claude.exe' : 'claude';
  return firstExisting([
    path.join(root, 'claude', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
    path.join(root, 'claude', 'node_modules', '.bin', exe),
    path.join(root, 'claude', 'bin', exe),
    path.join(root, 'claude', exe),
  ]);
}

// Diretórios a PREPOR no PATH dos processos filhos (claude, bash do agente,
// git operations), pra que node/npm/git/claude embutidos sejam achados primeiro.
function pathDirs() {
  const root = runtimeRoot();
  if (!root) return [];
  const dirs = [];
  const n = nodeDir(); if (n) dirs.push(n);
  const g = gitDir();
  if (g) {
    dirs.push(g);
    // Ferramentas unix do MinGit (bash, ssh, etc.) — úteis pro agente.
    for (const sub of [['git', 'mingw64', 'bin'], ['git', 'usr', 'bin']]) {
      const p = path.join(root, ...sub);
      if (fs.existsSync(p)) dirs.push(p);
    }
  }
  const c = claudeBin(); if (c) dirs.push(path.dirname(c));
  return dirs;
}

// true se há pelo menos o Claude embutido (o item central do "sai usando").
function hasBundle() {
  return !!claudeBin();
}

module.exports = {
  runtimeRoot, nodeDir, nodeBin, gitDir, gitBin, claudeBin, pathDirs, hasBundle,
};
