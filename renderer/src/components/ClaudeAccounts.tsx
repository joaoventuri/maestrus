import { useEffect, useRef, useState } from 'react';
import { Users, Check, Loader2, Plus, Trash2, ExternalLink, AlertCircle, RefreshCw } from 'lucide-react';
import { useT } from '../lib/i18n';

// Multi-conta do Claude CLI: lista os perfis do HOST (local no desktop; via
// relay no web), permite trocar a conta ativa (switch), adicionar outra conta
// (OAuth paste-code) e remover. A troca vale pro PRÓXIMO turno — a conversa
// continua a mesma (sessões compartilhadas entre perfis).

type Profile = { id: string; name: string; createdAt: number };
type ProfStatus = { loading: boolean; loggedIn?: boolean; email?: string | null; plan?: string | null; error?: string };

/**
 * `scope` diz de QUEM são as contas: 'local' = esta máquina; um projectId =
 * a máquina que roda aquele projeto (host ou container). Sem isso a tela
 * mostrava sempre as locais, mesmo conectada a um host com outras contas.
 */
export default function ClaudeAccounts({ scope = 'local', withUsage = false, bare = false }: { scope?: string; withUsage?: boolean; bare?: boolean }) {
  const { t } = useT();
  const base = (window as any).maestrus?.claudeProfiles;
  // Mesma superfície de API, origem diferente: as telas não precisam saber.
  const api = scope === 'local' ? base : {
    ...base,
    list: () => base?.listFor?.(scope),
    setActive: (id: string) => base?.setActiveFor?.(scope, id),
  };
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [active, setActive] = useState<string>('default');
  const [statuses, setStatuses] = useState<Record<string, ProfStatus>>({});
  const [usageOpen, setUsageOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  // fluxo de adicionar/conectar conta
  const [login, setLogin] = useState<{ id: string; url: string | null; code: string; submitting: boolean; error: string | null } | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const pollRef = useRef<number | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await api.list();
      if (!r || r.ok === false) { setErr(r?.error === 'not_connected' ? (t('claudeAcc.notConnected') || 'Conecte a um host pra gerenciar as contas.') : (r?.error || 'erro')); return; }
      setProfiles(r.profiles || []);
      setActive(r.active || 'default');
      // status de cada perfil (sequencial — cada um spawna o CLI no host)
      for (const p of r.profiles || []) {
        setStatuses((m) => ({ ...m, [p.id]: { ...(m[p.id] || {}), loading: true } }));
        try {
          const s = await api.status(p.id);
          setStatuses((m) => ({ ...m, [p.id]: { loading: false, loggedIn: !!s?.loggedIn, email: s?.email || null, plan: s?.plan || null } }));
        } catch {
          setStatuses((m) => ({ ...m, [p.id]: { loading: false, error: 'status' } }));
        }
      }
    } catch (e: any) { setErr(e?.message || 'erro'); }
  }

  useEffect(() => { if (api) load(); return () => { if (pollRef.current) window.clearInterval(pollRef.current); }; }, []);

  if (!api) return null;

  async function switchTo(id: string) {
    if (id === active) return;
    setSwitching(id);
    try {
      const r = await api.setActive(id);
      if (r?.ok) setActive(id);
      else if (r?.error === 'team_bound') window.alert(t('accounts.teamBoundMsg'));
    } finally { setSwitching(null); }
  }

  function startPoll(profileId: string) {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const st = await api.loginState();
        if (!st) return;
        setLogin((l) => (l && l.id === profileId ? { ...l, url: st.url || l.url } : l));
        if (st.done) {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          if (st.success) {
            setLogin(null);
            // atualiza status do perfil recém-conectado
            const s = await api.status(profileId).catch(() => null);
            setStatuses((m) => ({ ...m, [profileId]: { loading: false, loggedIn: !!s?.loggedIn, email: s?.email || null, plan: s?.plan || null } }));
          } else {
            setLogin((l) => (l && l.id === profileId ? { ...l, submitting: false, error: t('claudeAcc.loginFailed') || 'Falhou — tente de novo.' } : l));
          }
        }
      } catch {}
    }, 1500);
  }

  async function connect(profileId: string) {
    setLogin({ id: profileId, url: null, code: '', submitting: false, error: null });
    const r = await api.loginStart(profileId);
    if (!r || r.ok === false) {
      setLogin({ id: profileId, url: null, code: '', submitting: false, error: r?.error || (t('claudeAcc.loginFailed') || 'Falhou — tente de novo.') });
      return;
    }
    startPoll(profileId);
  }

  async function addAccount() {
    setCreating(true);
    try {
      const r = await api.create(newName.trim());
      if (r?.ok && r.id) {
        setNewName('');
        await load();
        await connect(r.id);
      }
    } finally { setCreating(false); }
  }

  async function removeProfile(id: string) {
    if (!confirm(t('claudeAcc.confirmRemove') || 'Remover esta conta do Maestrus? (o histórico de conversas é compartilhado e NÃO é apagado)')) return;
    const r = await api.remove(id);
    if (r?.ok) load();
  }

  async function submitCode() {
    if (!login || !login.code.trim()) return;
    setLogin({ ...login, submitting: true, error: null });
    const r = await api.loginCode(login.code.trim());
    if (!r || r.ok === false) setLogin((l) => (l ? { ...l, submitting: false, error: t('claudeAcc.badCode') || 'Código inválido — tente de novo.' } : l));
    // sucesso é detectado pelo poll (loginState.done)
  }

  function openUrl(url: string) {
    const shell = (window as any).maestrus?.shell;
    if (shell?.openExternal) shell.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }

  return (
    <section className="settings-section">
      {!bare && <>
      <h2><Users size={15} /> {t('claudeAcc.title') || 'Contas do Claude'}</h2>
      <p className="page-sub">{t('claudeAcc.desc') || 'Cadastre mais de uma assinatura do Claude e troque quando o limite de uma acabar — a conversa continua exatamente de onde parou.'}</p>
      </>}

      {err && <div className="byok-error"><AlertCircle size={13} /> {err} <button className="btn-icon" onClick={load} title="retry"><RefreshCw size={12} /></button></div>}

      {!err && profiles === null && <div className="page-sub"><Loader2 size={13} className="spin" /> {t('common.loading') || 'Carregando…'}</div>}

      {profiles && (
        <div className="claude-acc-list">
          {profiles.map((p) => {
            const st = statuses[p.id];
            const isActive = p.id === active;
            return (
              <div key={p.id} className={`claude-acc-row ${isActive ? 'active' : ''}`}>
                <button
                  className={`claude-acc-switch ${isActive ? 'on' : ''}`}
                  onClick={() => switchTo(p.id)}
                  disabled={switching !== null}
                  title={isActive ? (t('claudeAcc.activeNow') || 'Conta em uso') : (t('claudeAcc.useThis') || 'Usar esta conta')}
                >
                  {switching === p.id ? <Loader2 size={13} className="spin" /> : isActive ? <Check size={13} /> : null}
                </button>
                <div className="claude-acc-info">
                  <div className="claude-acc-name">
                    {p.name}
                    {isActive && <span className="claude-acc-badge">{t('claudeAcc.inUse') || 'em uso'}</span>}
                  </div>
                  <div className="claude-acc-sub">
                    {st?.loading ? <><Loader2 size={11} className="spin" /> {t('claudeAcc.checking') || 'verificando…'}</>
                      : st?.loggedIn ? <>{st.email || (t('claudeAcc.connected') || 'conectada')}{st.plan ? ` · ${st.plan}` : ''}</>
                      : <span className="claude-acc-off">{t('claudeAcc.notLogged') || 'não conectada'}</span>}
                  </div>
                </div>
                <div className="claude-acc-actions">
                  {withUsage && st?.loggedIn && (
                    <button className="btn-secondary" onClick={() => setUsageOpen(usageOpen === p.id ? null : p.id)}>
                      {usageOpen === p.id ? (t('llm.hideUsage') || 'Ocultar uso') : (t('llm.showUsage') || 'Ver uso')}
                    </button>
                  )}
                  {st && !st.loading && !st.loggedIn && (
                    <button className="btn-secondary" onClick={() => connect(p.id)}>{t('claudeAcc.connect') || 'Conectar'}</button>
                  )}
                  {p.id !== 'default' && (
                    <button className="btn-icon danger" onClick={() => removeProfile(p.id)} title={t('claudeAcc.remove') || 'Remover'}><Trash2 size={13} /></button>
                  )}
                </div>
                {withUsage && usageOpen === p.id && <UsageBars profileId={p.id} onReconnect={() => { setUsageOpen(null); connect(p.id); }} />}
              </div>
            );
          })}
        </div>
      )}

      {/* fluxo de login (OAuth paste-code) */}
      {login && (
        <div className="claude-acc-login">
          {!login.url && !login.error && <div className="page-sub"><Loader2 size={13} className="spin" /> {t('claudeAcc.waitingUrl') || 'Abrindo autorização do Claude…'}</div>}
          {login.url && (
            <>
              <div className="claude-acc-oauth-hint">{t('claudeAcc.oauthHint') || 'Você vai pro site da Anthropic aprovar com sua conta Claude (Pro/Max) — é normal. Não precisa de chave de API. Depois copie o código que aparecer e cole abaixo.'}</div>
              <button className="btn-primary" onClick={() => openUrl(login.url!)}>
                <ExternalLink size={13} /> {t('claudeAcc.authorize') || 'Autorizar no Claude'}
              </button>
              <div className="claude-acc-code">
                <input
                  value={login.code}
                  onChange={(e) => setLogin({ ...login, code: e.target.value })}
                  placeholder={t('claudeAcc.pasteCode') || 'Cole o código aqui'}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="btn-primary" onClick={submitCode} disabled={login.submitting || !login.code.trim()}>
                  {login.submitting ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {t('claudeAcc.confirmCode') || 'Conectar'}
                </button>
              </div>
            </>
          )}
          {login.error && <div className="byok-error"><AlertCircle size={13} /> {login.error}</div>}
          <button className="btn-secondary" onClick={() => { api.loginCancel().catch(() => {}); if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; } setLogin(null); }}>
            {t('common.cancel') || 'Cancelar'}
          </button>
        </div>
      )}

      {/* adicionar conta */}
      {!login && profiles && (
        <div className="claude-acc-add">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('claudeAcc.namePlaceholder') || 'Nome da conta (ex: Conta 2 — Max)'}
            maxLength={40}
          />
          <button className="btn-secondary" onClick={addAccount} disabled={creating}>
            {creating ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} {t('claudeAcc.add') || 'Adicionar conta'}
          </button>
        </div>
      )}

      <div className="byok-footnote">{t('claudeAcc.footnote') || 'A troca vale a partir da próxima mensagem, em todos os projetos deste host. O histórico é compartilhado entre as contas.'}</div>
    </section>
  );
}


