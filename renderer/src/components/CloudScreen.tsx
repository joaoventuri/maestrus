import { useEffect, useState } from 'react';
import { LogOut, Loader2, Cloud, CheckCircle2, HardDrive, ExternalLink, Sparkles, Server, Power, Rocket } from 'lucide-react';
import Logo from './Logo';
import { CloudAccount } from '../types';
import { useT } from '../lib/i18n';

interface ContainerInfo {
  exists: boolean;
  container?: {
    subdomain: string; status: string; url: string; plan: string; device_id: string; error_note?: string;
    cpu_limit?: string; mem_limit?: string; created_at?: string;
    live?: { uptime: number; memoryMB: number; projects: number; relay: string } | null;
  };
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

function memLimitMB(lim?: string): number {
  if (!lim) return 0;
  const m = String(lim).trim().match(/^([\d.]+)\s*([gGmM])?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return (m[2] || 'g').toLowerCase() === 'g' ? Math.round(n * 1024) : Math.round(n);
}

function fmtBytes(b: number): string {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

export default function CloudScreen({ onAuthed }: { onAuthed?: () => void } = {}) {
  const { t } = useT();
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('https://maestrus.io');
  const [container, setContainer] = useState<ContainerInfo | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [containerErr, setContainerErr] = useState<string | null>(null);

  const loadContainer = () => {
    (window as any).maestrus?.cloud?.containerStatus?.().then((r: any) => {
      if (r && r.ok) setContainer({ exists: !!r.exists, container: r.container });
    }).catch(() => {});
  };

  useEffect(() => {
    window.maestrus.cloud.account().then((a) => { setAccount(a); setLoading(false); if (a) loadContainer(); });
    window.maestrus.app.config().then((c) => { if (c?.base) setBaseUrl(c.base); }).catch(() => {});
    // Atualiza saldo de IA / uso (validate traz o campo ai).
    window.maestrus.cloud.validate().then((r) => { if (r && r.account) setAccount(r.account); }).catch(() => {});
  }, []);

  // Poll do status do container enquanto provisionando
  useEffect(() => {
    if (container?.container?.status === 'provisioning' || container?.container?.status === 'starting') {
      const id = setInterval(loadContainer, 4000);
      return () => clearInterval(id);
    }
  }, [container?.container?.status]);

  async function provisionContainer() {
    setProvisioning(true);
    setContainerErr(null);
    try {
      const r: any = await (window as any).maestrus?.cloud?.containerProvision?.();
      if (r && r.ok && r.container) {
        setContainer({ exists: true, container: r.container });
        // conecta o client no container (discovery)
        setTimeout(() => (window as any).maestrus?.cloud?.containerConnect?.().catch(() => {}), 1000);
      } else if (r && r.ok) {
        // provision aceito mas sem payload — busca o estado real
        loadContainer();
      } else {
        const err = r?.error || r?.reason || '';
        setContainerErr(
          err === 'trial_expired' ? (t('cloud.containerErrTrial') || 'Seu período de teste expirou — assine um plano pra ativar sua instância.')
          : err === 'cloud_required' ? (t('cloud.containerErrPro') || 'Disponível nos planos Cloud — faça upgrade no painel.')
          : (t('cloud.containerErrGeneric') || 'Não foi possível criar sua instância agora. Tente de novo em instantes.'));
      }
    } catch {
      setContainerErr(t('cloud.containerErrGeneric') || 'Não foi possível criar sua instância agora. Tente de novo em instantes.');
    }
    finally { setProvisioning(false); }
  }

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
    const quota = account.plan?.quota_bytes || 0;
    const pct = quota > 0 ? Math.min(100, Math.round((account.usedBytes / quota) * 100)) : 0;
    const cap = account.capBytes || 0;
    const ovCents = account.overageCentsPerGb || 0;
    const overageGb = quota > 0 ? Math.max(0, Math.ceil((account.usedBytes - quota) / 1073741824)) : 0;
    const overageCost = ((overageGb * ovCents) / 100).toFixed(2);
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
          <div className="cloud-kv"><span>{t('cloud.plan')}</span><span>{account.plan?.name || '—'}</span></div>
          <div className="cloud-kv"><span>{t('cloud.license')}</span><code>{account.licenseKey}</code></div>
          {/* Billing de IA removido: a engine "Claude API" usa a chave Anthropic
              do próprio usuário (Configurações → Claude API). Sem saldo/recarga. */}
          {/* ─── Meu Container Cloud (Maestrus completo 24/7) ─── */}
          <div className="cloud-container-box">
            <div className="cloud-container-head">
              <Server size={14} /> {t('cloud.containerTitle') || 'Meu Maestrus na nuvem'}
            </div>
            {!container || !container.exists || !container.container ? (
              <>
                <p className="cloud-container-desc">
                  {t('cloud.containerDesc') || 'Um Maestrus completo rodando 24h na nuvem — acesse de qualquer dispositivo, sem depender do seu computador ligado.'}
                </p>
                <button className="cloud-container-btn primary" onClick={provisionContainer} disabled={provisioning}>
                  {provisioning ? <Loader2 size={14} className="spin" /> : <Rocket size={14} />}
                  {provisioning ? (t('cloud.containerProvisioning') || 'Criando…') : (t('cloud.containerCreate') || 'Ativar Maestrus na nuvem')}
                </button>
                {containerErr && <div className="cloud-container-errnote">{containerErr}</div>}
              </>
            ) : (
              <>
                <div className="cloud-container-status">
                  <span className={`cloud-container-dot ${container.container!.status}`} />
                  <span className="cloud-container-state">
                    {container.container!.status === 'running' ? (t('cloud.containerRunning') || 'Rodando')
                      : container.container!.status === 'provisioning' || container.container!.status === 'starting' ? (t('cloud.containerStarting') || 'Iniciando…')
                      : container.container!.status === 'error' ? (t('cloud.containerError') || 'Erro')
                      : container.container!.status}
                  </span>
                </div>
                <div className="cloud-kv"><span>{t('cloud.containerUrl') || 'Endereço'}</span><code>{container.container!.subdomain}.maestrus.cloud</code></div>
                <div className="cloud-kv"><span>{t('cloud.plan')}</span><span style={{ textTransform: 'capitalize' }}>{container.container!.plan}</span></div>
                {(container.container!.cpu_limit || container.container!.mem_limit) && (
                  <div className="cloud-kv"><span>{t('cloud.containerResources')}</span>
                    <span>{container.container!.cpu_limit ? `${container.container!.cpu_limit} vCPU` : ''}{container.container!.cpu_limit && container.container!.mem_limit ? ' · ' : ''}{container.container!.mem_limit ? `${String(container.container!.mem_limit).toUpperCase()} RAM` : ''}</span>
                  </div>
                )}
                {container.container!.live && (() => {
                  const live = container.container!.live!;
                  const limMB = memLimitMB(container.container!.mem_limit);
                  const memPct = limMB > 0 ? Math.min(100, Math.round((live.memoryMB / limMB) * 100)) : 0;
                  return (
                    <>
                      <div className="cloud-kv"><span>{t('cloud.containerUptime')}</span><span>{fmtUptime(live.uptime)}</span></div>
                      <div className="cloud-kv"><span>{t('cloud.containerProjects')}</span><span>{live.projects}</span></div>
                      <div className="cloud-kv" style={{ border: 'none', paddingBottom: 4 }}>
                        <span>{t('cloud.containerMemory')}</span>
                        <span>{live.memoryMB} MB{limMB > 0 && <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> / {limMB >= 1024 ? (limMB / 1024).toFixed(0) + ' GB' : limMB + ' MB'}</span>}</span>
                      </div>
                      {limMB > 0 && <div className="cloud-bar"><div style={{ width: memPct + '%' }} /></div>}
                    </>
                  );
                })()}
                {container.container!.error_note && (
                  <div className="cloud-container-errnote">{container.container!.error_note}</div>
                )}
                <button className="cloud-container-btn" onClick={() => window.maestrus.shell?.openExternal?.(container.container!.url)}>
                  <ExternalLink size={13} /> {t('cloud.containerOpen') || 'Abrir no navegador'}
                </button>
              </>
            )}
          </div>

          <button className="cloud-panel-btn" onClick={() => window.maestrus.cloud.openPanel()}>
            <ExternalLink size={14} /> {t('cloud.goToPanel')}
          </button>
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
          {t('cloud.noAccount')} <a onClick={() => window.maestrus.shell.openExternal(`${baseUrl}/register.php`)}>{t('cloud.createAt')}</a>
        </div>
      </form>
    </div>
  );
}
