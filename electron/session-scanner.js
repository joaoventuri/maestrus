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

const MAX_PARSE_BYTES = 25 * 1024 * 1024;

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

function parseSession(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = raw.split(/\r?\n/);
  let cwd = null, firstUser = null, count = 0, gitBranch = null;
  const okText = (txt) => txt && !txt.startsWith('<') && !txt.startsWith('Caveat:') && !/^This session is being continued/i.test(txt);
  for (const line of lines) {
    if (!line.trim()) continue;
    count++;
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
  return { cwd, firstUser, messages: count, gitBranch };
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
      const meta = st.size <= MAX_PARSE_BYTES ? parseSession(fpath) : { cwd: null, firstUser: null, messages: 0, gitBranch: null };
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

module.exports = { list, importSession };
