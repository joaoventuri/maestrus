'use strict';
// Gerenciador de Skills do Claude. Skills são pastas com um SKILL.md (frontmatter
// name + description) que o Claude Code descobre sozinho. O Maestrus usa o
// ~/.claude real do usuário (não sobrescreve HOME), então skills em
// ~/.claude/skills/ valem em TODA sessão de TODO projeto automaticamente.
//
// Este módulo é um CRUD simples sobre essa pasta: listar, ler, salvar e excluir
// skills, com um parser/serializer de frontmatter minimalista.

const fs = require('fs');
const os = require('os');
const path = require('path');

function skillsDir() { return path.join(os.homedir(), '.claude', 'skills'); }
function ensureDir() { try { fs.mkdirSync(skillsDir(), { recursive: true }); } catch {} }

function slug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';
}

// Parser de frontmatter YAML minimalista: só pega name e description (string).
function parseSkill(md) {
  const out = { name: '', description: '', body: String(md || '') };
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md || '');
  if (m) {
    const fm = m[1];
    out.body = m[2] || '';
    for (const line of fm.split('\n')) {
      const kv = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (kv[1] === 'name') out.name = v;
      else if (kv[1] === 'description') out.description = v;
    }
  }
  return out;
}

function serializeSkill({ name, description, body }) {
  // description numa linha só; aspas se tiver dois-pontos pra não quebrar o YAML.
  const desc = String(description || '').replace(/\n/g, ' ').trim();
  const descOut = /[:#]/.test(desc) ? JSON.stringify(desc) : desc;
  const nm = String(name || '').replace(/\n/g, ' ').trim();
  const nmOut = /[:#]/.test(nm) ? JSON.stringify(nm) : nm;
  return `---\nname: ${nmOut}\ndescription: ${descOut}\n---\n\n${String(body || '').trimStart()}`;
}

function readSkillFile(dir) {
  // aceita SKILL.md ou skill.md
  for (const fn of ['SKILL.md', 'skill.md']) {
    const p = path.join(dir, fn);
    if (fs.existsSync(p)) { try { return { path: p, md: fs.readFileSync(p, 'utf8') }; } catch {} }
  }
  return null;
}

function list() {
  ensureDir();
  const root = skillsDir();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { skills: [] }; }
  const skills = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const f = readSkillFile(dir);
    if (!f) continue;
    const p = parseSkill(f.md);
    skills.push({ id: e.name, name: p.name || e.name, description: p.description, hasBody: !!p.body.trim() });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills };
}

function get(id) {
  const dir = path.join(skillsDir(), id);
  const f = readSkillFile(dir);
  if (!f) return null;
  const p = parseSkill(f.md);
  return { id, name: p.name || id, description: p.description, body: p.body };
}

// save({ id?, name, description, body }). Sem id → cria (slug do name). Com id
// → atualiza no mesmo diretório (mantém o id estável mesmo que o name mude).
function save({ id, name, description, body }) {
  ensureDir();
  if (!name || !String(name).trim()) throw new Error('name é obrigatório');
  let dirName = id;
  if (!dirName) {
    dirName = slug(name);
    // evita colisão se já existir
    let base = dirName, n = 2;
    while (fs.existsSync(path.join(skillsDir(), dirName))) { dirName = `${base}-${n++}`; }
  }
  const dir = path.join(skillsDir(), dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), serializeSkill({ name, description, body }), 'utf8');
  return { ok: true, id: dirName };
}

function remove(id) {
  const dir = path.join(skillsDir(), id);
  // segurança: só apaga se for mesmo uma skill (tem SKILL.md) e estiver dentro da pasta
  if (!readSkillFile(dir)) return { ok: false, error: 'not_a_skill' };
  const root = path.resolve(skillsDir());
  if (!path.resolve(dir).startsWith(root + path.sep)) return { ok: false, error: 'out_of_bounds' };
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

// Materializa as Skills da NUVEM em ~/.claude/skills (pro Claude CLI local usar).
// Fonte da verdade = nuvem. Escreve cada uma por slug e remove só as que ELE
// mesmo criou antes (manifesto) — nunca toca em skills puramente locais.
function materialize(skills) {
  ensureDir();
  const manifestPath = path.join(skillsDir(), '.maestrus-cloud.json');
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) || []; } catch {}
  const now = [];
  for (const s of (skills || [])) {
    if (!s || !s.name) continue;
    const dirName = slug(s.name);
    const dir = path.join(skillsDir(), dirName);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), serializeSkill({ name: s.name, description: s.description, body: s.body }), 'utf8');
      now.push(dirName);
    } catch {}
  }
  // remove as cloud-managed antigas que sumiram (sem tocar nas locais)
  for (const old of prev) {
    if (now.includes(old)) continue;
    const dir = path.join(skillsDir(), old);
    if (path.resolve(dir).startsWith(path.resolve(skillsDir()) + path.sep)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
  try { fs.writeFileSync(manifestPath, JSON.stringify(now), 'utf8'); } catch {}
  return { ok: true, count: now.length };
}

module.exports = { list, get, save, remove, skillsDir, materialize };
