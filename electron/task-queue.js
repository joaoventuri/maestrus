// Dispatcher de tarefas (Kanban). Roda no processo main do Electron.
//
// Como funciona:
//  - A cada TICK_MS, lista projetos com setting ligado.
//  - Pra cada projeto que (a) nao tem claude-pty rodando localmente e
//    (b) nao tem task 'doing' no servidor, chama tasks?op=claim — o servidor
//    atomicamente marca 1 task 'ready' como 'doing' (SKIP LOCKED garante que
//    so um desktop por vez pega).
//  - A task ganha eh disparada como prompt no orquestrador (claudePty.send).
//  - O hook em claudePty.onEvent observa o evento 'done' e marca a task como
//    'done' no servidor — o que libera a proxima do mesmo projeto no proximo
//    tick. Erros marcam como 'failed'.
//
// Liga/desliga: settings { enabled_global, enabled_projects } no servidor.
// O dispatcher consulta o cache local; renderer pede settings_set quando o
// usuario flipa o toggle.

const projectStore = require('./project-store');
const claudePty = require('./claude-pty');
const taskStore = require('./task-store');
const cloud = require('./cloud');

const TICK_MS = 15 * 1000;             // base
const TICK_AFTER_DONE_MS = 1500;       // depois que um turn termina, checa rapido
const SETTINGS_REFRESH_MS = 60 * 1000;

let _timer = null;
let _stopped = true;
let _mainWindow = null;
let _settings = { enabled_global: true, enabled_projects: {} };
let _settingsAt = 0;
// In-flight: task que ja foi disparada localmente, aguardando 'done' do pty.
// projectId -> { taskId, startedAt, acc, project, task, loop }
const _inflight = new Map();

// ─── Circuit breaker (evita loop infinito quando a API do Claude tá dando ─
// erro em cascata — rate limit, overloaded, "Too many requests", etc.).
// Se 3 falhas acontecem numa janela de 5 min, PAUSA o dispatcher por 30 min.
// Sem isso, o usuário via 30 tasks queimando tokens em erro numa rajada.
const _failWindow = [];               // array de timestamps das falhas recentes
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_THRESHOLD = 3;
const BREAKER_PAUSE_MS = 30 * 60 * 1000;
let _breakerUntil = 0;                // timestamp até quando o dispatcher fica pausado

// Regex que casa mensagens de erro típicas do Claude que devem SER tratadas
// como falha, mesmo quando o CLI sai com exit 0 (o erro veio como texto do
// assistant, não como stderr).
const API_ERROR_RE = /(rate[\s-]?limit|too many requests|429|api error|overloaded|max[\s-]?retries?|internal server error|500 error|502 bad gateway|503 service|context.*length|prompt.*too long|invalid_request_error)/i;

function isApiErrorNote(note) {
  if (!note || note.length < 4) return false;
  // Só olha as primeiras 500 chars — evita falso-positivo em respostas longas
  // que MENCIONAM rate limit no meio (ex: código Python que trata 429).
  return API_ERROR_RE.test(note.slice(0, 500));
}

function recordFailure(reason) {
  const now = Date.now();
  _failWindow.push(now);
  while (_failWindow.length && (now - _failWindow[0]) > FAIL_WINDOW_MS) _failWindow.shift();
  if (_failWindow.length >= FAIL_THRESHOLD && _breakerUntil < now) {
    _breakerUntil = now + BREAKER_PAUSE_MS;
    _failWindow.length = 0;
    const minutes = Math.round(BREAKER_PAUSE_MS / 60000);
    console.warn(`[taskQueue] circuit breaker ABERTO por ${minutes}min — ${FAIL_THRESHOLD} falhas seguidas (${reason})`);
    notify({ kind: 'breaker_open', pausedUntil: _breakerUntil, reason });
    if (_mainWindow) {
      _mainWindow.webContents.send('claude:event', {
        projectId: 'maestrus', type: 'system', subtype: 'task',
        text: `⏸ Kanban pausado por ${minutes}min — ${FAIL_THRESHOLD} falhas seguidas (${reason}). Retomará automaticamente.`,
        timestamp: Date.now(),
      });
    }
  }
}
function breakerBlocking() { return Date.now() < _breakerUntil; }
function resetBreaker() { _breakerUntil = 0; _failWindow.length = 0; notify({ kind: 'breaker_reset' }); }

// ─── Goal loops (loop engineering) ──────────────────────────────────────────
// Uma task pode iterar ate cumprir o objetivo. O estado do loop vive aqui no
// worker (mesmo processo do enqueue) — sem coluna nova no banco. O orquestrador
// registra via registerLoop() no claui_enqueue_task(max_iterations). A cada
// 'done', se o objetivo nao foi declarado (sentinela TASK_COMPLETE) e ainda ha
// iteracoes, re-dispara a MESMA task in-process realimentando o resultado.
// taskId -> { max, count, lastResult }
const _loops = new Map();
const LOOP_HARD_CAP = 25;            // teto de seguranca, mesmo se pedirem mais
const LOOP_DONE_RE = /\bTASK_COMPLETE\b/;

