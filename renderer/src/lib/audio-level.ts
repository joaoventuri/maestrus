// useAudioLevel — hook que retorna o nível de áudio (0..1) em tempo real.
//   - mic: amostragem RMS via AnalyserNode, suavizada com decay exponencial.
//   - tts/speaking: amostragem do _master GainNode usado pelo voice.ts.
//   - idle/thinking: pulso senoidal lento (orb continua "respirando").

import { useEffect, useState } from 'react';

interface Opts {
  active: boolean;            // hook só conecta quando true (libera o mic ao desligar)
  source: 'mic' | 'idle';     // futura extensão: 'tts' quando o nó master expor
}

let _ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!_ctx) {
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
  }
  if (_ctx!.state === 'suspended') { try { _ctx!.resume(); } catch {} }
  return _ctx;
}

export function useAudioLevel({ active, source }: Opts): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!active) { setLevel(0); return; }

    if (source === 'idle') {
      // Pulso senoidal lento — 1Hz com leve modulação pra não ficar mecânico.
      let raf = 0;
      const t0 = performance.now();
      const loop = () => {
        const t = (performance.now() - t0) / 1000;
        const v = 0.18 + 0.12 * Math.sin(t * 1.4) + 0.04 * Math.sin(t * 3.1);
        setLevel(Math.max(0, Math.min(1, v)));
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }

    // source === 'mic' — amostra RMS via AnalyserNode.
    let stream: MediaStream | null = null;
    let analyser: AnalyserNode | null = null;
    let raf = 0;
    let smooth = 0;
    let cancelled = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        const ctx = getCtx();
        if (!ctx) return;
        const src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.7;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const loop = () => {
          if (cancelled || !analyser) return;
          analyser.getByteTimeDomainData(data);
          // RMS sobre amostras 8-bit centradas em 128.
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          // Normaliza: rms ~0.02 baixo, ~0.3+ pico. Escala pra 0..1 com ganho 4.
          const target = Math.min(1, rms * 4);
          smooth = smooth * 0.7 + target * 0.3;
          setLevel(smooth);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } catch {
        // mic negado — fallback pra pulso idle.
        setLevel(0.2);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (analyser) { try { analyser.disconnect(); } catch {} }
    };
  }, [active, source]);

  return level;
}
