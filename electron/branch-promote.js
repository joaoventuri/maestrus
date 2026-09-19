// "Promover ao tronco": leva o que um ramo (fork) produziu de volta pra
// conversa principal do projeto, SEM misturar os transcripts.
//
// 1) Lê o ramo numa sessão descartável (--fork-session) e pede um resumo denso
//    do que foi feito/decidido — o ramo em si não ganha turno nem muda.
// 2) Entrega o resumo ao tronco como uma mensagem marcada; se o tronco estiver
//    no meio de um turno, entra na fila do host (nunca derruba o turno).
// O dono decide o que sobe; nada vaza sozinho entre ramos.
const projectStore = require('./project-store');
const claudePty = require('./claude-pty');
const turnQueue = require('./turn-queue');

const SUMMARY_PROMPT =
  'Resuma de forma densa e fiel o que foi FEITO e DECIDIDO nesta conversa desde que ela foi ramificada: ' +
  'objetivo, mudanças de código/arquivos (com caminhos), decisões e o porquê, pendências em aberto e ' +
  'qualquer convenção combinada. Escreva em tópicos, sem preâmbulo. NÃO use ferramentas nem execute nada — só o resumo.';

const _running = new Set();

async function promote(pid, convId) {
  const parent = projectStore.get(pid);
  const conv = parent && (parent.conversations || []).find((c) => c.id === convId);
  if (!parent || !conv) return { ok: false, error: 'not_found' };
  if (!conv.sessionId) return { ok: false, error: 'empty_branch' };
  const e = parent.engine;
  if (e === 'codex' || e === 'codex-api') return { ok: false, error: 'engine_unsupported' };
  const key = pid + '#' + convId;
  if (_running.has(key)) return { ok: false, error: 'already_running' };
  _running.add(key);
  try {
    const virt = projectStore.get(key);
    const r = await claudePty.dispatchOneShot(virt, SUMMARY_PROMPT, { timeoutMs: 240000, forkSession: true });
    const summary = String((r && r.text) || '').trim();
    if (!summary) return { ok: false, error: 'empty_summary' };
    const who = conv.branchOwner ? ` (${conv.branchOwner})` : '';
    const msg =
      `[Ramo "${conv.title}"${who} → tronco] Resumo do que foi feito e decidido neste ramo, promovido pelo dono ` +
      `para o contexto principal. Não execute nada agora: registre e responda apenas "Registrado.".\n\n${summary}`;
    try { await claudePty.send(parent, msg); }
    catch (err) {
      if (err && err.code === 'turn_in_progress') { turnQueue.enqueue(pid, { text: msg }); return { ok: true, queued: true }; }
      throw err;
    }
    try { projectStore.patchConversation(pid, convId, { promotedAt: Date.now() }); } catch {}
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  finally { _running.delete(key); }
}

module.exports = { promote };
