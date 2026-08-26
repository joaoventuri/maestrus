import { useEffect, useState } from 'react';
import { Wifi, WifiOff, Loader2, RefreshCw, Cloud } from 'lucide-react';

// Indicador de conexão de 1ª classe — unificado desktop/web/PWA. Deriva o estado
// REAL (relay + host) do clientState e mostra de forma clara e elegante; oferece
// "reconectar" quando cai. Fim da sensação de "não sei o que está acontecendo".
type St = 'local' | 'connecting' | 'syncing' | 'ready' | 'offline';

export default function ConnectionStatus({ variant = 'bar', hostLabel }: { variant?: 'bar' | 'pill'; hostLabel?: string | null }) {
  const [st, setSt] = useState<St>('local');
  const [host, setHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [everHad, setEverHad] = useState(false);

  function apply(s: any) {
    setHost(s?.hostName || null);
    if (s?.hostName || s?.connected) setEverHad(true);
    if (!s) return setSt('local');
    if (s.connected && s.syncing) return setSt('syncing');
    if (s.connected) return setSt('ready');
    if (s.status === 'connecting' || s.status === 'reconnecting') return setSt('connecting');
    if (s.hostName || everHad || s.status === 'offline' || s.status === 'error') return setSt('offline');
    return setSt('local');
  }
  useEffect(() => {
    const m: any = (window as any).maestrus;
    m?.remote?.clientState?.().then(apply).catch(() => {});
    const off = m?.remote?.onClientState?.(apply);
    return () => { try { off?.(); } catch {} };
  }, [everHad]);

  async function reconnect() {
    if (busy) return; setBusy(true);
    const m: any = (window as any).maestrus;
    try { await (m?.remote?.reconnect?.() || m?.remote?.discover?.()); } catch {}
    setTimeout(() => setBusy(false), 1600);
  }

  if (st === 'local') return null; // máquina local pura: sem ruído

  // Preferimos SEMPRE o host DESTE projeto (hostLabel) — assim o chip diz qual
  // máquina hospeda a conversa, em vez do resumo global "N máquinas".
  const shownHost = (hostLabel || host || '').replace(/\.local$/i, '') || null;
  const cfg: Record<Exclude<St, 'local'>, { c: string; label: string; sp?: boolean }> = {
    ready:      { c: '#3dd68c', label: shownHost ? shownHost : 'Conectado' },
    syncing:    { c: '#ffb84d', label: 'Sincronizando…', sp: true },
    connecting: { c: '#ffb84d', label: 'Conectando…', sp: true },
    offline:    { c: '#e08b6b', label: 'Sem conexão' },
  };
  const s = cfg[st];
  const Icon = st === 'ready' ? Wifi : st === 'offline' ? WifiOff : Loader2;

  return (
    <div className={`conn conn-${variant} conn-${st}`} title={st === 'ready' ? `Conectado a ${shownHost || 'host'}` : s.label}>
      <style>{CSS}</style>
      {/* Sem dot piscando — o próprio ícone de wifi (colorido) carrega o estado. */}
      <Icon size={13} className={s.sp ? 'conn-spin' : ''} style={{ color: s.c }} />
      <span className="conn-label">{s.label}</span>
      {st === 'offline' && (
        <button className="conn-retry" onClick={reconnect} title="Reconectar">
          {busy ? <Loader2 size={12} className="conn-spin" /> : <RefreshCw size={12} />}
        </button>
      )}
    </div>
  );
}

const CSS = `
.conn{display:inline-flex;align-items:center;gap:7px;font-family:'Space Grotesk',system-ui,sans-serif;font-size:12.5px;font-weight:600;
  letter-spacing:.01em;color:#cfc8bd;user-select:none}
.conn-pill{padding:5px 11px;border-radius:999px;background:rgba(242,236,224,.05);border:1px solid rgba(242,236,224,.09)}
.conn-dot{position:relative;width:8px;height:8px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 8px -1px currentColor}
.conn-ping{position:absolute;inset:-3px;border-radius:50%;border:1.5px solid;opacity:.6;animation:conn-pulse 2s ease-out infinite}
@keyframes conn-pulse{0%{transform:scale(1);opacity:.6}100%{transform:scale(2.2);opacity:0}}
.conn-label{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conn-spin{animation:conn-rot .8s linear infinite}
@keyframes conn-rot{to{transform:rotate(360deg)}}
.conn-offline{color:#e08b6b}
.conn-retry{margin-left:2px;background:rgba(224,139,107,.14);border:1px solid rgba(224,139,107,.4);color:#e08b6b;
  border-radius:7px;padding:3px 6px;cursor:pointer;display:flex;align-items:center;transition:background .15s}
.conn-retry:hover{background:rgba(224,139,107,.26)}
`;
