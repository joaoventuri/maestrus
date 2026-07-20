// Modo Voz "Jarvis" — turn-based, 100% OpenAI via backend (a chave fica só no
// servidor maestrus.cloud, medida por uso). Mesmo fluxo no desktop e no PWA:
//   - STT: grava uma fala (segmenta por silêncio) → POST /api.php?action=voice_stt
//          → OpenAI /v1/audio/transcriptions → texto.
//   - TTS: POST /api.php?action=realtime_tts → OpenAI /v1/audio/speech → PCM16
//          24kHz mono, tocado via Web Audio API (funciona até no iPhone).
// Idioma sempre o da UI (não deduz do áudio/modelo).

export type Lang = 'en' | 'pt' | 'es';
const API = 'https://maestrus.cloud';

// License key da conta logada — exigida pelos endpoints medidos do backend.
async function licenseKey(): Promise<string> {
  try {
    const m: any = (typeof window !== 'undefined') ? (window as any).maestrus : null;
    const acc = m && m.cloud && m.cloud.account ? await m.cloud.account() : null;
    return (acc && acc.licenseKey) || '';
  } catch { return ''; }
}

// ─── Audio unlock (iOS) ─────────────────────────────────────────────────────
// iOS Safari só toca áudio iniciado durante um user gesture. Chamamos isto na
// hora em que o usuário toca em "voz" para já criar+resumir o AudioContext e
// tocar um WAV silencioso (libera as Media APIs).
let _audioUnlocked = false;
const SILENT_WAV = 'UklGRiwAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
export function unlockAudio(): void {
  try { ensureAudio(); } catch {}
  if (_audioUnlocked) return;
  try {
    const a = new Audio('data:audio/wav;base64,' + SILENT_WAV);
    a.volume = 0;
    a.play().then(() => { _audioUnlocked = true; }).catch(() => {});
  } catch {}
}

// ─── TTS (OpenAI /v1/audio/speech via backend) ──────────────────────────────
// O backend retorna PCM16 24kHz mono; tocamos cada pedaço assim que chega.
export function ttsSupported(): boolean { return typeof window !== 'undefined'; }

const PCM_RATE = 24000; // OpenAI tts → PCM16 24kHz
let _audioCtx: AudioContext | null = null;
let _master: GainNode | null = null;
let _playTime = 0;
let _scheduled: AudioBufferSourceNode[] = [];
let _activeAbort: AbortController | null = null;

function ensureAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!_audioCtx) {
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    _audioCtx = new AC();
    _master = _audioCtx!.createGain();
    _master.connect(_audioCtx!.destination);
  }
  if (_audioCtx!.state === 'suspended') { try { _audioCtx!.resume(); } catch {} }
  return _audioCtx;
}

function stopScheduled(): void {
  for (const s of _scheduled) { try { s.stop(0); s.disconnect(); } catch {} }
  _scheduled = [];
  if (_audioCtx) _playTime = _audioCtx.currentTime;
}

