/**
 * Rotinas agendadas por projeto — o "Cron Jobs".
 *
 * Vive no HOST, não no client. Quem executa o turno é quem agenda: um projeto
 * local agenda nesta máquina, um projeto do host agenda lá. Sem isso a rotina
 * morreria ao fechar o notebook, que é justamente o oposto do que se espera de
 * um agendamento.
 *
 * O horário é resolvido no fuso da FONTE. "Todo dia às 9h" significa 9h onde o
 * projeto roda — se resolvêssemos no client, quem viaja veria a rotina andar
 * sozinha.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let jobs = new Map();      // projectId -> Job[]
let loaded = false;
let onChange = null;

function storeDir() {
  const home = process.env.MAESTRUS_HOME
    || (process.env.APPDATA ? path.join(process.env.APPDATA, 'maestrus')
      : path.join(os.homedir(), 'Library', 'Application Support', 'maestrus'));
  try { fs.mkdirSync(home, { recursive: true }); } catch {}
  return home;
}
function storePath() { return path.join(storeDir(), 'cron-jobs.json'); }

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw);
    jobs = new Map(Object.entries(data.jobs || {}));
  } catch { jobs = new Map(); }
}

function persist() {
  try {
    fs.writeFileSync(storePath(), JSON.stringify({ jobs: Object.fromEntries(jobs) }, null, 2));
  } catch {}
}

function setOnChange(fn) { onChange = fn; }
function emitChange(projectId) { try { onChange && onChange(projectId); } catch {} }

function newId() {
  return 'cj_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Presets → expressão cron de 5 campos (min hora dia mês diaSemana).
 *
 * O usuário escolhe em português; o cron é detalhe interno. Guardamos os DOIS:
 * o preset para reexibir a escolha original sem tentar adivinhá-la de volta a
 * partir da expressão, e o cron porque é ele que o agendador entende.
 */
function presetToCron(preset, opts = {}) {
  const hour = Number.isFinite(opts.hour) ? opts.hour : 9;
  const minute = Number.isFinite(opts.minute) ? opts.minute : 0;
  const weekday = Number.isFinite(opts.weekday) ? opts.weekday : 1; // 0=domingo
  switch (preset) {
    case 'every15m': return '*/15 * * * *';
    case 'every30m': return '*/30 * * * *';
    case 'hourly': return '0 * * * *';
    case 'every2h': return '0 */2 * * *';
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': return `${minute} ${hour} * * ${weekday}`;
    case 'custom': return String(opts.cron || '').trim();
    default: return '';
  }
}

/** Um campo cron casa com o valor? Aceita *, listas, faixas e passos. */
function fieldMatches(field, value) {
  if (field === '*') return true;
  for (const part of String(field).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    if (!Number.isFinite(step) || step < 1) continue;
    let lo, hi;
    if (range === '*') { lo = -Infinity; hi = Infinity; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map((n) => parseInt(n, 10));
      lo = a; hi = b;
    } else {
      const n = parseInt(range, 10);
      if (n === value) return true;
      // "5/15" sem faixa: a partir de 5, de 15 em 15
      if (stepRaw && Number.isFinite(n) && value >= n && (value - n) % step === 0) return true;
      continue;
    }
    if (!Number.isFinite(lo)) { if (value % step === 0) return true; continue; }
    if (value < lo || value > hi) continue;
    if ((value - lo) % step === 0) return true;
  }
  return false;
}

/**
 * A expressão casa com este minuto? Comparação em minutos cheios: o agendador
 * acorda com frequência e usa isto como filtro, então precisa ser idempotente
 * dentro do mesmo minuto (o controle de "já rodou" é do runner).
 */
function cronMatches(expr, date) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return fieldMatches(min, date.getMinutes())
    && fieldMatches(hour, date.getHours())
    && fieldMatches(dom, date.getDate())
    && fieldMatches(mon, date.getMonth() + 1)
    && fieldMatches(dow, date.getDay());
}

/** Descrição legível, para a UI não precisar reinterpretar a expressão. */
function describe(job, lang = 'pt') {
  const p = job.preset;
  const hh = String(job.hour ?? 9).padStart(2, '0');
  const mm = String(job.minute ?? 0).padStart(2, '0');
  const days = {
    pt: ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'],
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  }[lang] || [];
  const t = {
    pt: { every15m: 'a cada 15 minutos', every30m: 'a cada 30 minutos', hourly: 'a cada hora', every2h: 'a cada 2 horas', daily: `todo dia às ${hh}:${mm}`, weekdays: `de segunda a sexta às ${hh}:${mm}`, weekly: `toda ${days[job.weekday ?? 1]} às ${hh}:${mm}` },
    en: { every15m: 'every 15 minutes', every30m: 'every 30 minutes', hourly: 'hourly', every2h: 'every 2 hours', daily: `daily at ${hh}:${mm}`, weekdays: `weekdays at ${hh}:${mm}`, weekly: `every ${days[job.weekday ?? 1]} at ${hh}:${mm}` },
    es: { every15m: 'cada 15 minutos', every30m: 'cada 30 minutos', hourly: 'cada hora', every2h: 'cada 2 horas', daily: `todos los días a las ${hh}:${mm}`, weekdays: `de lunes a viernes a las ${hh}:${mm}`, weekly: `cada ${days[job.weekday ?? 1]} a las ${hh}:${mm}` },
  }[lang] || {};
  return t[p] || job.cron || '';
}

