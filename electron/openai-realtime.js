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

const MODEL = 'gpt-4o-realtime-preview-2024-12-17';
const URL_BASE = 'wss://api.openai.com/v1/realtime';
const VOICE = 'shimmer'; // alloy, ash, ballad, coral, echo, sage, shimmer, verse

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
    `You are Maestrus, an AI orchestration assistant. The user speaks to you while working.`,
    langLine,
    `You can dispatch prompts to the user's coding projects, manage kanban tasks, run MCP tools, take screenshots, control the browser, and more — ALL via the tools provided.`,
    `Keep responses CONCISE and SPOKEN: this is a voice interface. Avoid markdown.`,
    `When the user asks to "do" something, USE A TOOL — don't just describe it.`,
    `If a tool call would take more than a few seconds, briefly acknowledge before/after.`,
  ].join(' ');
}

async function start({ projectId, lang } = {}) {
  if (!WS) return { ok: false, error: 'ws_not_installed' };
  if (isOpen()) return { ok: true, alreadyOpen: true };
  const key = await openaiKey.getKey();
  if (!key) return { ok: false, error: 'no_openai_key' };

  activeProjectId = projectId || null;
  try {
    ws = new WS(`${URL_BASE}?model=${encodeURIComponent(MODEL)}`, {
      headers: { 'Authorization': `Bearer ${key}`, 'OpenAI-Beta': 'realtime=v1' },
    });
  } catch (e) {
    return { ok: false, error: 'ws_connect: ' + (e && e.message) };
  }

  ws.on('open', () => {
    send('realtime:status', { status: 'connected' });
    // Configura a sessão: voz, instructions, tools, formato de áudio.
    safeSend({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        voice: VOICE,
        instructions: instructions(lang || 'pt'),
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: 500 },
        tools: tools.definitions(),
        tool_choice: 'auto',
        temperature: 0.8,
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
    case 'response.audio.delta':
      // ev.delta = base64 PCM16. Encaminha pro renderer reproduzir.
      send('realtime:audio', { delta: ev.delta, response_id: ev.response_id });
      return;
    case 'response.audio.done':
      send('realtime:event', { type: 'audio_done' });
      return;
    case 'response.audio_transcript.delta':
      send('realtime:transcript', { kind: 'assistant', delta: ev.delta || '' });
      return;
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
      send('realtime:event', { type: 'response_done' });
      return;
    case 'error':
      send('realtime:status', { status: 'error', message: (ev.error && ev.error.message) || 'unknown' });
      return;
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
  return { ok: true };
}

function status() {
  return { open: isOpen(), sessionId, projectId: activeProjectId };
}

module.exports = { setMainWindow, start, stop, appendAudio, commitAudio, cancelResponse, sendText, setProject, status };
