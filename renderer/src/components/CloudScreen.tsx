import { useEffect, useState } from 'react';
import { LogOut, Loader2, Cloud, CheckCircle2, HardDrive, ExternalLink, Sparkles, Server, Power, Rocket, Globe, X, Copy, Check, Cpu, ChevronDown, Kanban, AlertCircle } from 'lucide-react';
import Logo from './Logo';
import { CloudAccount } from '../types';
import { useT } from '../lib/i18n';

interface ContainerInfo {
  exists: boolean;
  container?: {
    subdomain: string; status: string; url: string; plan: string; device_id: string; error_note?: string;
    cpu_limit?: string; mem_limit?: string; created_at?: string; last_active_at?: string;
    live?: { uptime: number; memoryMB: number; projects: number; relay: string } | null;
  };
}

interface DomainInfo {
  domain: string | null;
  status: 'pending' | 'verified' | 'active' | string | null;
  cname_target?: string;
  url?: string | null;
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

// Datas do backend chegam como "YYYY-MM-DD HH:MM:SS" (sem TZ) — normaliza pra Date.
function parseDt(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}
function fmtDate(s?: string): string {
  const d = parseDt(s);
  if (!d) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtRelative(s?: string, nowLabel = 'agora'): string {
  const d = parseDt(s);
  if (!d) return '—';
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return nowLabel;
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
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
  const [addrCopied, setAddrCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pausing, setPausing] = useState(false);
  async function doPauseContainer() {
    if (pausing) return;
    setPausing(true);
    try {
      const r: any = await (window as any).maestrus?.cloud?.containerPause?.();
      if (r && r.ok) setContainer((c) => c && c.container ? { ...c, container: { ...c.container, status: 'suspended' } } : c);
    } catch {}
    finally { setPausing(false); }
  }
  // Domínio próprio (plano Pro). isSelfhost: o api() do shim é gateado — a
  // seção nem aparece (self-host resolve domínio na própria infra do usuário).
  const isSelfhost = !!(window as any).maestrus?.isSelfhost;
  const [domInfo, setDomInfo] = useState<DomainInfo | null>(null);
  const [domPro, setDomPro] = useState(true);
  const [domInput, setDomInput] = useState('');
  const [domBusy, setDomBusy] = useState(false);
  const [domErr, setDomErr] = useState<string | null>(null);

  const loadContainer = () => {
    (window as any).maestrus?.cloud?.containerStatus?.().then((r: any) => {
      if (r && r.ok) setContainer({ exists: !!r.exists, container: r.container });
    }).catch(() => {});
    loadDomain();
  };

  const loadDomain = () => {
    if (isSelfhost) return;
    (window as any).maestrus?.cloud?.domainStatus?.().then((r: any) => {
      if (r && r.ok) { setDomPro(true); setDomInfo({ domain: r.domain || null, status: r.status || null, cname_target: r.cname_target, url: r.url || null }); }
      else if (r && r.error === 'pro_required') { setDomPro(false); setDomInfo(null); }
    }).catch(() => {});
  };

  useEffect(() => {
    window.maestrus.cloud.account().then((a) => { setAccount(a); setLoading(false); if (a) loadContainer(); });
    window.maestrus.app.config().then((c) => { if (c?.base) setBaseUrl(c.base); }).catch(() => {});
    // Revalida a sessão e atualiza os dados da conta (plano, uso, licença).
    window.maestrus.cloud.validate().then((r) => { if (r && r.account) setAccount(r.account); }).catch(() => {});
  }, []);

  // Poll do status do container enquanto provisionando
  useEffect(() => {
    if (container?.container?.status === 'provisioning' || container?.container?.status === 'starting') {
      const id = setInterval(loadContainer, 4000);
      return () => clearInterval(id);
    }
  }, [container?.container?.status]);

  function copyAddress(addr: string) {
    navigator.clipboard?.writeText(addr).catch(() => {});
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 1500);
  }

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

  async function domainSave() {
    const d = domInput.trim();
    if (!d) return;
    setDomBusy(true); setDomErr(null);
    try {
      const r: any = await (window as any).maestrus?.cloud?.domainSet?.(d);
      if (r && r.ok) { setDomInfo({ domain: r.domain, status: 'pending', cname_target: r.cname_target, url: null }); setDomInput(''); }
      else if (r?.error === 'invalid_domain') setDomErr(t('cloud.dom_errInvalid') || 'Domínio inválido. Use um hostname completo, ex.: app.seudominio.com.');
      else if (r?.error === 'pro_required') setDomPro(false);
      else if (r?.error === 'no_container') setDomErr(t('cloud.dom_errNoContainer') || 'Ative sua instância na nuvem antes de conectar um domínio.');
      else setDomErr(t('cloud.dom_errGeneric') || 'Não foi possível concluir agora. Tente de novo em instantes.');
    } catch { setDomErr(t('cloud.dom_errGeneric') || 'Não foi possível concluir agora. Tente de novo em instantes.'); }
    finally { setDomBusy(false); }
  }

  async function domainVerify() {
    setDomBusy(true); setDomErr(null);
    try {
      const r: any = await (window as any).maestrus?.cloud?.domainVerify?.();
      if (r && r.ok) setDomInfo((p) => ({ ...(p || { domain: null, status: null }), domain: r.domain, status: 'active', url: r.url }));
      else if (r?.error === 'dns_not_pointing') setDomErr(t('cloud.dom_errDns') || 'O DNS ainda não aponta pra sua instância. Confira o CNAME e tente de novo em alguns minutos.');
      else if (r?.error === 'pro_required') setDomPro(false);
      else { setDomErr(t('cloud.dom_errGeneric') || 'Não foi possível concluir agora. Tente de novo em instantes.'); loadDomain(); }
    } catch { setDomErr(t('cloud.dom_errGeneric') || 'Não foi possível concluir agora. Tente de novo em instantes.'); }
    finally { setDomBusy(false); }
  }

  async function domainRemove() {
    if (!window.confirm(t('cloud.dom_removeConfirm') || 'Remover o domínio próprio? A instância volta a responder só pelo subdomínio maestrus.cloud.')) return;
    setDomBusy(true); setDomErr(null);
    try { await (window as any).maestrus?.cloud?.domainRemove?.(); setDomInfo((p) => ({ domain: null, status: null, cname_target: p?.cname_target })); }
    catch { setDomErr(t('cloud.dom_errGeneric') || 'Não foi possível concluir agora. Tente de novo em instantes.'); }
    finally { setDomBusy(false); }
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
            ) : (() => {
              const c = container.container!;
              const live = c.live || null;
              const limMB = memLimitMB(c.mem_limit);
              const memPct = live && limMB > 0 ? Math.min(100, Math.round((live.memoryMB / limMB) * 100)) : 0;
              const st = c.status;
              const pillCls = st === 'running' ? 'running'
                : (st === 'provisioning' || st === 'starting') ? 'starting'
                : st === 'error' ? 'error' : 'suspended';
              const busyPill = st === 'provisioning' || st === 'starting';
              const pillLabel = st === 'running' ? (t('cloud.containerRunning') || 'Rodando')
                : busyPill ? (t('cloud.containerStarting') || 'Iniciando…')
                : st === 'error' ? (t('cloud.containerError') || 'Erro')
                : st === 'suspended' ? (t('cloud.containerSuspended') || 'Suspenso')
                : st;
              const memLimLabel = limMB >= 1024 ? (limMB / 1024).toFixed(0) + ' GB' : limMB + ' MB';
              const addr = `${c.subdomain}.maestrus.cloud`;
              return (
                <div className="cloud-hero">
                  <div className="cloud-hero-top">
                    <div className="cloud-hero-glyph"><Server size={19} /></div>
                    <div className="cloud-hero-id">
                      <button className="cloud-hero-addr" onClick={() => copyAddress(addr)} title={t('common.copy') || 'Copiar'}>
                        <span>{addr}</span>
                        {addrCopied ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                      {live && (
                        <span className={`cloud-hero-relay ${live.relay === 'online' ? 'on' : ''}`}>
                          {live.relay === 'online' ? (t('cloud.containerRelayOnline') || 'Conectado') : (t('cloud.containerRelayOffline') || 'Sem conexão')}
                        </span>
                      )}
                    </div>
                    <span className={`cloud-status-pill ${pillCls}`}>
                      {busyPill ? <Loader2 size={11} className="spin" /> : <span className="cloud-status-dot" />}
                      {pillLabel}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="cloud-container-btn primary" style={{ flex: 1 }} onClick={() => window.maestrus.shell?.openExternal?.(c.url)}>
                      <ExternalLink size={14} /> {t('cloud.containerOpen') || 'Abrir no navegador'}
                    </button>
                    {st === 'running' && (
                      <button className="cloud-container-btn" onClick={doPauseContainer} disabled={pausing} title={t('cloud.pauseHint') || ''}>
                        {pausing ? <Loader2 size={14} className="spin" /> : <Power size={14} />} {t('cloud.pauseNow') || 'Pausar'}
                      </button>
                    )}
                  </div>
                  <p className="cloud-hero-sub" style={{ marginTop: 6, fontSize: 12, opacity: .7 }}>
                    {t('cloud.autoSuspendNote') || 'Sua instância pausa sozinha quando fica ociosa (economiza recursos) e religa no próximo acesso — seus projetos e histórico ficam salvos.'}
                  </p>

                  <div className="cloud-kpis">
                    <div className="cloud-kpi">
                      <div className="cloud-kpi-head"><Rocket size={13} /> {t('cloud.plan')}</div>
                      <div className="cloud-kpi-val" style={{ textTransform: 'capitalize' }}>{c.plan}</div>
                      <div className="cloud-kpi-sub">{c.cpu_limit ? `${c.cpu_limit} vCPU` : ''}{c.cpu_limit && c.mem_limit ? ' · ' : ''}{c.mem_limit ? `${String(c.mem_limit).toUpperCase()} RAM` : ''}</div>
                    </div>
                    <div className="cloud-kpi">
                      <div className="cloud-kpi-head"><Power size={13} /> {t('cloud.containerUptime') || 'No ar há'}</div>
                      <div className="cloud-kpi-val">{live ? fmtUptime(live.uptime) : '—'}</div>
                      <div className="cloud-kpi-sub">{live ? '' : (t('cloud.containerStarting') || 'Iniciando…')}</div>
                    </div>
                    <div className="cloud-kpi">
                      <div className="cloud-kpi-head"><HardDrive size={13} /> {t('cloud.containerStorage') || 'Armazenamento'}</div>
                      <div className="cloud-kpi-val">{fmtBytes(account.usedBytes)}</div>
                      <div className="cloud-kpi-sub">{quota > 0 ? `/ ${fmtBytes(quota)}` : ''}</div>
                      {quota > 0 && <div className="cloud-bar cloud-kpi-bar"><div style={{ width: pct + '%' }} /></div>}
                    </div>
                    <div className="cloud-kpi">
                      <div className="cloud-kpi-head"><Cpu size={13} /> {t('cloud.containerMemory') || 'Memória'}</div>
                      <div className="cloud-kpi-val">{live ? `${live.memoryMB} MB` : '—'}</div>
                      <div className="cloud-kpi-sub">{live && limMB > 0 ? `/ ${memLimLabel}` : ''}</div>
                      {live && limMB > 0 && <div className="cloud-bar cloud-kpi-bar"><div style={{ width: memPct + '%' }} /></div>}
                    </div>
                    {live && (
                      <div className="cloud-kpi cloud-kpi-wide">
                        <div className="cloud-kpi-head"><Kanban size={13} /> {t('cloud.containerProjects') || 'Projetos'}</div>
                        <div className="cloud-kpi-val">{live.projects}</div>
                      </div>
                    )}
                  </div>

                  <button className={`cloud-details-toggle ${detailsOpen ? 'open' : ''}`} onClick={() => setDetailsOpen((v) => !v)}>
                    <ChevronDown size={15} /> {t('cloud.containerDetails') || 'Detalhes'}
                  </button>
                  {detailsOpen && (
                    <div className="cloud-details">
                      <div className="cloud-kv"><span>{t('cloud.containerSince') || 'Criado em'}</span><span>{fmtDate(c.created_at)}</span></div>
                      <div className="cloud-kv"><span>{t('cloud.containerLastActive') || 'Última atividade'}</span><span>{fmtRelative(c.last_active_at, t('cloud.containerNow') || 'agora')}</span></div>
                      {c.error_note && (
                        <div className="cloud-alert"><AlertCircle size={14} /> <span>{c.error_note}</span></div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* ─── Domínio próprio (plano Pro) ─── */}
          {!isSelfhost && container?.exists && (
            <div className="cloud-container-box">
              <div className="cloud-container-head">
                <Globe size={14} /> {t('cloud.dom_title') || 'Domínio próprio'}
                <span className="cloud-pro-badge">PRO</span>
              </div>
              {!domPro ? (
                <>
                  <p className="cloud-container-desc">
                    {t('cloud.dom_proUpsell') || 'Use seu próprio domínio na sua instância Maestrus — exclusivo do plano Pro.'}
                  </p>
                  <button className="cloud-container-btn" onClick={() => window.maestrus.cloud.openPanel()}>
                    <Sparkles size={13} /> {t('cloud.dom_proCta') || 'Fazer upgrade'}
                  </button>
                </>
              ) : !domInfo?.domain ? (
                <>
                  <p className="cloud-container-desc">
                    {t('cloud.dom_desc') || 'Acesse sua instância pelo seu próprio domínio, com certificado SSL automático.'}
                  </p>
                  <div className="cloud-domain-row">
                    <input
                      type="text"
                      value={domInput}
                      onChange={(e) => setDomInput(e.target.value)}
                      placeholder={t('cloud.dom_placeholder') || 'app.seudominio.com'}
                      spellCheck={false}
                      autoCapitalize="none"
                    />
                    <button className="cloud-container-btn primary" onClick={domainSave} disabled={domBusy || !domInput.trim()} style={{ width: 'auto', marginTop: 0 }}>
                      {domBusy ? <Loader2 size={13} className="spin" /> : null}
                      {t('cloud.dom_save') || 'Salvar'}
                    </button>
                  </div>
                  {domErr && <div className="cloud-container-errnote">{domErr}</div>}
                </>
              ) : (
                <>
                  <div className="cloud-kv"><span>{t('cloud.dom_domain') || 'Domínio'}</span><code>{domInfo.domain}</code></div>
                  <div className="cloud-kv">
                    <span>{t('cloud.dom_status') || 'Status'}</span>
                    <span className={`cloud-domain-status ${domInfo.status || 'pending'}`}>
                      {domInfo.status === 'active' ? (t('cloud.dom_statusActive') || 'Ativo')
                        : domInfo.status === 'verified' ? (t('cloud.dom_statusVerified') || 'DNS verificado — ativando')
                        : (t('cloud.dom_statusPending') || 'Aguardando DNS')}
                    </span>
                  </div>
                  {domInfo.status !== 'active' && (
                    <>
                      <ol className="cloud-domain-steps">
                        <li>{t('cloud.dom_step1') || 'No seu provedor de DNS, crie um registro CNAME apontando o domínio para:'} <code>{domInfo.cname_target}</code></li>
                        <li>{t('cloud.dom_step2') || 'Propagou? Clique em Verificar — o certificado SSL é emitido automaticamente.'}</li>
                      </ol>
                      <button className="cloud-container-btn primary" onClick={domainVerify} disabled={domBusy}>
                        {domBusy ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
                        {domBusy ? (t('cloud.dom_verifying') || 'Verificando…') : (t('cloud.dom_verify') || 'Verificar')}
                      </button>
                    </>
                  )}
                  {domInfo.status === 'active' && domInfo.url && (
                    <button className="cloud-container-btn" onClick={() => window.maestrus.shell?.openExternal?.(domInfo.url!)}>
                      <ExternalLink size={13} /> {t('cloud.containerOpen') || 'Abrir no navegador'}
                    </button>
                  )}
                  {domErr && <div className="cloud-container-errnote">{domErr}</div>}
                  <button className="cloud-container-btn" onClick={domainRemove} disabled={domBusy}>
                    <X size={13} /> {t('cloud.dom_remove') || 'Remover domínio'}
                  </button>
                </>
              )}
            </div>
          )}

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