// ─── Uso oficial por conta (mesma fonte do /usage do Claude Code) ───────────
// Sessão de 5h, semana e semana por modelo, com severidade e reset. Erros
// viram frase de gente: "sem credencial" numa conta estacionada não é bug — o
// token só materializa quando a conta é usada uma vez.
function UsageBars({ profileId, onReconnect }: { profileId: string; onReconnect?: () => void }) {
  const { t } = useT();
  const [data, setData] = useState<{ limits: any[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const r: any = await (window as any).maestrus?.claude?.usage?.({ profileId });
      if (r?.ok && Array.isArray(r.limits)) setData({ limits: r.limits });
      else setData({ limits: [], error: r?.error || 'erro' });
    } catch (e: any) { setData({ limits: [], error: e?.message || 'erro' }); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [profileId]);

  const friendly = (e: string) =>
    e === 'no_credentials' || e === 'auth_expired'
      ? (t('llm.usageReconnect') || 'O token desta conta não está guardado aqui (login antigo). Reconecte uma vez — depois o uso aparece sempre, sem trocar de conta.')
      : `${t('llm.usageErr') || 'Não consegui buscar o uso:'} ${e}`;

  if (!data) return <div className="llm-usage-loading"><Loader2 size={13} className="spin" /></div>;
  if (data.error) return (
    <div className="llm-usage-err">
      {friendly(data.error)}
      {(data.error === 'no_credentials' || data.error === 'auth_expired') && onReconnect
        ? <button className="btn-secondary" onClick={onReconnect}>{t('claudeAcc.connect') || 'Conectar'}</button>
        : <button onClick={load}><RefreshCw size={11} /></button>}
    </div>
  );
  if (!data.limits.length) return <div className="llm-usage-err">{t('llm.usageEmpty')}</div>;
  return (
    <div className="llm-usage">
      {data.limits.map((l: any, i: number) => {
        const pct = Math.max(0, Math.min(100, Math.round(l.percent ?? 0)));
        const sev = l.severity === 'exceeded' || pct >= 95 ? 'crit' : (l.severity === 'warning' || pct >= 80 ? 'warn' : 'ok');
        const reset = (() => {
          if (!l.resetsAt) return '';
          const d = new Date(l.resetsAt); if (isNaN(d.getTime())) return '';
          const mins = Math.round((d.getTime() - Date.now()) / 60000); if (mins <= 0) return '';
          if (mins < 60) return `${t('llm.resets')} ${mins}min`;
          if (mins < 48 * 60) return `${t('llm.resets')} ${Math.round(mins / 60)}h`;
          return `${t('llm.resets')} ${d.toLocaleDateString(undefined, { weekday: 'short' })}`;
        })();
        return (
          <div key={i} className="llm-limit">
            <div className="llm-limit-head">
              <span className="llm-limit-label">{l.label}</span>
              <span className={`llm-limit-pct ${sev}`}>{l.percent === null ? '—' : `${pct}%`}</span>
            </div>
            <div className="llm-bar"><div className={`llm-bar-fill ${sev}`} style={{ width: `${pct}%` }} /></div>
            <div className="llm-limit-reset">{reset}</div>
          </div>
        );
      })}
      <button className="llm-refresh" onClick={load} disabled={busy}>{busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}</button>
    </div>
  );
}
