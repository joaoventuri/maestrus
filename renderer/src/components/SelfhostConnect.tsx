import { useState } from 'react';
import { Loader2, Server, KeyRound, ArrowRight } from 'lucide-react';
import Logo from './Logo';
import { useT } from '../lib/i18n';

// Tela de conexão do web app quando ele é servido por um servidor SELF-HOST
// (não maestrus.cloud). Sem conta, sem cadastro: só o SELFHOST_SECRET que o
// dono definiu no docker-compose. Ao conectar, entra direto no Maestrus dele.
export default function SelfhostConnect({ info, onConnected }: { info: any; onConnected: () => void }) {
  const { t } = useT();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await (window as any).maestrus?.remote?.selfhostConnect?.(secret.trim());
      if (r && r.ok) onConnected();
      else setError(r?.error === 'bad_secret' ? (t('selfhost.badSecret') || 'Chave incorreta.') : (t('selfhost.errConn') || 'Não consegui conectar ao servidor.'));
    } catch { setError(t('selfhost.errConn') || 'Não consegui conectar ao servidor.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="cloud-screen">
      <div className="cloud-grid" />
      <form className="cloud-card" onSubmit={submit}>
        <Logo size={52} textSize={36} />
        <div className="cloud-tagline"><Server size={13} /> {info?.hostName || t('selfhost.title') || 'Meu Maestrus (self-host)'}</div>
        <p className="page-sub" style={{ textAlign: 'center', margin: '4px 0 14px' }}>
          {t('selfhost.desc') || 'Este é o seu servidor Maestrus. Informe a chave de acesso definida no seu docker-compose (SELFHOST_SECRET).'}
        </p>
        {error && <div className="cloud-error">{error}</div>}
        <label className="cloud-field">
          <span><KeyRound size={12} /> {t('selfhost.secret') || 'Chave de acesso'}</span>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required autoFocus placeholder="SELFHOST_SECRET" spellCheck={false} />
        </label>
        <button className="cloud-submit" type="submit" disabled={busy || !secret.trim()}>
          {busy ? <Loader2 size={16} className="spin" /> : <>{t('selfhost.connect') || 'Entrar'} <ArrowRight size={15} /></>}
        </button>
        <div className="cloud-foot" style={{ opacity: .7 }}>
          {t('selfhost.foot') || 'Maestrus self-host — sua infra, sua conta do Claude, seus dados.'}
        </div>
      </form>
    </div>
  );
}
