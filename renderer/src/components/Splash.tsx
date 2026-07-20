import { useEffect, useRef, useState } from 'react';
import Logo from './Logo';
import introUrl from '../assets/intro.mp3';
import { isMuted } from '../lib/sound';

interface Props { onDone: () => void; }

const FALLBACK_DUR = 6;   // s — se o áudio não tocar (mudo/bloqueado)
const FADE_OUT = 1.8;     // s — fade do logo + áudio no fim
const MAX_DUR = 20;       // s — teto de segurança
const PEAK_VOL = 0.7;

// Intro do Maestrus: logo faz fade in, segura, e some no fim da música.
// O carregamento do app roda por trás; quando a intro termina, chama onDone.
export default function Splash({ onDone }: Props) {
  const [hide, setHide] = useState(false);   // fade-out do container inteiro
  const [out, setOut] = useState(false);     // fade-out do logo
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const doneRef = useRef(false);
  const startedRef = useRef(false);

  useEffect(() => {
    const a = audioRef.current;
    const muted = isMuted();
    const timers: number[] = [];
    let volTimer = 0;

    function finish() {
      if (doneRef.current) return;
      doneRef.current = true;
      setHide(true);
      window.setTimeout(onDone, 650);
    }

    function rampVolume(el: HTMLAudioElement, target: number, ms: number) {
      window.clearInterval(volTimer);
      const steps = 24;
      const from = el.volume;
      let i = 0;
      volTimer = window.setInterval(() => {
        i++;
        el.volume = Math.max(0, Math.min(1, from + (target - from) * (i / steps)));
        if (i >= steps) window.clearInterval(volTimer);
      }, ms / steps);
    }

    function begin(durSec: number) {
      if (startedRef.current) return;
      startedRef.current = true;
      const total = Math.min(Math.max(durSec, 3), MAX_DUR);
      timers.push(window.setTimeout(() => setOut(true), (total - FADE_OUT) * 1000));
      if (a && !muted) timers.push(window.setTimeout(() => rampVolume(a, 0, FADE_OUT * 1000), (total - FADE_OUT) * 1000));
      timers.push(window.setTimeout(finish, total * 1000));
    }

    if (muted || !a) {
      begin(FALLBACK_DUR);
      return () => { timers.forEach(clearTimeout); window.clearInterval(volTimer); };
    }

    a.volume = 0;
    const onMeta = () => begin(isFinite(a.duration) && a.duration > 1 ? a.duration : FALLBACK_DUR);
    a.addEventListener('loadedmetadata', onMeta, { once: true });
    if (a.readyState >= 1) onMeta(); // metadata já disponível (cache)

    a.play().then(() => rampVolume(a, PEAK_VOL, 1400)).catch(() => begin(FALLBACK_DUR));
    // rede de segurança caso metadata demore
    timers.push(window.setTimeout(() => begin(FALLBACK_DUR), 1200));

    return () => { timers.forEach(clearTimeout); window.clearInterval(volTimer); try { a.pause(); } catch {} };
  }, []);

  return (
    <div className={`splash ${hide ? 'hide' : ''}`}>
      <div className="splash-grid" />
      <div className="splash-glow" />
      <div className={`splash-logo ${out ? 'out' : ''}`}>
        <Logo size={84} textSize={52} />
      </div>
      <audio ref={audioRef} src={introUrl} preload="auto" />
    </div>
  );
}
