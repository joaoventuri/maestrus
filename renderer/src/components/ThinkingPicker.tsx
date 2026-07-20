import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Check, ChevronDown } from 'lucide-react';
import { ThinkingMode } from '../types';
import { useT } from '../lib/i18n';

interface Props {
  value: ThinkingMode;
  onChange: (m: ThinkingMode) => void;
}

const MODE_IDS: ThinkingMode[] = ['none', 'low', 'medium', 'high'];

export default function ThinkingPicker({ value, onChange }: Props) {
  const { t } = useT();
  const MODES = MODE_IDS.map((id) => ({ id, label: t(`thinking.${id}`), desc: t(`thinking.${id}Desc`) }));
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

  const current = MODES.find((m) => m.id === value) || MODES[2];

  return (
    <div className="picker">
      <button ref={triggerRef} className="picker-trigger" onClick={toggle}>
        <Brain size={13} />
        <span>{t('thinking.label')}: {current.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && coords && createPortal(
        <div ref={menuRef} className="picker-menu" style={{ top: coords.top, right: coords.right }}>
          <div className="picker-title">{t('thinking.title')}</div>
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`picker-item ${m.id === value ? 'selected' : ''}`}
              onClick={() => { onChange(m.id); setOpen(false); }}
            >
              <div className="picker-check">{m.id === value && <Check size={13} />}</div>
              <div className="picker-body">
                <div className="picker-label">{m.label}</div>
                <div className="picker-desc">{m.desc}</div>
              </div>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
