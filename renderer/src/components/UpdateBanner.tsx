import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, X, CheckCircle2, Sparkles } from 'lucide-react';
import { useT } from '../lib/i18n';

type Phase = 'idle' | 'available' | 'downloading' | 'ready' | 'download' | 'asar-available' | 'asar-downloading' | 'asar-ready';

export default function UpdateBanner() {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('idle');
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const lastV = useRef('');
  // Once the asar check resolves, this is true. Legacy .dmg flow only kicks in
  // if asar explicitly returned requiresInstaller — never as a race winner.
  const asarChecked = useRef(false);

  // Subscribe to asar-update events from main (progress / downloaded / error
  // also arrive here, not just `available`).
  useEffect(() => {
    const off = window.maestrus?.update?.onAsarEvent?.((ch, payload) => {
      if (ch === 'asar-update:available') {
        const v = payload.version || '';
        if (!v || v === lastV.current) return;
        lastV.current = v; setVersion(v); setDismissed(false); setPhase('asar-available');
      }
      else if (ch === 'asar-update:progress') { setPercent(payload.percent || 0); setPhase('asar-downloading'); setErrMsg(''); }
      else if (ch === 'asar-update:downloaded') { setPhase('asar-ready'); setErrMsg(''); }
      else if (ch === 'asar-update:error') {
        // Mostra o erro no banner pra usuário poder retry ou ir pro .dmg manual.
        setErrMsg(payload?.message || 'erro desconhecido');
        setPhase('asar-available'); // permite retry
      }
    });
    return () => { off && off(); };
  }, []);

  // Initial check + periodic refresh. Tries asar first; falls back to installer
  // only when asar says "Electron bumped" or there's no manifest.
  useEffect(() => {
    let alive = true;
    const isWin = window.maestrus?.platform === 'win32';

    const checkOnce = async () => {
      if (!alive) return;
      try {
        const r: any = await window.maestrus?.update?.asarCheck?.();
        asarChecked.current = true;
        if (!alive) return;
        if (r?.ok && r.hasUpdate) {
          // Banner já vai aparecer pelo onAsarEvent (main emite 'available').
          // Mas em check manual o evento pode não disparar de novo — força:
          const v = r.version || '';
          if (v && v !== lastV.current) {
            lastV.current = v; setVersion(v); setDismissed(false);
            // r.downloaded = o .pending já está baixado e íntegro → direto pro "reiniciar"
            setPhase(r.downloaded ? 'asar-ready' : 'asar-available');
          }
          return;
        }
        // Sem patch asar disponível → tenta o caminho do instalador completo
        // (electron-updater no Win, manual via cloud.checkUpdate no Mac).
        if (isWin) return; // electron-updater já registra ouvintes próprios
        const r2: any = await window.maestrus?.cloud?.checkUpdate?.();
        if (!alive || !r2 || !r2.update_available || !r2.url || !r2.latest) return;
        if (r2.latest === lastV.current) return;
        lastV.current = r2.latest; setVersion(r2.latest); setDownloadUrl(r2.url); setPhase('download'); setDismissed(false);
      } catch {}
    };

    checkOnce();
    const onFocus = () => checkOnce();
    window.addEventListener('focus', onFocus);
    const id = window.setInterval(checkOnce, 30 * 60 * 1000);

    // Electron-updater (Windows) flow: fica de olho nos eventos do main process.
    // Só aparece se o asar JÁ FOI checado e não tem patch (asarChecked=true + idle).
    let offUpdate: undefined | (() => void);
    if (isWin) {
      offUpdate = window.maestrus.update.onEvent((ch, payload) => {
        const isAsar = (p: Phase) => p.startsWith('asar-');
        setPhase((cur) => {
          if (isAsar(cur)) return cur; // asar tem precedência sempre
          if (ch === 'update:available') {
            const v = payload.version || '';
            if (!v || v === lastV.current) return cur;
            lastV.current = v; setVersion(v); setDismissed(false);
            return 'available';
          }
          if (ch === 'update:progress') { setPercent(payload.percent || 0); return 'downloading'; }
          if (ch === 'update:downloaded') return 'ready';
          if (ch === 'update:error') {
            // Download do instalador falhou — volta pro botão com a msg (permite retry).
            setErrMsg(payload?.message || 'erro no download');
            return cur === 'downloading' || cur === 'available' ? 'available' : cur;
          }
          return cur;
        });
      });
    }

    return () => { alive = false; window.removeEventListener('focus', onFocus); clearInterval(id); offUpdate && offUpdate(); };
  }, []);

  if (phase === 'idle' || dismissed) return null;

  return (
    <div className="update-banner">
      {phase === 'asar-available' && (
        <>
          <span className="update-msg">
            <Sparkles size={14} /> {t('update.patchAvailable') || 'Atualização rápida disponível'} <strong>v{version}</strong>
            {errMsg && <span className="update-err"> · {errMsg}</span>}
          </span>
          <div className="update-actions">
            <button className="update-btn primary" onClick={async (ev) => {
              ev.preventDefault(); ev.stopPropagation();
              console.log('[update-banner] CLICK FIRED → asarDownload');
              setErrMsg('');
              setPercent(0);
              setPhase('asar-downloading'); // feedback imediato
              const t0 = Date.now();
              try {
                const r: any = await window.maestrus.update.asarDownload();
                console.log('[update-banner] asarDownload resolved in', Date.now() - t0, 'ms ::', r);
                if (r && r.ok === false) {
                  setErrMsg(r.error || r.reason || 'falhou');
                  setPhase('asar-available');
                } else if (r && r.ok) {
                  // Fallback: o invoke resolve quando o download termina — mesmo
                  // que os eventos de progresso se percam, nunca fica preso em 0%.
                  setPhase('asar-ready');
                }
              } catch (e: any) {
                console.log('[update-banner] asarDownload threw', e);
                setErrMsg(e?.message || String(e));
                setPhase('asar-available');
              }
            }}>{t('update.update')}</button>
            <button className="update-btn ghost" onClick={() => setDismissed(true)}><X size={14} /></button>
          </div>
        </>
      )}
      {phase === 'asar-downloading' && (
        <span className="update-msg"><Loader2 size={14} className="spin" /> {t('update.downloading')} {percent}%</span>
      )}
      {phase === 'asar-ready' && (
        <>
          <span className="update-msg"><CheckCircle2 size={14} /> {t('update.patchReady') || 'Pronto — reinicie pra aplicar (sem perder permissões)'}</span>
          <div className="update-actions">
            <button className="update-btn primary" onClick={() => window.maestrus.update.asarApply()}>{t('update.restart')}</button>
            <button className="update-btn ghost" onClick={() => setDismissed(true)}><X size={14} /></button>
          </div>
        </>
      )}
      {phase === 'available' && (
        <>
          <span className="update-msg"><Download size={14} /> {t('update.available')} <strong>v{version}</strong>
            {errMsg && <span className="update-err"> · {errMsg}</span>}
          </span>
          <div className="update-actions">
            <button className="update-btn primary" onClick={() => { setErrMsg(''); window.maestrus.update.download(); }}>{t('update.update')}</button>
            <button className="update-btn ghost" onClick={() => setDismissed(true)}><X size={14} /></button>
          </div>
        </>
      )}
      {phase === 'download' && (
        <>
          <span className="update-msg"><Download size={14} /> {t('update.available')} <strong>v{version}</strong></span>
          <div className="update-actions">
            <button className="update-btn primary" onClick={() => window.maestrus.shell.openExternal(downloadUrl)}>{t('update.download')}</button>
            <button className="update-btn ghost" onClick={() => setDismissed(true)}><X size={14} /></button>
          </div>
        </>
      )}
      {phase === 'downloading' && (
        <span className="update-msg"><Loader2 size={14} className="spin" /> {t('update.downloading')} {percent}%</span>
      )}
      {phase === 'ready' && (
        <>
          <span className="update-msg"><CheckCircle2 size={14} /> {t('update.ready')}</span>
          <div className="update-actions">
            <button className="update-btn primary" onClick={() => window.maestrus.update.install()}>{t('update.restart')}</button>
            <button className="update-btn ghost" onClick={() => setDismissed(true)}><X size={14} /></button>
          </div>
        </>
      )}
    </div>
  );
}
