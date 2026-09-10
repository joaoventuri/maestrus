// Descobre os modelos que o Claude CLI INSTALADO conhece — lendo o binário.
//
// Não existe `claude models list`: a lista vive hardcoded dentro do executável
// e muda a cada release do CLI. Manter uma cópia curada no Maestrus significa
// ficar para trás toda vez que a Anthropic lança modelo — foi exatamente o que
// aconteceu com o Fable 5.1. Então a fonte da verdade passa a ser o próprio
// binário: extraímos os ids `claude-<família>-<versão>` por regex e o picker se
// alimenta deles. CLI atualizado = lista atualizada, sem release do Maestrus.
//
// O que fica de fora, de propósito:
//  - datados (claude-opus-4-5-20251101) e `-v1`: são a MESMA versão com outro
//    rótulo (Bedrock/Vertex) — só duplicariam o menu.
//  - `-fast` e `mythos`: variantes que o plano comum não seleciona por --model.
//  - minor absurdo (ex.: "sonnet-4-51", fragmento de string vizinha no binário).
const fs = require('fs');

const ID_RE = /claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?![\d\w-])/g;

/** Extrai ids canônicos de um Buffer (exposto separado pra teste). */
function extractIds(buf) {
  const text = buf.toString('latin1');
  const out = new Set();
  let m;
  while ((m = ID_RE.exec(text))) {
    const major = Number(m[2]);
    const minor = m[3] === undefined ? null : Number(m[3]);
    // Sanidade: major 4..19, minor 0..15. Fora disso é lixo de string vizinha.
    if (major < 4 || major > 19) continue;
    if (minor !== null && minor > 15) continue;
    out.add(minor === null ? `claude-${m[1]}-${major}` : `claude-${m[1]}-${major}-${minor}`);
  }
  return [...out];
}

/**
 * Varre o binário em blocos de 8MB com sobreposição (um id não pode se perder
 * por cair na fronteira de dois blocos). O arquivo tem ~200MB; isso roda uma
 * vez por versão do CLI e o resultado fica cacheado por (tamanho, mtime).
 */
function scanFile(binPath) {
  const BLOCK = 8 * 1024 * 1024;
  const OVERLAP = 64;
  const fd = fs.openSync(binPath, 'r');
  const ids = new Set();
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(BLOCK + OVERLAP);
    for (let pos = 0; pos < size; pos += BLOCK) {
      const len = fs.readSync(fd, buf, 0, Math.min(BLOCK + OVERLAP, size - pos), pos);
      for (const id of extractIds(buf.subarray(0, len))) ids.add(id);
    }
  } finally { fs.closeSync(fd); }
  return [...ids].sort();
}

let _cache = null;   // { key, ids }

/**
 * Lista os modelos do CLI em `binPath`, com cache por identidade do arquivo.
 * Erros viram lista vazia — o picker sempre tem o registro curado como base,
 * então descoberta nenhuma é degradação, não quebra.
 */
function discover(binPath) {
  try {
    if (!binPath || !fs.existsSync(binPath)) return [];
    const st = fs.statSync(binPath);
    const key = `${binPath}:${st.size}:${st.mtimeMs}`;
    if (_cache && _cache.key === key) return _cache.ids;
    const ids = scanFile(binPath);
    _cache = { key, ids };
    return ids;
  } catch { return []; }
}

module.exports = { discover, extractIds, scanFile };
