// Inicializador — launcher por voz.
// Esquerda: o fluxo (passos parseados do execution_start.bat) + palavra-chave +
//   botão "Iniciar agora".
// Direita: o chat construtor (ProjectChat do projeto especial 'starter'), que
//   é um Claude Code dedicado a montar/editar o execution_start.bat.

import { useEffect, useRef, useState } from 'react';
import { Play, Mic, Zap, Music4, Terminal, RefreshCw } from 'lucide-react';
import { Project } from '../types';
import ProjectChat from './ProjectChat';
import { useT } from '../lib/i18n';

interface FlowStep { type: 'action' | 'voice'; label: string }
interface Props {
  onStartVoice: () => void;     // abre o Maestrus no modo voz realtime
  onWakeChanged?: (phrase: string, enabled: boolean) => void; // App reinicia o engine
  onOpenLink?: (url: string) => void;
}

export default function StarterScreen({ onStartVoice, onWakeChanged, onOpenLink }: Props) {
  const { t } = useT();
  const [project, setProject] = useState<Project | null>(null);
  const [flow, setFlow] = useState<FlowStep[]>([]);
  const [phrase, setPhrase] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [running, setRunning] = useState(false);
  const [savedHint, setSavedHint] = useState(false);
  const phraseTimer = useRef<any>(null);

  async function refresh() {
    const s = await window.maestrus.starter.get();
    setProject(s.project);
    setFlow(s.flow || []);
    return s;
  }

  useEffect(() => {
    (async () => {
      const s = await window.maestrus.starter.get();
      setProject(s.project);
      setFlow(s.flow || []);
      setPhrase(s.wakePhrase || 'Hello Maestrus');
      setEnabled(!!s.wakeEnabled);
    })();
  }, []);

  // O chat edita o execution_start.bat → repare o fluxo periodicamente.
  useEffect(() => {
    const id = setInterval(() => { window.maestrus.starter.get().then((s) => setFlow(s.flow || [])).catch(() => {}); }, 2500);
    return () => clearInterval(id);
  }, []);

  // O main pode pedir pra abrir a voz (após rodar o bat com o marcador).
  useEffect(() => window.maestrus.starter.onOpenVoice(() => onStartVoice()), [onStartVoice]);

  function onPhraseChange(v: string) {
    setPhrase(v);
    if (phraseTimer.current) clearTimeout(phraseTimer.current);
    phraseTimer.current = setTimeout(() => {
      window.maestrus.starter.setWake({ phrase: v });
      onWakeChanged?.(v, enabled);
      setSavedHint(true); setTimeout(() => setSavedHint(false), 1200);
    }, 600);
  }
  function onToggle(v: boolean) {
    setEnabled(v);
    window.maestrus.starter.setWake({ enabled: v });
    onWakeChanged?.(phrase, v);
  }
  async function runNow() {
    setRunning(true);
    try {
      const r = await window.maestrus.starter.run();
      if (r.ok && r.startVoice) setTimeout(() => onStartVoice(), 600);
    } finally { setRunning(false); }
  }

  return (
    <div className="starter">
      {/* ESQUERDA — fluxo + wake word */}
      <div className="starter-flow">
        <div className="starter-head">
          <div className="starter-title"><Zap size={18} /> {t('starter.title')}</div>
          <button className="starter-refresh" onClick={() => refresh()} title={t('starter.refresh')}><RefreshCw size={14} /></button>
        </div>
        <p className="starter-sub">{t('starter.subtitle')}</p>

        <div className="starter-wake">
          <label className="starter-label">{t('starter.phrase')}</label>
          <div className="starter-phrase-row">
            <Mic size={14} />
            <input value={phrase} onChange={(e) => onPhraseChange(e.target.value)} placeholder="Hello Maestrus" />
            {savedHint && <span className="starter-saved">✓</span>}
          </div>
          <label className="starter-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
            <span>{t('starter.listenBg')}</span>
          </label>
        </div>

        <div className="starter-flow-label">{t('starter.flow')}</div>
        <div className="starter-steps">
          {flow.length === 0 && <div className="starter-empty">{t('starter.empty')}</div>}
          {flow.map((s, i) => (
            <div key={i} className={`starter-step ${s.type}`}>
              <span className="starter-step-n">{i + 1}</span>
              <span className="starter-step-ico">
                {s.type === 'voice' ? <Mic size={14} /> : /youtube|spotify|music|som|música|tocar|play/i.test(s.label) ? <Music4 size={14} /> : <Terminal size={14} />}
              </span>
              <span className="starter-step-label">{s.label}</span>
            </div>
          ))}
        </div>

        <button className="starter-run" onClick={runNow} disabled={running || flow.length === 0}>
          <Play size={15} fill="currentColor" /> {running ? t('starter.running') : t('starter.runNow')}
        </button>
      </div>

      {/* DIREITA — chat construtor */}
      <div className="starter-chat">
        {project ? (
          <ProjectChat
            key={project.id}
            project={project}
            onProjectUpdate={(p) => setProject(p)}
            onOpenLink={onOpenLink}
          />
        ) : (
          <div className="starter-loading">…</div>
        )}
      </div>
    </div>
  );
}
