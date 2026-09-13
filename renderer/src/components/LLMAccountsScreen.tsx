import { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, Loader2, Check, UserRound, ChevronDown, ChevronRight, Gauge } from 'lucide-react';
import ClaudeAccounts from './ClaudeAccounts';
import { useT } from '../lib/i18n';

/**
 * Contas LLM — o cockpit das contas que pagam os turnos.
 *
 * Uma tela responde as três perguntas que antes exigiam garimpo: QUAIS contas
 * existem (Claude e Codex), QUANTO cada uma já gastou dos limites oficiais
 * (sessão de 5h, semana, semana por modelo — a MESMA fonte do /usage do
 * Claude Code, sem estimativa local) e QUAL está ativa — com troca a um
 * clique. Conta amarrada a um acesso de equipe aparece marcada e não vira a
 * ativa do dono por engano.
 */

type Limit = { kind: string; label: string; percent: number | null; severity: string; resetsAt: string | null; active: boolean };

function resetLabel(iso: string | null, t: (k: string) => string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const mins = Math.round((d.getTime() - now) / 60000);
  if (mins <= 0) return '';
  if (mins < 60) return `${t('llm.resets')} ${mins}min`;
  if (mins < 48 * 60) return `${t('llm.resets')} ${Math.round(mins / 60)}h`;
  return `${t('llm.resets')} ${d.toLocaleDateString(undefined, { weekday: 'short' })}`;
}

function UsageBars({ profileId }: { profileId: string }) {
  const { t } = useT();
  const [data, setData] = useState<{ limits: Limit[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r: any = await (window as any).maestrus?.claude?.usage?.({ profileId: profileId === 'default' ? 'default' : profileId });
      if (r?.ok && Array.isArray(r.limits)) setData({ limits: r.limits });
      else setData({ limits: [], error: r?.error || 'erro' });
    } catch (e: any) { setData({ limits: [], error: e?.message || 'erro' }); }
    finally { setBusy(false); }
  }, [profileId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="llm-usage-loading"><Loader2 size={13} className="spin" /></div>;
  if (data.error) return <div className="llm-usage-err">{t('llm.usageErr')} <code>{data.error}</code> <button onClick={load}><RefreshCw size={11} /></button></div>;
  if (!data.limits.length) return <div className="llm-usage-err">{t('llm.usageEmpty')}</div>;

  return (
    <div className="llm-usage">
      {data.limits.map((l, i) => {
        const pct = Math.max(0, Math.min(100, Math.round(l.percent ?? 0)));
        const sev = l.severity === 'exceeded' || pct >= 95 ? 'crit' : (l.severity === 'warning' || pct >= 80 ? 'warn' : 'ok');
        return (
          <div key={i} className="llm-limit">
            <div className="llm-limit-head">
              <span className="llm-limit-label">{l.label}</span>
              <span className={`llm-limit-pct ${sev}`}>{l.percent === null ? '—' : `${pct}%`}</span>
            </div>
            <div className="llm-bar"><div className={`llm-bar-fill ${sev}`} style={{ width: `${pct}%` }} /></div>
            <div className="llm-limit-reset">{resetLabel(l.resetsAt, t)}</div>
          </div>
        );
      })}
      <button className="llm-refresh" onClick={load} disabled={busy} title={t('llm.refresh')}>
        {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
      </button>
    </div>
  );
}

export default function LLMAccountsScreen() {
  const { t } = useT();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);   // conta com uso expandido
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r: any = await (window as any).maestrus?.claudeProfiles?.listFor?.(null);
      setAccounts(Array.isArray(r) ? r : (r?.profiles || []));
    } catch {}
  }, []);
  useEffect(() => {
    load();
    const off = (window as any).maestrus?.claude?.onEvent?.((ev: any) => { if (ev?.type === 'profiles') load(); });
    return () => { try { off && off(); } catch {} };
  }, [load]);

  async function activate(id: string) {
    setBusy(id); setErr('');
    try {
      const r: any = await (window as any).maestrus?.claudeProfiles?.setActiveFor?.(null, id);
      if (r?.ok === false) setErr(r.error === 'team_bound' ? t('accounts.teamBound') : String(r.error));
      await load();
    } finally { setBusy(''); }
  }

  return (
    <div className="cloud-screen remote-web-screen">
      <div className="cloud-grid" />
      <div className="remote-stack remote-web">
        <div className="remote-web-head">
          <h1><Bot size={22} style={{ verticalAlign: '-3px', marginRight: 8 }} />{t('llm.title')}</h1>
          <p>{t('llm.sub')}</p>
        </div>

        {/* ── Claude: contas + uso oficial + troca ─────────────────────────── */}
        <div className="cloud-card remote-card span-2">
          <div className="remote-head">
            <Gauge size={24} />
            <div>
              <div className="remote-title">{t('llm.claudeTitle')}</div>
              <div className="remote-sub">{t('llm.claudeSub')}</div>
            </div>
          </div>

          <div className="llm-acct-list">
            {accounts.map((a) => (
              <div key={a.id} className={`llm-acct ${a.active ? 'on' : ''} ${a.teamBound ? 'team' : ''}`}>
                <button className="llm-acct-row" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  {open === a.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <UserRound size={14} />
                  <span className="llm-acct-name">{a.email || a.name || a.id}</span>
                  {a.email && a.name && <span className="llm-acct-sub">{a.name}</span>}
                  {a.teamBound && <span className="acct-team">{t('accounts.teamShort')}</span>}
                  {a.active && <span className="llm-acct-active"><Check size={12} /> {t('llm.active')}</span>}
                </button>
                {!a.active && !a.teamBound && (
                  <button className="llm-acct-use" onClick={() => activate(a.id)} disabled={!!busy}>
                    {busy === a.id ? <Loader2 size={12} className="spin" /> : t('llm.use')}
                  </button>
                )}
                {open === a.id && <UsageBars profileId={a.id} />}
              </div>
            ))}
          </div>
          {err && <div className="cloud-error">{err}</div>}
        </div>

        {/* ── Gestão (criar/logar/remover) — o módulo que já existia, agora aqui ── */}
        <div className="cloud-card remote-card span-2">
          <div className="remote-head">
            <UserRound size={24} />
            <div>
              <div className="remote-title">{t('llm.manageTitle')}</div>
              <div className="remote-sub">{t('llm.manageSub')}</div>
            </div>
          </div>
          <ClaudeAccounts />
        </div>
      </div>
    </div>
  );
}
