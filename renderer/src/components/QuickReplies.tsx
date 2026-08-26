import { useState } from 'react';
import { Check, Send } from 'lucide-react';
import { QuickReply } from '../lib/quick-replies';
import { useT } from '../lib/i18n';

// Botões de resposta rápida acima do composer. Single = clica e manda; multi =
// marca vários e envia.
export default function QuickReplies({ data, onSend }: { data: QuickReply; onSend: (text: string) => void }) {
  const { t } = useT();
  const [sel, setSel] = useState<Set<string>>(new Set());

  const options = Array.isArray(data?.options) ? data.options : [];
  if (options.length === 0) return null;

  if (!data.multiSelect) {
    return (
      <div className="quick-replies">
        {options.map((o, i) => (
          <button key={i} className="qr-chip" title={o.description} onClick={() => onSend(o.label)}>
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  function toggle(label: string) {
    setSel((s) => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n; });
  }

  return (
    <div className="quick-replies multi">
      {options.map((o, i) => (
        <button key={i} className={`qr-chip ${sel.has(o.label) ? 'on' : ''}`} title={o.description} onClick={() => toggle(o.label)}>
          {sel.has(o.label) && <Check size={12} />} {o.label}
        </button>
      ))}
      <button className="qr-send" disabled={sel.size === 0} onClick={() => onSend([...sel].join(', '))}>
        <Send size={12} /> {t('chat.sendAnswer')}
      </button>
    </div>
  );
}
