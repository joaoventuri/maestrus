import { useEffect, useRef } from 'react';

/**
 * Onda sonora do modo voz, em tempo real, com a cor de quem está falando:
 * laranja (a marca) quando é VOCÊ, ciano/violeta quando é a IA. Assim dá pra
 * saber de quem é o turno sem ler nenhum rótulo.
 *
 * Desenha em canvas em vez de N divs animadas: são 60fps sobre ~64 barras mais
 * partículas, e com DOM isso vira layout thrash. O canvas escala com o devicePixelRatio
 * pra não sair borrado em tela retina.
 *
 * A fonte do nível é um analyser do WebAudio; quando não há um (a IA falando
 * por um <audio> que não dá pra interceptar), cai numa animação sintética
 * guiada por `level`, que ainda comunica "está falando".
 */

export type WaveSpeaker = 'user' | 'ai' | 'idle';

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; }

const PALETTE: Record<WaveSpeaker, { a: string; b: string; glow: string }> = {
  // laranja da marca
  user: { a: '#ff8a3d', b: '#ffbe86', glow: 'rgba(255,138,61,.55)' },
  // ciano→violeta: distingue da marca sem competir com ela
  ai:   { a: '#7ad7ff', b: '#a78bff', glow: 'rgba(122,140,255,.5)' },
  idle: { a: '#4a453f', b: '#6a635a', glow: 'rgba(120,115,110,.25)' },
};

export default function VoiceWave({ speaker, level = 0, analyser, height = 120 }: {
  speaker: WaveSpeaker;
  /** 0..1 — usado quando não há analyser (fallback sintético). */
  level?: number;
  /** Analyser do WebAudio pra desenhar o espectro REAL. */
  analyser?: AnalyserNode | null;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Refs em vez de deps: o loop de animação é criado uma vez e lê o valor atual,
  // senão cada mudança de nível recriaria o requestAnimationFrame.
  const speakerRef = useRef(speaker);
  const levelRef = useRef(level);
  const analyserRef = useRef(analyser);
  speakerRef.current = speaker;
  levelRef.current = level;
  analyserRef.current = analyser || null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const BARS = 64;
    const particles: Particle[] = [];
    const smooth = new Float32Array(BARS);
    let raf = 0;
    let t = 0;
    // Transição suave de cor quando o turno troca (0 = user, 1 = ai).
    let mix = speaker === 'ai' ? 1 : 0;

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas!.clientWidth || 300;
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const freq = new Uint8Array(BARS * 2);

    function draw() {
      const w = canvas!.clientWidth || 300;
      const h = height;
      const sp = speakerRef.current;
      const target = sp === 'ai' ? 1 : 0;
      mix += (target - mix) * 0.08;

      const from = PALETTE[sp === 'idle' ? 'idle' : 'user'];
      const to = PALETTE[sp === 'idle' ? 'idle' : 'ai'];
      const pal = sp === 'idle' ? PALETTE.idle : (mix > 0.5 ? to : from);

      ctx!.clearRect(0, 0, w, h);
      t += 0.05;

      // Amplitude por barra: espectro real quando há analyser; senão, uma onda
      // sintética modulada pelo nível (ainda "respira" junto com a voz).
      const an = analyserRef.current;
      let amp = levelRef.current;
      if (an) {
        an.getByteFrequencyData(freq as any);
        let sum = 0;
        for (let i = 0; i < BARS; i++) sum += freq[i];
        amp = Math.min(1, (sum / BARS / 255) * 2.2);
      }
      if (sp === 'idle') amp = Math.min(amp, 0.12);

      const mid = h / 2;
      const gap = 3;
      const bw = Math.max(2, (w - gap * (BARS - 1)) / BARS);

      const grad = ctx!.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, pal.a);
      grad.addColorStop(0.5, pal.b);
      grad.addColorStop(1, pal.a);
      ctx!.fillStyle = grad;
      ctx!.shadowColor = pal.glow;
      ctx!.shadowBlur = 12;

      for (let i = 0; i < BARS; i++) {
        const norm = i / (BARS - 1);
        // Envelope: barras do meio mais altas que as das pontas.
        const env = Math.sin(norm * Math.PI) ** 0.8;
        const raw = an
          ? (freq[i] / 255) * env
          : env * (0.25 + 0.75 * Math.abs(Math.sin(t + norm * 6))) * amp;
        // Suavização temporal: sem isto o gráfico pisca a cada frame.
        smooth[i] += (raw - smooth[i]) * (reduced ? 1 : 0.28);

        const bh = Math.max(2, smooth[i] * (h * 0.86) + (sp === 'idle' ? 2 : 3));
        const x = i * (bw + gap);
        const r = Math.min(bw / 2, 3);
        ctx!.beginPath();
        ctx!.roundRect?.(x, mid - bh / 2, bw, bh, r);
        if (!ctx!.roundRect) ctx!.rect(x, mid - bh / 2, bw, bh);
        ctx!.fill();

        // Partícula solta no pico: dá a sensação de energia saindo da onda.
        if (!reduced && smooth[i] > 0.55 && Math.random() < 0.04 && particles.length < 90) {
          particles.push({
            x: x + bw / 2,
            y: mid - bh / 2,
            vx: (Math.random() - 0.5) * 0.5,
            vy: -0.4 - Math.random() * 0.9,
            life: 0,
            max: 40 + Math.random() * 30,
          });
        }
      }

      ctx!.shadowBlur = 0;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy; p.vy += 0.004; p.life++;
        if (p.life > p.max) { particles.splice(i, 1); continue; }
        const a = 1 - p.life / p.max;
        ctx!.globalAlpha = a * 0.7;
        ctx!.fillStyle = pal.b;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, 1.4 * a + 0.4, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [height]);

  return <canvas ref={canvasRef} className="vw-canvas" style={{ width: '100%', height }} aria-hidden="true" />;
}
