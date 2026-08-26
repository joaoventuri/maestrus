// Testes do acesso a arquivos do workspace (Fase C). Foco no que é CRÍTICO:
// a resolução de path NUNCA pode escapar do projeto (path traversal / symlink).
// Roda com `node --test` — zero dependência, valida em tempo real.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fa = require('./file-access');

function mkroot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-test-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello world');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.md'), '# título\ncorpo');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), 'x');
  return root;
}

test('resolveInProject: rel válido resolve dentro do projeto', () => {
  const root = mkroot();
  const p = fa.resolveInProject(root, 'sub/b.md');
  assert.ok(p && p.startsWith(root), 'deveria resolver dentro do root');
  assert.ok(fs.existsSync(p));
});

test('resolveInProject: bloqueia path traversal (../)', () => {
  const root = mkroot();
  assert.strictEqual(fa.resolveInProject(root, '../../../etc/passwd'), null);
  assert.strictEqual(fa.resolveInProject(root, '..'), null);
  assert.strictEqual(fa.resolveInProject(root, 'sub/../../escape.txt'), null);
});

test('resolveInProject: bloqueia symlink que aponta pra FORA do projeto', () => {
  const root = mkroot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'segredo');
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'dir'); }
  catch { return; } // sem permissão de symlink (Windows sem admin) → pula
  // Arquivo EXISTE via symlink → realpath revela que está fora → null.
  assert.strictEqual(fa.resolveInProject(root, 'link/secret.txt'), null);
});

test('tree: lista arquivos e PULA node_modules', () => {
  const root = mkroot();
  const r = fa.tree(root);
  assert.strictEqual(r.ok, true);
  const rels = r.files.map((f) => f.rel);
  assert.ok(rels.includes('a.txt'));
  assert.ok(rels.includes('sub/b.md'));
  assert.ok(!rels.some((x) => x.includes('node_modules')), 'node_modules não pode aparecer');
  const a = r.files.find((f) => f.rel === 'a.txt');
  assert.strictEqual(a.size, 11);
  assert.strictEqual(a.mime, 'text/plain');
});

test('tree: root inexistente retorna erro', () => {
  assert.strictEqual(fa.tree('/caminho/que/nao/existe/xyz').ok, false);
  assert.strictEqual(fa.tree(null).ok, false);
});

test('readFile: arquivo pequeno volta em base64', () => {
  const root = mkroot();
  const r = fa.readFile(root, 'a.txt');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(Buffer.from(r.dataB64, 'base64').toString('utf8'), 'hello world');
  assert.strictEqual(r.mime, 'text/plain');
});

test('readFile: arquivo grande (>4MB) pede chunked', () => {
  const root = mkroot();
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 7));
  const r = fa.readFile(root, 'big.bin');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.chunked, true);
  assert.strictEqual(r.size, 5 * 1024 * 1024);
});

test('readFile: nega arquivo fora do projeto', () => {
  const root = mkroot();
  assert.strictEqual(fa.readFile(root, '../../etc/passwd').ok, false);
});

test('readChunk: lê pedaços e marca done no fim', () => {
  const root = mkroot();
  fs.writeFileSync(path.join(root, 'data.bin'), Buffer.from('ABCDEFGHIJ')); // 10 bytes
  const c1 = fa.readChunk(root, 'data.bin', 0, 4);
  assert.strictEqual(c1.ok, true);
  assert.strictEqual(Buffer.from(c1.dataB64, 'base64').toString(), 'ABCD');
  assert.strictEqual(c1.done, false);
  const c2 = fa.readChunk(root, 'data.bin', 4, 4);
  assert.strictEqual(Buffer.from(c2.dataB64, 'base64').toString(), 'EFGH');
  const c3 = fa.readChunk(root, 'data.bin', 8, 4);
  assert.strictEqual(Buffer.from(c3.dataB64, 'base64').toString(), 'IJ');
  assert.strictEqual(c3.done, true);
  // Reassembly (o que o client faz) reconstrói o arquivo inteiro.
  const joined = Buffer.concat([c1, c2, c3].map((c) => Buffer.from(c.dataB64, 'base64'))).toString();
  assert.strictEqual(joined, 'ABCDEFGHIJ');
});

test('guessMime: extensões comuns', () => {
  assert.strictEqual(fa.guessMime('x.md'), 'text/markdown');
  assert.strictEqual(fa.guessMime('x.png'), 'image/png');
  assert.strictEqual(fa.guessMime('x.desconhecido'), 'application/octet-stream');
});
