// Lê as sessões do Claude Code local (~/.claude/projects/<cwd-encoded>/*.jsonl)
// e enriquece com o TÍTULO real do Claude Desktop (gerado automaticamente, o
// mesmo que aparece na lista de conversas), que fica em
//   <Claude>/claude-code-sessions/<user>/<org>/local_*.json  → { cliSessionId, title, ... }
// Casamos cliSessionId (= nome do .jsonl) com o título.
// Importa uma sessão como projeto do Maestrus (codeDir = cwd real da sessão).

const fs = require('fs');
const os = require('os');
const path = require('path');
const projectStore = require('./project-store');


function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Diretórios onde o Claude Desktop guarda os metadados/títulos das sessões.
function desktopSessionDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(roaming, 'Claude', 'claude-code-sessions'));
    dirs.push(path.join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'));
  } else {
    dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude-code-sessions'));
  }
  return dirs;
}

// Mapa cliSessionId → { title, branch, worktreeName, archived, lastActivityAt }.
// Em duplicata (Roaming + UWP), mantém o mais recente.
function loadTitleMap() {
  const map = new Map();
  const stack = desktopSessionDirs().filter((d) => fs.existsSync(d));
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile() || !/^local_.*\.json$/i.test(ent.name)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      const cli = j.cliSessionId;
      if (!cli) continue;
      const prev = map.get(cli);
      const at = j.lastActivityAt || j.lastFocusedAt || j.createdAt || 0;
      if (prev && (prev._at || 0) >= at) continue;
      map.set(cli, {
        title: typeof j.title === 'string' ? j.title.trim() : null,
        branch: j.branch || null,
        worktreeName: j.worktreeName || null,
        archived: !!j.isArchived,
        _at: at,
      });
    }
  }
  return map;
}

// Conta linhas (eventos) sem carregar o arquivo na memória — seguro pra sessões
// gigantes (conversas longas passam fácil de 25MB).
function countLines(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1 << 20); // 1MB por chunk
    let n = 0, read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i++) if (buf[i] === 10) n++;
    }
    fs.closeSync(fd);
    return n;
  } catch { return 0; }
}

// Metadados (cwd, gitBranch, 1º prompt) ficam nas PRIMEIRAS linhas — lemos só o
// HEAD, independente do tamanho do arquivo. Antes, sessões > 25MB eram puladas
// por inteiro (cwd=null → import desabilitado; messages=0). Agora nunca pulamos.
const HEAD_BYTES = 2 * 1024 * 1024;
function parseSession(file, size) {
  let head;
  try {
    if (size <= HEAD_BYTES) {
      head = fs.readFileSync(file, 'utf8');
    } else {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      fs.closeSync(fd);
      head = buf.toString('utf8', 0, read);
      const nl = head.lastIndexOf('\n'); // descarta a última linha cortada
      if (nl > 0) head = head.slice(0, nl);
    }
  } catch { return null; }
  const lines = head.split(/\r?\n/);
  let cwd = null, firstUser = null, gitBranch = null, headCount = 0;
  const okText = (txt) => txt && !txt.startsWith('<') && !txt.startsWith('Caveat:') && !/^This session is being continued/i.test(txt);
  for (const line of lines) {
    if (!line.trim()) continue;
    headCount++;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!gitBranch && e.gitBranch) gitBranch = e.gitBranch;
    if (!firstUser && e.type === 'queue-operation' && typeof e.content === 'string' && okText(e.content.trim())) {
      firstUser = e.content.trim();
    }
    if (!firstUser && e.type === 'user' && e.message && !e.isCompactSummary) {
      const c = e.message.content;
      const txt = (typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b && b.type === 'text')?.text || '') : '').trim();
      if (okText(txt)) firstUser = txt;
    }
  }
  // Contagem real: se coube no HEAD, já temos; senão conta o arquivo todo (stream).
  const messages = size <= HEAD_BYTES ? headCount : countLines(file);
  return { cwd, firstUser, messages, gitBranch };
}

function list() {
  const root = projectsRoot();
  const titles = loadTitleMap();
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return { ok: true, sessions: [] }; }
  for (const dir of dirs) {
    const dpath = path.join(root, dir);
    let files;
    try { if (!fs.statSync(dpath).isDirectory()) continue; files = fs.readdirSync(dpath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fpath = path.join(dpath, f);
      let st;
      try { st = fs.statSync(fpath); } catch { continue; }
      if (st.size < 100) continue;
      const sessionId = f.replace(/\.jsonl$/, '');
      const meta = parseSession(fpath, st.size);
      if (!meta) continue;
      const t = titles.get(sessionId);
      // Título do Claude (auto) tem prioridade; senão o 1º prompt; senão a pasta.
      let name = (t && t.title) || meta.firstUser || (meta.cwd ? path.basename(meta.cwd) : sessionId);
      name = String(name).replace(/\s+/g, ' ').trim().slice(0, 100);
      out.push({
        sessionId,
        name,
        cwd: meta.cwd,
        branch: (t && t.branch) || meta.gitBranch || null,
        archived: !!(t && t.archived),
        hasTitle: !!(t && t.title),
        messages: meta.messages,
        sizeBytes: st.size,
        modified: st.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.modified - a.modified);
  return { ok: true, sessions: out };
}

// Importa uma sessão como projeto do Maestrus (codeDir = cwd real da sessão).
function importSession({ sessionId, cwd, name }) {
  if (!sessionId) throw new Error('sessionId obrigatório');
  if (!cwd || !fs.existsSync(cwd)) throw new Error('pasta da sessão (cwd) não encontrada: ' + cwd);

  const existing = projectStore.list().find((p) => p.codeDir === cwd && p.sessionId === sessionId);
  if (existing) return existing;

  const draft = projectStore.createDraft({
    name: (name || path.basename(cwd)).slice(0, 100),
    source: 'local',
    localPath: cwd,
  });
  draft.codeDir = cwd;
  draft.sessionId = sessionId;
  projectStore.save(draft);
  return draft;
}

// Descobre a URL do repositório git de uma sessão (pra clonar num host remoto
// na importação). Read-only; retorna null se não for um repo git.
function gitRemote(cwd) {
  if (!cwd) return null;
  try {
    const cp = require('child_process');
    const out = cp.execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000,
    }).toString().trim();
    return out || null;
  } catch { return null; }
}

// Caminho do .jsonl LOCAL de uma sessão (pra fazer upload pro host). Mesma
// codificação do Claude Code / claude-pty: cwd → [^A-Za-z0-9] vira '-'.
function sessionFilePath(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const enc = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const p = path.join(projectsRoot(), enc, sessionId + '.jsonl');
  return fs.existsSync(p) ? p : null;
}

module.exports = { list, importSession, gitRemote, sessionFilePath };
