'use strict';
// Cliente OpenAI Realtime API (gpt-4o-realtime). WebSocket no main process pra
// não vazar a chave no renderer. Renderer manda áudio (PCM16 base64) via IPC,
// main forwarda pra OpenAI; áudio de saída da OpenAI volta como deltas que o
// main encaminha pro renderer reproduzir via Web Audio.
//
// Function calling: a Realtime API anuncia tools via session.update; quando o
// modelo chama uma function, recebemos `response.function_call_arguments.done`
// → executamos via realtime-tools → respondemos com conversation.item.create
// (tipo function_call_output) + response.create pra ela falar a resposta.

let WS = null; try { WS = require('ws'); } catch {}
const openaiKey = require('./openai-key');
const tools = require('./realtime-tools');
const claudePty = require('./claude-pty'); // acompanha o turno despachado pela voz

// Modelo GA (o preview da beta saiu do ar). Sobrescrevível por env pra não
// precisar de release quando a OpenAI publicar um snapshot novo.
const MODEL = process.env.MAESTRUS_REALTIME_MODEL || 'gpt-realtime';
const URL_BASE = 'wss://api.openai.com/v1/realtime';
// Voz do Maestrus: masculina, fixa. Um produto tem UMA voz — trocar de timbre a
// cada sessão quebra a sensação de estar falando com o mesmo interlocutor.
const VOICE = 'ash';
// Taxa do PCM. Tem que bater com o AudioContext do renderer (realtime-voice.ts).
const PCM_RATE = 24000;

let ws = null;
let mainWindow = null;
let sessionId = null;
let activeProjectId = null;
let pendingFunctionCalls = new Map(); // call_id → { name, args }

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) try { mainWindow.webContents.send(channel, payload); } catch {}
}

function setMainWindow(w) { mainWindow = w; }

function isOpen() { return !!(ws && ws.readyState === 1); }

function instructions(lang) {
  const langLine = lang === 'pt' ? 'Sempre fale em português brasileiro.'
                  : lang === 'es' ? 'Habla siempre en español.'
                  : 'Always speak in English.';
  return [
    // Identidade: quem fala é o Maestrus, não um modelo genérico.
    `You are MAESTRUS, speaking in first person: the conductor of this user's projects.`,
    langLine,
    `Personality: calm, sharp, dry wit, zero servility. Never grovel, never pad with "claro!" or "com certeza!".`,
    `You talk like a trusted chief of staff who already knows the projects — brief, direct, no ceremony.`,
    `Never mention Claude, Anthropic, OpenAI or any underlying model: you ARE Maestrus.`,

    // Voz: fala de gente, nunca documentação lida em voz alta.
    `This is a VOICE conversation. Speak in short, natural sentences — 1 to 3 unless asked to elaborate.`,
    `No markdown, no lists, no headings, no emoji, no code, no file paths read aloud.`,
    `Round numbers and describe identifiers instead of dictating them: say "uns cinco arquivos" or "o arquivo do parser", never a full path or a hash digit by digit.`,

    // Fluxo de decisão: consultar antes de trabalhar. Sem isto o modelo
    // despachava um turno novo pra perguntar algo que já estava respondido no
    // histórico — caro, lento e irritante pra quem já tinha a resposta.
    `DECISION ORDER, always in this order:`,
    `1. If the user asks about something already discussed, call read_conversation FIRST and answer from it. Do not dispatch.`,
    `2. If you are unsure whether work is still running, call work_status. NEVER say "terminou", "não veio resposta" or "não retornou nada" without checking it first — the agent is often still working.`,
    `3. Only dispatch_project when there is genuinely NEW work to do.`,

    // Ação: o trabalho pesado é despachado, não descrito.
    `When the user asks you to DO something new in a project, call dispatch_project — don't describe what you would do.`,
    `Dispatch returns IMMEDIATELY, while the work runs in background. Say one short line acknowledging it ("beleza, olhando isso") and then KEEP TALKING with the user normally.`,
    `You will later receive a system message with the finished result.`,

    // A regra que resolve o texto cheio de path/número: RESUMIR, nunca recitar.
    `CRITICAL: when a dispatched result arrives, do NOT read it out loud. It is written text full of paths, numbers and code.`,
    `Read it silently, understand the OUTCOME, and tell the user in one or two spoken sentences what happened —`,
    `"ajustei o parser do stream, três arquivos, os testes passaram". Offer detail only if they ask.`,
    `If the result is an error, say plainly what failed in one sentence.`,
    // Stand-by: áudio é cobrado por minuto, então tagarelar enquanto espera é
    // caro e cansativo. Fica quieto até ter o que dizer.
    `While work is running, STAY QUIET unless the user speaks to you. Do not fill the silence, do not narrate progress, do not repeat that you are working.`,
    `Answer the user normally if they talk to you meanwhile — the pending work does not block the conversation.`,
  ].join(' ');
}

