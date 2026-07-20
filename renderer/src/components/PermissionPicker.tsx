import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, ShieldAlert, Shield, ShieldOff, Check, ChevronDown } from 'lucide-react';
import { PermissionMode } from '../types';
import { useT } from '../lib/i18n';

interface Props {
  value: PermissionMode;
  onChange: (m: PermissionMode) => void;
}

const MODE_DEFS: { id: PermissionMode; key: string; icon: any }[] = [
  { id: 'default', key: 'default', icon: Shield },
  { id: 'acceptEdits', key: 'acceptEdits', icon: ShieldCheck },
  { id: 'plan', key: 'plan', icon: ShieldAlert },
  { id: 'bypassPermissions', key: 'bypass', icon: ShieldOff },
];

export default function PermissionPicker({ value, onChange }: Props) {
  const { t } = useT();
  const MODES = MODE_DEFS.map((m) => ({ id: m.id, icon: m.icon, label: t(`permission.${m.key}`), desc: t(`permission.${m.key}Desc`) }));
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

  const current = MODES.find((m) => m.id === value) || MODES[0];
  const Icon = current.icon;
  const isYolo = value === 'bypassPermissions';

  return (
    <div className="picker">
      <button
        ref={triggerRef}
        className={`picker-trigger ${isYolo ? 'picker-trigger-warn' : ''}`}
        onClick={toggle}
        title={`${t('permission.title')}: ${current.desc}`}
      >
        <Icon size={13} />
        <span>{current.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && coords && createPortal(
        <div ref={menuRef} className="picker-menu" style={{ top: coords.top, right: coords.right }}>
          <div className="picker-title">{t('permission.title')}</div>
          {MODES.map((m) => {
            const MIcon = m.icon;
            return (
              <button
                key={m.id}
                className={`picker-item ${m.id === value ? 'selected' : ''}`}
                onClick={() => { onChange(m.id); setOpen(false); }}
              >
                <div className="picker-check">{m.id === value && <Check size={13} />}</div>
                <div className="picker-body">
                  <div className="picker-label">
                    <MIcon size={12} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                    {m.label}
                  </div>
                  <div className="picker-desc">{m.desc}</div>
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
