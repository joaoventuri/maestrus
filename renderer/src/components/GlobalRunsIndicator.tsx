import { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu } from 'lucide-react';
import RunsPanel from './RunsPanel';
import { useT } from '../lib/i18n';

/**
 * Indicador GLOBAL de execuções em segundo plano — vive no topo, em qualquer
 * tela. Só aparece quando há algo rodando (tela limpa quando ocioso): pulso +
 * contagem, clique abre o painel com todas as execuções de todos os projetos,
 * saída ao vivo e botão de encerrar.
 *
 * Existe porque o run-store resolvia a metade invisível do problema: os
 * processos sobreviviam ao turno, mas só quem abrisse o chip DENTRO do chat
 * daquele projeto ficava sabendo. Trabalho em segundo plano que ninguém vê é
 * indistinguível de trabalho que morreu.
 */
export default function GlobalRunsIndicator() {
  const { t } = useT();
  const api = (window as any).maestrus?.runs;
  const [count, setCount] = useState(0);
  const [openPanel, setOpenPanel] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try { setCount((await api?.activeCount?.()) || 0); } catch {}
  }, []);

  useEffect(() => {
    if (!api) return;
    refresh();
    // Evento cobre o tempo real (o run-store emite a cada chunk de saída);
    // o intervalo cobre evento perdido.
    const off = api.onChange?.(() => refresh());
    const iv = setInterval(refresh, 8000);
    return () => { try { off && off(); } catch {} clearInterval(iv); };
  }, [refresh]);

  // Clique fora fecha o painel.
  useEffect(() => {
    if (!openPanel) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenPanel(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openPanel]);

  if (!api || (!count && !openPanel)) return null;

  return (
    <div className="global-runs" ref={wrapRef}>
      <button
        className={`global-runs-pill ${count ? 'on' : ''}`}
        onClick={() => setOpenPanel((v) => !v)}
        title={t('runs.globalTitle')}
      >
        <span className="global-runs-pulse" />
        <Cpu size={13} />
        <span>{count}</span>
      </button>
      {openPanel && <RunsPanel global onClose={() => setOpenPanel(false)} />}
    </div>
  );
}
