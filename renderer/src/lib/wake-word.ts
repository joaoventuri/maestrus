// Wake word offline (Vosk WASM) — escuta sempre, 100% local, detecta a frase
// que o usuário definir e dispara o Inicializador.
//
// Como "Maestrus" (e nomes inventados) NÃO estão no vocabulário do Vosk, o
// reconhecedor transcreve algo foneticamente próximo ("my strus", "mastrus").
// Por isso casamos por SIMILARIDADE (Levenshtein normalizado) além do match
// exato — robusto pra frases-chave personalizadas.

import { createModel } from 'vosk-browser';

const MODEL_URL = (lang: string) => `https://maestrus.cloud/downloads/voice/models/vosk-${lang}.tar.gz`;
const SUPPORTED = new Set(['pt', 'en', 'es']);

let model: any = null;
let recognizer: any = null;
let audioCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let node: ScriptProcessorNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let running = false;
let loadingFor = '';     // chave "lang" do modelo carregado
let lastTrigger = 0;

function norm(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = new Array(n + 1);
  for (let j = 0; j <= n; j++) d[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n];
}
function similar(a: string, b: string): number {
  const max = Math.max(a.length, b.length, 1);
  return 1 - lev(a, b) / max;
}

export function wakeSupported(): boolean {
  return typeof window !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && !!((window as any).AudioContext || (window as any).webkitAudioContext);
}

export interface WakeOpts { phrase: string; lang: string; onDetect: () => void; onError?: (e: string) => void; onReady?: () => void; }

export async function startWakeWord({ phrase, lang, onDetect, onError, onReady }: WakeOpts): Promise<void> {
  await stopWakeWord();
  const l = SUPPORTED.has((lang || '').slice(0, 2)) ? lang.slice(0, 2) : 'en';
  const target = norm(phrase || 'hello maestrus');
  const targetNS = target.replace(/ /g, '');
  running = true;
  try {
    // Modelo (lazy, baixado uma vez e cacheado pelo browser).
    if (!model || loadingFor !== l) {
      try { model?.terminate?.(); } catch {}
      model = await createModel(MODEL_URL(l));
      loadingFor = l;
    }
    if (!running) return; // parou durante o load
    recognizer = new model.KaldiRecognizer(16000);
    recognizer.setWords(false);
    const handle = (text: string) => {
      const t = norm(text);
      if (!t) return;
      const tNS = t.replace(/ /g, '');
      // Dispara se a frase aparece no texto OU se a similaridade é alta.
      const hit = t.includes(target) || (targetNS.length >= 4 && (similar(tNS, targetNS) >= 0.6 || tNS.includes(targetNS)));
      if (hit) {
        const now = Date.now();
        if (now - lastTrigger < 4000) return; // debounce (evita re-disparo)
        lastTrigger = now;
        try { onDetect(); } catch {}
      }
    };
    recognizer.on('result', (m: any) => handle(m?.result?.text || ''));
    recognizer.on('partialresult', (m: any) => { const p = m?.result?.partial || ''; if (p && p.split(' ').length >= (target.split(' ').length)) handle(p); });

    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    if (!running) { stopWakeWord(); return; }
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    audioCtx = new AC();
    source = audioCtx!.createMediaStreamSource(micStream);
    node = audioCtx!.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => { if (!running || !recognizer) return; try { recognizer.acceptWaveform(e.inputBuffer); } catch {} };
    source.connect(node);
    node.connect(audioCtx!.destination); // ScriptProcessor não escreve saída → silêncio (sem feedback)
    onReady?.();
  } catch (e: any) {
    running = false;
    onError?.(e?.message || String(e));
  }
}

export async function stopWakeWord(): Promise<void> {
  running = false;
  try { node?.disconnect(); } catch {}
  try { source?.disconnect(); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { await audioCtx?.close(); } catch {}
  try { recognizer?.remove?.(); } catch {}
  node = null; source = null; micStream = null; audioCtx = null; recognizer = null;
  // mantém `model` em cache pra re-ligar rápido.
}

export function wakeRunning(): boolean { return running; }
