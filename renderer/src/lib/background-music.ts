// Música clássica de fundo para o modo Jarvis. Singleton que mantém o tag de
// <audio> vivo entre prompts — não reinicia entre turnos. Fade in/out suave,
// loop infinito, abaixa volume quando a IA fala (duck) e silencia quando o
// usuário fala (mute). Estado "habilitada" persiste em localStorage.

const SRC = './voice/orchestral.mp3';
const KEY_ENABLED = 'maestrus_music_enabled';

const VOL_FULL = 0.18;      // volume base quando idle
const VOL_DUCK = 0.05;      // quando a IA está falando
const VOL_MUTE = 0.0;       // quando o usuário está falando

class BgMusic {
  private audio: HTMLAudioElement | null = null;
  private targetVol = VOL_FULL;
  private fadeTimer: any = null;
  private enabled = true;
  private active = false;
  private duckLevel: 'full' | 'duck' | 'mute' = 'full';

  constructor() {
    try { this.enabled = localStorage.getItem(KEY_ENABLED) !== '0'; } catch {}
  }

  isEnabled(): boolean { return this.enabled; }
  isActive(): boolean { return this.active; }

  setEnabled(v: boolean): void {
    this.enabled = v;
    try { localStorage.setItem(KEY_ENABLED, v ? '1' : '0'); } catch {}
    if (!v && this.audio) this.fadeTo(0, 350, () => this.audio?.pause());
    else if (v && this.active) this.start();
  }

  // Inicia a sessão (carrega áudio se ainda não), começa a tocar. Idempotente:
  // se já está tocando, não reinicia — preserva currentTime entre prompts.
  start(): void {
    this.active = true;
    if (!this.enabled) return;
    if (!this.audio) {
      this.audio = new Audio(SRC);
      this.audio.loop = true;
      this.audio.preload = 'auto';
      this.audio.volume = 0;
    }
    if (this.audio.paused) {
      this.audio.play().catch(() => {});
    }
    this.fadeTo(this.targetForState(), 800);
  }

  // Pausa a sessão (saiu do modo Jarvis). Fade out e pausa, mas mantém o tag e
  // o currentTime para retomar na próxima abertura.
  stop(): void {
    this.active = false;
    if (!this.audio) return;
    const a = this.audio;
    this.fadeTo(0, 600, () => { try { a.pause(); } catch {} });
  }

  duck(): void { this.duckLevel = 'duck'; if (this.active) this.fadeTo(this.targetForState(), 250); }
  mute(): void { this.duckLevel = 'mute'; if (this.active) this.fadeTo(this.targetForState(), 200); }
  unduck(): void { this.duckLevel = 'full'; if (this.active) this.fadeTo(this.targetForState(), 500); }

  private targetForState(): number {
    if (!this.enabled || !this.active) return 0;
    if (this.duckLevel === 'mute') return VOL_MUTE;
    if (this.duckLevel === 'duck') return VOL_DUCK;
    return VOL_FULL;
  }

  private fadeTo(target: number, ms: number, onDone?: () => void): void {
    if (!this.audio) { onDone?.(); return; }
    if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; }
    this.targetVol = target;
    const startVol = this.audio.volume;
    const startTime = performance.now();
    this.fadeTimer = setInterval(() => {
      if (!this.audio) { clearInterval(this.fadeTimer); this.fadeTimer = null; return; }
      const t = Math.min(1, (performance.now() - startTime) / ms);
      this.audio.volume = startVol + (target - startVol) * t;
      if (t >= 1) {
        clearInterval(this.fadeTimer); this.fadeTimer = null;
        this.audio.volume = target;
        onDone?.();
      }
    }, 30);
  }
}

export const bgMusic = new BgMusic();
