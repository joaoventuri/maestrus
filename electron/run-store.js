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
const pollers = new Map();  // runId -> interval (cauda do log / vida do pid)
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

function metaPath(id) { return path.join(baseDir(), `${id}.json`); }
function persist(run) {
  // Metadado no disco a cada mudança de estado: é o que permite o run
  // SOBREVIVER ao próprio Maestrus fechar — ao reabrir, a reidratação lê isto.
  try {
    const { tail, ...meta } = run;
    fs.writeFileSync(metaPath(run.id), JSON.stringify(meta));
  } catch {}
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Lê a cauda do log DIRETO do arquivo (o filho escreve nele sem passar por
// nós). Só os últimos 64KB — a UI não precisa de mais.
function syncTailFromFile(run) {
  try {
    const st = fs.statSync(run.logPath);
    if (st.size === run.bytes) return false;
    run.bytes = st.size;
    const fd = fs.openSync(run.logPath, 'r');
    try {
      const len = Math.min(64 * 1024, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split(/(?<=\n)/);
      run.tail = lines.slice(-MAX_TAIL_LINES);
      run.truncated = st.size > MAX_LOG_BYTES;
    } finally { fs.closeSync(fd); }
    return true;
  } catch { return false; }
}

function startPoller(run) {
  stopPoller(run.id);
  const iv = setInterval(() => {
    const changed = syncTailFromFile(run);
    // Run reidratado (sem handle do processo): a vida é o pid. Morreu → fecha.
    if (!procs.has(run.id) && !pidAlive(run.pid)) {
      run.status = run.status === 'running' ? 'done' : run.status;
      run.exitCode = run.exitCode === undefined ? null : run.exitCode;
      run.endedAt = run.endedAt || Date.now();
      stopPoller(run.id);
      persist(run);
      emit(run);
      return;
    }
    if (changed) emit(run);
  }, 1200);
  iv.unref?.();
  pollers.set(run.id, iv);
}
function stopPoller(id) {
  const iv = pollers.get(id);
  if (iv) { clearInterval(iv); pollers.delete(id); }
}

/**
 * Reidrata execuções de sessões anteriores do APP. Os processos escrevem
 * direto no arquivo de log (não num pipe nosso), então fechar o Maestrus não
 * os afeta em nada — ao reabrir, quem ainda tem pid vivo volta como 'running'
 * com a cauda ao vivo; quem terminou no escuro é fechado com honestidade.
 */
function rehydrate() {
  let files = [];
  try { files = fs.readdirSync(baseDir()).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(baseDir(), f), 'utf8'));
      if (!meta || !meta.id || runs.has(meta.id)) continue;
      const run = { ...meta, tail: [], bytes: 0 };
      syncTailFromFile(run);
      if (run.status === 'running') {
        if (pidAlive(run.pid)) {
          startPoller(run);                       // segue vivo — retoma o acompanhamento
        } else {
          run.status = 'done';                    // terminou com o app fechado
          run.exitCode = null;
          run.endedAt = run.endedAt || Date.now();
          persist(run);
        }
      }
      runs.set(run.id, run);
    } catch {}
  }
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

  // stdout/err vão DIRETO para o arquivo de log, sem pipe pelo Electron. É o
  // que torna a sobrevivência CONCRETA: se o Maestrus fechar, o filho não tem
  // nenhum fd apontando pra gente — segue escrevendo no disco como se nada
  // tivesse acontecido, e a reidratação retoma o acompanhamento ao reabrir.
  // (Com pipe, fechar o app fechava a ponta de leitura → EPIPE no filho.)
  let outFd = null;
  try { outFd = fs.openSync(logPath, 'a'); } catch {}
  let proc;
  try {
    proc = spawn(command, {
      cwd: run.cwd,
      shell: true,          // comando livre, como o agente escreveria no terminal
      detached: true,       // grupo próprio: sobrevive ao fim do turno
      windowsHide: true,
      stdio: ['ignore', outFd ?? 'ignore', outFd ?? 'ignore'],
      env: { ...process.env, ...(env || {}) },
    });
  } catch (e) {
    run.status = 'error';
    run.endedAt = Date.now();
    run.tail.push(`falha ao iniciar: ${e.message}\n`);
    try { if (outFd !== null) fs.closeSync(outFd); } catch {}
    persist(run);
    emit(run);
    return publicView(run);
  }
  // O fd foi herdado pelo filho; a nossa cópia fecha (o filho mantém a dele).
  try { if (outFd !== null) fs.closeSync(outFd); } catch {}

  procs.set(id, proc);
  run.pid = proc.pid;
  // Sem unref o processo do Electron esperaria por ele para encerrar.
  try { proc.unref(); } catch {}
  persist(run);
  startPoller(run);   // a cauda vem do arquivo — mesma fonte com app aberto ou não

  proc.on('close', (code, signal) => {
    procs.delete(id);
    run.status = signal ? 'stopped' : (code === 0 ? 'done' : 'error');
    run.exitCode = code;
    run.endedAt = Date.now();
    syncTailFromFile(run);
    stopPoller(id);
    persist(run);
    prune(run.projectId);
    emit(run);
  });
  proc.on('error', (e) => {
    procs.delete(id);
    run.status = 'error';
    run.endedAt = Date.now();
    run.tail.push(`erro: ${e.message}\n`);
    stopPoller(id);
    persist(run);
    emit(run);
  });

  emit(run);
  return publicView(run);
}

function stop(runId) {
  const proc = procs.get(runId);
  const run = runs.get(runId);
  if (!run) return { ok: false, error: 'not_found' };
  if (proc) {
    try { killTree(proc); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true };
  }
  // Run REIDRATADO (o app reabriu): não temos o handle, mas temos o pid — e o
  // detached fez dele líder de grupo, então -pid derruba a árvore no POSIX.
  if (run.status === 'running' && pidAlive(run.pid)) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawn('taskkill', ['/pid', String(run.pid), '/T', '/F'], { windowsHide: true });
      } else {
        try { process.kill(-run.pid, 'SIGTERM'); } catch { process.kill(run.pid, 'SIGTERM'); }
        setTimeout(() => {
          if (pidAlive(run.pid)) { try { process.kill(-run.pid, 'SIGKILL'); } catch { try { process.kill(run.pid, 'SIGKILL'); } catch {} } }
        }, 1500).unref?.();
      }
      run.status = 'stopped';
      run.endedAt = Date.now();
      stopPoller(runId);
      persist(run);
      emit(run);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'not_running' };
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
    try { fs.unlinkSync(metaPath(id)); } catch {}
    runs.delete(id);
  }
}

module.exports = { start, stop, stopAll, list, get, readLog, activeCount, setOnChange, rehydrate };
