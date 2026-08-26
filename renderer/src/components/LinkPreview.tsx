import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, X, Globe } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Props { url: string; onClose: () => void; }

// Navegador embutido (painel à direita) pra dar preview de links do chat sem
// sair do app. Usa <webview> (processo isolado, sem node). Toolbar com voltar/
// avançar/recarregar/abrir-no-navegador/fechar.
export default function LinkPreview({ url, onClose }: Props) {
  const { t } = useT();
  const ref = useRef<any>(null);
  const [current, setCurrent] = useState(url);
  const [loading, setLoading] = useState(true);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);

  // Clicou outro link → navega a webview existente (não recria).
  useEffect(() => {
    setCurrent(url);
    const wv = ref.current;
    try { if (wv && wv.getURL && wv.getURL() !== url) wv.loadURL(url); } catch {}
  }, [url]);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const refreshNav = () => { try { setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward()); setCurrent(wv.getURL()); } catch {} };
    const onStart = () => setLoading(true);
    const onStop = () => { setLoading(false); refreshNav(); };
    const onNav = (e: any) => { if (e.url) setCurrent(e.url); refreshNav(); };
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    return () => {
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNav);
    };
  }, []);

  // O agente está navegando AGORA? Acende a moldura laranja: você vê o Maestrus
  // trabalhando no navegador em tempo real, em vez de a página mudar sozinha
  // sem explicação.
  const [agentBusy, setAgentBusy] = useState(false);
  useEffect(() => {
    const off = (window as any).maestrus?.browser?.onAgent?.(({ active }: { active: boolean }) => setAgentBusy(!!active));
    return () => { try { off && off(); } catch {} };
  }, []);

  return (
    <aside className={`link-preview ${agentBusy ? 'agent-busy' : ''}`}>
      <div className="lp-toolbar">
        <button className="lp-btn" disabled={!canBack} onClick={() => ref.current?.goBack()} title={t('linkPreview.back')}><ArrowLeft size={14} /></button>
        <button className="lp-btn" disabled={!canFwd} onClick={() => ref.current?.goForward()} title={t('linkPreview.forward')}><ArrowRight size={14} /></button>
        <button className="lp-btn" onClick={() => ref.current?.reload()} title={t('linkPreview.reload')}><RotateCw size={14} /></button>
        <div className="lp-url" title={current}><Globe size={12} /><span>{current}</span></div>
        <button className="lp-btn" onClick={() => window.maestrus.shell.openExternal(current)} title={t('linkPreview.openExternal')}><ExternalLink size={14} /></button>
        <button className="lp-btn" onClick={onClose} title={t('linkPreview.close')}><X size={14} /></button>
      </div>
      <div className={`lp-progress ${loading ? 'on' : ''}`} />
      {/* @ts-ignore — webview é um elemento do Electron */}
      <webview ref={ref} src={url} className="lp-webview" partition="persist:preview" />
      {agentBusy && (
        <div className="lp-agent-overlay" aria-hidden="true">
          <span className="lp-agent-pill"><span className="lp-agent-dot" /> {t('linkPreview.agentBusy') || 'Maestrus navegando…'}</span>
        </div>
      )}
    </aside>
  );
}
