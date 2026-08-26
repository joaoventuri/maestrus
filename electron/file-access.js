// Acesso a arquivos do WORKSPACE de um projeto — usado pelo host (remote-host.js,
// via RPC de um client remoto) E pelo main (projeto local). Uma fonte só = a
// mesma resolução SEGURA de path (nunca escapa do codeDir) nos dois caminhos.
const fs = require('fs');
const path = require('path');

// Diretórios pesados/irrelevantes que não entram na árvore.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-app', 'dist-renderer', 'dist-web',
  'dist-mobile', '.next', 'build', 'vendor', '.cache', '.turbo', 'coverage',
]);

const MIME_BY_EXT = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.jsx': 'text/javascript', '.css': 'text/css', '.scss': 'text/css', '.html': 'text/html',
  '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go', '.rs': 'text/x-rust',
  '.java': 'text/x-java', '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c', '.php': 'text/x-php',
  '.sh': 'text/x-sh', '.yml': 'text/yaml', '.yaml': 'text/yaml', '.toml': 'text/plain', '.ini': 'text/plain',
  '.csv': 'text/csv', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

function guessMime(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Resolve um path RELATIVO com segurança DENTRO de `root`. Retorna o path
// absoluto ou null. Defesa em DUAS camadas (as duas têm que passar):
//   1) lexical  → bloqueia path traversal (../, absoluto pra fora);
//   2) realpath → bloqueia symlink que aponte pra fora (o furo que o teste pegou:
//      antes o fallback lexical liberava mesmo quando o realpath saía do root).
function resolveInProject(root, rel) {
  try {
    if (!root || !fs.existsSync(root)) return null;
    const clean = String(rel || '').replace(/^[\/]+/, '');
    if (!clean) return root;
    const full = path.resolve(root, clean);
    // 1) Lexical: full precisa estar dentro do root.
    const rootAbs = path.resolve(root);
    const lexSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
    if (full !== rootAbs && !full.startsWith(lexSep)) return null;
    // 2) Se existe, o caminho REAL (resolvendo symlinks) também tem que estar
    //    dentro do root real — senão é escape por symlink.
    if (fs.existsSync(full)) {
      const real = fs.realpathSync(full);
      const rootReal = fs.realpathSync(root);
      const realSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
      if (real !== rootReal && !real.startsWith(realSep)) return null;
    }
    return full;
  } catch { return null; }
}

// Árvore do workspace (rel paths seguros). { ok, root, files:[{rel,dir,size,mime}], truncated }
function tree(root, sub) {
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'no_workspace' };
  const MAX = 4000; const out = []; let count = 0; let truncated = false;
  const start = sub ? resolveInProject(root, sub) : root;
  if (!start) return { ok: false, error: 'bad_path' };
  const walk = (dir, depth) => {
    if (truncated || depth > 8) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (count >= MAX) { truncated = true; return; }
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.maestrus')) continue;
        out.push({ rel, dir: true }); count++;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0; try { size = fs.statSync(full).size; } catch {}
        out.push({ rel, dir: false, size, mime: guessMime(e.name) }); count++;
      }
    }
  };
  walk(start, 0);
  return { ok: true, root: path.basename(root), files: out, truncated };
}

const INLINE_MAX = 4 * 1024 * 1024; // acima disso → readChunk

// Lê um arquivo inteiro em base64 (pequeno). { ok, rel, size, mime, dataB64 } | { ok:false, chunked }
function readFile(root, rel) {
  const full = resolveInProject(root, rel);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, error: 'not_found' };
  const size = fs.statSync(full).size;
  if (size > INLINE_MAX) return { ok: false, error: 'too_big', size, chunked: true };
  const buf = fs.readFileSync(full);
  return { ok: true, rel, size, mime: guessMime(full), dataB64: buf.toString('base64') };
}

// Lê um PEDAÇO (offset/length) em base64 — download chunked p/ caber no relay.
function readChunk(root, rel, offset, length) {
  const full = resolveInProject(root, rel);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, error: 'not_found' };
  const size = fs.statSync(full).size;
  const off = Math.max(0, offset | 0);
  const len = Math.min((length | 0) || (2 * 1024 * 1024), size - off);
  const fd = fs.openSync(full, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, len));
    const read = len > 0 ? fs.readSync(fd, buf, 0, len, off) : 0;
    return { ok: true, rel, size, offset: off, read, done: off + read >= size, mime: guessMime(full), dataB64: buf.subarray(0, read).toString('base64') };
  } finally { fs.closeSync(fd); }
}

module.exports = { guessMime, resolveInProject, tree, readFile, readChunk, INLINE_MAX, SKIP_DIRS };
