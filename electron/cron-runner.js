/**
 * Agendador das rotinas. Roda no HOST.
 *
 * Três decisões que definem o comportamento:
 *
 * 1. Acorda a cada 20s e compara o MINUTO corrente, em vez de calcular o
 *    próximo disparo com setTimeout longo. Timer longo derrapa quando a máquina
 *    dorme (notebook fechado) e nunca dispara ao acordar. O guard `_ranAt`
 *    garante uma execução por minuto, mesmo acordando 3x dentro dele.
 *
 * 2. Nunca faz spawn direto. Entrega o prompt à fila do host (turn-queue), a
 *    mesma que o chat usa. Assim a rotina nunca atropela um turno em andamento
 *    nem duas rotinas colidem no mesmo projeto — o problema clássico de cron
 *    com agente.
 *
 * 3. O padrão é sessão efêmera. Uma rotina de 30 em 30 minutos numa conversa
 *    madura reenviaria ~400k tokens de contexto por disparo, e o cache de
 *    prompt já expirou nesse intervalo: seriam 48 execuções/dia pagando o
 *    contexto inteiro como input novo. Efêmero manda só o prompt.
 */
const cronStore = require('./cron-store');

let timer = null;
let deps = null;
const _ranAt = new Map();   // jobId -> "YYYY-MM-DDTHH:MM" já executado

const TICK_MS = 20 * 1000;

function minuteKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}T${d.getHours()}:${d.getMinutes()}`;
}

/**
 * deps.enqueue(projectId, prompt, opts) — entrega à fila do host
 * deps.dispatchEphemeral(projectId, prompt) — execução em sessão própria
 * deps.projectExists(projectId) — projeto ainda existe?
 * deps.log(msg)
 */
function start(d) {
  deps = d || {};
  stop();
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  tick();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(now = new Date()) {
  let all = [];
  try { all = cronStore.listAll(); } catch { return; }
  const key = minuteKey(now);
  for (const job of all) {
    if (!job.enabled) continue;
    if (_ranAt.get(job.id) === key) continue;          // já rodou neste minuto
    let matches = false;
    try { matches = cronStore.cronMatches(job.cron, now); } catch {}
    if (!matches) continue;
    _ranAt.set(job.id, key);
    runJob(job).catch(() => {});
  }
  // O mapa não pode crescer para sempre: guarda só o minuto corrente.
  for (const [id, k] of _ranAt) if (k !== key) _ranAt.delete(id);
}

async function runJob(job) {
  const { projectId } = job;
  // Projeto apagado com rotina viva: limpa em vez de falhar em silêncio a cada
  // minuto para sempre.
  try {
    if (deps.projectExists && !deps.projectExists(projectId)) {
      cronStore.removeProject(projectId);
      return;
    }
  } catch {}

  const started = Date.now();
  try {
    if (job.ephemeral && deps.dispatchEphemeral) {
      await deps.dispatchEphemeral(projectId, job.prompt, job);
      cronStore.recordRun(projectId, job.id, { status: 'ok', mode: 'ephemeral', ms: Date.now() - started });
    } else if (deps.enqueue) {
      await deps.enqueue(projectId, job.prompt, { conversationId: job.conversationId, source: 'cron', jobId: job.id });
      cronStore.recordRun(projectId, job.id, { status: 'queued', mode: 'queue', ms: Date.now() - started });
    } else {
      cronStore.recordRun(projectId, job.id, { status: 'error', error: 'sem_executor', ms: Date.now() - started });
    }
  } catch (e) {
    cronStore.recordRun(projectId, job.id, {
      status: 'error', error: String((e && e.message) || e).slice(0, 300), ms: Date.now() - started,
    });
    try { deps.log && deps.log(`[cron] falhou ${job.id}: ${e && e.message}`); } catch {}
  }
}

/** Execução manual ("Rodar agora"), sem esperar o horário. */
async function runNow(projectId, id) {
  const job = cronStore.get(projectId, id);
  if (!job) return { ok: false, error: 'not_found' };
  await runJob({ ...job, projectId });
  return { ok: true };
}

module.exports = { start, stop, tick, runNow, _ranAt };
