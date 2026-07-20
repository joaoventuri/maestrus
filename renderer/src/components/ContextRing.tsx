interface Props {
  used: number;
  total: number;
  size?: number;
}

export default function ContextRing({ used, total, size = 36 }: Props) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  let color = '#7bc16f';
  if (pct > 85) color = '#e06c75';
  else if (pct > 70) color = '#d8b657';

  const usedLabel = used >= 1_000_000 ? (used / 1_000_000).toFixed(2) + 'M'
    : used >= 1_000 ? (used / 1_000).toFixed(1) + 'k' : String(used);
  const totalLabel = total >= 1_000_000 ? (total / 1_000_000) + 'M'
    : total >= 1_000 ? (total / 1_000) + 'k' : String(total);

  const title = total > 0
    ? `Context: ${usedLabel} / ${totalLabel} (${pct.toFixed(1)}%) — considera /compact se >85%`
    : 'Sem dados de contexto — envie uma mensagem';

  return (
    <div className="context-ring" title={title}>
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={stroke}
          fill="transparent"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={stroke}
          fill="transparent"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.3s ease' }}
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dy="0.35em"
          fontSize={size * 0.28}
          fontFamily="var(--mono, monospace)"
          fill={color}
        >
          {pct.toFixed(0)}%
        </text>
      </svg>
    </div>
  );
}
