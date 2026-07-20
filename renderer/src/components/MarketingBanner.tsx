import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useT } from '../lib/i18n';

// Banner de campanha pro usuário que não está logado no Maestrus Cloud.
// Dispensável por sessão (volta a aparecer numa nova abertura do app).
export default function MarketingBanner({ onOpen }: { onOpen: () => void }) {
  const { t } = useT();
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    if (sessionStorage.getItem('maestrus.promo.dismissed')) return;
    window.maestrus.cloud.account().then((acc) => {
      if (alive && !acc) setShow(true); // só quando NÃO logado
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!show) return null;

  function dismiss() {
    try { sessionStorage.setItem('maestrus.promo.dismissed', '1'); } catch {}
    setShow(false);
  }

  return (
    <div className="promo-banner">
      <span className="promo-msg">
        <Sparkles size={14} /> {t('promo.text')}
      </span>
      <div className="promo-actions">
        <button className="promo-btn" onClick={onOpen}>{t('promo.cta')}</button>
        <button className="promo-x" onClick={dismiss} title={t('common.remove')}><X size={14} /></button>
      </div>
    </div>
  );
}
