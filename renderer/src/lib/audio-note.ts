/**
 * Áudio por projeto: grava uma nota de voz e transcreve AO VIVO.
 *
 * Duas saídas do mesmo microfone, em paralelo:
 *   • MediaRecorder → blob webm/opus, que vira o player no balão da conversa
 *   • PCM16 24kHz  → WebSocket Realtime da OpenAI (sessão do tipo
 *     'transcription'), que devolve o texto em deltas enquanto você fala
 *
 * A sessão de transcrição NÃO gera resposta de IA nem áudio de volta: é só
 * speech-to-text em streaming, e roda com a chave OpenAI do próprio usuário
 * (BYOK), então o custo é dele e nada passa pelo nosso servidor.
 *
 * O que vai pro agente é o TEXTO. O áudio fica anexado pra reouvir.
 */

// A beta foi desligada ("The Realtime Beta API is no longer supported"): o
// subprotocolo openai-beta.realtime-v1 saiu e o corpo do session.update segue o
// schema GA (audio.input.format objeto, transcription/turn_detection aninhados).
// Sessão de TRANSCRIÇÃO da GA. Verificado contra a API real:
//   ?intent=transcription  → session.type 'transcription', aceita o update abaixo
//   ?model=gpt-realtime    → session.type 'realtime', e aí a API responde
//                            "Passing a transcription session update to a
//                             realtime session is not allowed"
//   ?model=gpt-4o-transcribe → "is a transcription model and cannot be used as
//                               the realtime session model"
//   sem query              → "You must provide a model parameter"
// Ou seja: aqui o intent SUBSTITUI o model (diferente do modo voz em
// electron/openai-realtime.js, que é sessão realtime e exige ?model=).
const RT_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const RT_RATE = 24000;

// Viés de vocabulário: sem isto o modelo escreve fonética portuguesa em cima de
// termo técnico ("array" → "arrei").
//
// CUIDADO — o prompt é uma faca de dois gumes: com áudio curto ou quase mudo,
// estes modelos ECOAM o prompt como se fosse a fala ("oi tudo bem" virava a
// lista inteira de termos). Por isso o prompt é curto e uma frase natural, não
// uma lista enorme: quanto menor e mais parecido com fala real, menor a chance
// de eco. O guard isEcho() abaixo descarta o que escapar disso.
const TECH_VOCAB =
  'Conversa sobre programação: array, database, deploy, commit, endpoint, backend, frontend, build.';

// Assinatura do prompt pra reconhecer o eco: palavras raras que só aparecem
// juntas se o modelo devolveu o prompt.
const ECHO_MARKERS = ['array', 'database', 'deploy', 'commit', 'endpoint', 'backend', 'frontend', 'build'];

/**
 * O texto transcrito é, na verdade, o prompt ecoado?
 *
 * Heurística: se aparecem 4+ dos termos do prompt E o texto é essencialmente
 * só isso (quase nenhuma palavra fora da lista), é eco. Uma frase real que
 * mencione "deploy do backend" tem muitas outras palavras em volta, então não
 * dispara.
 */
function isEcho(text: string): boolean {
  const t = text.toLowerCase();
  const hits = ECHO_MARKERS.filter((w) => t.includes(w)).length;
  if (hits < 4) return false;
  const words = t.split(/[^a-zà-ú]+/i).filter((w) => w.length > 2);
  if (!words.length) return true;
  const fromPrompt = words.filter((w) => ECHO_MARKERS.includes(w) || 'conversa sobre programacao programação'.includes(w)).length;
  return fromPrompt / words.length > 0.6;
}

export type AudioNoteState = 'idle' | 'recording' | 'transcribing' | 'done' | 'error';

export interface AudioNoteResult {
  blob: Blob | null;
  mime: string;
  durationMs: number;
  text: string;
}

interface Handlers {
  /** Texto acumulado até agora (parcial enquanto grava). */
  onText?: (text: string) => void;
  /** Nível 0..1 pra desenhar a onda. */
  onLevel?: (level: number) => void;
  onState?: (s: AudioNoteState) => void;
  onError?: (message: string) => void;
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Média do intervalo — evita o aliasing metálico do "pega 1 a cada N".
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

function floatToPcm16b64(f32: Float32Array): string {
  const buf = new ArrayBuffer(f32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as any);
  }
  return btoa(bin);
}