// ─── Ponte trabalho → fala ──────────────────────────────────────────────────
// dispatch_project volta na hora e o Claude trabalha em background. Sem esta
// ponte o usuário ficava sem saber quando terminou (era a "demora" sentida no
// modo voz). Aqui acompanhamos o turno despachado e, no 'done', entregamos o
// resultado ao Realtime — que RESUME em fala, em vez de recitar o texto cru
// cheio de path e número.
const watching = new Map(); // projectId → { name, text }
let unwatch = null;

// Fila de resultados: se dois despachos terminam quase juntos, falar os dois de
// uma vez vira atropelo. Entrega um, espera a fala acabar, entrega o próximo.
const resultQueue = [];
let speakingResult = false;

/** Passa a acompanhar um projeto despachado pela voz. */
function watchDispatch(projectId, projectName) {
  watching.set(projectId, { name: projectName || 'projeto', text: '' });
  ensureWatcher();
}

function ensureWatcher() {
  if (unwatch) return;
  unwatch = claudePty.onEvent((payload) => {
    if (!payload || !watching.has(payload.projectId)) return;
    const w = watching.get(payload.projectId);

    // Acumula só o texto do assistente — tool calls e thinking não interessam
    // pra fala.
    if (payload.type === 'assistant-text' && payload.text) {
      w.text += payload.text;
      return;
    }
    if (payload.type !== 'done') return;

    watching.delete(payload.projectId);
    if (!isOpen()) return;                    // usuário fechou a voz: nada a falar
    if (payload.cancelled) return;            // ele mesmo mandou parar

    // Corta: o modelo só precisa do suficiente pra entender o desfecho, e texto
    // gigante aqui é token caro num canal cobrado por minuto.
    const body = (w.text || '').trim().slice(0, 4000) || 'terminou sem produzir texto.';
    resultQueue.push({ name: w.name, body });
    send('realtime:event', { type: 'dispatch_done', project: w.name });
    drainResults();
  });
}

/**
 * Entrega UM resultado por vez ao Realtime. Enquanto ele fala, o próximo espera:
 * dois resultados simultâneos viravam duas respostas sobrepostas.
 */
function drainResults() {
  if (speakingResult || !resultQueue.length || !isOpen()) return;
  const { name, body } = resultQueue.shift();
  speakingResult = true;
  safeSend({
    type: 'conversation.item.create',
    item: {
      type: 'message', role: 'system',
      content: [{ type: 'input_text', text:
        `[RESULTADO de ${name}] O trabalho terminou. LEIA e RESUMA em uma ou duas frases faladas — nunca leia o texto em voz alta, nunca dite caminhos, números ou código:\n\n${body}` }],
    },
  });
  safeSend({ type: 'response.create' });
}

/** Há trabalho despachado ainda rodando? Usado pelo stand-by. */
function hasPendingWork() { return watching.size > 0; }

function stopWatching() {
  watching.clear();
  resultQueue.length = 0;
  speakingResult = false;
  try { unwatch && unwatch(); } catch {}
  unwatch = null;
}

