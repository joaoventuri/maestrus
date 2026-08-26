import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { fmtDuration } from '../lib/audio-note';

/**
 * Player da nota de voz dentro do balão da conversa.
 *
 * A onda é derivada do próprio áudio (uma amostragem do PCM decodificado), não
 * um enfeite aleatório: as barras correspondem ao que foi falado, e clicar
 * numa delas salta pra aquele ponto.
 */
const BARS = 34;

export default function AudioBubble({ src, durationMs, text }: {
  src: string;
  durationMs?: number;
  text?: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);       // 0..1
  const [dur, setDur] = useState(durationMs ? durationMs / 1000 : 0);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  // Extrai a envoltória uma vez. Se falhar (codec exótico), cai numa onda
  // neutra em vez de sumir com o player.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer();
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const step = Math.floor(data.length / BARS) || 1;
        const out: number[] = [];
        for (let i = 0; i < BARS; i++) {
          let peak = 0;
          for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) {
            const v = Math.abs(data[j]);
            if (v > peak) peak = v;
          }
          out.push(peak);
        }
        const max = Math.max(...out, 0.01);
        if (alive) {
          setPeaks(out.map((p) => Math.max(0.12, p / max)));
          if (!durationMs) setDur(audio.duration);
        }
        ctx.close();
      } catch {
        if (alive) setPeaks(Array.from({ length: BARS }, (_, i) => 0.3 + Math.abs(Math.sin(i)) * 0.4));
      }
    })();
    return () => { alive = false; };
  }, [src, durationMs]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play(); setPlaying(true); } else { a.pause(); setPlaying(false); }
  }

  function seekTo(ratio: number) {
    const a = audioRef.current;
    if (!a || !isFinite(a.duration)) return;
    a.currentTime = Math.max(0, Math.min(1, ratio)) * a.duration;
    setPos(ratio);
  }

  const bars = useMemo(() => peaks || Array.from({ length: BARS }, () => 0.3), [peaks]);
  const played = Math.round(pos * BARS);
  const shown = dur ? fmtDuration((playing || pos > 0 ? pos * dur : dur) * 1000) : '';

  return (
    <div className="ab-wrap">
      <div className="ab-player">
        <button className="ab-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>

        <div
          className="ab-wave"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            seekTo((e.clientX - r.left) / r.width);
          }}
        >
          {bars.map((h, i) => (
            <span key={i} className={i <= played ? 'on' : ''} style={{ height: `${Math.round(h * 100)}%` }} />
          ))}
        </div>

        <span className="ab-time">{shown}</span>
      </div>

      {text && <div className="ab-text">{text}</div>}

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => { const d = (e.target as HTMLAudioElement).duration; if (isFinite(d)) setDur(d); }}
        onTimeUpdate={(e) => {
          const a = e.target as HTMLAudioElement;
          if (isFinite(a.duration) && a.duration > 0) setPos(a.currentTime / a.duration);
        }}
        onEnded={() => { setPlaying(false); setPos(0); }}
      />
    </div>
  );
}
