// Gera o par do update rápido para a plataforma atual:
//   dist-app/app-<plat>.asar   — o bundle de código
//   dist-app/asar-<plat>.json  — manifesto que o app lê no GitHub Releases
//
// O update rápido troca só o app.asar (~40 MB) em vez do instalador inteiro
// (~330 MB), e é o único caminho que funciona no macOS sem certificado
// Developer ID — o Squirrel recusa pacote não assinado, este não passa por ele.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const electronVer = JSON.parse(fs.readFileSync('node_modules/electron/package.json', 'utf8')).version;
const plat = { win32: 'win', darwin: 'mac' }[process.platform] || 'linux';
const DIST = 'dist-app';

// Acha o app.asar dentro do bundle que o electron-builder acabou de gerar.
function findAsar(dir, depth = 0) {
  if (depth > 6) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === 'app.asar') return p;
    if (e.isDirectory() && !e.name.endsWith('.asar')) {
      const found = findAsar(p, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const src = findAsar(DIST);
if (!src) {
  console.error(`::error::app.asar não encontrado em ${DIST}/ — o build gerou algo?`);
  process.exit(1);
}

const out = path.join(DIST, `app-${plat}.asar`);
fs.copyFileSync(src, out);
const buf = fs.readFileSync(out);
const manifest = {
  version: pkg.version,
  electron: electronVer,
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  size: buf.length,
  url: `https://github.com/${process.env.GH_REPO || 'joaoventuri/maestrus'}/releases/download/v${pkg.version}/app-${plat}.asar`,
};
fs.writeFileSync(path.join(DIST, `asar-${plat}.json`), JSON.stringify(manifest, null, 2));
console.log(`asar-${plat}.json`, JSON.stringify(manifest));
