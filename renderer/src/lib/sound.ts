// Sons do Maestrus. O "swell" de abertura ainda é sintetizado via Web Audio;
// o som de conclusão usa uma gravação licenciada (done.mp3).
import doneUrl from '../assets/done.mp3';

const MUTE_KEY = 'maestrus.sound.muted';

export function isMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
export function setMuted(m: boolean) {
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch {}
}

let ctx: AudioContext | null = null;
function ac(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Toca um acorde com timbre de cordas + fade in/out.
// freqs: notas (Hz). dur: duração total. peak: volume de pico.
function chord(freqs: number[], dur: number, peak: number, attack: number, release: number) {
  const a = ac();
  const now = a.currentTime;
  const master = a.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(peak, now + attack);          // fade in
  master.gain.setValueAtTime(peak, now + dur - release);
  master.gain.exponentialRampToValueAtTime(0.0001, now + dur);           // fade out
  // filtro pra suavizar (timbre quente de cordas)
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800, now);
  lp.frequency.linearRampToValueAtTime(3200, now + attack);
  lp.Q.value = 0.6;
  lp.connect(master);
  master.connect(a.destination);

  // vibrato sutil
  const lfo = a.createOscillator();
  const lfoGain = a.createGain();
  lfo.frequency.value = 5.2;
  lfoGain.gain.value = 2.5;
  lfo.connect(lfoGain);
  lfo.start(now); lfo.stop(now + dur);

  for (const f of freqs) {
    // duas oscilações por nota, levemente desafinadas → encorpa (efeito naipe)
    for (const detune of [-5, 5]) {
      const osc = a.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.detune.value = detune;
      lfoGain.connect(osc.detune);
      const g = a.createGain();
      g.gain.value = 1 / (freqs.length * 2);
      osc.connect(g); g.connect(lp);
      osc.start(now); osc.stop(now + dur);
    }
  }
}

// Swell triunfante de ~2s (ao abrir o Maestrus). Dó maior + oitava.
export function playMaestrusOpen() {
  if (isMuted()) return;
  try { chord([261.63, 329.63, 392.0, 523.25], 2.0, 0.18, 0.35, 0.7); } catch {}
}

// Som de conclusão (quando a IA termina) — gravação licenciada (done.mp3).
let doneAudio: HTMLAudioElement | null = null;
export function playDone() {
  if (isMuted()) return;
  try {
    if (!doneAudio) { doneAudio = new Audio(doneUrl); doneAudio.volume = 0.7; }
    doneAudio.currentTime = 0;
    doneAudio.play().catch(() => {});
  } catch {}
}
