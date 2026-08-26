/**
 * Powers cross-engine: uma configuração, dois formatos nativos.
 *
 * O usuário configura MCPs e regras globais UMA vez no Maestrus; este módulo
 * compila isso pro formato que cada CLI realmente lê:
 *
 *   MCPs          Claude → .mcp.json (project-scoped, escrito por main.js)
 *                 Codex  → ~/.codex/config.toml, tabelas [mcp_servers.<nome>]
 *   Regras globais Claude → ~/.claude/CLAUDE.md
 *                 Codex  → ~/.codex/AGENTS.md
 *
 * Nem tudo tem par: Agents (subagentes) e Hooks são exclusivos do Claude, e
 * Skills não têm equivalente nativo no Codex. Em vez de fingir paridade, o
 * módulo declara a compatibilidade de cada tipo em POWER_SUPPORT — a UI usa
 * isso pra marcar cada item com o selo da(s) engine(s) onde ele vale.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Compatibilidade real de cada tipo de Power, por engine. */
const POWER_SUPPORT = {
  mcp:      { claude: 'native',  codex: 'native'  },
  rules:    { claude: 'native',  codex: 'native'  }, // CLAUDE.md ↔ AGENTS.md
  commands: { claude: 'native',  codex: 'compiled' }, // viram prompts do Codex
  skills:   { claude: 'native',  codex: 'partial' },  // sem carregamento sob demanda
  agents:   { claude: 'native',  codex: 'none'    },
  hooks:    { claude: 'native',  codex: 'none'    },
};

function codexDir() { return path.join(os.homedir(), '.codex'); }
function codexConfigPath() { return path.join(codexDir(), 'config.toml'); }
function codexAgentsPath() { return path.join(codexDir(), 'AGENTS.md'); }
function codexPromptsDir() { return path.join(codexDir(), 'prompts'); }

// ─── TOML ────────────────────────────────────────────────────────────────────
// Só o suficiente pra emitir tabelas [mcp_servers.*]: string, número, booleano
// e array de strings. Basta pro shape de um servidor MCP e evita uma dependência.
function tomlValue(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => tomlValue(x)).join(', ') + ']';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v)); // JSON escapa aspas/barras igual ao TOML básico
}

function mcpServerToToml(name, def) {
  const lines = [`[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}]`];
  if (def.command) lines.push(`command = ${tomlValue(def.command)}`);
  if (Array.isArray(def.args) && def.args.length) lines.push(`args = ${tomlValue(def.args)}`);
  if (def.env && Object.keys(def.env).length) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [k, val] of Object.entries(def.env)) lines.push(`${k} = ${tomlValue(val)}`);
  }
  return lines.join('\n');
}

const BEGIN = '# >>> maestrus:mcp >>>';
const END = '# <<< maestrus:mcp <<<';

/**
 * Escreve os servidores MCP no config.toml do Codex dentro de um bloco marcado,
 * preservando tudo que o usuário tenha configurado à mão fora dele.
 */
function writeCodexMcp(mcpServers) {
  const entries = Object.entries(mcpServers || {}).filter(([, d]) => d && d.command);
  const block = [BEGIN, '# Gerado pelo Maestrus. Edite os MCPs no app, não aqui.']
    .concat(entries.map(([n, d]) => mcpServerToToml(n, d)))
    .concat([END])
    .join('\n');

  let prev = '';
  try { prev = fs.readFileSync(codexConfigPath(), 'utf8'); } catch {}

  let next;
  if (prev.includes(BEGIN) && prev.includes(END)) {
    next = prev.slice(0, prev.indexOf(BEGIN)) + block + prev.slice(prev.indexOf(END) + END.length);
  } else {
    next = (prev.trimEnd() + '\n\n' + block + '\n').trimStart();
  }
  if (next === prev) return { ok: true, changed: false, count: entries.length };

  fs.mkdirSync(codexDir(), { recursive: true });
  fs.writeFileSync(codexConfigPath(), next.endsWith('\n') ? next : next + '\n', 'utf8');
  return { ok: true, changed: true, count: entries.length };
}

/** Espelha as regras globais no AGENTS.md, que é o que o Codex lê. */
function writeCodexRules(content) {
  const header = '<!-- Gerado pelo Maestrus a partir das Regras globais. -->\n\n';
  const body = header + String(content || '').trim() + '\n';
  try {
    if (fs.readFileSync(codexAgentsPath(), 'utf8') === body) return { ok: true, changed: false };
  } catch {}
  fs.mkdirSync(codexDir(), { recursive: true });
  fs.writeFileSync(codexAgentsPath(), body, 'utf8');
  return { ok: true, changed: true };
}

/**
 * Compila os comandos slash do Claude em prompts do Codex (um .md por comando).
 * Remove os que o Maestrus gerou e não existem mais, sem tocar nos do usuário.
 */
function writeCodexCommands(items) {
  const dir = codexPromptsDir();
  fs.mkdirSync(dir, { recursive: true });
  const tag = '<!-- maestrus -->';
  const wanted = new Map();
  for (const it of items || []) {
    if (!it || !it.id) continue;
    wanted.set(`${it.id}.md`, `${tag}\n${String(it.body || '').trim()}\n`);
  }
  let written = 0;
  for (const [file, body] of wanted) {
    const p = path.join(dir, file);
    let cur = null;
    try { cur = fs.readFileSync(p, 'utf8'); } catch {}
    if (cur === body) continue;
    if (cur !== null && !cur.startsWith(tag)) continue; // é do usuário, não sobrescreve
    fs.writeFileSync(p, body, 'utf8');
    written++;
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (wanted.has(f) || !f.endsWith('.md')) continue;
      const p = path.join(dir, f);
      if (fs.readFileSync(p, 'utf8').startsWith(tag)) fs.unlinkSync(p);
    }
  } catch {}
  return { ok: true, written, total: wanted.size };
}

/**
 * Ponto único chamado depois de qualquer alteração nos Powers. Best-effort: se
 * o Codex não está instalado (sem ~/.codex), não é erro, só não há o que fazer.
 */
function syncToCodex({ mcpServers, rules, commands } = {}) {
  const out = { mcp: null, rules: null, commands: null, errors: [] };
  const step = (name, fn) => {
    try { out[name] = fn(); }
    catch (e) { out.errors.push(`${name}: ${e && e.message}`); }
  };
  if (mcpServers) step('mcp', () => writeCodexMcp(mcpServers));
  if (typeof rules === 'string') step('rules', () => writeCodexRules(rules));
  if (commands) step('commands', () => writeCodexCommands(commands));
  return out;
}

module.exports = {
  POWER_SUPPORT,
  syncToCodex,
  writeCodexMcp,
  writeCodexRules,
  writeCodexCommands,
  codexConfigPath,
  codexAgentsPath,
  codexPromptsDir,
};
