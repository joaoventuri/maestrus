import { useEffect, useRef, useState } from 'react';

interface Props {
  used: number;
  total: number;
  size?: number;
}

function fmt(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + 'M'
    : n >= 1_000 ? (n / 1_000).toFixed(1) + 'k' : String(n);
}

export default function ContextRing({ used, total, size = 36 }: Props) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  let color = '#3dd68c';
  if (pct > 85) color = '#ff6b6b';
  else if (pct > 70) color = '#ffcf5c';

  const hasData = total > 0;

  return (
    <div className="context-ring" ref={ref}>
      <button className="context-ring-btn" onClick={() => setOpen((o) => !o)} title={hasData ? `Contexto: ${fmt(used)} / ${fmt(total)} (${pct.toFixed(1)}%)` : 'Sem dados de contexto'}>
        <svg width={size} height={size}>
          <circle cx={size / 2} cy={size / 2} r={radius} stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} fill="transparent" />
          <circle cx={size / 2} cy={size / 2} r={radius} stroke={color} strokeWidth={stroke} fill="transparent"
            strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.3s ease' }} />
          <text x="50%" y="50%" textAnchor="middle" dy="0.35em" fontSize={size * 0.28} fontFamily="var(--mono, monospace)" fill={color}>
            {pct.toFixed(0)}%
          </text>
        </svg>
      </button>

      {open && (
        <div className="ctx-popover">
          <div className="ctx-pop-row">
            <span className="ctx-pop-title">Janela de contexto</span>
            <span className="ctx-pop-val" style={{ color }}>{hasData ? `${fmt(used)} / ${fmt(total)} (${pct.toFixed(0)}%)` : '—'}</span>
          </div>
          <div className="ctx-pop-bar"><span style={{ width: `${pct}%`, background: color }} /></div>
          <div className="ctx-pop-hint">
            {pct > 85 ? 'Contexto quase cheio — considere /compact.'
              : pct > 70 ? 'Contexto enchendo — /compact quando quiser resumir.'
              : hasData ? 'Contexto saudável.'
              : 'Envie uma mensagem para medir o contexto.'}
          </div>
        </div>
      )}
    </div>
  );
}
