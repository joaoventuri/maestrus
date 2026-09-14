import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Server, Loader2, Wifi, WifiOff, Copy, Check, ShieldCheck, Smartphone, Link2, Trash2, Users, ChevronDown, ChevronRight, UserRound } from 'lucide-react';
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

  // Equipe: seu nome — presença na sala + assinatura "Nome:" nas mensagens.
  const [myName, setMyName] = useState('');
  useEffect(() => {
    (window.maestrus.app as any).getCloudSettings?.().then((r: any) => setMyName(String(r?.settings?.user_name || ''))).catch(() => {});
  }, []);
  function saveName(n: string) {
    setMyName(n);
    (window.maestrus.app as any).setCloudSetting?.('user_name', n.trim().slice(0, 40)).catch(() => {});
  }

  // ── Compartilhar conversas ESPECÍFICAS (convite com escopo) ──────────────
  const [shareOpen, setShareOpen] = useState(false);
  const [allProjects, setAllProjects] = useState<any[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [shareWrite, setShareWrite] = useState(true);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [grants, setGrants] = useState<any[]>([]);
  const [invScoped, setInvScoped] = useState(false);          // sou convidado com escopo → não compartilho nada
  const [shareStatus, setShareStatus] = useState<Record<string, any>>({});   // grant_id → entrega por e-mail
  const [sharedWithMe, setSharedWithMe] = useState<any[]>([]); // acessos que outros liberaram pro meu e-mail
  // Enviar por E-MAIL: se a pessoa tem conta no maestrus.cloud, o convite fica
  // na caixa dela e o app entra sozinho quando ela logar — nem link precisa.
  const [shareEmail, setShareEmail] = useState('');
  const [shareNote, setShareNote] = useState<string | null>(null);
  function loadShare() {
    // Projetos locais E remotos: no client, as conversas moram no host — o
    // pedido de grant é roteado pra lá pelo main (um link = uma máquina).
    window.maestrus.projects.list().then((ps: any[]) => setAllProjects((ps || []).filter((p) => p.id !== 'maestrus' && p.id !== 'starter' && !String(p.id).startsWith('remote:cloud-')))).catch(() => {});
    inviteApi?.grants?.().then((r: any) => setGrants(r?.grants || [])).catch(() => {});
    inviteApi?.shareStatus?.().then((r: any) => { if (r?.ok) { const m: Record<string, any> = {}; for (const sh of r.shares || []) if (sh.grant_id) m[sh.grant_id] = sh; setShareStatus(m); } }).catch(() => {});
  }
  function loadSharedWithMe() { inviteApi?.sharedWithMe?.().then((r: any) => setSharedWithMe(r?.shares || [])).catch(() => {}); }
  useEffect(() => { if (shareOpen) loadShare(); }, [shareOpen]);
  // Escopo por CONVERSA. `sel` guarda `pid` (projeto inteiro, forks futuros
  // inclusos), `pid#main` (só a principal) e/ou `pid#<convId>` (forks). Um
  // fork fora do escopo não aparece pro convidado — nem por id.
  const convIdsOf = (p: any) => ['main', ...(((p.conversations || []) as any[]).map((c) => String(c.id)))];
  const projState = (p: any): 'all' | 'partial' | 'none' => {
    if (sel.has(p.id)) return 'all';
    return [...sel].some((x) => x.startsWith(p.id + '#')) ? 'partial' : 'none';
  };
  const convOn = (p: any, cid: string) => sel.has(p.id) || sel.has(`${p.id}#${cid}`);
  const [pickOpen, setPickOpen] = useState<Record<string, boolean>>({});
  function toggleSel(id: string) {
    const p = allProjects.find((x) => x.id === id);
    setSel((cur) => {
      const n = new Set(cur);
      const st = p ? (n.has(id) ? 'all' : [...n].some((x) => x.startsWith(id + '#')) ? 'partial' : 'none') : (n.has(id) ? 'all' : 'none');
      for (const x of [...n]) if (x === id || x.startsWith(id + '#')) n.delete(x);
      if (st === 'none') n.add(id);
      return n;
    });
    setShareUrl(null);
  }
  function toggleConv(p: any, cid: string) {
    setSel((cur) => {
      const n = new Set(cur);
      const all = convIdsOf(p);
      if (n.has(p.id)) {                    // inteiro → explode em conversas e tira esta
        n.delete(p.id);
        for (const c of all) if (c !== cid) n.add(`${p.id}#${c}`);
        return n;
      }
      const key = `${p.id}#${cid}`;
      n.has(key) ? n.delete(key) : n.add(key);
      if (all.every((c) => n.has(`${p.id}#${c}`))) {   // todas marcadas → volta a ser o projeto inteiro
        for (const c of all) n.delete(`${p.id}#${c}`);
        n.add(p.id);
      }
      return n;
    });
    setShareUrl(null);
  }
  async function genShare() {
    if (!sel.size) return;
    setShareBusy(true); setError(null); setShareUrl(null);
    try {
      setShareNote(null);
      const r = await inviteApi?.createScoped?.({ projects: [...sel], write: shareWrite, email: shareEmail.trim() || undefined });
      if (r?.ok && r.url) {
        setShareUrl(r.url); refreshInvite(); loadShare();
        if (shareEmail.trim()) {
          setShareNote(r.emailSent ? t('team.emailSent').replace('{email}', shareEmail.trim())
            : r.emailError === 'email_not_found' ? t('team.emailNotFound')
            : t('team.emailFailed'));
        }
      }
      else setError(r?.error === 'mixed_hosts' ? t('team.shareOneHost')
        : r?.error === 'no_room' ? t('team.shareNoRoom')
        : t('invite.errCreate'));
    } finally { setShareBusy(false); }
  }
  // IA do grant (conta do time): dono configura/vê aqui mesmo.
  const [aiCfg, setAiCfg] = useState<any>(null);        // { grant, st?, flow?, code }
  async function openAiCfg(g: any) {
    const st = await inviteApi?.aiAdmin?.('status', g.id, g.hostId).catch(() => null);
    // Contas já logadas na máquina do host: reaproveitar em vez de logar de novo.
    const lp = await inviteApi?.aiAdmin?.('listProfiles', g.id, g.hostId).catch(() => null);
    setAiCfg({ grant: g, st, code: '', profiles: (lp?.profiles || []).filter((p: any) => p.email && !p.teamBound) });
  }
  async function aiBindExisting(profileId: string) {
    if (!aiCfg) return;
    const st = await inviteApi?.aiAdmin?.('bindExisting', aiCfg.grant.id, aiCfg.grant.hostId, profileId).catch(() => null);
    if (st?.ok) { setAiCfg({ ...aiCfg, st, profiles: (aiCfg.profiles || []).filter((p: any) => p.id !== profileId) }); loadShare(); }
  }
  async function aiLoginStart() {
    if (!aiCfg) return;
    const r = await inviteApi?.aiAdmin?.('loginStart', aiCfg.grant.id, aiCfg.grant.hostId).catch(() => null);
    if (r?.ok === false) { setAiCfg({ ...aiCfg, err: r.error }); return; }
    const flow = await inviteApi?.aiAdmin?.('loginState', aiCfg.grant.id, aiCfg.grant.hostId).catch(() => null);
    setAiCfg({ ...aiCfg, flow });
  }
  // Polling do fluxo enquanto ativo (URL aparece; done fecha).
  useEffect(() => {
    if (!aiCfg?.flow?.active) return;
    const iv = setInterval(async () => {
      const f = await inviteApi?.aiAdmin?.('loginState', aiCfg.grant.id, aiCfg.grant.hostId).catch(() => null);
      if (!f) return;
      if (f.done) {
        clearInterval(iv);
        const st = await inviteApi?.aiAdmin?.('status', aiCfg.grant.id, aiCfg.grant.hostId).catch(() => null);
        setAiCfg((c: any) => c ? { ...c, flow: null, st } : c);
        loadShare();
      } else setAiCfg((c: any) => c ? { ...c, flow: f } : c);
    }, 1500);
    return () => clearInterval(iv);
  }, [aiCfg?.flow?.active, aiCfg?.grant?.id]);
  async function aiSendCode() {
    if (!aiCfg?.code?.trim()) return;
    await inviteApi?.aiAdmin?.('loginCode', aiCfg.grant.id, aiCfg.grant.hostId, aiCfg.code.trim()).catch(() => {});
  }
  async function aiUnbind(profileId?: string) {
    const st = await inviteApi?.aiAdmin?.('unbind', aiCfg.grant.id, aiCfg.grant.hostId, profileId || '').catch(() => null);
    const lp = await inviteApi?.aiAdmin?.('listProfiles', aiCfg.grant.id, aiCfg.grant.hostId).catch(() => null);
    setAiCfg((c: any) => c ? { ...c, st, profiles: (lp?.profiles || []).filter((p: any) => p.email && !p.teamBound) } : c);
    loadShare();
  }

  async function revokeGrant(g: any) {
    const r = await inviteApi?.revokeGrant?.(g.id, g.hostId).catch((e: any) => ({ ok: false, error: String(e?.message || e) }));
    if (r && r.ok === false) { setError(r.error || t('remote.errGeneric')); loadShare(); return; }
    setGrants((gs) => gs.filter((x) => x.id !== g.id));
    loadShare();
  }
  // Grants do host vêm com ids CURTOS; a lista local usa remote:<host>:<id>.
  function nameOf(pid: string) {
    const i = pid.indexOf('#');
    const base = i > 0 ? pid.slice(0, i) : pid; const conv = i > 0 ? pid.slice(i + 1) : null;
    const hit = allProjects.find((p) => p.id === base || String(p.id).endsWith(':' + base));
    const name = hit?.name || base.slice(0, 8);
    if (!conv) return name;
    if (conv === 'main') return `${name} · ${t('team.shareMain')}`;
    const c = ((hit?.conversations || []) as any[]).find((x) => String(x.id) === conv);
    return `${name} · ${c?.title || conv.slice(0, 6)}`;
  }

  function refreshInvite() {
    inviteApi?.state?.().then((s: any) => {
      setInvHost(!!s?.host);
      setInvClient(!!s?.client);
      setInvScoped(!!s?.client?.scoped);
    }).catch(() => {});
  }

  useEffect(() => {
    window.maestrus.cloud.account().then(setAccount);
    window.maestrus.remote.hostState().then(setHost);
    window.maestrus.remote.clientState().then(setClient);
    refreshInvite(); loadSharedWithMe();
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
  // "Usar como Client" no primeiro uso → esta tela É o passo seguinte: abre
  // direto em Conectar (código/QR), não na aba de virar servidor.
  useEffect(() => {
    (window.maestrus.app as any).getMode?.().then((m: any) => { if (m?.mode === 'client') setTab('connect'); }).catch(() => {});
  }, []);
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

        {/* Equipe: um nome por pessoa. É o que transforma a sala em time —
            presença com nome e cada mensagem assinada por quem escreveu. */}
        <div className="remote-name span-2">
          <UserRound size={15} />
          <input value={myName} onChange={(e) => saveName(e.target.value)}
            placeholder={t('team.yourName')} maxLength={40} spellCheck={false} />
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

                {Array.isArray((host as any).peers) && (host as any).peers.length > 0 && (
                  <div className="remote-peers">
                    <Users size={13} />
                    <span>{t('team.inRoom')}: {(host as any).peers.map((p: any) => (p.email && p.name) ? `${p.name} (${p.email})` : (p.email || p.name || p.deviceId.slice(0, 6))).join(', ')}</span>
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

        {/* ── Compartilhar SÓ conversas específicas (equipe via navegador) ── */}
        {tab === 'host' && !invScoped && (
          <details className="remote-advanced span-2" open={shareOpen} onToggle={(e: any) => setShareOpen(e.currentTarget.open)}>
            <summary>
              <ChevronDown size={14} className="remote-adv-chev" />
              <Users size={14} /> {t('team.shareTitle')}
            </summary>
            <div className="remote-adv-body">
              <p className="remote-explain" style={{ margin: 0 }}>{t('team.shareSub')}</p>

              {!isWeb && !host.running && !(host as any).alwaysOn && (
                <div className="cloud-hint" style={{ color: 'var(--accent)' }}>{t('team.hostOff')}</div>
              )}
              <div className="share-pick">
                <div className="share-pick-h">{t('team.sharePick')}</div>
                <div className="cloud-hint" style={{ marginTop: 0, marginBottom: 6 }}>{t('team.sharePickHint')}</div>
                {allProjects.map((p) => {
                  const st = projState(p);
                  const convs: any[] = p.conversations || [];
                  const open = pickOpen[p.id] ?? (st === 'partial');
                  return (
                    <div key={p.id}>
                      <div className={`share-item ${st !== 'none' ? 'on' : ''} ${st === 'partial' ? 'partial' : ''}`} onClick={() => toggleSel(p.id)}>
                        {convs.length > 0 ? (
                          <button className="share-item-chev" onClick={(e) => { e.stopPropagation(); setPickOpen((o) => ({ ...o, [p.id]: !open })); }} title={`${convs.length + 1}`}>
                            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </button>
                        ) : null}
                        <span className="share-item-name">{p.name}{convs.length > 0 && <em style={{ color: 'var(--text-dim)', fontStyle: 'normal' }}> · {st === 'partial' ? t('team.sharePartial') : `${convs.length + 1}`}</em>}</span>
                        <MiniSwitch on={st !== 'none'} />
                      </div>
                      {open && convs.length > 0 && (
                        <>
                          <div className={`share-item conv ${convOn(p, 'main') ? 'on' : ''}`} onClick={() => toggleConv(p, 'main')}>
                            <span className="share-item-name">{t('team.shareMain')}</span>
                            <MiniSwitch on={convOn(p, 'main')} />
                          </div>
                          {convs.map((c: any) => (
                            <div key={c.id} className={`share-item conv ${convOn(p, String(c.id)) ? 'on' : ''}`} onClick={() => toggleConv(p, String(c.id))}>
                              <span className="share-item-name">{c.title}</span>
                              <MiniSwitch on={convOn(p, String(c.id))} />
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  );
                })}
                {allProjects.length === 0 && <div className="cloud-hint">—</div>}
              </div>

              <label className="cloud-field" style={{ maxWidth: 320 }}>
                <span>{t('team.emailLabel')}</span>
                <input value={shareEmail} onChange={(e) => setShareEmail(e.target.value)}
                  placeholder="colega@empresa.com" type="email" spellCheck={false} />
              </label>

              <div className="share-perm">
                <button className={`remote-tab ${shareWrite ? 'active' : ''}`} onClick={() => { setShareWrite(true); setShareUrl(null); }}>{t('team.shareWrite')}</button>
                <button className={`remote-tab ${!shareWrite ? 'active' : ''}`} onClick={() => { setShareWrite(false); setShareUrl(null); }}>{t('team.shareRead')}</button>
              </div>

              {shareUrl && (
                <div className="remote-pair">
                  <div className="remote-qr"><QRCodeSVG value={shareUrl} size={148} includeMargin /></div>
                  <button className="remote-code long" onClick={() => { navigator.clipboard?.writeText(shareUrl); setShareCopied(true); setTimeout(() => setShareCopied(false), 1500); }}>
                    <code>{shareUrl.slice(0, 34)}…</code>{shareCopied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <div className="cloud-hint">{t('team.shareLink')}</div>
                </div>
              )}
              {shareNote && <div className="cloud-hint" style={{ color: 'var(--accent)' }}>{shareNote}</div>}
              {/* O botão fica SEMPRE visível (com e-mail ele também envia): antes
                  ele sumia depois de gerar o link, e digitar o e-mail "não fazia
                  nada" porque não havia mais ação na tela. */}
              <button className="cloud-submit" style={{ maxWidth: 320 }} onClick={genShare} disabled={shareBusy || !sel.size} title={!sel.size ? t('team.shareNone') : ''}>
                {shareBusy ? <Loader2 size={16} className="spin" />
                  : shareEmail.trim() ? <><Link2 size={15} /> {t('team.shareGenEmail')}</>
                  : <><Link2 size={15} /> {t('team.shareGen')}</>}
              </button>

              {aiCfg && (
                <div className="share-ai-cfg">
                  <div className="share-pick-h">{t('team.aiCfgTitle')}: {(aiCfg.grant.p || []).slice(0, 2).map(nameOf).join(', ')}</div>
                  {aiCfg.flow?.active ? (
                    <>
                      <div className="cloud-hint">{t('team.aiFlowHint')}</div>
                      {aiCfg.flow.url && (
                        <button className="cloud-logout" style={{ width: 'auto' }} onClick={() => window.open(aiCfg.flow.url, '_blank')}>
                          <Link2 size={13} /> {t('team.aiOpenLink')}
                        </button>
                      )}
                      <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 420 }}>
                        <input className="share-ai-code" value={aiCfg.code} spellCheck={false}
                          onChange={(e) => setAiCfg({ ...aiCfg, code: e.target.value })}
                          placeholder={t('team.aiPasteCode')} />
                        <button className="cloud-submit" style={{ width: 'auto', marginTop: 0, padding: '8px 14px' }} onClick={aiSendCode} disabled={!aiCfg.code?.trim()}>
                          {t('team.aiSend')}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      {(aiCfg.st?.accounts || []).length === 0
                        ? <div className="cloud-hint">{t('team.aiHost')}</div>
                        : (
                          <div className="share-ai-pool">
                            {(aiCfg.st.accounts as any[]).map((a) => (
                              <div key={a.id} className="share-grant">
                                <span className="share-grant-label"><UserRound size={13} /> {a.email || '—'}{!a.loggedIn && <em> · {t('team.aiPending')}</em>}</span>
                                <button className="dev-del" title={t('team.aiRemove')} onClick={() => aiUnbind(a.id)}><Trash2 size={13} /></button>
                              </div>
                            ))}
                            {(aiCfg.st.accounts as any[]).length > 1 && <div className="cloud-hint">{t('team.aiPoolHint')}</div>}
                          </div>
                        )}
                      {aiCfg.profiles?.length > 0 && (
                        <div className="share-ai-reuse">
                          <div className="share-pick-h">{t('team.aiReuse')}</div>
                          {aiCfg.profiles.map((p: any) => (
                            <button key={p.id} className="cloud-logout" style={{ width: 'auto', marginTop: 0 }} onClick={() => aiBindExisting(p.id)}>
                              <UserRound size={13} /> {p.email}
                            </button>
                          ))}
                        </div>
                      )}
                      <button className="cloud-submit" style={{ maxWidth: 320 }} onClick={aiLoginStart}>
                        <UserRound size={14} /> {(aiCfg.st?.accounts || []).length ? t('team.aiAddNew') : t('team.aiCfgConnect')}
                      </button>
                    </>
                  )}
                  <button className="m-link" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 12 }} onClick={() => setAiCfg(null)}>{t('common.close')}</button>
                </div>
              )}
              {grants.length > 0 && (
                <div className="share-grants">
                  <div className="share-pick-h">{t('team.shareActive')}</div>
                  {grants.map((g) => (
                    <div key={g.id} className="share-grant">
                      <span className="share-grant-label">
                        {g.email ? <strong>{g.email} · </strong> : null}
                        {(g.p || []).slice(0, 3).map(nameOf).join(', ')}{(g.p || []).length > 3 ? ` +${g.p.length - 3}` : ''}
                        <em> · {g.w ? t('team.shareWrite') : t('team.shareRead')} · {g.aiBound ? (g.aiCount > 1 ? t('team.aiPoolShort', { n: g.aiCount }) : t('team.aiOwn')) : t('team.aiHostShort')}
                          {g.online ? <> · <span style={{ color: 'var(--accent)' }}>{t('team.online')}</span></> : g.email ? <> · {shareStatus[g.id]?.claimed_at ? t('team.delivered') : t('team.notOpened')}</> : null}
                          {g.e ? <> · {t('team.expires', { date: new Date(g.e).toLocaleDateString() })}</> : null}</em>
                      </span>
                      <button className="dev-del" title={t('team.aiCfg')} onClick={() => openAiCfg(g)}><UserRound size={13} /></button>
                      <button className="dev-del" title={t('team.shareRevoke')} onClick={() => revokeGrant(g)}><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        )}

        {/* ── CONECTAR ────────────────────────────────────────────────────── */}
        {tab === 'connect' && (
          <>
            {account && sharedWithMe.length > 0 && (
              <div className="cloud-card remote-card span-2">
                <div className="remote-head">
                  <Users size={24} />
                  <div>
                    <div className="remote-title">{t('team.sharedWithMe')}</div>
                    <div className="remote-sub">{t('team.sharedWithMeSub')}</div>
                  </div>
                </div>
                {sharedWithMe.map((sh: any) => (
                  <div key={sh.id} className="remote-status" style={{ justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <strong>{sh.owner_name || sh.owner_email}</strong>
                      <span style={{ opacity: .55, marginLeft: 6 }}>{sh.host_name || ''}</span>
                    </span>
                    <button className="cloud-submit" style={{ width: 'auto', padding: '6px 14px' }}
                      onClick={async () => { const r = await inviteApi?.joinShare?.(sh.id).catch(() => null); if (r?.ok) { refreshInvite(); onConnected?.(); } else setError(t('invite.errCreate')); }}>
                      <Link2 size={14} /> {t('team.enter')}
                    </button>
                  </div>
                ))}
              </div>
            )}
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

// Switch pequeno (linhas de lista) — checkbox cru destoava do resto do app.
function MiniSwitch({ on }: { on: boolean }) {
  return <span className={`m-switch mini ${on ? 'on' : ''}`} role="switch" aria-checked={on}><span className="m-switch-knob" /></span>;
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
