const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const https = require('https');
const { execFileSync } = require('child_process');
let claudeProfiles = null;
try { claudeProfiles = require('./claude-profiles'); } catch {}

// ─── Uso REAL da conta Claude (mesmo dado do /usage do Claude Code) ─────────
// GET api.anthropic.com/api/oauth/usage com o token OAuth da conta ativa.
// Retorna as cotas oficiais: sessão (5h), semanal geral e semanal por modelo,
// com percentual, severidade e horário de reset — sem estimativa local.

function readOauthCreds() {
  // 1) arquivo .credentials.json do PERFIL ATIVO (multi-conta) ou do ~/.claude
  const dirs = [];
  try {
    const d = claudeProfiles && claudeProfiles.configDir(claudeProfiles.getActive());
    if (d) dirs.push(d);
  } catch {}
  dirs.push(path.join(os.homedir(), '.claude'));
  for (const d of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, '.credentials.json'), 'utf8'));
      if (j && j.claudeAiOauth && j.claudeAiOauth.accessToken) return j.claudeAiOauth;
    } catch {}
  }
  // 2) macOS guarda no Keychain
  if (process.platform === 'darwin') {
    try {
      const blob = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 8000 }).trim();
      const j = JSON.parse(blob);
      if (j && j.claudeAiOauth && j.claudeAiOauth.accessToken) return j.claudeAiOauth;
    } catch {}
  }
  return null;
}

const LIMIT_LABELS = {
  session: 'Sessão atual (janela de 5h)',
  weekly_all: 'Semana — todos os modelos',
  weekly_scoped: 'Semana',
};

function real() {
  return new Promise((resolve) => {
    const creds = readOauthCreds();
    if (!creds) return resolve({ ok: false, real: true, error: 'no_credentials' });
    const req = https.get('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': 'Bearer ' + creds.accessToken,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return resolve({ ok: false, real: true, error: 'auth_expired' });
        if (res.statusCode !== 200) return resolve({ ok: false, real: true, error: 'http_' + res.statusCode });
        let j;
        try { j = JSON.parse(data); } catch { return resolve({ ok: false, real: true, error: 'bad_response' }); }
        // `limits` é a fonte normalizada (o próprio Claude Code renderiza dela).
        let limits = Array.isArray(j.limits) ? j.limits.map((l) => ({
          kind: l.kind,
          group: l.group,
          label: (l.scope && l.scope.model && l.scope.model.display_name)
            ? `${LIMIT_LABELS.weekly_scoped} — ${l.scope.model.display_name}`
            : (LIMIT_LABELS[l.kind] || l.kind),
          percent: typeof l.percent === 'number' ? l.percent : null,
          severity: l.severity || 'normal',
          resetsAt: l.resets_at || null,
          active: !!l.is_active,
        })) : [];
        // Fallback pra formatos antigos do endpoint.
        if (limits.length === 0) {
          if (j.five_hour) limits.push({ kind: 'session', label: LIMIT_LABELS.session, percent: j.five_hour.utilization ?? null, severity: 'normal', resetsAt: j.five_hour.resets_at || null, active: false });
          if (j.seven_day) limits.push({ kind: 'weekly_all', label: LIMIT_LABELS.weekly_all, percent: j.seven_day.utilization ?? null, severity: 'normal', resetsAt: j.seven_day.resets_at || null, active: false });
        }
        const extra = j.extra_usage && j.extra_usage.is_enabled ? {
          utilization: j.extra_usage.utilization, usedCredits: j.extra_usage.used_credits, monthlyLimit: j.extra_usage.monthly_limit,
        } : null;
        resolve({ ok: true, real: true, limits, extra, fetchedAt: Date.now() });
      });
    });
    req.on('error', (e) => resolve({ ok: false, real: true, error: 'network: ' + e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, real: true, error: 'timeout' }); });
  });
}

