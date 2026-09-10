// O updater existe pra UMA dor: "Claude Code X does not support this model" —
// o CLI embutido congela no build e o asar nao o atualiza. O que se testa:
// a copia gravavel so vence quando e MAIS NOVA, e o layout npm e resolvido.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const upd = require('./claude-cli-updater');

function fakeInstall(root, version, withBin = true) {
  const pkgDir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  if (withBin) {
    const nat = path.join(root, 'node_modules', '@anthropic-ai', `claude-code-${process.platform}-${process.arch}`);
    fs.mkdirSync(nat, { recursive: true });
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    fs.writeFileSync(path.join(nat, exe), '#!/bin/sh\n');
    fs.chmodSync(path.join(nat, exe), 0o755);
  }
}

test('cmpVer ordena versoes de tres pontos', () => {
  assert.ok(upd.cmpVer('2.1.267', '2.1.228') > 0);
  assert.ok(upd.cmpVer('2.1.228', '2.1.251') < 0);
  assert.equal(upd.cmpVer('2.1.0', '2.1.0'), 0);
  assert.ok(upd.cmpVer('3.0.0', '2.99.99') > 0);
});

test('nativeBinAt acha o binario no layout do npm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcli-'));
  try {
    fakeInstall(dir, '2.1.267');
    const bin = upd.nativeBinAt(dir);
    assert.ok(bin && fs.existsSync(bin));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nativeBinAt sem binario nativo devolve null (instalacao capenga nao vira candidato)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcli-'));
  try {
    fakeInstall(dir, '2.1.267', false);
    assert.equal(upd.nativeBinAt(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