async function start({ projectId, lang } = {}) {
  if (!WS) return { ok: false, error: 'ws_not_installed' };
  if (isOpen()) return { ok: true, alreadyOpen: true };
  const key = await openaiKey.getKey();
  if (!key) return { ok: false, error: 'no_openai_key' };

  activeProjectId = projectId || null;
  try {
    // API GA: SEM o header 'OpenAI-Beta: realtime=v1' (a beta foi desligada —
    // "The Realtime Beta API is no longer supported. Please use /v1/realtime").
    ws = new WS(`${URL_BASE}?model=${encodeURIComponent(MODEL)}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
  } catch (e) {
    return { ok: false, error: 'ws_connect: ' + (e && e.message) };
  }

  ws.on('open', () => {
    send('realtime:status', { status: 'connected' });
    // Configura a sessão no formato GA. Mudou tudo em relação à beta:
    //  · session.type é OBRIGATÓRIO ("parameter missing session.type" sem ele);
    //  · modalities → output_modalities;
    //  · input_audio_format/output_audio_format (string) → audio.input/.output
    //    .format como OBJETO {type:'audio/pcm', rate};
    //  · input_audio_transcription → audio.input.transcription;
    //  · turn_detection → audio.input.turn_detection.
    // A taxa é 24kHz pra bater com o que o renderer captura e toca (AudioContext
    // a 24000 em realtime-voice.ts) — divergir aqui deixa a voz acelerada/grave.
    safeSend({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: instructions(lang || 'pt'),
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: PCM_RATE },
            transcription: { model: 'whisper-1' },
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: 500 },
          },
          output: { format: { type: 'audio/pcm', rate: PCM_RATE }, voice: VOICE },
        },
        tools: tools.definitions(),
        tool_choice: 'auto',
      },
    });
  });

  ws.on('message', async (raw) => {
    let ev = null;
    try { ev = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!ev || !ev.type) return;
    await handleEvent(ev);
  });

  ws.on('close', (code) => {
    send('realtime:status', { status: 'closed', code });
    ws = null; sessionId = null;
  });

  ws.on('error', (err) => {
    send('realtime:status', { status: 'error', message: String(err && err.message || err) });
  });

  return { ok: true };
}

function safeSend(obj) {
  if (!isOpen()) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

async function handleEvent(ev) {
  switch (ev.type) {
    case 'session.created':
    case 'session.updated':
      sessionId = ev.session && ev.session.id || sessionId;
      send('realtime:event', { type: ev.type, sessionId });
      return;
    // Os nomes GA ganharam o prefixo "output_" (response.audio.delta →
    // response.output_audio.delta). Aceitamos OS DOIS: assim a voz não quebra se
    // a conta ainda estiver num snapshot antigo nem quando a OpenAI virar a chave.
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      // ev.delta = base64 PCM16. Encaminha pro renderer reproduzir.
      send('realtime:audio', { delta: ev.delta, response_id: ev.response_id });
      return;
    case 'response.output_audio.done':
    case 'response.audio.done':
      send('realtime:event', { type: 'audio_done' });
      return;
    case 'response.output_audio_transcript.delta':
    case 'response.output_text.delta':
    case 'response.audio_transcript.delta':
      send('realtime:transcript', { kind: 'assistant', delta: ev.delta || '' });
      return;
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      send('realtime:transcript', { kind: 'assistant', done: true, text: ev.transcript || '' });
      return;
    case 'conversation.item.input_audio_transcription.completed':
      send('realtime:transcript', { kind: 'user', done: true, text: ev.transcript || '' });
      return;
    case 'response.function_call_arguments.delta':
      // streaming dos args — descarta, esperamos o .done
      return;
    case 'response.function_call_arguments.done': {
      const callId = ev.call_id;
      const name = ev.name;
      let args = {}; try { args = JSON.parse(ev.arguments || '{}'); } catch {}
      pendingFunctionCalls.set(callId, { name, args });
      send('realtime:event', { type: 'tool_call', name, callId });
      // Executa de forma assíncrona
      tools.run(name, args, { projectId: activeProjectId, mainWindow })
        .then((result) => {
          // Envia o resultado de volta + pede pra continuar a resposta
          safeSend({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result ?? null) },
          });
          safeSend({ type: 'response.create' });
          send('realtime:event', { type: 'tool_result', name, callId, ok: true });
        })
        .catch((err) => {
          safeSend({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ error: String(err && err.message || err) }) },
          });
          safeSend({ type: 'response.create' });
          send('realtime:event', { type: 'tool_result', name, callId, ok: false, error: String(err && err.message || err) });
        });
      return;
    }
    case 'response.done':
      // Terminou de falar: se havia outro resultado esperando, entrega agora.
      if (speakingResult) { speakingResult = false; setTimeout(drainResults, 60); }
      send('realtime:event', { type: 'response_done' });
      return;
    case 'error': {
      const err = ev.error || {};
      const msg = err.message || 'unknown';
      // Erro de SCHEMA da sessão (parâmetro faltando/inválido, modelo inexistente)
      // é FATAL: a sessão nunca vai funcionar. Em vez de deixar o usuário num
      // modo voz morto, marcamos fatal → o chat cai sozinho pro modo turn-based
      // (STT+TTS+CLI), que não depende do schema da Realtime. Assim uma mudança
      // futura da OpenAI degrada a experiência em vez de quebrá-la.
      const fatal = /missing|invalid|unknown parameter|unsupported|not found|does not exist|model/i.test(msg)
        || err.type === 'invalid_request_error';
      console.warn('[maestrus][realtime] erro da API:', msg);
      send('realtime:status', { status: 'error', message: msg, fatal });
      if (fatal) { try { ws && ws.close(); } catch {} }
      return;
    }
    default:
      // Outros eventos: descartamos por enquanto.
      return;
  }
}

// Renderer → OpenAI: chunk de áudio do mic (base64 PCM16 24kHz mono).
function appendAudio(b64) {
  return safeSend({ type: 'input_audio_buffer.append', audio: b64 });
}

// Indica que terminou de mandar áudio nesse turno (server_vad já comita sozinho,
// mas é útil quando push-to-talk).
function commitAudio() {
  if (!isOpen()) return false;
  safeSend({ type: 'input_audio_buffer.commit' });
  safeSend({ type: 'response.create' });
  return true;
}

function cancelResponse() {
  return safeSend({ type: 'response.cancel' });
}

function sendText(text) {
  if (!safeSend({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: String(text || '') }] },
  })) return false;
  return safeSend({ type: 'response.create' });
}

function setProject(projectId) { activeProjectId = projectId || null; }

function stop() {
  try { ws && ws.close(); } catch {}
  ws = null; sessionId = null; pendingFunctionCalls.clear();
  // Solta o listener do claude-pty: sem isso cada abrir/fechar da voz deixava
  // um listener vivo no barramento de eventos.
  stopWatching();
  return { ok: true };
}

function status() {
  return { open: isOpen(), sessionId, projectId: activeProjectId };
}

module.exports = {
  watchDispatch, hasPendingWork, setMainWindow, start, stop, appendAudio, commitAudio, cancelResponse, sendText, setProject, status };