// Texto: remove markdown que polui a fala (code fences, asteriscos, links…).
function cleanForTTS(t: string): string {
  return (t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~|>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

async function streamPcmToAudio(text: string, lang: Lang, license: string, signal: AbortSignal): Promise<void> {
  const ctx = ensureAudio();
  if (!ctx) throw new Error('no audio context');
  const res = await fetch(`${API}/api.php?action=realtime_tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lang, license_key: license }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error('http ' + res.status);
  const reader = res.body.getReader();
  if (_playTime < ctx.currentTime + 0.02) _playTime = ctx.currentTime + 0.02;
  let leftover: Uint8Array | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    let bytes: Uint8Array = value;
    if (leftover) {
      const merged = new Uint8Array(leftover.length + bytes.length);
      merged.set(leftover, 0); merged.set(bytes, leftover.length);
      bytes = merged; leftover = null;
    }
    const usable = bytes.length & ~1; // múltiplo de 2 (int16)
    if (usable < bytes.length) leftover = bytes.slice(usable);
    if (usable === 0) continue;
    const view = new Int16Array(bytes.buffer, bytes.byteOffset, usable >> 1);
    const float32 = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) float32[i] = view[i] / 32768;
    const buf = ctx.createBuffer(1, float32.length, PCM_RATE);
    buf.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(_master!);
    src.start(_playTime);
    _playTime += float32.length / PCM_RATE;
    _scheduled.push(src);
    src.onended = () => {
      const i = _scheduled.indexOf(src);
      if (i >= 0) _scheduled.splice(i, 1);
      try { src.disconnect(); } catch {}
    };
  }
}

export async function ttsSpeak(text: string, lang: Lang, onEnd?: () => void): Promise<void> {
  const clean = cleanForTTS(text);
  if (!clean) { onEnd && onEnd(); return; }

  // Cancela só requisições anteriores; mantém o áudio já agendado tocando
  // (assim sentenças encadeadas não engasgam).
  if (_activeAbort) { try { _activeAbort.abort(); } catch {} }
  _activeAbort = new AbortController();
  const signal = _activeAbort.signal;

  try {
    const license = await licenseKey();
    if (signal.aborted) return;
    const ctxBefore = _audioCtx;
    await streamPcmToAudio(clean, lang, license, signal);
    if (signal.aborted) return;
    const ctx = _audioCtx || ctxBefore;
    if (!ctx) { onEnd && onEnd(); return; }
    const waitMs = Math.max(0, (_playTime - ctx.currentTime) * 1000 + 30);
    setTimeout(() => { if (!signal.aborted) onEnd && onEnd(); }, waitMs);
  } catch {
    if (signal.aborted) return;
    onEnd && onEnd(); // falhou → segue o loop (re-escuta), sem travar
  }
}

export function ttsCancel(): void {
  if (_activeAbort) { try { _activeAbort.abort(); } catch {} _activeAbort = null; }
  stopScheduled();
}

// ─── STT (OpenAI /v1/audio/transcriptions via backend) ──────────────────────
export interface SttEngine {
  supported(): boolean;
  start(lang: Lang, cb: { onFinal: (t: string) => void; onInterim?: (t: string) => void; onError?: (e: string) => void; onEnd?: () => void }): void;
  stop(): void;
}

// Captura UMA fala (segmenta por silêncio), manda o áudio pro backend (OpenAI) e
// chama onFinal com o texto. Uma utterance por start() — o controlador re-escuta.
class OpenAISTT implements SttEngine {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private running = false;
  private raf = 0;
  private cb: any = null;
  private lang: Lang = 'en';
  private hadSpeech = false;
  private startedAt = 0;
  private maxTimer: any = null;

  supported(): boolean {
    return typeof window !== 'undefined' && !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function' && (window as any).MediaRecorder);
  }

  async start(lang: Lang, cb: any): Promise<void> {
    this.lang = lang; this.cb = cb; this.running = true; this.hadSpeech = false; this.chunks = [];
    this.startedAt = performance.now();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch { this.running = false; cb.onError && cb.onError('mic'); return; }
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    const src = this.ctx!.createMediaStreamSource(this.stream);
    this.analyser = this.ctx!.createAnalyser(); this.analyser.fftSize = 2048;
    src.connect(this.analyser);
    try {
      this.rec = new MediaRecorder(this.stream);
      this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.rec.onstop = () => this.finalize();
      this.rec.start(250);
    } catch { this.running = false; cb.onError && cb.onError('rec'); return; }
    // Sem fala em 12s → encerra o segmento (o controlador re-escuta).
    this.maxTimer = setTimeout(() => { if (!this.hadSpeech) this.endSegment(); }, 12000);
    this.monitor();
  }

  private monitor(): void {
    const buf = new Uint8Array(this.analyser!.frequencyBinCount);
    let silenceStart = 0;
    const SILENCE_MS = 1000, THRESH = 0.012;
    const tick = () => {
      if (!this.running || !this.analyser) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > THRESH) { this.hadSpeech = true; silenceStart = 0; }
      else if (this.hadSpeech) {
        if (!silenceStart) silenceStart = now;
        else if (now - silenceStart > SILENCE_MS) { this.endSegment(); return; }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private endSegment(): void {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); else this.finalize(); } catch { this.finalize(); }
  }

  private async finalize(): Promise<void> {
    const had = this.hadSpeech;
    const durMs = Math.round(performance.now() - this.startedAt);
    const type = this.rec?.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    this.cleanup();
    if (!had || blob.size < 1200) { this.cb && this.cb.onEnd && this.cb.onEnd(); return; }
    try {
      const license = await licenseKey();
      const fd = new FormData();
      const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
      fd.append('audio', blob, `speech.${ext}`);
      fd.append('lang', this.lang);
      fd.append('license_key', license);
      fd.append('duration_ms', String(durMs));
      const res = await fetch(`${API}/api.php?action=voice_stt`, { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({}));
      const text = (j && j.text || '').trim();
      if (text && this.cb) { this.cb.onFinal(text); return; }
    } catch { /* descarta o segmento */ }
    this.cb && this.cb.onEnd && this.cb.onEnd();
  }

  private cleanup(): void {
    this.running = false;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx && this.ctx.close(); } catch {}
    this.stream = null; this.ctx = null; this.analyser = null; this.rec = null; this.chunks = [];
  }

  stop(): void {
    this.running = false;
    if (this.rec) { try { this.rec.onstop = null; if (this.rec.state !== 'inactive') this.rec.stop(); } catch {} }
    this.cleanup();
  }
}

// Engine único — OpenAI em todas as plataformas.
let _stt: SttEngine = new OpenAISTT();
export function getSttEngine(): SttEngine { return _stt; }
export function setSttEngine(e: SttEngine): void { _stt = e; }
export function sttSupported(): boolean { return _stt.supported(); }

// Compat: o controlador (ProjectChat) chama isto antes de capturar o mic. Não há
// mais o que resolver (engine único), então é um no-op.
export async function resolveSttEngineFromConfig(): Promise<void> { /* OpenAI sempre */ }

// ─── Sentence splitter for streaming TTS ────────────────────────────────────
// Extrai frases faláveis enquanto a resposta da IA chega em stream.
// Divide apenas em pontuação final (.!?) ou parágrafo duplo (\n\n).
// NÃO divide em vírgula, dois-pontos, travessão ou \n simples — essas
// quebras produzem fragmentos sonoros incompletos ("agora vou procurar o que").
// Para frases muito longas sem ponto (25+ palavras), força divisão num espaço.
let _firstChunkEmitted = false;
export function resetSentenceSplitter(): void { _firstChunkEmitted = false; }
export function extractSentences(text: string): { sentences: string[]; remaining: string } {
  const sentences: string[] = [];
  let s = text;
  while (true) {
    let m: RegExpMatchArray | null = null;
    if (!_firstChunkEmitted) {
      // Primeiro chunk: mínimo 5 palavras + pontuação final ou parágrafo duplo.
      // Evita começar a falar com fragmento de 3 palavras que termina em vírgula.
      m = s.match(/^(\s*\S+(?:\s+\S+){4,}?[.!?])(\s[\s\S]*)$/) ||
          s.match(/^(.{50,}?)\n\n([\s\S]*)$/);
    }
    if (!m) {
      m = s.match(/^(.{5,}?[.!?])(\s[\s\S]*)$/) ||
          s.match(/^(.{5,}?)\n\n([\s\S]*)$/) ||
          s.match(/^(\s*\S+(?:\s+\S+){24,}?)(\s[\s\S]*)$/);
    }
    if (!m) break;
    const sentence = m[1].trim();
    s = (m[2] || '').trimStart();
    if (sentence) { sentences.push(sentence); _firstChunkEmitted = true; }
  }
  return { sentences, remaining: s };
}
