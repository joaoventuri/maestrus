import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Cpu, Check, ChevronDown } from 'lucide-react';
import { ModelChoice } from '../types';
import { MODEL_REGISTRY, getModelInfo, costTier } from '../lib/model-info';
import { useT } from '../lib/i18n';

interface Props {
  value: ModelChoice;
  onChange: (m: ModelChoice) => void;
  /** Quando 'cloud', mostra o custo relativo ($/$$/$$$) — só importa no medido. */
  engine?: 'claude' | 'cloud';
}

export default function ModelPicker({ value, onChange, engine }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onResize() { setOpen(false); }
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  function toggle() {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setCoords({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((v) => !v);
  }

  const current = getModelInfo(value);
  const cloud = engine === 'cloud';

  return (
    <div className="picker">
      <button ref={triggerRef} className="picker-trigger" onClick={toggle} title={t(current.descKey)}>
        <Cpu size={13} />
        <span>{current.label}</span>
        {cloud && <span className={`cost-tier t${costTier(value).length}`}>{costTier(value)}</span>}
        <ChevronDown size={12} />
      </button>
      {open && coords && createPortal(
        <div ref={menuRef} className="picker-menu wide" style={{ top: coords.top, right: coords.right }}>
          <div className="picker-title">{t('model.title')}</div>
          {cloud && <div className="picker-note">{t('model.cloudCost')}</div>}
          {MODEL_REGISTRY.map((m) => {
            const tier = costTier(m.id);
            return (
              <button
                key={m.id}
                className={`picker-item ${m.id === value ? 'selected' : ''}`}
                onClick={() => { onChange(m.id); setOpen(false); }}
              >
                <div className="picker-check">{m.id === value && <Check size={13} />}</div>
                <div className="picker-body">
                  <div className="picker-label">
                    {m.label}
                    {cloud && <span className={`cost-tier t${tier.length}`}>{tier}</span>}
                  </div>
                  <div className="picker-desc">{t(m.descKey)}</div>
                </div>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}
