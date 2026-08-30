/**
 * Execuções em segundo plano — processos que sobrevivem ao turno.
 *
 * Por que existe: o Maestrus roda `claude -p`, um processo one-shot que sai
 * quando termina de responder. Tudo que ele lançou em segundo plano morre
 * junto — e o `detached: true` que damos ao turno (para o botão Parar
 * conseguir matar sub-agentes) torna isso ainda mais garantido. No Claude Code
 * interativo o processo fica vivo e o trabalho continua; aqui, não.
 *
 * A saída não é "parar de matar": um processo órfão é pior — ninguém coleta a
 * saída, ninguém sabe que existe, ninguém consegue encerrar depois. A saída é o
 * processo pertencer ao MAESTRUS: fora do grupo do turno, com log em disco,
 * estado observável e parada explícita.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { killTree } = require('./kill-tree');

const MAX_LOG_BYTES = 2 * 1024 * 1024;   // log por execução; o resto vai para o arquivo
const MAX_TAIL_LINES = 500;              // o que a UI recebe sem pedir o arquivo inteiro
const KEEP_FINISHED = 20;                // histórico por projeto

const runs = new Map();     // runId -> Run
const procs = new Map();    // runId -> ChildProcess
let onChange = null;

function setOnChange(fn) { onChange = fn; }
function emit(run) { try { onChange && onChange(run); } catch {} }

function baseDir() {
  const home = process.env.MAESTRUS_HOME
    || (process.env.APPDATA ? path.join(process.env.APPDATA, 'maestrus')
      : path.join(os.homedir(), 'Library', 'Application Support', 'maestrus'));
  const dir = path.join(home, 'runs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function newId() {
  return 'run_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function publicView(r) {
  const { logPath, ...rest } = r;
  // pid exposto de proposito: permite verificar o process group de fora (o
  // teste do isolamento depende disso) e ajuda a diagnosticar processo preso.
  const proc = procs.get(r.id);
  return { ...rest, pid: proc ? proc.pid : (r.pid || null), tail: r.tail.join('') };
}

function list(projectId) {
  const out = [];
  for (const r of runs.values()) {
    if (!projectId || r.projectId === projectId) out.push(publicView(r));
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

function get(runId) {
  const r = runs.get(runId);
  return r ? publicView(r) : null;
}

/** Quantas execuções vivas — alimenta o indicador no topo da conversa. */
function activeCount(projectId) {
  let n = 0;
  for (const r of runs.values()) {
    if (r.status === 'running' && (!projectId || r.projectId === projectId)) n++;
  }
  return n;
}

/**
 * Dispara um comando que NÃO morre com o turno.
 *
 * `detached: true` aqui tem o sentido oposto do turno: em vez de agrupar para
 * matar junto, isola em um grupo próprio para que a morte do turno não o leve.
 */
function start({ projectId, command, cwd, label, env }) {
  if (!command || !String(command).trim()) throw new Error('command_required');
  const id = newId();
  const logPath = path.join(baseDir(), `${id}.log`);
  const run = {
    id,
    projectId: projectId || null,
    label: label || String(command).slice(0, 80),
    command: String(command),
    cwd: cwd || process.cwd(),
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    bytes: 0,
    truncated: false,
    tail: [],
    logPath,
  };
  runs.set(id, run);

  let proc;
  try {
    proc = spawn(command, {
      cwd: run.cwd,
      shell: true,          // comando livre, como o agente escreveria no terminal
      detached: true,       // grupo próprio: sobrevive ao fim do turno
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(env || {}) },
    });
  } catch (e) {
    run.status = 'error';
    run.endedAt = Date.now();
    run.tail.push(`falha ao iniciar: ${e.message}\n`);
    emit(run);
    return publicView(run);
  }

  procs.set(id, proc);
  run.pid = proc.pid;
  // Sem unref o processo do Electron esperaria por ele para encerrar.
  try { proc.unref(); } catch {}

  let stream = null;
  try { stream = fs.createWriteStream(logPath, { flags: 'a' }); } catch {}

  const onData = (chunk) => {
    const text = chunk.toString();
    run.bytes += chunk.length;
    if (stream && run.bytes <= MAX_LOG_BYTES) stream.write(text);
    else if (!run.truncated) { run.truncated = true; if (stream) stream.write('\n[log truncado]\n'); }
    run.tail.push(text);
    if (run.tail.length > MAX_TAIL_LINES) run.tail.splice(0, run.tail.length - MAX_TAIL_LINES);
    emit(run);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code, signal) => {
    procs.delete(id);
    run.status = signal ? 'stopped' : (code === 0 ? 'done' : 'error');
    run.exitCode = code;
    run.endedAt = Date.now();
    try { stream && stream.end(); } catch {}
    prune(run.projectId);
    emit(run);
  });
  proc.on('error', (e) => {
    procs.delete(id);
    run.status = 'error';
    run.endedAt = Date.now();
    run.tail.push(`erro: ${e.message}\n`);
    try { stream && stream.end(); } catch {}
    emit(run);
  });

  emit(run);
  return publicView(run);
}

function stop(runId) {
  const proc = procs.get(runId);
  const run = runs.get(runId);
  if (!run) return { ok: false, error: 'not_found' };
  if (!proc) return { ok: false, error: 'not_running' };
  try { killTree(proc); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

/** Para tudo de um projeto. Usado no encerramento do app, não no fim do turno. */
function stopAll(projectId) {
  let n = 0;
  for (const [id, r] of runs) {
    if (r.status === 'running' && (!projectId || r.projectId === projectId)) {
      if (stop(id).ok) n++;
    }
  }
  return n;
}

/** Log completo, para quando a cauda não basta. */
function readLog(runId) {
  const r = runs.get(runId);
  if (!r) return null;
  try { return fs.readFileSync(r.logPath, 'utf8'); } catch { return r.tail.join(''); }
}

function prune(projectId) {
  const finished = [];
  for (const [id, r] of runs) {
    if (r.projectId === projectId && r.status !== 'running') finished.push([id, r]);
  }
  finished.sort((a, b) => b[1].startedAt - a[1].startedAt);
  for (const [id, r] of finished.slice(KEEP_FINISHED)) {
    try { fs.unlinkSync(r.logPath); } catch {}
    runs.delete(id);
  }
}

module.exports = { start, stop, stopAll, list, get, readLog, activeCount, setOnChange };
