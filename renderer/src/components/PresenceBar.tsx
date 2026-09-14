import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';

/**
 * Quem está nesta conversa, ao vivo: avatares (iniciais) de quem está na
 * sala e "Fulano está escrevendo…". Alimentado pelos eventos `team.presence`
 * e `team.typing` do host — sem polling, sem estado local além do que chega.
 * Só aparece quando há MAIS alguém além de mim (numa conversa solo, silêncio).
 */
type Peer = { deviceId: string; name?: string | null; email?: string | null; owner?: boolean };

export function usePresence(projectId: string) {
  const api = (window as any).maestrus;
  const [peers, setPeers] = useState<Peer[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({});
  useEffect(() => {
    let alive = true;
    api?.team?.who?.(projectId).then((r: any) => { if (alive && r?.peers) { setPeers(r.peers); setMe(r.me || null); } }).catch(() => {});
    const off = api?.claude?.onEvent?.((e: any) => {
      if (e?.type === 'team.presence' && Array.isArray(e.peers)) setPeers(e.peers);
      if (e?.type === 'team.typing' && e.from) {
        const base = (id: string) => String(id || '').split('#')[0];
        if (e.projectId && base(String(e.projectId)) !== base(projectId) && String(e.projectId) !== projectId) return;
        const key = e.from.deviceId || 'x';
        setTyping((t) => { const n = { ...t }; if (e.typing) n[key] = { name: e.from.name || e.from.email || '…', at: Date.now() }; else delete n[key]; return n; });
      }
    });
    const iv = setInterval(() => setTyping((t) => { const n: typeof t = {}; let ch = false; for (const k of Object.keys(t)) { if (Date.now() - t[k].at < 6000) n[k] = t[k]; else ch = true; } return ch ? n : t; }), 2000);
    return () => { alive = false; try { off && off(); } catch {} clearInterval(iv); };
  }, [projectId]);
  const others = peers.filter((p) => p.deviceId !== me && !(me === 'host' && p.owner));
  return { peers, others, typing: Object.values(typing).map((x) => x.name) };
}

/** Sinal "estou escrevendo": chame a cada tecla; ele cuida do throttle e do "parei". */
export function useTypingSignal(projectId: string) {
  const api = (window as any).maestrus;
  const lastSent = useRef(0); const stopTimer = useRef<any>(null);
  return () => {
    const now = Date.now();
    if (now - lastSent.current > 2500) { lastSent.current = now; api?.team?.typing?.(projectId, true).catch?.(() => {}); }
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => { lastSent.current = 0; api?.team?.typing?.(projectId, false).catch?.(() => {}); }, 4000);
  };
}

function initials(p: Peer) { const n = String(p.name || p.email || '?').trim(); const parts = n.split(/[\s@._-]+/).filter(Boolean); return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase(); }

export default function PresenceBar({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const { t } = useT();
  const { others, typing } = usePresence(projectId);
  if (!others.length && !typing.length) return null;
  return (
    <span className={`presence ${compact ? 'compact' : ''}`} title={others.map((p) => p.name || p.email || p.deviceId.slice(0, 6)).join(', ')}>
      <span className="presence-avatars">
        {others.slice(0, 5).map((p) => <span key={p.deviceId} className={`presence-avatar ${p.owner ? 'owner' : ''}`}>{initials(p)}</span>)}
        {others.length > 5 && <span className="presence-avatar more">+{others.length - 5}</span>}
      </span>
      {typing.length > 0 && <span className="presence-typing">{typing.length === 1 ? t('team.typingOne', { name: typing[0] }) : t('team.typingMany', { n: typing.length })}</span>}
    </span>
  );
}
