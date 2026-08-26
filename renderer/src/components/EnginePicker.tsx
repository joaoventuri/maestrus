import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Terminal, KeyRound } from 'lucide-react';
import { ClaudeMark, OpenAIMark } from './BrandMarks';
import { useT } from '../lib/i18n';

export type EngineId = 'claude' | 'cloud' | 'codex' | 'codex-api';

interface EngineDef {
  id: EngineId;
  provider: 'Claude' | 'Codex';
  label: string;   // rótulo curto no gatilho
  kind: 'CLI' | 'API';
  descKey: string; // i18n
}

// Ordem: os dois do Claude, depois os dois do Codex. "CLI" = assinatura
// (Claude Code / ChatGPT), "API" = BYOK (chave Anthropic / OpenAI).
const ENGINES: EngineDef[] = [
  { id: 'claude',    provider: 'Claude', label: 'Claude CLI', kind: 'CLI', descKey: 'engine.claudeCliDesc' },
  { id: 'cloud',     provider: 'Claude', label: 'Claude API', kind: 'API', descKey: 'engine.claudeApiDesc' },
  { id: 'codex',     provider: 'Codex',  label: 'Codex CLI',  kind: 'CLI', descKey: 'engine.codexCliDesc' },
  { id: 'codex-api', provider: 'Codex',  label: 'Codex API',  kind: 'API', descKey: 'engine.codexApiDesc' },
];

interface Props {
  value: EngineId;
  onChange: (e: EngineId) => void;
  avail: Record<EngineId, boolean>;
}

export default function EnginePicker({ value, onChange, avail }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const n = e.target as Node;
      if (triggerRef.current?.contains(n) || menuRef.current?.contains(n)) return;
      setOpen(false);
    }
    function onResize() { setOpen(false); }
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('resize', onResize); };
  }, []);

  function toggle() {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const openUp = window.innerHeight - r.bottom < 300;
      setCoords(openUp
        ? { bottom: window.innerHeight - r.top + 6, left: r.left }
        : { top: r.bottom + 6, left: r.left });
    }
    setOpen((v) => !v);
  }

  const cur = ENGINES.find((e) => e.id === value) || ENGINES[0];
  const CurMark = cur.provider === 'Codex' ? OpenAIMark : ClaudeMark;

  const groups: Array<'Claude' | 'Codex'> = ['Claude', 'Codex'];

  return (
    <div className="picker engine-picker">
      <button ref={triggerRef} className={`picker-trigger engine-trigger prov-${cur.provider.toLowerCase()}`} onClick={toggle} title={t('engine.tooltip')}>
        <CurMark size={13} />
        <span>{cur.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && coords && createPortal(
        <div ref={menuRef} className="picker-menu engine-menu" style={{ top: coords.top, bottom: coords.bottom, left: coords.left }}>
          {groups.map((g) => (
            <div key={g} className="engine-group">
              <div className="engine-group-title">{g === 'Codex' ? 'Codex · OpenAI' : 'Claude · Anthropic'}</div>
              {ENGINES.filter((e) => e.provider === g).map((e) => {
                const on = avail[e.id];
                const KIcon = e.kind === 'API' ? KeyRound : Terminal;
                return (
                  <button
                    key={e.id}
                    className={`picker-item engine-item ${e.id === value ? 'selected' : ''} ${!on ? 'off' : ''}`}
                    onClick={() => { onChange(e.id); setOpen(false); }}
                  >
                    <div className="picker-check">{e.id === value && <Check size={13} />}</div>
                    <div className="picker-body">
                      <div className="picker-label">
                        <KIcon size={12} /> {e.label}
                        {!on && <span className="engine-off-badge">{t('engine.offBadge') || 'configurar'}</span>}
                      </div>
                      <div className="picker-desc">{t(e.descKey)}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
