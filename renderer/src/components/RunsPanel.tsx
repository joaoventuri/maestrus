import { useCallback, useEffect, useState } from 'react';
import { Cpu, Square, ChevronRight, ChevronDown, X as XIcon, Loader2 } from 'lucide-react';
import { useT } from '../lib/i18n';
import type { BackgroundRun } from '../types';

/**
 * Execuções em segundo plano do projeto.
 *
 * Antes, o que o agente lançava em segundo plano morria junto com o turno e
 * ninguém via nada acontecer. Agora os processos pertencem ao host e este
 * painel é a janela para eles: o que está rodando, a saída ao vivo e o botão
 * de encerrar.
 */
export function RunsChip({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const { t } = useT();
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try { setCount(await window.maestrus.runs.activeCount(projectId) || 0); } catch {}
  }, [projectId]);

  useEffect(() => {
    refresh();
    // Atualiza por evento (barato) e por intervalo (cobre evento perdido, o
    // mesmo problema que fazia as bolinhas do sidebar travarem).
    const off = window.maestrus.runs.onChange(() => refresh());
    const iv = setInterval(refresh, 10000);
    return () => { try { off && off(); } catch {} clearInterval(iv); };
  }, [refresh]);

  if (!count) return null;
  return (
    <button className="runs-chip" onClick={onOpen} title={t('runs.openPanel') || 'Execuções em segundo plano'}>
      <Cpu size={13} className="runs-chip-icon" />
      <span>{count}</span>
    </button>
  );
}

function statusLabel(s: BackgroundRun['status'], t: (k: string) => string) {
  return {
    running: t('runs.running') || 'rodando',
    done: t('runs.done') || 'concluído',
    error: t('runs.error') || 'erro',
    stopped: t('runs.stopped') || 'parado',
  }[s];
}

function elapsed(r: BackgroundRun) {
  const end = r.endedAt || Date.now();
  const s = Math.max(0, Math.round((end - r.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}min` : `${Math.floor(m / 60)}h${m % 60}`;
}

export default function RunsPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useT();
  const [runs, setRuns] = useState<BackgroundRun[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try { setRuns(await window.maestrus.runs.list(projectId) || []); } catch {}
  }, [projectId]);

  useEffect(() => {
    load();
    const off = window.maestrus.runs.onChange(() => load());
    const iv = setInterval(load, 5000);
    return () => { try { off && off(); } catch {} clearInterval(iv); };
  }, [load]);

  async function stop(id: string) {
    setBusy(id);
    try { await window.maestrus.runs.stop(id); await load(); } finally { setBusy(''); }
  }

  return (
    <aside className="runs-panel">
      <header className="runs-panel-head">
        <Cpu size={14} />
        <span>{t('runs.title') || 'Segundo plano'}</span>
        <button className="runs-panel-close" onClick={onClose} title={t('common.close')}><XIcon size={13} /></button>
      </header>

      {!runs.length && <p className="runs-empty">{t('runs.empty') || 'Nada rodando em segundo plano.'}</p>}

      <div className="runs-list">
        {runs.map((r) => {
          const isOpen = open === r.id;
          return (
            <div key={r.id} className={`run-item ${r.status}`}>
              <button className="run-head" onClick={() => setOpen(isOpen ? null : r.id)}>
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className={`run-dot ${r.status}`} />
                <span className="run-label" title={r.command}>{r.label}</span>
                <span className="run-meta">{statusLabel(r.status, t)} · {elapsed(r)}</span>
              </button>

              {r.status === 'running' && (
                <button className="run-stop" onClick={() => stop(r.id)} disabled={busy === r.id}
                  title={t('runs.stop') || 'Encerrar'}>
                  {busy === r.id ? <Loader2 size={11} className="spin" /> : <Square size={11} />}
                </button>
              )}

              {isOpen && (
                <div className="run-body">
                  <code className="run-cmd">{r.command}</code>
                  {/* A cauda basta para acompanhar; o log completo fica em disco
                      e não é despejado na UI sem necessidade. */}
                  <pre className="run-log">{r.tail || (t('runs.noOutput') || 'sem saída ainda…')}</pre>
                  {r.truncated && <span className="run-trunc">{t('runs.truncated') || 'log truncado'}</span>}
                  {r.exitCode !== null && <span className="run-exit">exit {r.exitCode}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
