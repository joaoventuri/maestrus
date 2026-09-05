import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { KeyRound, Loader2, Copy, Check, Link2, WifiOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { useT } from '../lib/i18n';

type InviteState = {
  ok: boolean;
  relayUrl: string;
  host: { room: string; createdAt: number | null; running: boolean } | null;
  client: { room: string; hostName: string | null; relayUrl: string | null } | null;
};

// Pareamento por CONVITE: duas máquinas se acham por um segredo que elas
// mesmas compartilham, sem cadastro em servidor nenhum. `mode` decide o lado
// mostrado — 'host' (gera o convite) ou 'connect' (cola o convite).
export default function InvitePairing({ mode, onConnected }: { mode: 'host' | 'connect'; onConnected?: () => void }) {
  const { t } = useT();
  const api = (window as any).maestrus?.invite as any;
  const [state, setState] = useState<InviteState | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    api?.state().then(setState).catch(() => {});
    // Convite aceito por deep link: a sala mudou sem ninguém tocar nesta tela.
    return api?.onJoined?.((r: any) => {
      if (r && r.ok) { api.state().then(setState).catch(() => {}); onConnected?.(); }
      else if (r) setError(r.error === 'expired' ? t('invite.errExpired') : t('invite.errCode'));
    });
  }, []);
  // Relógio só enquanto há código na tela — o que expira precisa parecer que
  // expira, senão o usuário manda um convite morto e culpa o app.
  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (!api) return null;

  const remainMs = expiresAt ? expiresAt - now : 0;
  const expired = !!expiresAt && remainMs <= 0;
  const remain = (() => {
    const s = Math.max(0, Math.floor(remainMs / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  })();

  async function generate(rotate = false) {
    setBusy(true); setError(null);
    try {
      const r = await api!.create(rotate ? { rotate: true } : {});
      if (r.ok && r.code) { setCode(r.code); setExpiresAt(r.expiresAt || null); setNow(Date.now()); }
      else setError(t('invite.errCreate'));
      setState(await api!.state());
    } catch { setError(t('invite.errCreate')); }
    finally { setBusy(false); }
  }

  async function revoke() {
    setBusy(true);
    try { await api!.revoke(); setCode(null); setExpiresAt(null); setState(await api!.state()); }
    finally { setBusy(false); }
  }

  async function join() {
    const v = joinCode.trim();
    if (!v) return;
    setBusy(true); setError(null);
    try {
      const r = await api!.join(v);
      if (r.ok) { setJoinCode(''); setState(await api!.state()); onConnected?.(); }
      else setError(r.error === 'expired' ? t('invite.errExpired') : t('invite.errCode'));
    } catch { setError(t('invite.errCode')); }
    finally { setBusy(false); }
  }

  async function leave() {
    setBusy(true);
    try { await api!.leave(); setState(await api!.state()); }
    finally { setBusy(false); }
  }

  function copy() {
    if (!code) return;
    navigator.clipboard?.writeText(code);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }

  // ── Lado HOST: gera e mostra o convite ────────────────────────────────────
  if (mode === 'host') {
    const active = !!state?.host;
    return (
      <div className="cloud-card remote-card span-2">
        <div className="remote-head">
          <KeyRound size={24} />
          <div>
            <div className="remote-title">{t('invite.hostTitle')}</div>
            <div className="remote-sub">{t('invite.hostSub')}</div>
          </div>
        </div>
        <p className="remote-explain">{t('invite.explain')}</p>

        {active && (
          <div className="remote-status">
            <span className={`remote-dot ${state?.host?.running ? 'on' : 'pending'}`} />
            <span>{state?.host?.running ? t('invite.roomOpen') : t('invite.roomStarting')}</span>
          </div>
        )}

        {code && !expired ? (
          <div className="remote-pair">
            <div className="remote-qr"><QRCodeSVG value={`maestrus://pair?c=${code}`} size={148} includeMargin /></div>
            <button className="remote-code" onClick={copy} title={t('common.copy')}>
              <code style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{code}</code>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <div className="cloud-hint">{t('invite.codeHint')} · {t('invite.expiresIn')} {remain}</div>
          </div>
        ) : null}

        <div className="remote-pair-row" style={{ gap: 8, display: 'flex', flexWrap: 'wrap' }}>
          <button className="cloud-submit" onClick={() => generate(false)} disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <><KeyRound size={15} /> {code && expired ? t('invite.newCode') : active ? t('invite.showCode') : t('invite.generate')}</>}
          </button>
          {active && (
            <button className="cloud-logout" onClick={revoke} disabled={busy} style={{ width: 'auto' }}>
              <WifiOff size={14} /> {t('invite.revoke')}
            </button>
          )}
          {active && (
            <button className="cloud-logout" onClick={() => generate(true)} disabled={busy} style={{ width: 'auto' }}>
              <RefreshCw size={14} /> {t('invite.rotate')}
            </button>
          )}
        </div>
        {error && <div className="cloud-error">{error}</div>}
        <div className="cloud-hint"><ShieldCheck size={12} /> {t('invite.security')}</div>
      </div>
    );
  }

  // ── Lado CLIENT: cola o convite ───────────────────────────────────────────
  const joined = state?.client;
  return (
    <div className="cloud-card remote-card span-2">
      <div className="remote-head">
        <Link2 size={24} />
        <div>
          <div className="remote-title">{t('invite.joinTitle')}</div>
          <div className="remote-sub">{t('invite.joinSub')}</div>
        </div>
      </div>

      {joined ? (
        <>
          <div className="remote-status">
            <span className="remote-dot on" />
            <span>{t('invite.joinedTo')} <strong>{joined.hostName || t('mode.host')}</strong></span>
          </div>
          <div className="cloud-hint">{joined.relayUrl}</div>
          <button className="cloud-logout" onClick={leave} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <><WifiOff size={14} /> {t('invite.leave')}</>}
          </button>
        </>
      ) : (
        <>
          <label className="cloud-field">
            <span>{t('invite.codeLabel')}</span>
            <textarea ref={inputRef} value={joinCode} rows={3} spellCheck={false}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="maestrus://pair?c=…"
              style={{ fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }} />
          </label>
          {error && <div className="cloud-error">{error}</div>}
          <button className="cloud-submit" onClick={join} disabled={busy || !joinCode.trim()}>
            {busy ? <Loader2 size={16} className="spin" /> : <><Link2 size={15} /> {t('invite.join')}</>}
          </button>
          <div className="cloud-hint">{t('invite.joinExplain')}</div>
        </>
      )}
    </div>
  );
}