function list(projectId) {
  load();
  return (jobs.get(projectId) || []).map((j) => ({ ...j }));
}

function listAll() {
  load();
  const out = [];
  for (const [projectId, arr] of jobs) for (const j of arr) out.push({ ...j, projectId });
  return out;
}

function get(projectId, id) {
  load();
  return (jobs.get(projectId) || []).find((j) => j.id === id) || null;
}

function create(projectId, input) {
  load();
  const cron = presetToCron(input.preset, input);
  if (!cron) throw new Error('schedule_invalid');
  const job = {
    id: newId(),
    name: String(input.name || '').slice(0, 120) || null,
    prompt: String(input.prompt || ''),
    preset: input.preset,
    cron,
    hour: input.hour ?? null,
    minute: input.minute ?? null,
    weekday: input.weekday ?? null,
    enabled: input.enabled !== false,
    // Efêmero: roda numa sessão própria em vez de continuar a conversa. É o
    // padrão porque uma rotina de 30 em 30 min numa conversa longa reenvia todo
    // o contexto a cada disparo, e o cache de prompt já expirou nesse intervalo.
    ephemeral: input.ephemeral !== false,
    conversationId: input.conversationId || null,
    createdAt: Date.now(),
    lastRunAt: null,
    lastStatus: null,
    history: [],
  };
  if (!job.prompt.trim()) throw new Error('prompt_required');
  const arr = jobs.get(projectId) || [];
  arr.push(job);
  jobs.set(projectId, arr);
  persist();
  emitChange(projectId);
  return job;
}

function update(projectId, id, patch) {
  load();
  const arr = jobs.get(projectId) || [];
  const job = arr.find((j) => j.id === id);
  if (!job) return null;
  if (patch.prompt !== undefined) job.prompt = String(patch.prompt || '');
  if (patch.name !== undefined) job.name = patch.name ? String(patch.name).slice(0, 120) : null;
  if (patch.enabled !== undefined) job.enabled = !!patch.enabled;
  if (patch.ephemeral !== undefined) job.ephemeral = !!patch.ephemeral;
  if (patch.conversationId !== undefined) job.conversationId = patch.conversationId || null;
  if (patch.preset !== undefined || patch.hour !== undefined || patch.minute !== undefined || patch.weekday !== undefined || patch.cron !== undefined) {
    const next = { ...job, ...patch };
    const cron = presetToCron(next.preset, next);
    if (!cron) throw new Error('schedule_invalid');
    job.preset = next.preset; job.cron = cron;
    job.hour = next.hour ?? null; job.minute = next.minute ?? null; job.weekday = next.weekday ?? null;
  }
  persist();
  emitChange(projectId);
  return { ...job };
}

function remove(projectId, id) {
  load();
  const arr = jobs.get(projectId) || [];
  const i = arr.findIndex((j) => j.id === id);
  if (i < 0) return false;
  arr.splice(i, 1);
  if (arr.length) jobs.set(projectId, arr); else jobs.delete(projectId);
  persist();
  emitChange(projectId);
  return true;
}

/** Some com as rotinas de um projeto apagado (senão o agendador tenta rodá-las). */
function removeProject(projectId) {
  load();
  if (!jobs.has(projectId)) return false;
  jobs.delete(projectId);
  persist();
  return true;
}

const MAX_HISTORY = 20;

/** Registra a execução. O custo entra depois, quando o turno termina. */
function recordRun(projectId, id, entry) {
  load();
  const job = (jobs.get(projectId) || []).find((j) => j.id === id);
  if (!job) return null;
  job.lastRunAt = entry.at || Date.now();
  job.lastStatus = entry.status || 'ok';
  job.history = [{ ...entry, at: job.lastRunAt }, ...(job.history || [])].slice(0, MAX_HISTORY);
  persist();
  emitChange(projectId);
  return { ...job };
}

module.exports = {
  list, listAll, get, create, update, remove, removeProject, recordRun,
  presetToCron, cronMatches, fieldMatches, describe, setOnChange,
  PRESETS: ['every15m', 'every30m', 'hourly', 'every2h', 'daily', 'weekdays', 'weekly', 'custom'],
};
