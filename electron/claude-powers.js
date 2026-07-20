'use strict';
// Claude Powers — gestão dos "superpoderes" do Claude Code no host:
//   • Agents (subagentes)  ~/.claude/agents/*.md    (frontmatter name/description)
//   • Comandos (slash)     ~/.claude/commands/*.md  (viram /nome no CLI)
//   • Regras globais       ~/.claude/CLAUDE.md      (valem pra TODOS os projetos)
// Skills têm store próprio (skills-store.js + user_skills na conta) e MCPs têm
// o mcp.js — este módulo cobre o resto do ecossistema gerenciável por arquivo.
// Consumido por IPC (desktop) e por RPC via relay (web/PWA gerenciam o host).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const skillsStore = require('./skills-store');
const cloud = require('./cloud');
let runtime = null; try { runtime = require('./runtime'); } catch {}
let requirements = null; try { requirements = require('./requirements'); } catch {}
let claudeProfiles = null; try { claudeProfiles = require('./claude-profiles'); } catch {}

function baseDir() { return path.join(os.homedir(), '.claude'); }
function agentsDir() { return path.join(baseDir(), 'agents'); }
function commandsDir() { return path.join(baseDir(), 'commands'); }
function globalMdPath() { return path.join(baseDir(), 'CLAUDE.md'); }

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

// Frontmatter simples (name/description) — mesmo formato dos agents do Claude Code.
function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(md || ''));
  if (!m) return { meta: {}, body: String(md || '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: m[2] };
}

function listDir(dir, kind) {
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        out.push({
          id: f.replace(/\.md$/, ''),
          name: meta.name || f.replace(/\.md$/, ''),
          description: meta.description || body.trim().split('\n')[0].slice(0, 120),
          updatedAt: fs.statSync(path.join(dir, f)).mtimeMs,
          kind,
        });
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function getItem(dir, id) {
  const safe = slugify(id);
  const p = path.join(dir, safe + '.md');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return { ok: true, id: safe, name: meta.name || safe, description: meta.description || '', body };
  } catch { return { ok: false, error: 'not_found' }; }
}

function saveItem(dir, { id, name, description, body }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const safe = slugify(id || name);
    if (!safe) return { ok: false, error: 'invalid_name' };
    const md = `---\nname: ${String(name || safe).replace(/\n/g, ' ')}\ndescription: ${String(description || '').replace(/\n/g, ' ')}\n---\n\n${String(body || '').trim()}\n`;
    fs.writeFileSync(path.join(dir, safe + '.md'), md, 'utf8');
    return { ok: true, id: safe };
  } catch (e) { return { ok: false, error: e.message }; }
}