export class AudioNoteRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private ws: WebSocket | null = null;
  private startedAt = 0;
  private levelTimer: number | null = null;

  /** Trechos já fechados pelo modelo + o delta em curso. */
  private committed = '';
  private partial = '';
  private state: AudioNoteState = 'idle';

  constructor(private h: Handlers = {}) {}

  private setState(s: AudioNoteState) {
    this.state = s;
    this.h.onState?.(s);
  }

  private emitText() {
    const txt = (this.committed + ' ' + this.partial).replace(/\s+/g, ' ').trim();
    this.h.onText?.(txt);
  }

  /** Abre a sessão de transcrição. Falhar aqui não impede a gravação. */
  private async openSocket(apiKey: string, lang: string) {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try {
        // No browser a chave vai por subprotocolo (não há como pôr header no
        // handshake). É a chave do próprio usuário e a conexão é TLS direta
        // com a OpenAI — nunca passa pelo nosso backend.
        const ws = new WebSocket(RT_URL, [
          'realtime',
          'openai-insecure-api-key.' + apiKey,
        ]);
        this.ws = ws;

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: RT_RATE },
                  transcription: { model: 'gpt-4o-transcribe', language: lang, prompt: TECH_VOCAB },
                  // Sem server_vad: quem decide o fim é o usuário soltando o
                  // botão. Assim pausa longa pra pensar não fecha a nota.
                  turn_detection: null,
                },
              },
            },
          }));
          done();
        };

        ws.onmessage = (ev) => {
          let msg: any;
          try { msg = JSON.parse(String(ev.data)); } catch { return; }
          if (msg.type === 'conversation.item.input_audio_transcription.delta') {
            this.partial += msg.delta || '';
            this.emitText();
          } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
            const got = String(msg.transcript || this.partial || '');
            // Áudio curto/silencioso faz o modelo devolver o PROMPT como se
            // fosse fala. Descarta em vez de mandar a lista de termos ao agente.
            if (isEcho(got)) { this.partial = ''; this.emitText(); return; }
            this.committed = (this.committed + ' ' + got).trim();
            this.partial = '';
            this.emitText();
          } else if (msg.type === 'error') {
            const m = (msg.error && msg.error.message) || 'erro na transcrição';
            this.h.onError?.(m);
          }
        };
        ws.onerror = () => { this.h.onError?.('não foi possível conectar à transcrição'); done(); };
        ws.onclose = () => done();
        // Não trava a gravação esperando a sessão subir.
        setTimeout(done, 2500);
      } catch (e: any) {
        this.h.onError?.(e?.message || 'falha ao abrir a transcrição');
        done();
      }
    });
  }

  async start(opts: { apiKey?: string; lang?: string } = {}) {
    if (this.state === 'recording') return;
    this.committed = ''; this.partial = ''; this.chunks = [];

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // Blob pro player. Deixa o browser escolher o container que ele sabe gravar.
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m)) || '';
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(250);

    if (opts.apiKey) await this.openSocket(opts.apiKey, opts.lang || 'pt');

    // PCM16 pro socket + nível pra onda.
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);

    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const pcm = downsample(e.inputBuffer.getChannelData(0), this.ctx!.sampleRate, RT_RATE);
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: floatToPcm16b64(pcm) }));
    };
    src.connect(this.node);
    this.node.connect(this.ctx.destination); // ScriptProcessor só roda se ligado à saída

    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.levelTimer = window.setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
      this.h.onLevel?.(Math.min(1, peak * 1.6));
    }, 60);

    this.startedAt = Date.now();
    this.setState('recording');
  }

  /** Encerra a captura e devolve áudio + texto. */
  async stop(): Promise<AudioNoteResult> {
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }

    const blob = await new Promise<Blob | null>((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state === 'inactive') return resolve(this.chunks.length ? new Blob(this.chunks) : null);
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
      try { rec.stop(); } catch { resolve(null); }
    });

    try { this.node && (this.node.onaudioprocess = null as any); this.node?.disconnect(); } catch {}
    try { this.analyser?.disconnect(); } catch {}
    try { await this.ctx?.close(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}

    // Fecha o buffer pra o modelo transcrever o resto antes de desligar.
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.setState('transcribing');
      try { ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch {}
      // Espera curta pelo último trecho: se não vier, entrega o que já tem.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        const prev = ws.onmessage;
        ws.onmessage = (ev) => {
          prev?.call(ws, ev);
          try {
            const m = JSON.parse(String(ev.data));
            if (m.type === 'conversation.item.input_audio_transcription.completed') {
              clearTimeout(t); resolve();
            }
          } catch {}
        };
      });
    }
    try { ws?.close(); } catch {}
    this.ws = null;
    this.recorder = null;
    this.ctx = null;
    this.node = null;
    this.analyser = null;
    this.stream = null;

    let text = (this.committed + ' ' + this.partial).replace(/\s+/g, ' ').trim();
    if (isEcho(text)) text = ''; // rede de segurança: nunca entrega o prompt como fala
    this.setState('done');
    return { blob, mime: blob?.type || 'audio/webm', durationMs, text };
  }

  /** Aborta sem entregar nada (usuário arrastou pra cancelar). */
  cancel() {
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    try { this.recorder?.state !== 'inactive' && this.recorder?.stop(); } catch {}
    try { this.node && (this.node.onaudioprocess = null as any); this.node?.disconnect(); } catch {}
    try { this.ctx?.close(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ws?.close(); } catch {}
    this.ws = null; this.recorder = null; this.ctx = null; this.node = null; this.stream = null;
    this.chunks = [];
    this.setState('idle');
  }
}

/** Duração legível pro player: 0:07, 1:32. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
