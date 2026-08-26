// PlasmaOrb — orb visual do Jarvis. Comportamento por estado:
//   - 'thinking'  → GIF animado (cosmos rodando, IA trabalhando)
//   - 'listening' → frame-0 frozen + pulse com nível do mic
//   - 'speaking'  → frame-0 frozen + pulse com áudio da resposta
//   - 'idle'      → frame-0 frozen + respiração suave (level senoidal idle)
//
// Implementação: duas camadas sobrepostas — o <img> com o GIF rola sempre em
// background (sem custo perceptível) e um <canvas> com o frame-0 capturado
// fica POR CIMA, com opacity 1 quando frozen e fade-out pra 0 quando entra em
// 'thinking'. Isso evita parsear/decoder o GIF — o próprio browser faz tudo.
// O pulse é um scale CSS no wrapper externo, fluido a 60fps via transform.

import { useEffect, useRef, useState } from 'react';

interface Props {
  // 0 = silêncio, 1 = pico de fala. Drive da pulsação.
  level: number;
  state: 'idle' | 'listening' | 'thinking' | 'speaking';
  size?: number; // px
}

const GIF_URL = './voice/orb.gif';

export default function PlasmaOrb({ level, state, size = 280 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [staticReady, setStaticReady] = useState(false);
  // Suavização do nível em ref pra animar sem rerender:
  const smoothLevelRef = useRef(0);
  const innerRef = useRef<HTMLDivElement>(null);

  // Captura frame-0 do GIF pra exibir quando NÃO está thinking. Usa um Image
  // off-screen — mesma origem (renderer/public/voice/), então drawImage não
  // taint o canvas e fica tudo carregado e disponível imediato.
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const cvs = canvasRef.current;
      if (!cvs) return;
      // Resolução do canvas casa com a do GIF (300x300 default).
      cvs.width = img.naturalWidth || 300;
      cvs.height = img.naturalHeight || 300;
      const ctx = cvs.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
      setStaticReady(true);
    };
    img.src = GIF_URL;
  }, []);

  // RAF: anima o scale do wrapper com base no nível suavizado. Não rerender —
  // mexe direto em style.transform, sem custo de React.
  useEffect(() => {
    let raf = 0;
    function tick() {
      // Quando thinking, ignora o level (GIF tem sua própria animação).
      const target = state === 'thinking' ? 0.2 : level;
      smoothLevelRef.current = smoothLevelRef.current * 0.82 + target * 0.18;
      const scale = state === 'thinking'
        ? 1.0 + smoothLevelRef.current * 0.04                  // respiração leve sobre o GIF
        : 1.0 + smoothLevelRef.current * 0.22;                 // pulse forte do level
      if (innerRef.current) innerRef.current.style.transform = `scale(${scale})`;
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, level]);

  const animating = state === 'thinking';

  return (
    <div className="plasma-orb" style={{ width: size, height: size }} aria-hidden>
      <div ref={innerRef} className="orb-inner" style={{ willChange: 'transform' }}>
        {/* GIF sempre montado, animando em background. Quando 'thinking', a
            camada de cima (canvas) fica transparente e revelamos o GIF. */}
        <img src={GIF_URL} className="orb-layer orb-gif" draggable={false} alt="" />
        <canvas
          ref={canvasRef}
          className={`orb-layer orb-static ${animating ? 'fade' : ''} ${staticReady ? 'ready' : ''}`}
        />
      </div>
    </div>
  );
}
