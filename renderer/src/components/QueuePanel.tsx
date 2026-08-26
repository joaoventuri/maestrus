import { useState } from 'react';
import { ListOrdered, X, ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import { useT } from '../lib/i18n';

/**
 * Fila de prompts da conversa. A fila vive no HOST (electron/turn-queue.js) —
 * este painel só mostra e manda comandos, então reordenar aqui reordena para
 * todos os dispositivos.
 *
 * Fica recolhido por padrão: enquanto a IA responde, o que importa é a resposta.
 * Aparece só quando há algo na fila.
 */
export interface QueueItem { id: string; text: string; at?: number }

export default function QueuePanel({ items, projectId }: { items: QueueItem[]; projectId: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (!items.length) return null;

  const api = () => (window as any).maestrus?.claude;

  function move(idx: number, dir: -1 | 1) {
    const next = [...items];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    api()?.queueReorder?.(projectId, next.map((x) => x.id));
  }

  return (
    <div className={`qp ${open ? 'open' : ''}`}>
      <button className="qp-head" onClick={() => setOpen((v) => !v)}>
        <ListOrdered size={13} />
        <span>{t('queue.count', { n: items.length }) || `${items.length} na fila`}</span>
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>

      {open && (
        <div className="qp-list">
          {items.map((it, i) => (
            <div key={it.id} className="qp-item">
              <span className="qp-idx">{i + 1}</span>
              <span className="qp-text" title={it.text}>{it.text}</span>
              <button className="qp-mv" onClick={() => move(i, -1)} disabled={i === 0} title={t('queue.up') || 'Subir'}>
                <ChevronUp size={13} />
              </button>
              <button className="qp-mv" onClick={() => move(i, 1)} disabled={i === items.length - 1} title={t('queue.down') || 'Descer'}>
                <ChevronDown size={13} />
              </button>
              <button className="qp-rm" onClick={() => api()?.queueRemove?.(projectId, it.id)} title={t('queue.remove') || 'Remover'}>
                <X size={13} />
              </button>
            </div>
          ))}
          <button className="qp-clear" onClick={() => api()?.queueClear?.(projectId)}>
            <Trash2 size={12} /> {t('queue.clear') || 'Limpar fila'}
          </button>
        </div>
      )}
    </div>
  );
}
