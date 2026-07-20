import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Server, Loader2, Wifi, WifiOff, Copy, Check, ShieldCheck, Smartphone, Link2, CloudCog, Globe, Pause as PauseIcon, Trash2 } from 'lucide-react';
import { CloudAccount, RemoteHostState, RemoteClientState, CloudSession } from '../types';
import { useT } from '../lib/i18n';

// "Remote Access" — HOST: vira servidor e gera código/QR. CLIENT: conecta num
// host com o código e opera os projetos dele (CLI do host) por aqui.
export default function RemoteAccess({ onConnected }: { onConnected?: () => void }) {
  const { t } = useT();
  // No web não há "ser host" (sem CLI local) nem troca de modo: a tela vira um
  // painel cloud-first largo e centralizado, sem scroll interno apertado.
  const isWeb = !!(window as any).maestrus?.isWeb;
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [host, setHost] = useState<RemoteHostState>({ running: false, status: 'idle' });
  const [client, setClient] = useState<RemoteClientState>({ connected: false, status: 'idle', hostName: null });
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    window.maestrus.cloud.account().then(setAccount);
    window.maestrus.remote.hostState().then(setHost);
    window.maestrus.remote.clientState().then(setClient);
    const offH = window.maestrus.remote.onHostState(setHost);
    const offC = window.maestrus.remote.onClientState((s) => { setClient(s); if (s.connected) onConnected?.(); });
    return () => { offH(); offC(); };
  }, []);

  function goPro() { setError(t('remote.proRequired')); window.maestrus.cloud.openPanel().catch(() => {}); }

  async function enable() {
    setBusy(true); setError(null);
    const r = await window.maestrus.remote.hostEnable();
    if (r.error === 'pro_required' || r.error === 'free_limit') goPro();
    else if (!r.ok) setError(r.error === 'relay_not_configured' ? t('remote.errNotConfigured') : (r.error || t('remote.errGeneric')));
    setBusy(false);
  }
  async function disable() { setBusy(true); await window.maestrus.remote.hostDisable(); setCode(null); setBusy(false); }
  async function genCode() {
    setCodeBusy(true); setError(null);
    const r = await window.maestrus.remote.pairCreate();
    if (r.ok && r.code) setCode(r.code); else setError(r.error || t('remote.errGeneric'));
    setCodeBusy(false);
  }
  function copy() { if (!code) return; navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }
  async function connect() {
    if (!joinCode.trim()) return;
    setJoining(true); setError(null);
    const r = await window.maestrus.remote.connect(joinCode.trim());
    if (r.error === 'pro_required' || r.error === 'free_limit') goPro();
    else if (!r.ok) setError(r.error === 'invalid_or_expired' ? t('remote.errCode') : (r.error || t('remote.errGeneric')));
    else { setJoinCode(''); onConnected?.(); }
    setJoining(false);
  }
  async function disconnect() { setJoining(true); await window.maestrus.remote.disconnect(); setJoining(false); }

  // ─── Self-host: conectar num servidor Maestrus próprio (URL + secret) ──────
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

  // ─── Maestrus on Cloud ─────────────────────────────────────────────────────
  const [cloudSessions, setCloudSessions] = useState<CloudSession[]>([]);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [localProjects, setLocalProjects] = useState<{ id: string; name: string }[]>([]);
  const [activateId, setActivateId] = useState('');
  const [activating, setActivating] = useState(false);
  async function loadCloud() {
    try { const r = await window.maestrus.cloud.cloudList?.(); if (r && r.ok) setCloudSessions(r.sessions || []); } catch {}
  }
  const [devices, setDevices] = useState<Array<{ device_id: string; device_name: string | null; online: boolean; last_seen: string }>>([]);
  async function loadDevices() { try { const r = await window.maestrus.cloud.devices?.(); if (r && r.ok) setDevices(r.devices || []); } catch {} }
  useEffect(() => {
    loadCloud(); loadDevices();
    window.maestrus.projects.list().then((ps) => setLocalProjects(ps.filter((p) => p.id !== 'maestrus' && p.id !== 'starter' && !p.remoteHostId).map((p) => ({ id: p.id, name: p.name })))).catch(() => {});
    const id = setInterval(() => { loadCloud(); loadDevices(); }, 20000); return () => clearInterval(id);
  }, []);
  // Abas (substituem a pilha de cards e o antigo toggle server/client).
  const [tab, setTab] = useState<'cloud' | 'host' | 'connect'>(isWeb ? 'cloud' : 'host');
  // "Procurar outras instâncias do Maestrus" — OFF por padrão. Liga a descoberta
  // automática de máquinas da mesma conta. Persistido no main (disco).
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

  // Status online AO VIVO: a lista de dispositivos vem do banco (last_seen, que
  // fica obsoleto e mostra host ligado como "offline"). Cruzamos com a presença
  // real do relay (client.hosts) e com o host local ligado.
  const liveHostIds = new Set<string>(((client as any).hosts || []).map((h: any) => h.deviceId));
  function devOnline(d: { device_id: string; online: boolean }) {
    return d.online || liveHostIds.has(d.device_id);
  }
  async function deleteDevice(deviceId: string) {
    if (!window.confirm(t('remote.devRemoveConfirm'))) return;
    setDevices((ds) => ds.filter((d) => d.device_id !== deviceId)); // otimista
    try { await (window.maestrus.cloud as any).deviceDelete?.(deviceId); } catch {}
    loadDevices();
  }

  async function activateCloud() {
    if (!activateId) return;
    setActivating(true); setError(null);
    try {
      const r = await window.maestrus.cloud.cloudStart?.(activateId, true);
      if (r && r.ok) { setActivateId(''); await loadCloud(); }
      else if (r && r.error === 'cloud_required') goPro();
      else setError((r && r.error) || t('remote.errGeneric'));
    } finally { setActivating(false); }
  }
  async function openCloud(s: CloudSession) {
    setCloudBusy(s.project_id);
    try {
      if (s.status === 'paused') { await window.maestrus.cloud.cloudResume?.(s.project_id); await loadCloud(); }
      const r = await window.maestrus.cloud.openCloud?.(s.device_id, s.name);
      if (r && r.ok) onConnected?.();
      else if (r && (r.error === 'cloud_required')) goPro();
    } finally { setCloudBusy(null); }
  }
  async function pauseCloud(s: CloudSession) {
    setCloudBusy(s.project_id);
    try { await window.maestrus.cloud.cloudPause?.(s.project_id); await loadCloud(); } finally { setCloudBusy(null); }
  }
  async function stopCloud(s: CloudSession) {
    if (!window.confirm(t('cloud.confirmStop', { name: s.name }))) return;
    setCloudBusy(s.project_id);
    try { await window.maestrus.cloud.cloudStop?.(s.project_id); await loadCloud(); } finally { setCloudBusy(null); }
  }

  const tabs: { id: 'cloud' | 'host' | 'connect'; label: string; icon: any }[] = isWeb
    ? [{ id: 'cloud', label: t('remote.tabCloud'), icon: CloudCog }, { id: 'connect', label: t('remote.tabConnect'), icon: Smartphone }]
    : [
        { id: 'host', label: t('remote.tabHost'), icon: Server },
        { id: 'connect', label: t('remote.tabConnect'), icon: Smartphone },
        { id: 'cloud', label: t('remote.tabCloud'), icon: CloudCog },
      ];

  return (
    <div className="cloud-screen remote-web-screen">
      <div className="cloud-grid" />
      <div className="remote-stack remote-web">

        <div className="remote-web-head">
          <h1>{t('remote.screenTitle')}</h1>
          <p>{t('remote.screenSub')}</p>
        </div>

        {/* ABAS */}
        <div className="remote-tabs span-2" role="tablist">
          {tabs.map((tb) => (
            <button key={tb.id} role="tab" aria-selected={tab === tb.id}
              className={`remote-tab ${tab === tb.id ? 'active' : ''}`} onClick={() => setTab(tb.id)}>
              <tb.icon size={15} /> {tb.label}
            </button>
          ))}
        </div>

        {/* ── ESTA MÁQUINA (HOST) ────────────────────────────────────────── */}
        {tab === 'host' && !isWeb && (
          <div className="cloud-card remote-card span-2">
            <div className="remote-head">
              <Server size={26} />
              <div>
                <div className="remote-title">{t('remote.title')}</div>
                <div className="remote-sub">{t('remote.subtitle')}</div>
              </div>
              {account && (
                <Switch on={host.running} busy={busy} onToggle={() => (host.running ? disable() : enable())} />
              )}
            </div>
            <p className="remote-explain">{t('remote.explain')}</p>

            {!account ? (
              <div className="remote-warn">{t('remote.needCloud')}</div>
            ) : !host.running ? (
              <div className="remote-status">
                <span className="remote-dot" /><WifiOff size={14} />
                <span>{t('remote.hostOffHint')}</span>
              </div>
            ) : (
              <>
                <div className="remote-status">
                  <span className={`remote-dot ${host.status === 'online' ? 'on' : 'pending'}`} />
                  {host.status === 'online' ? <Wifi size={14} /> : <Loader2 size={13} className="spin" />}
                  <span>{t(`remote.status_${host.status}`)}</span>
                </div>
                <div className="remote-pair-row">
                  {!code ? (
                    <button className="cloud-submit" onClick={genCode} disabled={codeBusy}>
                      {codeBusy ? <Loader2 size={16} className="spin" /> : <><Smartphone size={15} /> {t('remote.genCode')}</>}
                    </button>
                  ) : (
                    <div className="remote-pair">
                      <div className="remote-qr"><QRCodeSVG value={code} size={148} includeMargin /></div>
                      <button className="remote-code" onClick={copy} title={t('common.copy')}>
                        <code>{code}</code>{copied ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      <div className="cloud-hint">{t('remote.codeHint')}</div>
                    </div>
                  )}
                </div>
                <div className="remote-how">
                  <div className="remote-how-title"><ShieldCheck size={13} /> {t('remote.howTitle')}</div>
                  <ol><li>{t('remote.how1')}</li><li>{t('remote.how2')}</li><li>{t('remote.how3')}</li></ol>
                  <div className="cloud-hint">{t('remote.security')}</div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── CONEXÕES (discovery + parear + dispositivos) ───────────────── */}
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

            {/* Parear por código */}
            {account && (
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
                      <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                        placeholder="XXXXXXXX" maxLength={12} style={{ fontFamily: 'var(--mono)', letterSpacing: 2 }} />
                    </label>
                    <button className="cloud-submit" onClick={connect} disabled={joining || !joinCode.trim()}>
                      {joining ? <Loader2 size={16} className="spin" /> : <><Link2 size={15} /> {t('remote.connect')}</>}
                    </button>
                    <div className="cloud-hint">{t('remote.connectExplain')}</div>
                  </>
                )}
              </div>
            )}

            {/* Conectar ao MEU servidor (self-host) — independe de conta cloud */}
            {sh && (
              <div className="cloud-card remote-card span-2">
                <div className="remote-head">
                  <Server size={24} />
                  <div>
                    <div className="remote-title">{t('selfhostDesk.title') || 'Conectar ao meu servidor'}</div>
                    <div className="remote-sub">{t('selfhostDesk.sub') || 'Um Maestrus self-host seu (docker) — endereço + chave de acesso.'}</div>
                  </div>
                </div>
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
            )}

            {/* Dispositivos da conta */}
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

        {/* ── MAESTRUS ON CLOUD ──────────────────────────────────────────── */}
        {tab === 'cloud' && account && (
          <div className="cloud-card remote-card span-2">
            <div className="remote-head">
              <CloudCog size={26} />
              <div>
                <div className="remote-title">{t('cloud.cloudTitle')}</div>
                <div className="remote-sub">{t('cloud.cloudSub')}</div>
              </div>
            </div>
            <p className="remote-explain">{t('cloud.cloudExplain')}</p>
            {!isWeb && (
              <div className="cloud-activate">
                <select value={activateId} onChange={(e) => setActivateId(e.target.value)}>
                  <option value="">{t('cloud.pickProject')}</option>
                  {localProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="cloud-submit" disabled={!activateId || activating} onClick={activateCloud}>
                  {activating ? <Loader2 size={13} className="spin" /> : <CloudCog size={13} />} {t('cloud.activate')}
                </button>
              </div>
            )}
            {activating && <div className="remote-sub" style={{ marginTop: 6 }}>{t('cloud.activating')}</div>}
            {cloudSessions.length === 0 ? (
              <div className="remote-warn">{t('cloud.cloudEmpty')}</div>
            ) : (
              <div className="cloudsess-list">
                {cloudSessions.map((s) => (
                  <div key={s.project_id} className="cloudsess">
                    <div className="cloudsess-main">
                      <span className="cloudsess-name"><span className={`remote-dot ${s.status === 'running' ? 'on' : ''}`} /> {s.name}</span>
                      {s.preview_url && <a className="cloudsess-preview" href={s.preview_url} target="_blank" rel="noreferrer"><Globe size={12} /> {t('cloud.preview')}</a>}
                    </div>
                    <div className="cloudsess-actions">
                      <button className="btn-primary" disabled={cloudBusy === s.project_id} onClick={() => openCloud(s)}>
                        {cloudBusy === s.project_id ? <Loader2 size={12} className="spin" /> : <Link2 size={12} />} {s.status === 'paused' ? t('cloud.resume') : t('cloud.open')}
                      </button>
                      {s.status === 'running' && <button className="icon-btn" title={t('cloud.pause')} onClick={() => pauseCloud(s)}><PauseIcon size={14} /></button>}
                      <button className="icon-btn danger" title={t('cloud.stop')} onClick={() => stopCloud(s)}><WifiOff size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
