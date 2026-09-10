// A atualizacao tem que vir do GitHub Releases, nao de um servidor proprio.
// Este teste existe porque o caminho do update rapido (asar) ja se perdeu uma
// vez: ao migrar a distribuicao para o GitHub, o passo que publicava o asar
// ficou para tras e o banner sumiu sem ninguem notar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

test('config expoe os endpoints do GitHub', () => {
  const c = require('./config');
  assert.match(c.GH_LATEST, /github\.com\/.+\/releases\/latest\/download/);
  assert.match(c.GH_API, /api\.github\.com\/repos\//);
});

test('o repo e parametrizavel: um fork distribui pelo proprio', () => {
  const src = fs.readFileSync(__dirname + '/config.js', 'utf8');
  assert.match(src, /MAESTRUS_GH_REPO/,
    'GH_REPO deve sair de env, senao todo fork continua atualizando pelo upstream');
});

test('o updater de asar consulta o GitHub antes do legado', () => {
  const src = fs.readFileSync(__dirname + '/asar-updater.js', 'utf8');
  const gh = src.indexOf('FEED_GH');
  const legacy = src.indexOf('FEED_LEGACY');
  assert.ok(gh > 0 && legacy > 0, 'os dois feeds devem existir');
  const check = src.slice(src.indexOf('async function checkForUpdate'));
  assert.ok(check.indexOf('FEED_GH') < check.indexOf('FEED_LEGACY'),
    'GitHub tem que ser tentado primeiro; o legado e so fallback');
});

test('o fetch do manifesto segue redirect', () => {
  const src = fs.readFileSync(__dirname + '/asar-updater.js', 'utf8');
  const fn = src.slice(src.indexOf('function httpJson'), src.indexOf('function downloadTo'));
  assert.match(fn, /30[1278]/,
    'GitHub responde 302 em todo asset: sem seguir redirect o manifesto nunca carrega');
});

test('o CI publica o asar e o manifesto de cada plataforma', () => {
  const wf = fs.readFileSync(__dirname + '/../.github/workflows/release.yml', 'utf8');
  assert.match(wf, /make-asar-manifest\.mjs/, 'o passo de gerar o asar sumiu do CI');
  for (const p of ['win', 'mac', 'linux']) {
    assert.ok(wf.includes(`app-${p}.asar`), `app-${p}.asar nao vai para a release`);
    assert.ok(wf.includes(`asar-${p}.json`), `asar-${p}.json nao vai para a release`);
  }
});

test('o nome do asset pedido pelo updater E o nome que o CI publica', () => {
  // Esta divergencia ja aconteceu: o CI publicava asar-mac.json e o updater
  // pedia asar-mac-arm64.json → 404 silencioso → todo update virava .dmg.
  // Os dois lados saem de arquivos diferentes; este teste os amarra.
  const updater = fs.readFileSync(__dirname + '/asar-updater.js', 'utf8');
  const maker = fs.readFileSync(__dirname + '/../scripts/make-asar-manifest.mjs', 'utf8');
  // O gerador nomeia por SO: asar-<win|mac|linux>.json
  assert.match(maker, /asar-\$\{plat\}\.json/);
  assert.match(maker, /\{ win32: 'win', darwin: 'mac' \}/);
  // O updater precisa pedir exatamente esses nomes
  for (const asset of ["'asar-mac.json'", "'asar-win.json'", "'asar-linux.json'"]) {
    assert.ok(updater.includes(asset), `updater nao pede ${asset}`);
  }
  // E o fetch do manifesto tem que usar feedAsset(), nao o platformKey de arch
  const check = updater.slice(updater.indexOf('async function checkForUpdate'));
  assert.ok(/FEED_GH\}\/\$\{feedAsset\(\)\}/.test(check),
    'o fetch no GitHub deve usar feedAsset() — platformKey() e so do feed legado');
});