// Preço aproximado por 1M tokens (USD). Fonte: anthropic.com/pricing (família Claude 4.x).
const PRICING = {
  'claude-opus-4-7': { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4-6': { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4-1': { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { in: 0.8, out: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-3-5-sonnet': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { in: 0.8, out: 4, cacheRead: 0.08, cacheWrite: 1 },
};
const DEFAULT_PRICE = PRICING['claude-sonnet-4-5'];
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function priceForModel(model) {
  if (!model) return DEFAULT_PRICE;
  const lower = model.toLowerCase();
  for (const key of Object.keys(PRICING)) {
    if (lower.startsWith(key)) return PRICING[key];
  }
  return DEFAULT_PRICE;
}

function costFor(usage, model) {
  const p = priceForModel(model);
  const inT = usage.input_tokens || 0;
  const outT = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  return (
    (inT * p.in) / 1_000_000 +
    (outT * p.out) / 1_000_000 +
    (cacheRead * p.cacheRead) / 1_000_000 +
    (cacheWrite * p.cacheWrite) / 1_000_000
  );
}

function blank() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
}

function add(slot, usage, cost) {
  slot.input += usage.input_tokens || 0;
  slot.output += usage.output_tokens || 0;
  slot.cacheRead += usage.cache_read_input_tokens || 0;
  slot.cacheWrite += usage.cache_creation_input_tokens || 0;
  slot.cost += cost;
  slot.calls += 1;
}

function encodePath(p) {
  return p.replace(/[\\\/:]/g, '-').replace(/[^A-Za-z0-9.\-_]/g, '-');
}

async function streamFile(filePath, onEntry) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      onEntry(entry);
    });
    rl.on('close', resolve);
    rl.on('error', resolve);
  });
}

async function aggregate({ scope = 'all', cwd = null } = {}) {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const now = Date.now();

  const empty = {
    scope,
    files: 0,
    total: blank(),
    today: blank(),
    last24h: blank(),
    last7d: blank(),
    thisMonth: blank(),
    window5h: { ...blank(), windowStart: null, windowEnd: null },
    byModel: {},
    firstCallAt: null,
    lastCallAt: null,
  };

  if (!fs.existsSync(projectsRoot)) return empty;

  let dirs = [];
  if (scope === 'project' && cwd) {
    const encoded = encodePath(cwd);
    const candidate = path.join(projectsRoot, encoded);
    if (fs.existsSync(candidate)) dirs.push(candidate);
  }
  if (dirs.length === 0) {
    dirs = fs.readdirSync(projectsRoot)
      .map((n) => path.join(projectsRoot, n))
      .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  }

  // Janela de 5h "deslizante": começa na primeira chamada feita nos últimos 5h.
  // Coletamos timestamps brutos numa primeira passada pra achar windowStart.
  const recentTimestamps = [];

  const result = empty;
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      result.files += 1;
      await streamFile(fp, (entry) => {
        if (entry.type !== 'assistant' || !entry.message) return;
        const usage = entry.message.usage;
        if (!usage) return;
        const model = entry.message.model || 'unknown';
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        const cost = costFor(usage, model);

        add(result.total, usage, cost);

        if (!result.firstCallAt || (ts && ts < result.firstCallAt)) result.firstCallAt = ts || result.firstCallAt;
        if (!result.lastCallAt || (ts && ts > result.lastCallAt)) result.lastCallAt = ts || result.lastCallAt;

        const slot = result.byModel[model] || (result.byModel[model] = blank());
        add(slot, usage, cost);

        if (Number.isFinite(ts)) {
          if (ts >= startOfToday.getTime()) add(result.today, usage, cost);
          if (ts >= now - 24 * 3600_000) add(result.last24h, usage, cost);
          if (ts >= now - 7 * 86400_000) add(result.last7d, usage, cost);
          if (ts >= startOfMonth.getTime()) add(result.thisMonth, usage, cost);
          if (ts >= now - FIVE_HOURS_MS) {
            recentTimestamps.push({ ts, usage, cost });
          }
        }
      });
    }
  }

  // Calcula janela 5h baseada na primeira chamada dentro das últimas 5h
  if (recentTimestamps.length > 0) {
    recentTimestamps.sort((a, b) => a.ts - b.ts);
    const windowStart = recentTimestamps[0].ts;
    const windowEnd = windowStart + FIVE_HOURS_MS;
    for (const r of recentTimestamps) {
      if (r.ts <= windowEnd) add(result.window5h, r.usage, r.cost);
    }
    result.window5h.windowStart = windowStart;
    result.window5h.windowEnd = windowEnd;
  }

  return result;
}

module.exports = { aggregate, real };
