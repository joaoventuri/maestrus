import { useEffect, useState } from 'react';
import { LogOut, Loader2, Cloud, CheckCircle2, Users } from 'lucide-react';
import Logo from './Logo';
import { CloudAccount } from '../types';
import { useT } from '../lib/i18n';

/**
 * Conta Maestrus (opcional). Voltou porque é a identidade que faz o
 * compartilhamento por e-mail existir: "compartilhei com fulano@" só vira
 * "apareceu pra ele" se o app dele souber quem ele é. Sem plano, sem cota,
 * sem cobrança — quem usa o Maestrus sozinho nunca precisa passar por aqui.
 */
export default function CloudScreen({ onAuthed }: { onAuthed?: () => void }) {
  const { t } = useT();
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseUrl = (window as any).maestrus?.baseUrl || 'https://maestrus.cloud';

  useEffect(() => {
    window.maestrus.cloud.account().then((a: any) => setAccount(a || null)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await window.maestrus.cloud.login(email.trim(), password);
      if (r.ok && r.account) { setAccount(r.account); setPassword(''); onAuthed?.(); }
      else if (r.error === 'invalid_credentials') setError(t('cloud.errCreds'));
      else if (r.error === 'account_suspended') setError(t('cloud.errSuspended'));
      else setError(t('cloud.errConn'));
    } catch {
      setError(t('cloud.errConn'));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await window.maestrus.cloud.logout();
    setAccount(null);
  }

  if (loading) {
    return <div className="cloud-screen"><div className="cloud-grid" /><Loader2 className="spin" /></div>;
  }

  if (account) {
    return (
      <div className="cloud-screen">
        <div className="cloud-grid" />
        <div className="cloud-card">
          <Logo size={44} textSize={30} />
          <div className="cloud-connected"><CheckCircle2 size={15} /> {t('cloud.connected')}</div>
          <div className="cloud-account">
            <div className="cloud-acc-name">{account.name || account.email}</div>
            <div className="cloud-acc-email">{account.email}</div>
          </div>
          <div className="cloud-kv"><span><Users size={13} /> {t('cloud.sharesLabel')}</span><span>{t('cloud.sharesOn')}</span></div>
          <p className="cloud-hint">{t('cloud.accountWhy')}</p>
          <button className="cloud-logout" onClick={logout}><LogOut size={14} /> {t('cloud.signOut')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="cloud-screen">
      <div className="cloud-grid" />
      <form className="cloud-card" onSubmit={submit}>
        <Logo size={52} textSize={36} />
        <div className="cloud-tagline"><Cloud size={13} /> {t('cloud.loginTagline')}</div>
        <p className="cloud-hint" style={{ textAlign: 'center' }}>{t('cloud.accountWhy')}</p>
        {error && <div className="cloud-error">{error}</div>}
        <label className="cloud-field">
          <span>{t('cloud.email')}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="voce@email.com" />
        </label>
        <label className="cloud-field">
          <span>{t('cloud.password')}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" />
        </label>
        <button className="cloud-submit" type="submit" disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : t('cloud.signIn')}
        </button>
        <div className="cloud-foot">
          {t('cloud.noAccount')} <a onClick={() => window.maestrus.shell.openExternal(`${baseUrl}/register`)}>{t('cloud.createAt')}</a>
        </div>
      </form>
    </div>
  );
}
