import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, UserRound, AlertTriangle } from 'lucide-react';
import { useT } from '../lib/i18n';

/**
 * Contas do Claude DO PROJETO.
 *
 * A conta pertence a quem EXECUTA o turno: um projeto local usa as contas
 * desta máquina, um projeto do host usa as contas do host. Antes havia uma
 * lista global escolhida por heurística, então o cliente via as contas locais
 * achando que eram do host — e trocar não surtia efeito no turno.
 *
 * Atualiza em tempo real: o main emite `profiles` quando alguém troca em
 * qualquer lugar, então as várias telas que mostram a conta nunca divergem.
 */
export interface Account { id: string; name?: string; active?: boolean; email?: string }

export default function AccountPicker({ projectId, compact = false, onSwitched }: {
  projectId: string;
  /** Versão enxuta (uma linha de chips), pro banner de limite e o cabeçalho. */
  compact?: boolean;
  onSwitched?: (id: string) => void;
}) {
  const { t } = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r: any = await (window as any).maestrus?.claudeProfiles?.listFor?.(projectId);
      // host_unreachable é resposta legítima: melhor dizer que o host está fora
      // do que mostrar as contas locais como se fossem dele.
      if (r && r.ok === false) { setErr(r.error === 'host_unreachable' ? (t('accounts.hostOffline') || 'Host fora do ar') : String(r.error)); setAccounts([]); }
      else { setErr(''); setAccounts(Array.isArray(r) ? r : (r?.profiles || [])); }
    } catch (e: any) {
      setErr(e?.message || 'erro');
    } finally { setLoading(false); }
  }, [projectId, t]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  // Tempo real: qualquer troca (aqui, em outra tela ou em outro dispositivo)
  // republica o estado e todas as telas convergem.
  useEffect(() => {
    const off = (window as any).maestrus?.claude?.onEvent?.((ev: any) => {
      if (ev && ev.type === 'profiles') load();
    });
    return () => { try { off && off(); } catch {} };
  }, [load]);

  async function pick(id: string) {
    if (busy) return;
    setBusy(id);
    try {
      await (window as any).maestrus?.claudeProfiles?.setActiveFor?.(projectId, id);
      setAccounts((a) => a.map((x) => ({ ...x, active: x.id === id })));
      onSwitched?.(id);
    } catch (e: any) {
      setErr(e?.message || 'falha ao trocar');
    } finally { setBusy(''); }
  }

  if (loading) return <span className="acct-loading"><Loader2 size={12} className="spin" /></span>;
  if (err) return <span className="acct-err"><AlertTriangle size={12} /> {err}</span>;
  if (!accounts.length) return null;

  if (compact) {
    return (
      <span className="acct-chips">
        {accounts.map((a) => (
          <button
            key={a.id}
            className={`acct-chip ${a.active ? 'on' : ''}`}
            disabled={!!busy || a.active}
            onClick={() => pick(a.id)}
            title={a.email || a.name || a.id}
          >
            {busy === a.id ? <Loader2 size={11} className="spin" /> : (a.active ? <Check size={11} /> : null)}
            {a.name || a.id}
          </button>
        ))}
      </span>
    );
  }

  return (
    <div className="acct-list">
      {accounts.map((a) => (
        <button
          key={a.id}
          className={`acct-row ${a.active ? 'on' : ''}`}
          disabled={!!busy}
          onClick={() => pick(a.id)}
        >
          <UserRound size={14} />
          <span className="acct-name">{a.name || a.id}</span>
          {a.email && <span className="acct-email">{a.email}</span>}
          <span className="acct-state">
            {busy === a.id ? <Loader2 size={13} className="spin" />
              : a.active ? <><Check size={13} /> {t('accounts.active') || 'em uso'}</> : null}
          </span>
        </button>
      ))}
    </div>
  );
}
