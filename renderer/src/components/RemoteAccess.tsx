import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Server, Loader2, Wifi, WifiOff, Copy, Check, ShieldCheck, Smartphone, Link2, Trash2, Users, ChevronDown } from 'lucide-react';
import { CloudAccount, RemoteHostState, RemoteClientState } from '../types';
import { useT } from '../lib/i18n';

// "Acesso Remoto" — UM fluxo só, dos dois lados:
//   HOST: liga o switch, aparece UM QR + UM código. Com conta o código é o da
//   conta (curto); sem conta é um convite (o app escolhe sozinho — pra quem usa,
//   é sempre "o código que apareceu na outra tela").
//   CLIENT: UM campo que aceita qualquer um dos dois formatos e roteia sozinho.
export default function RemoteAccess({ onConnected }: { onConnected?: () => void }) {
  const { t } = useT();
  const isWeb = !!(window as any).maestrus?.isWeb;
  const inviteApi = (window as any).maestrus?.invite;
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [host, setHost] = useState<RemoteHostState>({ running: false, status: 'idle' });
  const [client, setClient] = useState<RemoteClientState>({ connected: false, status: 'idle', hostName: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // O código exibido no host — de conta (curto) ou convite (longo). Um por vez.
  const [pair, setPair] = useState<{ kind: 'account' | 'invite'; code: string; qr: string; expiresAt: number | null } | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Sala de convite ativa (host sem conta) — o switch reflete isso.
  const [invHost, setInvHost] = useState<boolean>(false);
  // Conexão de client feita por convite (pra rotear o "desconectar").
  const [invClient, setInvClient] = useState<boolean>(false);

  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);

  const [memberWs, setMemberWs] = useState<any[]>([]);
  const [wsBusy, setWsBusy] = useState<number | null>(null);

  function refreshInvite() {
    inviteApi?.state?.().then((s: any) => {
      setInvHost(!!s?.host);
      setInvClient(!!s?.client);
    }).catch(() => {});
  }

  useEffect(() => {
    window.maestrus.cloud.account().then(setAccount);
    window.maestrus.remote.hostState().then(setHost);
    window.maestrus.remote.clientState().then(setClient);
    refreshInvite();
    const offH = window.maestrus.remote.onHostState(setHost);
    const offC = window.maestrus.remote.onClientState((s) => { setClient(s); if (s.connected) onConnected?.(); });
    // Convite aceito por deep link (QR lido fora do app): espelha aqui.
    const offJ = inviteApi?.onJoined?.((r: any) => { if (r?.ok) { refreshInvite(); onConnected?.(); } });
    return () => { offH(); offC(); offJ?.(); };
  }, []);

  useEffect(() => {
    (window.maestrus.remote as any).memberWorkspaces?.()
      .then((w: any) => {
        const list = Array.isArray(w) ? w : [];
        setMemberWs(list);
        if (list.length > 0) {
          window.maestrus.remote.clientState().then((s) => { if (!s.connected) setTab('connect'); }).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // Relógio só enquanto há convite com validade na tela.
  useEffect(() => {
    if (!pair?.expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pair?.expiresAt]);

  const remainMs = pair?.expiresAt ? pair.expiresAt - now : 0;
  const expired = !!pair?.expiresAt && remainMs <= 0;
  const remain = (() => {
    const s = Math.max(0, Math.floor(remainMs / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  })();

  function goPro() { setError(t('remote.proRequired')); window.maestrus.cloud.openPanel().catch(() => {}); }

  // ── HOST: ligar/desligar ──────────────────────────────────────────────────
  const hostOn = account ? host.running : invHost;

  async function hostToggle() {
    setBusy(true); setError(null); setPair(null);
    try {
      if (hostOn) {
        if (account) await window.maestrus.remote.hostDisable();
        if (invHost) await inviteApi?.revoke?.();
        refreshInvite();
      } else if (account) {
        const r = await window.maestrus.remote.hostEnable();
        if (r.error === 'pro_required' || r.error === 'free_limit') goPro();
        else if (!r.ok) setError(r.error === 'relay_not_configured' ? t('remote.errNotConfigured') : (r.error || t('remote.errGeneric')));
      } else {
        // Sem conta: ligar o host É abrir a sala do convite.
        const r = await inviteApi?.create?.({});
        if (!r?.ok) setError(t('invite.errCreate'));
        else setPair({ kind: 'invite', code: r.code, qr: r.url || `maestrus://pair?c=${r.code}`, expiresAt: r.expiresAt || null });
        refreshInvite();
      }
    } finally { setBusy(false); }
  }

  // ── HOST: gerar/mostrar o código ──────────────────────────────────────────
  async function genCode() {
    setCodeBusy(true); setError(null);
    try {
      if (account && host.running) {
        const r = await window.maestrus.remote.pairCreate();
        if (r.ok && r.code) setPair({ kind: 'account', code: r.code, qr: r.code, expiresAt: null });
        else setError(r.error || t('remote.errGeneric'));
      } else {
        const r = await inviteApi?.create?.({});
        if (r?.ok && r.code) { setPair({ kind: 'invite', code: r.code, qr: r.url || `maestrus://pair?c=${r.code}`, expiresAt: r.expiresAt || null }); refreshInvite(); }
        else setError(t('invite.errCreate'));
      }
      setNow(Date.now());
    } finally { setCodeBusy(false); }
  }

  function copy() {
    if (!pair) return;
    navigator.clipboard?.writeText(pair.code);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }

  // ── CLIENT: um campo, qualquer código ─────────────────────────────────────
  async function connect() {
    const raw = joinCode.trim();
    if (!raw) return;
    // Convite é base64url longo (ou URL maestrus://); código de conta é curto.
    // Uppercase SÓ no curto — maiúscula quebra base64url.
    const val = (raw.length > 14 || /^maestrus:\/\//i.test(raw)) ? raw : raw.toUpperCase();
    setJoining(true); setError(null);
    const r = await window.maestrus.remote.connect(val);
    if (r.error === 'pro_required' || r.error === 'free_limit') goPro();
    else if (!r.ok) {
      setError(r.error === 'expired' ? t('invite.errExpired')
        : r.error === 'invalid_or_expired' ? t('remote.errCode')
        : (r.error || t('remote.errGeneric')));
    } else { setJoinCode(''); refreshInvite(); onConnected?.(); }
    setJoining(false);
  }

  async function disconnect() {
    setJoining(true);
    // Conexão veio de convite → sair da sala (limpa o segredo salvo também).
    if (invClient) await inviteApi?.leave?.().catch(() => {});
    await window.maestrus.remote.disconnect();
    refreshInvite();
    setJoining(false);
  }

  async function connectWs(w: any) {
    setWsBusy(Number(w.owner_id)); setError(null);
    try {
      const r = await (window.maestrus.remote as any).connectWorkspace?.(Number(w.owner_id), w.owner_name || w.owner_email);
      if (r && r.ok) onConnected?.();
      else setError(t('remote.wsOffline'));
    } finally { setWsBusy(null); }
  }

  // ── Self-host (avançado) ──────────────────────────────────────────────────
  const sh = (window as any).maestrus?.selfhost;
  const [shUrl, setShUrl] = useState('');
  const [shSecret, setShSecret] = useState('');
  const [shBusy, setShBusy] = useState(false);
  const [shInfo, setShInfo] = useState<{ configured: boolean; url?: string; hostName?: string } | null>(null);
  const [shErr, setShErr] = useState<string | null>(null);
  useEffect(() => { if (sh) sh.info().then(setShInfo).catch(() => {}); }, []);
  async function shConnect() {
    if (!shUrl.trim() || !shSecret.trim()) return;
    setShBusy(true); setShErr(null);
    try {
      const r = await sh.connect(shUrl.trim(), shSecret.trim());
      if (r && r.ok) { setShInfo({ configured: true, url: shUrl.trim(), hostName: r.hostName }); setShSecret(''); onConnected?.(); }
      else setShErr(r?.error === 'bad_secret' ? (t('selfhost.badSecret') || 'Chave incorreta.') : r?.error === 'not_selfhost' ? (t('selfhostDesk.notServer') || 'Esse endereço não é um servidor Maestrus.') : (t('selfhost.errConn') || 'Não consegui conectar ao servidor.'));
    } catch (e: any) { setShErr(e?.message || 'erro'); }
    finally { setShBusy(false); }
  }
  async function shForget() { await sh?.forget?.().catch(() => {}); setShInfo({ configured: false }); }

  // ── Dispositivos da conta ─────────────────────────────────────────────────
  const [devices, setDevices] = useState<Array<{ device_id: string; device_name: string | null; online: boolean; last_seen: string }>>([]);
  async function loadDevices() { try { const r = await window.maestrus.cloud.devices?.(); if (r && r.ok) setDevices(r.devices || []); } catch {} }
  useEffect(() => {
    loadDevices();
    const id = setInterval(() => { loadDevices(); }, 20000); return () => clearInterval(id);
  }, []);
  const liveHostIds = new Set<string>(((client as any).hosts || []).map((h: any) => h.deviceId));
  function devOnline(d: { device_id: string; online: boolean }) {
    return d.online || liveHostIds.has(d.device_id);
  }
  async function deleteDevice(deviceId: string) {
    if (!window.confirm(t('remote.devRemoveConfirm'))) return;
    setDevices((ds) => ds.filter((d) => d.device_id !== deviceId));
    try { await (window.maestrus.cloud as any).deviceDelete?.(deviceId); } catch {}
    loadDevices();
  }

  // ── Descoberta automática (conta) ─────────────────────────────────────────
  const [discovery, setDiscovery] = useState(false);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  useEffect(() => { window.maestrus.remote.getDiscovery?.().then((r) => setDiscovery(!!r?.enabled)).catch(() => {}); }, []);
  async function toggleDiscovery() {
    const next = !discovery; setDiscovery(next); setDiscoveryBusy(true); setError(null);
    try {
      const r = await window.maestrus.remote.setDiscovery?.(next);
      if (next && r && r.ok === false) { setDiscovery(false); if (r.error === 'free_limit' || r.error === 'pro_required') goPro(); }
    } catch {} finally { setDiscoveryBusy(false); }
  }

  const [tab, setTab] = useState<'host' | 'connect'>('host');
  const tabs: { id: 'host' | 'connect'; label: string; icon: any }[] = isWeb
    ? [{ id: 'connect', label: t('remote.tabConnect'), icon: Smartphone }]
    : [
        { id: 'host', label: t('remote.tabHost'), icon: Server },
        { id: 'connect', label: t('remote.tabConnect'), icon: Smartphone },
      ];

  // Código curto mostra inteiro e grande; convite longo mostra truncado (o QR e
  // o copiar carregam o valor completo — o olho não precisa dele).
  const codeDisplay = pair ? (pair.kind === 'account' ? pair.code : `${pair.code.slice(0, 10)}…${pair.code.slice(-4)}`) : '';

  return (
    <div className="cloud-screen remote-web-screen">
      <div className="cloud-grid" />
      <div className="remote-stack remote-web">

        <div className="remote-web-head">
          <h1>{t('remote.screenTitle')}</h1>
          <p>{t('remote.screenSub')}</p>
        </div>

        <div className="remote-tabs span-2" role="tablist">
          {tabs.map((tb) => (
            <button key={tb.id} role="tab" aria-selected={tab === tb.id}
              className={`remote-tab ${tab === tb.id ? 'active' : ''}`} onClick={() => setTab(tb.id)}>
              <tb.icon size={15} /> {tb.label}
            </button>
          ))}
        </div>

        {/* ── ESTA MÁQUINA (HOST): um card, um QR, um código ──────────────── */}
        {tab === 'host' && !isWeb && (
          <div className="cloud-card remote-card span-2">
            <div className="remote-head">
              <Server size={26} />
              <div>
                <div className="remote-title">{t('remote.title')}</div>
                <div className="remote-sub">{t('remote.subtitle')}</div>
              </div>
              <Switch on={hostOn} busy={busy} onToggle={hostToggle} />
            </div>
            <p className="remote-explain">{t('remote.explain')}</p>

            {!hostOn ? (
              <div className="remote-status">
                <span className="remote-dot" /><WifiOff size={14} />
                <span>{t('remote.hostOffHint')}</span>
              </div>
            ) : (
              <>
                <div className="remote-status">
                  <span className={`remote-dot ${(account ? host.status === 'online' : true) ? 'on' : 'pending'}`} />
                  {(account ? host.status === 'online' : true) ? <Wifi size={14} /> : <Loader2 size={13} className="spin" />}
                  <span>{account ? t(`remote.status_${host.status}`) : t('invite.roomOpen')}</span>
                </div>

                {pair && !expired ? (
                  <div className="remote-pair">
                    <div className="remote-qr"><QRCodeSVG value={pair.qr} size={148} includeMargin /></div>
                    <button className={`remote-code ${pair.kind === 'invite' ? 'long' : ''}`} onClick={copy} title={t('common.copy')}>
                      <code>{codeDisplay}</code>{copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                    <div className="cloud-hint">
                      {t('remote.codeHint')}
                      {pair.expiresAt ? <> · {t('invite.expiresIn')} {remain}</> : null}
                    </div>
                  </div>
                ) : (
                  <div className="remote-pair-row">
                    <button className="cloud-submit" onClick={genCode} disabled={codeBusy}>
                      {codeBusy ? <Loader2 size={16} className="spin" /> : <><Smartphone size={15} /> {pair && expired ? t('invite.newCode') : t('remote.genCode')}</>}
                    </button>
                  </div>
                )}

                <div className="remote-how">
                  <div className="remote-how-title"><ShieldCheck size={13} /> {t('remote.howTitle')}</div>
                  <ol><li>{t('remote.how1')}</li><li>{t('remote.how2')}</li><li>{t('remote.how3')}</li></ol>
                  <div className="cloud-hint">{account ? t('remote.security') : t('invite.security')}</div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── CONECTAR ────────────────────────────────────────────────────── */}
        {tab === 'connect' && (
          <>
            {account && !isWeb && (
              <div className="cloud-card remote-card span-2">
                <div className="remote-head">
                  <Wifi size={26} />
                  <div>
                    <div className="remote-title">{t('remote.discoverTitle')}</div>
                    <div className="remote-sub">{t('remote.discoverSub')}</div>
                  </div>
                  <Switch on={discovery} busy={discoveryBusy} onToggle={toggleDiscovery} />
                </div>
                <p className="remote-explain">{t('remote.discoverExplain')}</p>
                {discovery && (
                  <div className="remote-status">
                    {(client as any).syncing
                      ? <><Loader2 size={13} className="spin" /> <span>{t('mode.syncing')}</span></>
                      : <><span className={`remote-dot ${client.connected ? 'on' : ''}`} />
                          <span>{client.connected
                            ? <>{t('remote.connectedTo')} <strong>{client.hostName || t('mode.host')}</strong></>
                            : t('remote.discoverSearching')}</span></>}
                  </div>
                )}
              </div>
            )}

            {account && memberWs.length > 0 && (
              <div className="cloud-card remote-card span-2">
                <div className="remote-head">
                  <Users size={24} />
                  <div>
                    <div className="remote-title">{t('remote.wsTitle')}</div>
                    <div className="remote-sub">{t('remote.wsSub')}</div>
                  </div>
                </div>
                {memberWs.map((w) => (
                  <div key={w.owner_id} className="remote-status" style={{ justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <strong>{w.owner_name || w.owner_email}</strong>
                      {w.owner_name ? <span style={{ opacity: .55, marginLeft: 6 }}>{w.owner_email}</span> : null}
                    </span>
                    <button className="cloud-submit" style={{ width: 'auto', padding: '6px 14px' }}
                      onClick={() => connectWs(w)} disabled={wsBusy !== null}>
                      {wsBusy === Number(w.owner_id) ? <Loader2 size={14} className="spin" /> : <><Link2 size={14} /> {t('remote.wsConnect')}</>}
                    </button>
                  </div>
                ))}
                <div className="cloud-hint">{t('remote.wsHint')}</div>
              </div>
            )}

            {/* UM campo pra qualquer código (conta OU convite) */}
            <div className="cloud-card remote-card span-2">
              <div className="remote-head">
                <Link2 size={24} />
                <div>
                  <div className="remote-title">{t('remote.connectTitle')}</div>
                  <div className="remote-sub">{t('remote.connectSub')}</div>
                </div>
              </div>
              {client.connected ? (
                <>
                  <div className="remote-status">
                    <span className="remote-dot on" /><Wifi size={14} />
                    <span>{t('remote.connectedTo')} <strong>{client.hostName}</strong></span>
                  </div>
                  <div className="cloud-hint">{t('remote.connectedHint')}</div>
                  <button className="cloud-logout" onClick={disconnect} disabled={joining}>
                    {joining ? <Loader2 size={14} className="spin" /> : <><WifiOff size={14} /> {t('remote.disconnect')}</>}
                  </button>
                </>
              ) : (
                <>
                  <label className="cloud-field">
                    <span>{t('remote.codeLabel')}</span>
                    <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
                      placeholder={t('remote.codePlaceholder')} spellCheck={false}
                      onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
                      style={{ fontFamily: 'var(--mono)' }} />
                  </label>
                  <button className="cloud-submit" onClick={connect} disabled={joining || !joinCode.trim()}>
                    {joining ? <Loader2 size={16} className="spin" /> : <><Link2 size={15} /> {t('remote.connect')}</>}
                  </button>
                  <div className="cloud-hint">{t('remote.connectExplain')}</div>
                </>
              )}
            </div>

            {/* Self-host: opção avançada, recolhida — não compete com o fluxo normal */}
            {sh && (
              <details className="remote-advanced span-2" open={!!shInfo?.configured}>
                <summary>
                  <ChevronDown size={14} className="remote-adv-chev" />
                  <Server size={14} /> {t('selfhostDesk.title') || 'Conectar ao meu servidor (self-host)'}
                </summary>
                <div className="remote-adv-body">
                  {shInfo?.configured ? (
                    <>
                      <div className="remote-status">
                        <span className={`remote-dot ${client.connected ? 'on' : ''}`} /><Server size={14} />
                        <span>{t('selfhostDesk.linkedTo') || 'Servidor'}: <strong>{shInfo.hostName || shInfo.url}</strong></span>
                      </div>
                      <div className="cloud-hint">{shInfo.url}</div>
                      <button className="cloud-logout" onClick={shForget}><Trash2 size={14} /> {t('selfhostDesk.forget') || 'Esquecer servidor'}</button>
                    </>
                  ) : (
                    <>
                      <label className="cloud-field">
                        <span>{t('selfhostDesk.urlLabel') || 'Endereço do servidor'}</span>
                        <input value={shUrl} onChange={(e) => setShUrl(e.target.value)} placeholder="http://192.168.0.10:8090" spellCheck={false} />
                      </label>
                      <label className="cloud-field">
                        <span>{t('selfhostDesk.secretLabel') || 'Chave de acesso (SELFHOST_SECRET)'}</span>
                        <input type="password" value={shSecret} onChange={(e) => setShSecret(e.target.value)} placeholder="••••••••" spellCheck={false} />
                      </label>
                      {shErr && <div className="cloud-error">{shErr}</div>}
                      <button className="cloud-submit" onClick={shConnect} disabled={shBusy || !shUrl.trim() || !shSecret.trim()}>
                        {shBusy ? <Loader2 size={16} className="spin" /> : <><Server size={15} /> {t('selfhostDesk.connect') || 'Conectar'}</>}
                      </button>
                      <div className="cloud-hint">{t('selfhostDesk.explain') || 'Sem conta, sem nuvem — fala direto com o seu servidor. A IA é a sua conta do Claude.'}</div>
                    </>
                  )}
                </div>
              </details>
            )}

            {account && devices.length > 0 && (
              <div className="cloud-card remote-card span-2">
                <div className="remote-head">
                  <Smartphone size={26} />
                  <div>
                    <div className="remote-title">{t('remote.devicesTitle')}</div>
                    <div className="remote-sub">{t('remote.devicesSub')}</div>
                  </div>
                </div>
                <div className="dev-list">
                  {devices.map((d) => {
                    const on = devOnline(d);
                    return (
                      <div key={d.device_id} className="dev-item">
                        <span className={`dev-dot ${on ? 'on' : ''}`} />
                        <span className="dev-name">{d.device_name || d.device_id.slice(0, 18)}</span>
                        <span className="dev-status">{on ? t('remote.devOnline') : t('remote.devOffline')}</span>
                        <button className="dev-del" title={t('remote.devRemove')} onClick={() => deleteDevice(d.device_id)}><Trash2 size={13} /></button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {error && <div className="cloud-error" style={{ maxWidth: 460 }}>{error}</div>}
      </div>
    </div>
  );
}

// Switch enable/disable elegante (reutilizado pelo host e pela descoberta).
function Switch({ on, busy, onToggle }: { on: boolean; busy?: boolean; onToggle: () => void }) {
  return (
    <button
      className={`m-switch ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={onToggle}
    >
      <span className="m-switch-knob">{busy ? <Loader2 size={10} className="spin" /> : null}</span>
    </button>
  );
}
