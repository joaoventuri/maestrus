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

// Chave OpenAI do usuário (BYOK). O backend (voice_stt / realtime_tts) EXIGE a
// chave no POST e responde 'no_api_key' sem ela — sem isto o STT nunca ouvia e o
// TTS caía no sintetizador nativo. Cacheada em memória por sessão.
let _oaiKey: string | null = null;
async function openaiKey(): Promise<string> {
  if (_oaiKey) return _oaiKey;
  try {
    const m: any = (typeof window !== 'undefined') ? (window as any).maestrus : null;
    const r = m && m.openaiKey && m.openaiKey.get ? await m.openaiKey.get() : null;
    if (r && r.key) { _oaiKey = r.key; return _oaiKey!; }
  } catch {}
  return '';
}
export function resetVoiceKeyCache(): void { _oaiKey = null; }

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
let _ttsAnalyser: AnalyserNode | null = null;

/** Analyser da voz da IA (saída do TTS) — usado pela onda do modo voz. */
export function getTtsAnalyser(): AnalyserNode | null { return _ttsAnalyser; }
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
    // Analyser no caminho da SAÍDA: deixa a UI desenhar a onda do que a IA está
    // falando de verdade, em vez de uma animação sintética. Fica entre o master
    // e a saída, então não altera o som.
    _ttsAnalyser = _audioCtx!.createAnalyser();
    _ttsAnalyser.fftSize = 256;
    _ttsAnalyser.smoothingTimeConstant = 0.75;
    _master.connect(_ttsAnalyser);
    _ttsAnalyser.connect(_audioCtx!.destination);
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
    // Marcadores de lista no início da linha ("- ", "* ", "1. ") — ler "hífen,
    // hífen, hífen" em voz alta é péssimo.
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/https?:\/\/\S+/g, '')          // URLs não se falam
    .replace(/^\s*\|.*\|\s*$/gm, '')         // linhas de tabela markdown
    .replace(/^\s*[-=]{3,}\s*$/gm, '')       // réguas / separadores
    .replace(/\b[\w./-]+\.(ts|tsx|js|jsx|json|php|css|html|md|py|sh|yml|yaml)\b/gi, '') // caminhos de arquivo
    .replace(/[*_~|>#`]/g, '')
    // ─── Pontuação que DESTRÓI a entonação ────────────────────────────────
    // O TTS muda de prosódia (e às vezes de idioma) quando encontra sopa de
    // símbolos: "v0.4.26", "src/lib/voice", "2026-08-12", "16:9". Aqui isso
    // vira fala de gente.
    .replace(/\bv?(\d+)\.(\d+)\.(\d+)\b/g, 'versão $1 ponto $2 ponto $3')  // 0.4.26
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3/$2/$1')                    // data ISO → dd/mm/aaaa
    .replace(/(\d)\s*[-–]\s*(\d)/g, '$1 a $2')                              // 10-20 → "10 a 20"
    .replace(/(\w)\/(\w)/g, '$1 $2')            // barra entre palavras vira pausa
    .replace(/\s[-–—]\s/g, ', ')                // travessão solto → vírgula (pausa natural)
    .replace(/([a-zà-ú])[-_]([a-zà-ú])/gi, '$1 $2') // kebab/snake case → palavras
    .replace(/\.{2,}/g, '.')                    // reticências repetidas
    .replace(/\s*([,.!?])\s*/g, '$1 ')          // espaçamento consistente da pontuação
    .replace(/[()[\]{}]/g, ' ')                 // parênteses/colchetes soltos
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

/** Texto pronto pra ser FALADO e pra virar LEGENDA. A legenda mostrava o texto
 *  cru (com markdown), então você via "**foo**" enquanto ouvia outra coisa. */
export function speakableText(t: string): string { return cleanForTTS(t); }

async function streamPcmToAudio(text: string, lang: Lang, license: string, signal: AbortSignal): Promise<void> {
  const ctx = ensureAudio();
  if (!ctx) throw new Error('no audio context');
  const res = await fetch(`${API}/api.php?action=realtime_tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // openai_key: o backend é BYOK e recusa com 'no_api_key' sem ela.
    body: JSON.stringify({ text, lang, license_key: license, openai_key: await openaiKey(), speed: TTS_SPEED, ...getTtsChoice2() }),
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
    // Voz de graça: sem cobrança do nosso lado. O TTS do servidor (OpenAI) só
    // roda com o token do próprio usuário; se não houver, cai na voz nativa do
    // navegador (speechSynthesis) — gratuita e local, funciona em web/PWA/desktop.
    nativeSpeak(clean, lang, signal, onEnd);
  }
}

// Fallback de TTS 100% local e gratuito (Web Speech API). Usado quando o TTS
// do servidor não está disponível (sem token OpenAI do usuário).
function nativeSpeak(text: string, lang: Lang, signal: AbortSignal, onEnd?: () => void): void {
  try {
    const synth = (typeof window !== 'undefined') ? window.speechSynthesis : null;
    if (!synth || signal.aborted) { onEnd && onEnd(); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es-ES' : 'en-US';
    const done = () => { if (!signal.aborted) onEnd && onEnd(); };
    u.onend = done; u.onerror = done;
    signal.addEventListener('abort', () => { try { synth.cancel(); } catch {} }, { once: true });
    synth.speak(u);
  } catch { onEnd && onEnd(); }
}

export function ttsCancel(): void {
  if (_activeAbort) { try { _activeAbort.abort(); } catch {} _activeAbort = null; }
  try { window.speechSynthesis?.cancel(); } catch {}
  stopScheduled();
}

// ─── STT (OpenAI /v1/audio/transcriptions via backend) ──────────────────────
export interface SttCallbacks {
  onFinal: (t: string) => void;
  onInterim?: (t: string) => void;
  onError?: (e: string) => void;
  onEnd?: () => void;
  /** Disparado quando a fala do USUÁRIO é CONFIRMADA (energia + banda de voz +
   *  duração). O controlador usa isto pra cortar o TTS — barge-in. */
  onSpeechStart?: () => void;
}
export interface SttEngine {
  supported(): boolean;
  /** `speaking`: a IA está falando agora → limiar mais rígido (não se
   *  interrompe com o próprio eco nem com ruído ambiente). */
  start(lang: Lang, cb: SttCallbacks, opts?: { speaking?: boolean }): void;
  stop(): void;
}

// ─── Catálogo de vozes (seletor na tela de voz) ─────────────────────────────
// Modelo primeiro, vozes depois: o gpt-4o-mini-tts é o multilíngue bom (fala
// português sem sotaque) e aceita direção de estilo; a família tts-1 é a antiga,
// mais rápida e mais barata, porém com sotaque em PT.
export type VoiceGender = 'm' | 'f' | 'n';
export interface TtsVoice { id: string; label: string; gender: VoiceGender; note?: string }
export interface TtsModel { id: string; label: string; desc: string; voices: TtsVoice[] }

const V_CORE: TtsVoice[] = [
  { id: 'alloy',   label: 'Alloy',   gender: 'n' },
  { id: 'ash',     label: 'Ash',     gender: 'm' },
  { id: 'ballad',  label: 'Ballad',  gender: 'm' },
  { id: 'coral',   label: 'Coral',   gender: 'f' },
  { id: 'echo',    label: 'Echo',    gender: 'm' },
  { id: 'fable',   label: 'Fable',   gender: 'n' },
  { id: 'nova',    label: 'Nova',    gender: 'f' },
  { id: 'onyx',    label: 'Onyx',    gender: 'm' },
  { id: 'sage',    label: 'Sage',    gender: 'f' },
  { id: 'shimmer', label: 'Shimmer', gender: 'f' },
  { id: 'verse',   label: 'Verse',   gender: 'm' },
];
export const TTS_MODELS: TtsModel[] = [
  { id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', desc: 'voice.modelMiniDesc', voices: V_CORE },
  { id: 'tts-1',           label: 'TTS-1',           desc: 'voice.modelTts1Desc', voices: V_CORE.filter((v) => ['alloy','echo','fable','onyx','nova','shimmer'].includes(v.id)) },
  { id: 'tts-1-hd',        label: 'TTS-1 HD',        desc: 'voice.modelTts1hdDesc', voices: V_CORE.filter((v) => ['alloy','echo','fable','onyx','nova','shimmer'].includes(v.id)) },
];

const LS_MODEL = 'maestrus-tts-model', LS_VOICE = 'maestrus-tts-voice';
export function getTtsChoice(): { model: string; voice: string } {
  let model = '', voice = '';
  try { model = localStorage.getItem(LS_MODEL) || ''; voice = localStorage.getItem(LS_VOICE) || ''; } catch {}
  const m = TTS_MODELS.find((x) => x.id === model) || TTS_MODELS[0];
  const v = m.voices.find((x) => x.id === voice)
    || m.voices.find((x) => x.id === 'ash')     // padrão: masculina
    || m.voices.find((x) => x.gender === 'm')
    || m.voices[0];
  return { model: m.id, voice: v.id };
}
function getTtsChoice2() { const c = getTtsChoice(); return { tts_model: c.model, voice: c.voice }; }
export function setTtsChoice(model: string, voice: string): void {
  try { localStorage.setItem(LS_MODEL, model); localStorage.setItem(LS_VOICE, voice); } catch {}
}

// ─── Bordões de "estou nisso" (pegada Jarvis) ───────────────────────────────
// O agente da conversa pensa de verdade (lê arquivos, usa tools) — isso leva
// segundos. Em vez de silêncio morto, ele responde NA HORA com uma frase curta
// enquanto trabalha. É o que o Realtime dava de graça (resposta imediata) sem
// abrir mão da inteligência e do contexto do projeto.
const FILLERS: Record<Lang, string[]> = {
  pt: [
    'Certo, um minuto.', 'Deixa eu ver isso.', 'Entendi, vou analisar.',
    'Só um momento.', 'Beleza, já olho.', 'Deixa comigo.',
    'Tá, deixa eu conferir.', 'Certo, analisando.', 'Um instante.',
    'Deixa eu entender direito.', 'Ok, vou verificar.', 'Já te respondo.',
    'Deixa eu checar aqui.', 'Certo, me dá um segundo.', 'Entendido, verificando.',
    'Tô vendo isso agora.', 'Deixa eu olhar.', 'Perfeito, já volto.',
    'Anotado, analisando.', 'Certo, trabalhando nisso.',
  ],
  en: [
    'Got it, one minute.', 'Let me look at that.', 'Understood, analyzing.',
    'One moment.', 'Alright, checking now.', 'On it.',
    'Let me check that.', 'Right, analyzing.', 'Just a second.',
    'Let me make sure I got that.', 'Okay, verifying.', 'I will get back to you.',
    'Let me take a look.', 'Give me a second.', 'Understood, checking.',
    'Looking at it now.', 'Let me see.', 'Perfect, one moment.',
    'Noted, analyzing.', 'Right, working on it.',
  ],
  es: [
    'Bien, un minuto.', 'Déjame ver eso.', 'Entendido, voy a analizar.',
    'Un momento.', 'Vale, ya lo miro.', 'Déjamelo a mí.',
    'Vale, déjame comprobar.', 'Bien, analizando.', 'Un instante.',
    'Déjame entenderlo bien.', 'Ok, voy a verificar.', 'Ya te respondo.',
    'Déjame revisar aquí.', 'Dame un segundo.', 'Entendido, verificando.',
    'Lo estoy viendo ahora.', 'Déjame mirar.', 'Perfecto, ya vuelvo.',
    'Anotado, analizando.', 'Bien, trabajando en ello.',
  ],
};
let _lastFiller = -1;
/** Fala UM bordão curto na hora em que o prompt vai pro agente. Nunca repete o
 *  imediatamente anterior. O áudio da resposta real é agendado DEPOIS deste no
 *  mesmo relógio do Web Audio, então não se atropelam. */
export function speakThinkingFiller(lang: Lang): void {
  const list = FILLERS[lang] || FILLERS.en;
  let i = Math.floor(Math.random() * list.length);
  if (i === _lastFiller) i = (i + 1) % list.length;
  _lastFiller = i;
  try { ttsSpeak(list[i], lang); } catch {}
}

// ─── Parâmetros do VAD (detector de fim de fala) ────────────────────────────
// Tudo RELATIVO ao ruído do ambiente: um limiar fixo não funciona no mundo real
// (com música tocando o volume nunca cai abaixo dele e a fala nunca "termina").
const VAD_TICK_MS = 50;          // amostragem do nível
const CALIB_MS = 350;            // mede o ruído de fundo antes de decidir
// 1200ms: entre "olá" e "olá" cabe uma pausa. Com 900ms o segmento fechava no
// meio da frase e só a primeira palavra era enviada.
// Pausa que encerra a fala. Configurável: 1,2s cortava quem parava pra pensar
// no meio do raciocínio. Ver getVoiceTiming().
const SILENCE_MS_DEFAULT = 1600;
const SPEECH_OVER_NOISE = 1.8;   // fala = 1.8× o ruído de fundo
const QUIET_OVER_NOISE = 1.3;    // silêncio = perto do ruído de fundo
const QUIET_OF_PEAK = 0.3;       // ou 30% do pico da fala (fim de frase no barulho)
// Piso BAIXO: fala normal, a meio metro do mic, fica na casa de 0.01–0.05 de RMS.
// Estava em 0.02 (+ rigor de barge-in) e obrigava a GRITAR.
const MIN_SPEECH_RMS = 0.008;    // piso absoluto (não dispara no silêncio total)
const NO_SPEECH_MS = 8000;       // ninguém falou → devolve o turno
// TETO DURO: encerra mesmo SEM silêncio. Em 15s ele cortava frase longa no meio
// (a queixa "eu ainda estava falando"). 90s é folgado pra um raciocínio inteiro
// e ainda protege de um mic que ficou aberto sozinho.
const MAX_UTTERANCE_MS_DEFAULT = 90000;

const LS_SILENCE = 'maestrus.voice.silenceMs';
const LS_MAXUTT = 'maestrus.voice.maxUtteranceMs';

/** Tempo de pausa e teto de fala, ajustáveis nas configurações de voz. */
export function getVoiceTiming(): { silenceMs: number; maxUtteranceMs: number } {
  let silenceMs = SILENCE_MS_DEFAULT;
  let maxUtteranceMs = MAX_UTTERANCE_MS_DEFAULT;
  try {
    const a = Number(localStorage.getItem(LS_SILENCE));
    const b = Number(localStorage.getItem(LS_MAXUTT));
    if (Number.isFinite(a) && a >= 600 && a <= 8000) silenceMs = a;
    if (Number.isFinite(b) && b >= 15000 && b <= 300000) maxUtteranceMs = b;
  } catch {}
  return { silenceMs, maxUtteranceMs };
}

export function setVoiceTiming(silenceMs: number, maxUtteranceMs?: number): void {
  try {
    localStorage.setItem(LS_SILENCE, String(silenceMs));
    if (maxUtteranceMs) localStorage.setItem(LS_MAXUTT, String(maxUtteranceMs));
  } catch {}
}

// ─── Discriminação VOZ × RUÍDO (barge-in) ───────────────────────────────────
// Pra interromper a fala da IA só quando VOCÊ fala — não quando passa um carro,
// toca música ou alguém conversa longe. Três critérios COMBINADOS:
//  1. energia acima do ruído de fundo (já calibrado);
//  2. a energia tem que estar concentrada na BANDA DA VOZ (~300–3400 Hz) —
//     ruído de fundo/ar-condicionado é grave, chiado é agudo;
//  3. sustentada por VOICE_CONFIRM_MS — estalos e batidas são curtos demais.
// Enquanto a IA fala, o eco dela é suprimido pelo echoCancellation do mic e o
// limiar sobe (BARGE_STRICTNESS), então ela não se interrompe sozinha.
const VOICE_BAND_LO = 300;       // Hz
const VOICE_BAND_HI = 3400;      // Hz
const VOICE_BAND_MIN_RATIO = 0.55; // 55% da energia na banda da voz = fala
const VOICE_CONFIRM_MS = 280;    // tem que sustentar — mata estalo/batida
const BARGE_STRICTNESS = 2.0;    // limiar × isto enquanto a IA está falando
const TTS_SPEED = 1.0;           // velocidade natural

// ─── Anti-captura de terceiros e anti-alucinação do Whisper ─────────────────
// Alguém falando PERTO (não no mic) chega fraco: exigimos que o PICO da fala
// esteja bem acima do ruído de fundo pra considerar que foi VOCÊ. E áudio
// curto/fraco faz o Whisper inventar frase ("this really are", "Thank you.") —
// então exigimos um mínimo de fala real antes de enviar.
const OWN_VOICE_PEAK_OVER_NOISE = 3.5; // pico ≥ 3.5× o ruído = falou no mic
const OWN_VOICE_MIN_PEAK = 0.03;       // piso absoluto do pico
const MIN_SPEECH_MS = 350;             // menos que isto = ruído//estalo, não frase

// Frases que o Whisper INVENTA quando o áudio é ruim/curto (alucinações
// conhecidas, em vários idiomas). Se vier só isso, descartamos o segmento.
const HALLUCINATIONS = [
  'this really are', 'thank you', 'thanks for watching', 'thanks for watching!',
  'you', 'bye', 'bye.', 'okay', 'ok', '...', 'obrigado', 'obrigada',
  'legendas pela comunidade amara.org', 'subtitles by the amara.org community',
  'tchau', 'gracias', 'thank you very much', 'please subscribe',
];
function looksHallucinated(text: string, hadRealSpeech: boolean): boolean {
  const t = (text || '').trim().toLowerCase().replace(/[.!?¡¿]+$/g, '');
  if (!t) return true;
  if (HALLUCINATIONS.includes(t)) return true;
  // Texto muito curto sem fala consistente = provável invenção.
  if (!hadRealSpeech && t.length <= 12) return true;
  return false;
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

  private speakingMode = false;   // IA falando → limiar mais rígido (barge-in)
  private notifiedStart = false;  // onSpeechStart dispara uma vez por captura
  // Métricas da captura, usadas pra decidir se foi VOCÊ falando no mic (e não
  // alguém falando perto) e se há fala suficiente pra não virar alucinação.
  private peakRms = 0;
  private noiseRms = 0;
  private speechMs = 0;

  async start(lang: Lang, cb: any, opts?: { speaking?: boolean }): Promise<void> {
    // Já capturando? Não abre uma SEGUNDA captura por cima (vazava stream e
    // embaralhava o estado — o barge-in chamava start() com uma já ativa).
    if (this.running) return;
    this.lang = lang; this.cb = cb; this.running = true; this.hadSpeech = false; this.chunks = [];
    this.speakingMode = !!(opts && opts.speaking); this.notifiedStart = false;
    this.peakRms = 0; this.noiseRms = 0; this.speechMs = 0;
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
    // TETO DURO: encerra SEMPRE, tenha havido fala ou não. Antes só cortava
    // quando NÃO houve fala — com ruído/música o VAD nunca via silêncio e o
    // segmento gravava pra sempre ("fica ouvindo e não transcreve nunca").
    this.maxTimer = setTimeout(() => this.endSegment(), getVoiceTiming().maxUtteranceMs);
    this.monitor();
  }

  // VAD adaptativo. O limiar FIXO (0.012) não funcionava no mundo real: com
  // música tocando ou num ambiente com ruído o volume nunca cai abaixo dele, o
  // silêncio nunca é detectado e a fala não fecha. Agora medimos o RUÍDO DE
  // FUNDO nos primeiros ms e falamos em relação a ele — e também cortamos
  // quando o volume despenca em relação ao pico da fala.
  // Fração da energia que está na banda da VOZ (300–3400 Hz). Fala humana
  // concentra energia aí; ventilador/trânsito é grave, chiado é agudo. É o que
  // permite ignorar som ambiente e só reagir a VOCÊ.
  private voiceBandRatio(freq: Uint8Array): number {
    const sr = this.ctx ? this.ctx.sampleRate : 48000;
    const binHz = sr / 2 / freq.length;
    let band = 0, total = 0;
    for (let i = 1; i < freq.length; i++) {
      const hz = i * binHz;
      const v = freq[i];
      total += v;
      if (hz >= VOICE_BAND_LO && hz <= VOICE_BAND_HI) band += v;
    }
    return total > 0 ? band / total : 0;
  }

  private monitor(): void {
    const buf = new Uint8Array(this.analyser!.frequencyBinCount);
    const freq = new Uint8Array(this.analyser!.frequencyBinCount);
    let voiceSince = 0; // início da fala candidata (pra exigir duração)
    let silenceStart = 0;
    let noiseFloor = 0, calibN = 0;
    let peak = 0;
    const t0 = performance.now();
    const tick = () => {
      if (!this.running || !this.analyser) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();

      // Calibração: primeiros CALIB_MS viram a média do ruído ambiente.
      if (now - t0 < CALIB_MS) {
        noiseFloor = (noiseFloor * calibN + rms) / (calibN + 1); calibN++;
        return; // não decide nada enquanto calibra
      }
      // Fala = bem acima do ruído de fundo (piso mínimo pra não disparar no
      // silêncio absoluto). Enquanto a IA fala, o limiar sobe: assim o eco dela
      // e o ruído do ambiente não a interrompem — só a sua voz de verdade.
      const strict = this.speakingMode ? BARGE_STRICTNESS : 1;
      const speakThresh = Math.max(noiseFloor * SPEECH_OVER_NOISE * strict, MIN_SPEECH_RMS * strict);
      // Silêncio = perto do ruído de fundo OU muito abaixo do pico da fala
      // (fim de frase em ambiente barulhento).
      const quietThresh = Math.max(noiseFloor * QUIET_OVER_NOISE, peak * QUIET_OF_PEAK, MIN_SPEECH_RMS * 0.6);

      const loud = rms > speakThresh;
      // A confirmação por BANDA DE VOZ + DURAÇÃO só vale no BARGE-IN (enquanto a
      // IA fala), pra ruído/eco não calarem ela. Na escuta normal, energia BASTA.
      //
      // Era aqui o bug que travava tudo: eu exigia banda+duração SEMPRE. Fala
      // real por microfone raramente bate a razão de banda exigida, então
      // `hadSpeech` nunca virava true — e, como o ramo "alto" era tomado a cada
      // tick, a detecção de silêncio NUNCA rodava. Resultado: falar não fechava
      // o segmento; ele só terminava no timeout de "ninguém falou" (8s) e o
      // áudio era descartado. Era o "demora ~10s e não manda" — nada a ver com
      // volume: gritar não ajudava porque o gargalo não era o limiar.
      let isSpeech = loud;
      if (loud && this.speakingMode) {
        this.analyser!.getByteFrequencyData(freq);
        if (this.voiceBandRatio(freq) >= VOICE_BAND_MIN_RATIO) {
          if (!voiceSince) voiceSince = now;
          isSpeech = (now - voiceSince) >= VOICE_CONFIRM_MS;
        } else {
          voiceSince = 0; isSpeech = false;      // ruído: não interrompe a IA
        }
      }

      if (isSpeech) {
        this.hadSpeech = true; silenceStart = 0;
        this.speechMs += VAD_TICK_MS;            // quanto de fala REAL houve
        if (rms > peak) peak = rms;
        this.peakRms = peak; this.noiseRms = noiseFloor;
        if (!this.notifiedStart) {               // avisa UMA vez → corta o TTS
          this.notifiedStart = true;
          try { this.cb && this.cb.onSpeechStart && this.cb.onSpeechStart(); } catch {}
          // A IA vai calar agora: o resto DESTA fala já é conversa normal.
          // Sem isto, o restante do turno seguia com o limiar rígido do
          // barge-in e o fim da frase quase nunca era detectado.
          this.speakingMode = false;
        }
      } else if (this.hadSpeech) {
        // Já falou: conta o silêncio pra fechar a frase (e só ele fecha).
        if (rms < quietThresh) {
          if (!silenceStart) silenceStart = now;
          else if (now - silenceStart > getVoiceTiming().silenceMs) { this.endSegment(); return; }
        } else {
          silenceStart = 0;                      // ainda falando — reinicia
        }
      } else if (now - t0 > NO_SPEECH_MS) {
        this.endSegment(); return;               // ninguém falou — devolve o turno
      }
    };
    // setInterval e NÃO requestAnimationFrame: o rAF é congelado quando a tela
    // apaga / o app vai pro fundo no mobile — o VAD parava de rodar e a captura
    // ficava presa em "Ouvindo" pra sempre.
    this.raf = setInterval(tick, VAD_TICK_MS) as unknown as number;
  }

  private endSegment(): void {
    if (this.raf) { clearInterval(this.raf as unknown as number); this.raf = 0; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); else this.finalize(); } catch { this.finalize(); }
  }

  private async finalize(): Promise<void> {
    const had = this.hadSpeech;
    const durMs = Math.round(performance.now() - this.startedAt);
    const type = this.rec?.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    const peak = this.peakRms, floor = this.noiseRms, spokeMs = this.speechMs;
    this.cleanup();
    if (!had || blob.size < 1200) { this.cb && this.cb.onEnd && this.cb.onEnd(); return; }
    // FOI VOCÊ? Quem fala PERTO do aparelho (mas não nele) chega fraco: se o pico
    // não se destaca do ruído de fundo, é conversa alheia/TV — descarta em vez de
    // mandar pro agente. Também exige um mínimo de fala: áudio curto/fraco é o
    // que faz o Whisper INVENTAR frase (foi assim que "olha que bonita essa
    // casinha", falado por outra pessoa, virou "this really are").
    const ownVoice = peak >= Math.max(floor * OWN_VOICE_PEAK_OVER_NOISE, OWN_VOICE_MIN_PEAK);
    if (!ownVoice || spokeMs < MIN_SPEECH_MS) { this.cb && this.cb.onEnd && this.cb.onEnd(); return; }
    try {
      const license = await licenseKey();
      const fd = new FormData();
      const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
      fd.append('audio', blob, `speech.${ext}`);
      fd.append('lang', this.lang);
      fd.append('license_key', license);
      fd.append('duration_ms', String(durMs));
      // BYOK: sem a chave o backend responde 'no_api_key' (era a causa de "nunca ouve").
      fd.append('openai_key', await openaiKey());
      const res = await fetch(`${API}/api.php?action=voice_stt`, { method: 'POST', body: fd });
      const j: any = await res.json().catch(() => ({}));
      const text = (j && j.text || '').trim();
      // Última barreira: alucinação conhecida do Whisper ("Thank you.", "this
      // really are", "Legendas pela comunidade Amara.org"…) → ignora o turno.
      if (text && looksHallucinated(text, spokeMs >= 600)) { this.cb && this.cb.onEnd && this.cb.onEnd(); return; }
      if (text && this.cb) { this.cb.onFinal(text); return; }
      // Falha REAL vira erro visível — antes sumia em silêncio e parecia "surdo".
      if (j && j.ok === false && this.cb && this.cb.onError) {
        this.cb.onError(j.error === 'no_api_key' ? 'no_api_key' : (j.detail || j.error || 'stt_failed'));
      }
    } catch (e: any) {
      if (this.cb && this.cb.onError) this.cb.onError(e?.message || 'stt_failed');
    }
    this.cb && this.cb.onEnd && this.cb.onEnd();
  }

  private cleanup(): void {
    this.running = false;
    if (this.raf) { clearInterval(this.raf as unknown as number); this.raf = 0; }
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
