import { useEffect, useState } from 'react';
import { Server, MonitorSmartphone, Check, Loader2, Lock } from 'lucide-react';
import { useT } from '../lib/i18n';
import Logo from './Logo';

// Picker de modo (primeira abertura ou troca em Settings): Server (tudo local,
// pode hospedar clientes) ou Client (espelha um host pelo relay — o Claude roda
// NO host, então controle de PC e voz agem na máquina servidor).
// Multi-dispositivo (cliente / hospedar) é Pro — Free roda local (Server).
export default function ModePicker({ onDone, current }: { onDone: (mode: 'server' | 'client') => void; current?: 'server' | 'client' | null }) {
  const { t } = useT();
  const [sel, setSel] = useState<'server' | 'client'>(current || 'server');
  const [busy, setBusy] = useState(false);
  const [pro, setPro] = useState(true);
  const [freeLeft, setFreeLeft] = useState<number | null>(null);

  useEffect(() => {
    window.maestrus.app.entitlement?.().then((r) => { setPro(!!r.pro); setFreeLeft(r.remoteFreeRemaining); }).catch(() => {});
  }, []);

  const exhausted = !pro && (freeLeft ?? 1) <= 0;

  async function confirm() {
    // Cliente: Free esgotou a amostra → manda pro upgrade. Senão segue (usa amostra).
    if (sel === 'client' && exhausted) { try { await window.maestrus.cloud.openPanel(); } catch {} return; }
    setBusy(true);
    try {
      await window.maestrus.app.setMode?.(sel);
      onDone(sel);
    } finally { setBusy(false); }
  }

  return (
    <div className="mode-picker">
      <div className="mode-picker-inner">
        <div className="mode-logo"><Logo size={34} /></div>
        <h1 className="mode-title">{t('mode.title')}</h1>
        <p className="mode-sub">{t('mode.sub')}</p>

        <div className="mode-cards">
          <button className={`mode-card ${sel === 'server' ? 'active' : ''}`} onClick={() => setSel('server')}>
            <span className="mode-card-icon"><Server size={26} /></span>
            <span className="mode-card-name">{t('mode.serverTitle')} {sel === 'server' && <Check size={14} />}</span>
            <span className="mode-card-desc">{t('mode.serverDesc')}</span>
          </button>
          <button className={`mode-card ${sel === 'client' ? 'active' : ''}`} onClick={() => setSel('client')}>
            <span className="mode-card-icon"><MonitorSmartphone size={26} /></span>
            <span className="mode-card-name">
              {t('mode.clientTitle')} {sel === 'client' && (pro || !exhausted) && <Check size={14} />}
              {!pro && !exhausted && freeLeft != null && <span className="mode-pro mode-free">{t('mode.freeLeft', { n: freeLeft })}</span>}
              {exhausted && <span className="mode-pro"><Lock size={10} /> Pro</span>}
            </span>
            <span className="mode-card-desc">{t('mode.clientDesc')}</span>
          </button>
        </div>

        <button className="btn-primary mode-confirm" onClick={confirm} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : null}
          {sel === 'client' && exhausted ? t('mode.upgrade') : t('mode.continue')}
        </button>
        <p className="mode-hint">{t('mode.changeHint')}</p>
      </div>
    </div>
  );
}