function removeItem(dir, id) {
  try {
    const safe = slugify(id);
    fs.unlinkSync(path.join(dir, safe + '.md'));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─── API pública ─────────────────────────────────────────────────────────────
const agents = {
  list: () => ({ ok: true, items: listDir(agentsDir(), 'agent') }),
  get: (id) => getItem(agentsDir(), id),
  save: (def) => saveItem(agentsDir(), def || {}),
  remove: (id) => removeItem(agentsDir(), id),
};

const commands = {
  list: () => ({ ok: true, items: listDir(commandsDir(), 'command') }),
  get: (id) => getItem(commandsDir(), id),
  save: (def) => saveItem(commandsDir(), def || {}),
  remove: (id) => removeItem(commandsDir(), id),
};

const globalMd = {
  get: () => {
    try { return { ok: true, content: fs.readFileSync(globalMdPath(), 'utf8') }; }
    catch { return { ok: true, content: '' }; }
  },
  set: (content) => {
    try {
      fs.mkdirSync(baseDir(), { recursive: true });
      fs.writeFileSync(globalMdPath(), String(content || ''), 'utf8');
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};

// ─── Skills — FONTE DA VERDADE: ~/.claude/skills (o que o CLI realmente usa) ─
// Mostra TUDO que o Claude tem: skills locais/instaladas (npx skills add, à mão)
// + as da conta Maestrus (materializadas, com badge "sincronizada"). Salvar uma
// skill da conta atualiza o banco (sync entre devices); salvar uma local
// escreve direto no arquivo.
function cloudManagedIds() {
  try { return JSON.parse(fs.readFileSync(path.join(skillsStore.skillsDir(), '.maestrus-cloud.json'), 'utf8')) || []; }
  catch { return []; }
}

async function refreshCloudSkills() {
  try {
    if (!cloud.getAccount()) return;
    const r = await cloud.userApi('user_skills', { op: 'list' });
    if (r && r.ok) skillsStore.materialize((r.skills || []).map((s) => ({ name: s.name, description: s.description, body: s.body })));
  } catch {}
}

const skills = {
  list: async () => {
    await refreshCloudSkills();                       // nuvem → arquivos (best-effort)
    const managed = cloudManagedIds();
    const r = skillsStore.list();
    return { ok: true, skills: (r.skills || []).map((s) => ({ ...s, cloud: managed.includes(s.id) })) };
  },
  get: async (id) => {
    const s = skillsStore.get(id);
    if (s) return { ok: true, ...s, cloud: cloudManagedIds().includes(id) };
    return { ok: false, error: 'not_found' };
  },
  save: async (def) => {
    const d = def || {};
    const managed = cloudManagedIds();
    const isCloud = d.id && managed.includes(d.id);
    const isLocalExisting = d.id && !isCloud && !!skillsStore.get(d.id);
    if (isLocalExisting || !cloud.getAccount()) {
      // skill puramente local (ou sem conta): o arquivo é a verdade
      try { return skillsStore.save({ id: isLocalExisting ? d.id : undefined, name: d.name, description: d.description, body: d.body }); }
      catch (e) { return { ok: false, error: e && e.message }; }
    }
    // nova ou da conta → banco (sync entre devices) + materializa em arquivo
    let skillId = 'sk_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
    if (isCloud) {
      try {
        const r = await cloud.userApi('user_skills', { op: 'list' });
        const hit = (r.skills || []).find((x) => slugify(x.name || '') === d.id);
        if (hit) skillId = hit.skill_id;
      } catch {}
    }
    const r = await cloud.userApi('user_skills', { op: 'save', skill_id: skillId, name: d.name, description: d.description, body: d.body, enabled: true });
    await refreshCloudSkills();
    return r && r.ok ? { ok: true, id: slugify(d.name) } : { ok: false, error: (r && r.error) || 'save_failed' };
  },
  remove: async (id) => {
    const managed = cloudManagedIds();
    if (managed.includes(id) && cloud.getAccount()) {
      // skill da conta: apaga no banco (some de todos os devices) + rematerializa
      try {
        const r = await cloud.userApi('user_skills', { op: 'list' });
        const hit = (r.skills || []).find((x) => slugify(x.name || '') === id);
        if (hit) await cloud.userApi('user_skills', { op: 'delete', skill_id: hit.skill_id });
      } catch {}
      await refreshCloudSkills();
      return { ok: true };
    }
    return skillsStore.remove(id);
  },
};

// ─── MCPs JÁ conectados no Claude (fonte: o próprio CLI) ────────────────────
// `claude mcp list` mostra exatamente o que o Claude Code enxerga — incluindo
// servers adicionados fora do Maestrus. Remove via `claude mcp remove`.
function claudeBinSync() {
  try { const b = runtime && runtime.claudeBin(); if (b) return b; } catch {}
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}

function runClaude(args, timeoutMs = 45000) {
  return new Promise(async (resolve) => {
    const env = { ...process.env };
    try { const p = requirements && await requirements.shellPath(); if (p) env.PATH = p; } catch {}
    try { if (claudeProfiles) Object.assign(env, claudeProfiles.envVars()); } catch {}
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_BASE_URL; delete env.ANTHROPIC_AUTH_TOKEN;
    let proc;
    const bin = claudeBinSync();
    try { proc = spawn(bin, args, { stdio: 'pipe', env, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) }); }
    catch (e) { return resolve({ ok: false, error: e.message, out: '' }); }
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (out += d.toString()));
    proc.on('close', (code) => resolve({ ok: code === 0, code, out }));
    proc.on('error', (e) => resolve({ ok: false, error: e.message, out }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, error: 'timeout', out }); }, timeoutMs);
  });
}

const mcp = {
  list: async () => {
    const r = await runClaude(['mcp', 'list'], 60000);
    if (!r.ok && !r.out) return { ok: false, error: r.error || 'mcp_list_failed' };
    // Formato por linha: "nome: comando/url - ✔ Connected" (nome PODE ter
    // espaços, ex: "claude.ai GoDaddy"; status pode ser "! Needs authentication").
    const items = [];
    for (const line of String(r.out).split('\n')) {
      const l = line.trim();
      if (!l || /^checking|^health|^no mcp/i.test(l)) continue;
      const m = /^(.+?):\s+(.+)$/.exec(l);
      if (!m) continue;
      let rest = m[2];
      let status = null;
      const st = /\s[-–]\s*([✓✔✗✘!].*)$/.exec(rest);
      if (st) { status = st[1].trim(); rest = rest.slice(0, st.index).trim(); }
      items.push({ name: m[1].trim(), target: rest, status, connected: status ? /[✓✔]/.test(status) : null });
    }
    return { ok: true, items, raw: r.out.slice(0, 4000) };
  },
  remove: async (name) => {
    const safe = String(name || '').trim();
    if (!/^[\w@.\/-]+$/.test(safe)) return { ok: false, error: 'invalid_name' };
    const r = await runClaude(['mcp', 'remove', safe], 30000);
    return { ok: r.ok, error: r.ok ? undefined : (r.error || r.out.slice(-200)) };
  },
};

module.exports = { agents, commands, globalMd, skills, mcp };