function registerLoop(taskId, max) {
  const m = Math.max(1, Math.min(LOOP_HARD_CAP, parseInt(max, 10) || 1));
  if (m > 1) _loops.set(taskId, { max: m, count: 0, lastResult: '' });
  return m;
}
// Para um loop em andamento (o usuario clica "parar" / cancela a task).
function stopLoop(taskId) { _loops.delete(taskId); }

function setMainWindow(w) { _mainWindow = w; }

function notify(payload) {
  try { _mainWindow && _mainWindow.webContents.send('tasks:changed', payload); } catch {}
}

async function refreshSettings(force = false) {
  if (!force && Date.now() - _settingsAt < SETTINGS_REFRESH_MS) return _settings;
  const r = await taskStore.settingsGet();
  if (r && r.ok && r.settings) {
    _settings = {
      enabled_global: !!r.settings.enabled_global,
      enabled_projects: r.settings.enabled_projects || {},
    };
    _settingsAt = Date.now();
  }
  return _settings;
}

function isProjectEnabled(projectId) {
  if (!_settings.enabled_global) return false;
  const v = _settings.enabled_projects[projectId];
  // ausente = true (default)
  return v === undefined ? true : !!v;
}

// Compoe o prompt que vai pro Claude a partir de title + description. Em loop,
// anexa o contexto da iteracao + o resultado anterior (realimentacao) + a
// instrucao da sentinela de conclusao.
function composePrompt(task, loop) {
  const title = (task.title || '').trim();
  // Strip [LOOP:N] metadata prefix antes de enviar ao Claude
  const desc = (task.description || '').replace(/^\[LOOP:\d+\]\n*/i, '').trim();
  let base = desc ? `${title}\n\n${desc}` : title;
  if (loop && loop.max > 1) {
    const iter = (loop.count || 0) + 1;
    if (loop.lastResult) {
      base += `\n\n---\n[Loop ${iter}/${loop.max}] Resultado da iteracao anterior:\n${String(loop.lastResult).slice(0, 4000)}`;
    }
    base += `\n\n[MODO LOOP — iteracao ${iter} de ${loop.max}. Continue ate cumprir 100% o objetivo, construindo sobre a iteracao anterior. Quando estiver concluido E verificado, finalize sua resposta com a linha exata: TASK_COMPLETE]`;
  }
  return base;
}

async function dispatchOne(project) {
  const r = await taskStore.claim(project.id);
  if (!r || !r.ok || !r.task) return false;
  const task = r.task;
  // Auto-registra loop se a task tem [LOOP:N] na description e não foi
  // registrada via MCP (ex.: criada pelo /task slash command ou TaskModal).
  if (!_loops.has(task.id) && task.description) {
    const m = task.description.match(/^\[LOOP:(\d+)\]/i);
    if (m) registerLoop(task.id, parseInt(m[1], 10));
  }
  const loop = _loops.get(task.id) || null;
  _inflight.set(project.id, { taskId: task.id, startedAt: Date.now(), acc: '', project, task, loop });
  notify({ kind: 'started', task });
  try {
    // Emite um system event pra UI mostrar que veio do kanban.
    if (_mainWindow) {
      _mainWindow.webContents.send('claude:event', {
        projectId: project.id,
        type: 'system',
        subtype: 'task',
        text: loop && loop.max > 1 ? `🔁 Loop 1/${loop.max}: ${task.title}` : `▶ Kanban: ${task.title}`,
        timestamp: Date.now(),
      });
    }
    await claudePty.send(project, composePrompt(task, loop));
    // claudePty.send retorna apos disparar o processo — o 'done' chega
    // assincronamente pelo onEvent hook.
    return true;
  } catch (e) {
    _inflight.delete(project.id);
    const errMsg = String(e && e.message || e).slice(0, 500);
    await taskStore.update(task.id, { status: 'failed', result_note: errMsg });
    notify({ kind: 'failed', taskId: task.id, reason: 'spawn_error' });
    recordFailure(isApiErrorNote(errMsg) ? 'api_error' : 'spawn_error');
    return false;
  }
}

async function tick() {
  if (_stopped) return;
  if (breakerBlocking()) return;              // circuit breaker aberto — pula
  try {
    if (!cloud.getAccount()) return;
    await refreshSettings();
    if (!_settings.enabled_global) return;
    const projects = projectStore.list().filter((p) => p.id !== 'maestrus' && isProjectEnabled(p.id) && p.source !== 'remote');
    for (const p of projects) {
      if (_inflight.has(p.id)) continue;          // ja temos uma rodando local
      if (claudePty.isBusy(p.id)) continue;       // usuario esta usando manualmente
      // claim — servidor decide se ha 'ready' e se ja nao existe 'doing'
      await dispatchOne(p);
    }
  } catch (e) {
    // Silencioso: dispatcher nao deve quebrar o app.
  }
}

function scheduleNext(delay = TICK_MS) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { tick().finally(() => scheduleNext(TICK_MS)); }, delay);
}

