import { useEffect, useRef, useState } from 'react';
import { LogIn, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import Logo from './Logo';
import { useT } from '../lib/i18n';

interface Props { onAuthed: () => void; }

// Gate de autenticação do Claude. Sem login na conta Anthropic, o app não deixa
// mandar prompt. Botão dispara `claude auth login` (abre o navegador) e a gente
// re-checa o status quando termina.
export default function ClaudeAuthScreen({ onAuthed }: Props) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    return window.maestrus.claudeAuth.onLog(({ line }) => {
      setLog((prev) => prev + line);
      requestAnimationFrame(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; });
    });
  }, []);

  async function recheck() {
    const s = await window.maestrus.claudeAuth.status();
    if (s.loggedIn) { onAuthed(); return true; }
    return false;
  }

  async function login() {
    if (busy) return;
    setBusy(true); setError(null); setLog('');
    const r = await window.maestrus.claudeAuth.login();
    setBusy(false);
    const ok = await recheck();
    if (!ok && !r.ok) setError(t('auth.failed'));
  }

  return (
    <div className="cloud-screen">
      <div className="cloud-grid" />
      <div className="cloud-card">
        <Logo size={48} textSize={32} />
        <div className="cloud-tagline"><ShieldCheck size={13} /> {t('auth.tagline')}</div>
        <p className="auth-sub">{t('auth.body')}</p>
        {error && <div className="cloud-error">{error}</div>}
        <button className="cloud-submit" onClick={login} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <><LogIn size={15} /> {t('auth.signIn')}</>}
        </button>
        <button className="cloud-logout" onClick={recheck} disabled={busy}>
          <RefreshCw size={13} /> {t('auth.recheck')}
        </button>
        {log && (
          <pre ref={logRef} className="auth-log">{log}</pre>
        )}
        <div className="cloud-foot">{t('auth.hint')}</div>
      </div>
    </div>
  );
}
