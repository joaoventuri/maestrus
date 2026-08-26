// Modo Jarvis: overlay full-screen, conversa em tempo real com a IA.
// — Fundo escuro com vinhetas + glow neon
// — Plasma Orb 3D (Three.js) que reage ao mic enquanto ouve, pulsa enquanto
//   fala e gira enquanto pensa. Substituiu o GIF do maestro.
// — Switch "Voice Free / Voice Cloud" no controle:
//     Free  = STT local + Piper streaming TTS (atual, sem custo)
//     Cloud = OpenAI Realtime (full-duplex, pago via Maestrus AI) — ATIVA no
//             próximo release; aqui só fica como toggle pra UX consistente.
// — Música clássica de fundo (loop, fade, duck) — botão pra desativar
// — Constelação de ícones aparece conforme tools são chamadas
//
// Reutilizado por desktop (ProjectChat) e PWA (MobileApp).

import { useEffect, useState, useRef } from 'react';
import { X, Pause, Music2, VolumeX , Maximize2, PanelRight } from 'lucide-react';
import { iconForTool, labelForTool } from '../lib/tool-icons';
import { bgMusic } from '../lib/background-music';
import PlasmaOrb from './PlasmaOrb';
import { useAudioLevel } from '../lib/audio-level';
import VoiceWave from './VoiceWave';
import { getTtsAnalyser } from '../lib/voice';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface RecentTool { id: string; name: string; ts: number }

interface Props {
  open: boolean;
  state: VoiceState;
  // Texto em destaque (frase corrente que a IA está falando OU o que está ouvindo)
  caption?: string;
  // Últimas tools chamadas no turno corrente (limpa entre turnos)
  recentTools: RecentTool[];
  i18n: {
    listening: string;
    thinking: string;
    speaking: string;
    ready: string;
    pause: string;
    exit: string;
    musicOn: string;
    musicOff: string;
    dock?: string;
    fullscreen?: string;
  };
  onPause: () => void;        // interrompe IA e devolve mic
  /** Ancora numa coluna à direita em vez de ocupar a tela toda. */
  dock?: boolean;
  onToggleDock?: () => void;
  onClose: () => void;        // sai do modo Jarvis
}

export default function JarvisMode({ open, state, caption, recentTools, i18n, onPause, onClose, dock, onToggleDock }: Props) {
  const [musicOn, setMusicOn] = useState<boolean>(bgMusic.isEnabled());

  // Música: liga ao abrir, pausa ao fechar — preserva currentTime entre aberturas.
  useEffect(() => {
    if (!open) { bgMusic.stop(); return; }
    bgMusic.start();
    return () => { bgMusic.stop(); };
  }, [open]);

  // Duck/mute da música conforme estado da voz.
  useEffect(() => {
    if (!open) return;
    if (state === 'listening') bgMusic.mute();
    else if (state === 'speaking') bgMusic.duck();
    else bgMusic.unduck();
  }, [state, open]);

  // ESC fecha o modo.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Nível de áudio para alimentar o orb:
  //   listening → mic (RMS real do que está sendo dito)
  //   outros    → pulso idle senoidal (o orb continua "respirando")
  const audioLevel = useAudioLevel({
    active: open,
    source: state === 'listening' ? 'mic' : 'idle',
  });

  if (!open) return null;

  function toggleMusic() {
    const next = !musicOn;
    setMusicOn(next);
    bgMusic.setEnabled(next);
  }

  // Tamanho do orbe/halo vem do CONTÊINER, não da janela. No modo painel a
  // janela continua larga mas o painel tem ~400px: dimensionar pelo
  // window.innerWidth desenhava um orbe de 360px num painel de 400 e estourava
  // pra direita, desalinhando tudo e empurrando os botões pra fora.
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = boxRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el); setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, [open, dock]);
  const orbSize = Math.max(140, Math.min((boxW || 600) * 0.55, dock ? 240 : 360));

  return (
    <div ref={boxRef} className={`jarvis-overlay ${dock ? 'dock' : ''}`} role="dialog" aria-modal={!dock}>
      <div className="jarvis-grid" />
      <div className="jarvis-vignette" />

      <ToolHalo haloRadius={Math.round(orbSize * 0.72)} tools={recentTools} active={state === 'thinking'} />

      <div className="jarvis-stage">
        <PlasmaOrb level={audioLevel} state={state} size={orbSize} />
      </div>

      {/* Onda em tempo real, colorida por quem fala: laranja você, ciano a IA. */}
      <div className="jarvis-wave">
        <VoiceWave
          speaker={state === 'listening' ? 'user' : state === 'speaking' ? 'ai' : 'idle'}
          level={audioLevel}
          /* Falando: espectro REAL da saída do TTS. Ouvindo: o nível do mic já
             vem do useAudioLevel, então a onda sintética segue a sua voz. */
          analyser={state === 'speaking' ? getTtsAnalyser() : null}
          height={92}
        />
      </div>

      <div className="jarvis-caption">
        <span className={`jarvis-status state-${state}`}>
          {state === 'listening' ? i18n.listening
            : state === 'thinking' ? i18n.thinking
            : state === 'speaking' ? i18n.speaking
            : i18n.ready}
        </span>
        {caption && <div className="jarvis-words">{caption}</div>}
      </div>

      <div className="jarvis-controls">
        <button
          className={`jarvis-btn ${musicOn ? '' : 'off'}`}
          onClick={toggleMusic}
          title={musicOn ? i18n.musicOff : i18n.musicOn}
          aria-label={musicOn ? i18n.musicOff : i18n.musicOn}
        >
          {musicOn ? <Music2 size={16} /> : <VolumeX size={16} />}
          <span>{musicOn ? i18n.musicOff : i18n.musicOn}</span>
        </button>
        {(state === 'thinking' || state === 'speaking') && (
          <button className="jarvis-btn pause" onClick={onPause} title={i18n.pause}>
            <Pause size={16} fill="currentColor" />
            <span>{i18n.pause}</span>
          </button>
        )}
        {onToggleDock && (
          <button className="jarvis-btn" onClick={onToggleDock} title={dock ? i18n.fullscreen : i18n.dock}>
            {dock ? <Maximize2 size={16} /> : <PanelRight size={16} />}
            <span>{dock ? i18n.fullscreen : i18n.dock}</span>
          </button>
        )}
        <button className="jarvis-btn exit" onClick={onClose} title={i18n.exit} aria-label={i18n.exit}>
          <X size={16} />
          <span>{i18n.exit}</span>
        </button>
      </div>
    </div>
  );
}

function ToolHalo({ tools, active, haloRadius }: { tools: RecentTool[]; active: boolean; haloRadius?: number }) {
  // Mostra as últimas N tools em órbita ao redor do orb. Cada uma aparece,
  // dura ~6s e some — efeito "estrelas piscando" enquanto orquestra.
  const items = tools.slice(-12);
  if (items.length === 0) return null;
  return (
    <div className={`jarvis-halo ${active ? 'spinning' : ''}`} aria-hidden>
      {items.map((tool, i) => {
        const Icon = iconForTool(tool.name);
        const total = items.length;
        const angle = (i / Math.max(total, 6)) * Math.PI * 2;
        const radius = Math.max(96, (haloRadius || 240));
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        return (
          <span
            key={tool.id}
            className="jarvis-halo-item"
            style={{ transform: `translate(${x}px, ${y}px)` }}
            title={labelForTool(tool.name)}
          >
            <Icon size={18} />
          </span>
        );
      })}
    </div>
  );
}
