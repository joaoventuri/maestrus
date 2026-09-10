'use strict';
// Mantém o Claude CLI ATUALIZADO sem reinstalar o Maestrus.
//
// O instalador embute o CLI congelado na versão do dia do build, e o update
// rápido (asar) troca só o código do app — o runtime fica pra trás. O efeito
// real: sai um modelo novo, a API recusa com "Claude Code X does not support
// this model; version Y or newer is required" e o usuário fica travado até
// baixar um instalador inteiro por causa de um binário.
//
// Aqui o CLI ganha o mesmo tratamento que o Codex já tinha (codex-auth.install):
// uma cópia num diretório GRAVÁVEL (userData), instalada com o npm/node
// embutidos, atualizada em background. O findClaudeBin prefere a cópia mais
// NOVA entre a gravável e a embutida — um instalador futuro mais novo volta a
// vencer naturalmente, sem estado pra limpar.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const runtime = require('./runtime');

const PKG = '@anthropic-ai/claude-code';

function updateDir() {
  // Lazy: o módulo é carregado antes do app.ready em testes.
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'claude-cli');
}

function npmCmd() {
  try {
    const nd = runtime.nodeDir && runtime.nodeDir();
    if (nd) {
      for (const rel of [process.platform === 'win32' ? 'npm.cmd' : 'npm', path.join('bin', 'npm')]) {
        const c = path.join(nd, rel);
        if (fs.existsSync(c)) return c;
      }
    }
  } catch {}
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function pkgVersionAt(nmRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(nmRoot, 'node_modules', PKG, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

/** Versão da cópia gravável (null se nunca instalada). */
function updatedVersion() { return pkgVersionAt(updateDir()); }

/** Versão da cópia embutida no instalador (null fora de produção). */
function bundledVersion() {
  try {
    const root = runtime.runtimeRoot && runtime.runtimeRoot();
    return root ? pkgVersionAt(path.join(root, 'claude')) : null;
  } catch { return null; }
}

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/** Binário nativo dentro de uma raiz npm (mesmo layout do vendor do build). */
function nativeBinAt(nmRoot) {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const nativePkg = `claude-code-${process.platform}-${process.arch}`;
  for (const p of [
    path.join(nmRoot, 'node_modules', '@anthropic-ai', nativePkg, exe),
    path.join(nmRoot, 'node_modules', '@anthropic-ai', nativePkg, 'bin', exe),
    path.join(nmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'vendor', nativePkg, exe),
  ]) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}

/**
 * Binário da cópia gravável, mas SÓ se ela for mais nova que a embutida.
 * A comparação é por package.json (barata, sem spawn) — é o que faz um
 * instalador futuro, com CLI mais novo embutido, voltar a vencer sozinho.
 */
function updatedBinIfNewer() {
  const uv = updatedVersion();
  if (!uv) return null;
  const bv = bundledVersion();
  if (bv && cmpVer(uv, bv) <= 0) return null;
  return nativeBinAt(updateDir());
}

function registryLatest() {
  return new Promise((resolve) => {
    const req = https.get(`https://registry.npmjs.org/${PKG}/latest`, { headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d).version || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

let _installing = false;

/**
 * Confere o registro npm e, se houver CLI mais novo que TUDO que temos
 * (embutido e gravável), instala na cópia gravável em background.
 * Best-effort de ponta a ponta: falha de rede/instalação = fica como está.
 */
async function ensureLatest({ onUpdated } = {}) {
  if (_installing) return { ok: true, busy: true };
  const latest = await registryLatest();
  if (!latest) return { ok: false, reason: 'registry_unreachable' };
  const have = [bundledVersion(), updatedVersion()].filter(Boolean).sort(cmpVer).pop() || '0';
  if (cmpVer(latest, have) <= 0) return { ok: true, upToDate: true, version: have };

  _installing = true;
  const dir = updateDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  // package.json próprio: sem ele o npm sobe a árvore procurando um projeto e
  // instala no lugar errado.
  const pj = path.join(dir, 'package.json');
  try { if (!fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({ name: 'maestrus-claude-cli', version: '0.0.0', private: true }) + '\n'); } catch {}

  return new Promise((resolve) => {
    // --os/--cpu explícitos: o pacote nativo tem que casar com a MÁQUINA que
    // vai executar o claude, não com o que o npm embutido acha de si mesmo
    // (mesma lição do codex-auth com node x64 sob Rosetta).
    const args = ['install', '--no-save', '--no-audit', '--no-fund',
      `--os=${process.platform}`, `--cpu=${process.arch}`, `${PKG}@${latest}`];
    let proc;
    try {
      proc = spawn(npmCmd(), args, { cwd: dir, stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true });
    } catch (e) { _installing = false; return resolve({ ok: false, reason: String(e && e.message || e) }); }
    proc.on('error', (e) => { _installing = false; resolve({ ok: false, reason: e.message }); });
    proc.on('close', (code) => {
      _installing = false;
      if (code !== 0) return resolve({ ok: false, reason: 'npm_exit_' + code });
      const bin = nativeBinAt(dir);
      if (!bin) return resolve({ ok: false, reason: 'binary_missing_after_install' });
      console.log(`[claude-cli-updater] Claude CLI atualizado para ${latest} em ${dir}`);
      try { onUpdated && onUpdated(latest); } catch {}
      resolve({ ok: true, updated: true, version: latest });
    });
  });
}

module.exports = { ensureLatest, updatedBinIfNewer, updatedVersion, bundledVersion, cmpVer, nativeBinAt };