function start() {
  if (!_stopped) return;
  _stopped = false;
  // Escuta done/error do orquestrador pra fechar as tasks que dispararamos.
  claudePty.onEvent(async (evt) => {
    if (!evt || !evt.projectId) return;
    const inf = _inflight.get(evt.projectId);
    if (!inf) return;
    // Acumula o texto da resposta durante o turno pra guardar no result_note
    // (o orquestrador colhe depois via claui_check_results).
    if (evt.type === 'delta' && evt.text) { inf.acc = (inf.acc || '') + evt.text; return; }
    if (evt.type === 'assistant-text' && evt.text) { inf.acc = evt.text; return; }
    if (evt.type === 'done') {
      const note = (inf.acc || '').trim().slice(0, 100000);
      const loop = inf.loop;
      const goalMet = LOOP_DONE_RE.test(note);
      // Erro de API veio como texto do assistant (rate limit, overloaded, etc.).
      // NÃO conta como sucesso, NÃO segue o loop, e alimenta o circuit breaker.
      if (isApiErrorNote(note) || (evt.exitCode && evt.exitCode !== 0)) {
        _inflight.delete(evt.projectId);
        _loops.delete(inf.taskId);
        const brief = note.slice(0, 300) || `exit ${evt.exitCode}`;
        await taskStore.update(inf.taskId, { status: 'failed', result_note: `API error: ${brief}` });
        notify({ kind: 'failed', taskId: inf.taskId, reason: 'api_error' });
        recordFailure('api_error');
        // Sem scheduleNext rápido — deixa o tick normal (15s) tomar a vez pra
        // não bombardear a API que já tá com problema.
        return;
      }
      // Goal loop: ainda nao cumpriu e ainda ha iteracoes → re-dispara a MESMA
      // task in-process (status segue 'doing'), realimentando o resultado.
      if (loop && loop.max > 1 && !goalMet && (loop.count + 1) < loop.max) {
        loop.count += 1;
        loop.lastResult = note;
        _loops.set(inf.taskId, { max: loop.max, count: loop.count, lastResult: note });
        inf.acc = '';
        notify({ kind: 'loop', taskId: inf.taskId, iteration: loop.count + 1, max: loop.max });
        if (_mainWindow) {
          _mainWindow.webContents.send('claude:event', {
            projectId: evt.projectId, type: 'system', subtype: 'task',
            text: `🔁 Loop ${loop.count + 1}/${loop.max}: ${inf.task.title}`, timestamp: Date.now(),
          });
        }
        // pequeno delay pra o pty assentar antes da proxima volta
        setTimeout(() => {
          if (!_inflight.has(evt.projectId)) return; // cancelado nesse meio tempo
          claudePty.send(inf.project, composePrompt(inf.task, loop)).catch(async (e) => {
            _inflight.delete(evt.projectId); _loops.delete(inf.taskId);
            await taskStore.update(inf.taskId, { status: 'failed', result_note: String(e && e.message || e).slice(0, 500) });
            notify({ kind: 'failed', taskId: inf.taskId });
          });
        }, 250);
        return; // NAO marca done — o loop continua
      }
      // Fim: objetivo cumprido (TASK_COMPLETE) ou teto de iteracoes atingido.
      _inflight.delete(evt.projectId);
      _loops.delete(inf.taskId);
      await taskStore.update(inf.taskId, { status: 'done', result_note: note });
      notify({ kind: 'done', taskId: inf.taskId });
      // Tick rapido pra encadear a proxima do mesmo projeto.
      scheduleNext(TICK_AFTER_DONE_MS);
      // Envia resultado para o chat do Maestrus (aparece como mensagem de sistema).
      if (_mainWindow) {
        const cleanNote = note.replace(/\bTASK_COMPLETE\b/g, '').trim();
        const preview = cleanNote.slice(0, 1500) + (cleanNote.length > 1500 ? '\n…' : '');
        _mainWindow.webContents.send('claude:event', {
          projectId: 'maestrus',
          type: 'system',
          subtype: 'task_result',
          text: `✓ [${inf.project?.name || inf.project?.id || 'Projeto'}] "${inf.task?.title || 'Task'}" concluída:\n\n${preview}`,
          timestamp: Date.now(),
        });
      }
    } else if (evt.type === 'error') {
      _inflight.delete(evt.projectId);
      _loops.delete(inf.taskId);  // se era loop, PARA — não tenta iterar em cima do erro
      const text = String(evt.text || '').slice(0, 500);
      await taskStore.update(inf.taskId, { status: 'failed', result_note: text });
      notify({ kind: 'failed', taskId: inf.taskId, reason: 'pty_error' });
      recordFailure(isApiErrorNote(text) ? 'api_error' : 'pty_error');
      // Sem tick rápido — respeita eventual pausa do breaker.
    }
  });
  scheduleNext(4000);
}

function stop() {
  _stopped = true;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

// Forca uma checagem imediata (chamado quando settings/tasks mudam pela UI).
async function poke() { await refreshSettings(true); scheduleNext(500); }

function breakerState() { return { open: breakerBlocking(), pausedUntil: _breakerUntil, recentFailures: _failWindow.length }; }
module.exports = { setMainWindow, start, stop, poke, registerLoop, stopLoop, breakerState, resetBreaker };
