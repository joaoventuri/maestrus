import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { marked } from 'marked';
import { Share, X, QrCode, User, ExternalLink, LogOut, Sparkles, Mic, AudioLines, ChevronLeft, ChevronRight, ChevronDown, MessageSquare, GitBranch, Settings, ArrowUp, Kanban as KanbanIcon, CloudCog, Check, Cpu, Brain, ShieldOff, ShieldCheck, ShieldAlert, Shield, Square, KeyRound, ArrowRight, Trash2, AlertCircle, Bell, RefreshCw, Server, Copy, Power, HardDrive, Paperclip, Camera } from 'lucide-react';
import MobileKanban from './MobileKanban';
import jsQR from 'jsqr';
import Logo from '../components/Logo';
import ConnectionStatus from '../components/ConnectionStatus';

// Cache de histórico por projeto — reabrir mostra na hora e atualiza em 2º plano.
const mHistCache = new Map<string, any[]>();
import { useT, LANGS } from '../lib/i18n';
import { getModelInfo, costTier, modelsForEngine, defaultModelForEngine } from '../lib/model-info';
import { EngineMark } from '../components/BrandMarks';
import { filterCommands } from '../lib/slash-commands';
import { ttsSpeak, ttsCancel, ttsSupported, getSttEngine, sttSupported, unlockAudio, extractSentences, resetSentenceSplitter } from '../lib/voice';
// Lazy: Three.js só carrega quando o usuário abre o Jarvis (mantém o PWA leve).
const JarvisMode = lazy(() => import('../components/JarvisMode'));
import type { VoiceState } from '../components/JarvisMode';
import { iconForTool, labelForTool } from '../lib/tool-icons';
import { noteEvent, setActiveProject, getSnapshot as getActivity, markRead, useActivityMap } from '../lib/activity-store';
import ActivityIndicator from '../components/ActivityDot';
import CodexCliConnect from '../components/CodexCliConnect';

marked.setOptions({ gfm: true, breaks: true });
const md = (s: string) => {
  try { return marked.parse(String(s || '')) as string; } catch { return s; }
};
const M = () => (window as any).maestrus;

// Banner de instalação da PWA. Android/Chrome: botão nativo (beforeinstallprompt).
// iOS: instrução (não há API). Some quando já instalado (standalone) ou dispensado.
function InstallBanner({ t }: any) {
  const [deferred, setDeferred] = useState<any>(null);
  const [show, setShow] = useState(false);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
    if (standalone) return;                              // já instalado → não mostra
    if (sessionStorage.getItem('m_install_x')) return;   // dispensado nesta sessão
    if (isIOS) { setShow(true); return; }                // iOS: instrução
    const onBip = (e: any) => { e.preventDefault(); setDeferred(e); setShow(true); };
    const onInstalled = () => { setShow(false); };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onBip); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  if (!show) return null;
  function dismiss() { sessionStorage.setItem('m_install_x', '1'); setShow(false); }
  async function install() { if (!deferred) return; deferred.prompt(); const r = await deferred.userChoice.catch(() => null); if (r && r.outcome === 'accepted') setShow(false); }
  return (
    <div className="m-install">
      <span className="m-install-ic"><Logo size={22} showText={false} /></span>
      <div className="m-install-txt">
        <b>{t('mobile.installTitle')}</b>
        <span>{isIOS ? t('mobile.installIOS') : t('mobile.installDesc')}</span>
      </div>
      {isIOS ? <Share size={20} className="m-install-share" /> : <button className="m-install-btn" onClick={install}>{t('mobile.installBtn')}</button>}
      <button className="m-install-x" onClick={dismiss} aria-label="x"><X size={16} /></button>
    </div>
  );
}

function LangBar() {
  const { lang, setLang } = useT();
  return (
    <div className="m-langs">
      {LANGS.map((l) => (
        <button key={l.id} className={l.id === lang ? 'on' : ''} onClick={() => setLang(l.id)}>{l.flag}</button>
      ))}
    </div>
  );
}

export default function MobileApp() {
  const { t } = useT();
  const [account, setAccount] = useState<any>(null);
  const [client, setClient] = useState<any>({ connected: false, status: 'idle', hostName: null });
  const [projects, setProjects] = useState<any[]>([]);
  const [active, setActive] = useState<any>(null);
  const [booted, setBooted] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [showKanban, setShowKanban] = useState(false);

  // everConnected: já houve uma sessão remota viva nesta carga do app. Enquanto
  // true, uma queda transitória NÃO joga o usuário de volta pra tela de conexão
  // (mostra um overlay "reconectando" em cima da tela atual). Resetado só num
  // disconnect/logout explícito.
  const everConnectedRef = useRef(false);
  useEffect(() => { if (client.connected) everConnectedRef.current = true; }, [client.connected]);

  useEffect(() => {
    (async () => {
      let a = await M().cloud.account().catch(() => null);
      // SSO: sem conta salva mas com sessão do site ativa (cadastro/login que
      // redirecionou pro /app) → entra logado, sem pedir login de novo.
      if (!a) { try { const s = await M().cloud.sessionLogin?.(); if (s && s.ok && s.account) a = s.account; } catch {} }
      setAccount(a); setBooted(true);
      // Mesmo init flow do cold start: pareamento salvo (15d) + fallback discovery.
      if (a) {
        const r = M().remote.ensureConnected || M().remote.resume;
        r?.().catch(() => {});
      }
    })();
    M().remote.clientState().then(setClient);
    const off = M().remote.onClientState((s: any) => { setClient(s); if (s.connected) M().remote.refreshProjects().then(setProjects); });
    return off;
  }, []);

  // Atualiza lista quando o host notifica mudança de modelo/settings de um projeto
  useEffect(() => {
    const off = M().projects.onChanged?.(() => {
      M().projects.list().then((list: any[]) => {
        setProjects(list);
        setActive((cur: any) => {
          if (!cur) return cur;
          const fresh = list.find((p: any) => p.id === cur.id);
          return fresh ? { ...cur, model: fresh.model, engine: fresh.engine, thinkingMode: fresh.thinkingMode, permissionMode: fresh.permissionMode } : cur;
        });
      });
    });
    return off;
  }, []);

  // Status global: UM listener que sobrevive ao voltar pra lista (o Chat
  // desmonta, mas o rastreamento continua). Alimenta o activity-store.
  useEffect(() => {
    const off = M().claude.onEvent((evt: any) => noteEvent(evt));
    return off;
  }, []);
  useEffect(() => { setActiveProject(active ? active.id : null); }, [active]);

  const logout = () => { everConnectedRef.current = false; M().cloud.logout(); M().remote.disconnect(); setAccount(null); setClient({ connected: false, status: 'idle', hostName: null }); setShowAccount(false); setActive(null); };
  const disconnect = () => { everConnectedRef.current = false; M().remote.disconnect(); setActive(null); setProjects([]); };

  // Tentativa de conexão em curso (boot/resume) → mostra spinner, não a tela de
  // conexão (evita o flash da tela de "remote control" durante o resume).
  const attempting = client.status === 'connecting' || client.status === 'starting';
  // Queda transitória depois de já ter conectado → mantém a tela atual e sobe um
  // overlay "reconectando" (o ensureAlive/scheduleReconnect cuida da volta).
  const reconnecting = everConnectedRef.current && !client.connected;

  let screen;
  if (!booted) screen = <div className="m-center"><div className="m-spin" /></div>;
  else if (!account) screen = <Login t={t} onDone={setAccount} />;
  else if (!client.connected && !everConnectedRef.current && attempting) screen = <div className="m-center"><div className="m-spin" /></div>;
  else if (!client.connected && !everConnectedRef.current) screen = <Connect t={t} onAccount={() => setShowAccount(true)} onLogout={logout} />;
  else if (showKanban) screen = <MobileKanban onBack={() => setShowKanban(false)} projects={projects} />;
  else if (active) screen = <Chat t={t} project={active} onBack={() => setActive(null)}
    connected={client.connected}
    onPatch={(patch: any) => { setActive((p: any) => ({ ...p, ...patch })); setProjects((ps) => ps.map((p) => p.id === active.id ? { ...p, ...patch } : p)); }} />;
  else screen = <Projects t={t} projects={projects} host={client.hostName} onPick={setActive} onAccount={() => setShowAccount(true)}
    onKanban={() => setShowKanban(true)}
    onRefresh={() => M().remote.refreshProjects().then(setProjects)}
    onDisconnect={disconnect} />;
  return <>
    {screen}
    {reconnecting && (
      <div className="m-reconnect" role="status" aria-live="polite">
        <div className="m-spin sm" /><span>{t('mobile.reconnecting')}</span>
        <button className="m-resync-btn" onClick={() => {
          const r = (M().remote as any).ensureConnected || M().remote.reconnect;
          r?.().then(() => M().remote.refreshProjects().then(setProjects)).catch(() => {});
        }}>{t('mobile.resync')}</button>
      </div>
    )}
    {showAccount && account && <Account t={t} onClose={() => setShowAccount(false)} onLogout={logout} />}
    {!active && !showAccount && <InstallBanner t={t} />}
  </>;
}

// ─── Web Push (PWA) ──────────────────────────────────────────────────────────
// Toggle "Notificações push" na tela de conta. Só aparece pra conta do Maestrus
// Cloud (nunca em self-host — lá não há backend de push) e em browsers com
// suporte. iOS exige a PWA instalada (standalone) — mostramos a dica.
function urlB64ToU8(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function PushToggle({ t, account }: any) {
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isSelfhost = !!(account?.selfhost || (M() as any)?.isSelfhost) || !M()?.push;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  const iosNeedsInstall = isIOS && !standalone;
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!supported || isSelfhost) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((s) => setOn(!!s))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!supported || isSelfhost || !account) return null;

  async function toggle() {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const reg = await navigator.serviceWorker.ready;
      if (on) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          const ep = sub.endpoint;
          await sub.unsubscribe().catch(() => {});
          await M().push?.unsubscribe?.(ep)?.catch?.(() => {});
        }
        setOn(false);
      } else {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { setErr(t('mobile.pushDenied')); return; }
        const v: any = await M().push?.vapid?.();
        if (!v?.ok || !v.key) { setErr(t('mobile.pushError')); return; }
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(v.key) as any });
        const r: any = await M().push?.subscribe?.(sub.toJSON());
        if (!r?.ok) { await sub.unsubscribe().catch(() => {}); setErr(t('mobile.pushError')); return; }
        setOn(true);
      }
    } catch { setErr(t('mobile.pushError')); }
    finally { setBusy(false); }
  }

  return (
    <div className="m-acc-card m-push">
      <div className="m-acc-kv">
        <span><Bell size={13} /> {t('mobile.pushTitle')}</span>
        <b>{on ? <Check size={14} /> : ''}</b>
      </div>
      <div className="m-set-note">{t('mobile.pushDesc')}</div>
      {iosNeedsInstall ? (
        <div className="m-set-note">{t('mobile.pushIOSHint')}</div>
      ) : (
        <button className="m-acc-btn" onClick={toggle} disabled={busy}>
          <Bell size={16} /> {busy ? '…' : (on ? t('mobile.pushDisable') : t('mobile.pushEnable'))}
        </button>
      )}
      {err && <div className="m-err">{err}</div>}
    </div>
  );
}

function fmtBytesM(b: number): string {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b || 0) + ' B';
}
function fmtUptimeM(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}
function memLimitMBm(lim?: string): number {
  if (!lim) return 0;
  const mm = String(lim).trim().match(/^([\d.]+)\s*([gGmM])?/);
  if (!mm) return 0;
  const n = parseFloat(mm[1]);
  return (mm[2] || 'g').toLowerCase() === 'g' ? Math.round(n * 1024) : Math.round(n);
}

// Cartão da instância cloud 24/7 do usuário (mesmo container do CloudScreen).
function ContainerCard({ t, acc }: any) {
  const [info, setInfo] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    M().cloud.containerStatus?.().then((r: any) => { if (alive && r && r.ok) setInfo(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!info || !info.exists || !info.container) return null;
  const c = info.container;
  const live = c.live || null;
  const st = c.status;
  const pillCls = st === 'running' ? 'running' : (st === 'provisioning' || st === 'starting') ? 'starting' : st === 'error' ? 'error' : 'suspended';
  const pillLabel = st === 'running' ? (t('cloud.containerRunning') || 'Rodando')
    : (st === 'provisioning' || st === 'starting') ? (t('cloud.containerStarting') || 'Iniciando…')
    : st === 'error' ? (t('cloud.containerError') || 'Erro')
    : st === 'suspended' ? (t('cloud.containerSuspended') || 'Suspenso') : st;
  const addr = `${c.subdomain}.maestrus.cloud`;
  const limMB = memLimitMBm(c.mem_limit);
  const memLimLabel = limMB >= 1024 ? (limMB / 1024).toFixed(0) + ' GB' : limMB + ' MB';
  const quota = acc?.plan?.quota_bytes || 0;
  function copy() { navigator.clipboard?.writeText(addr).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }
  return (
    <div className="m-acc-card m-cont">
      <div className="m-cont-head">
        <span className="m-cont-glyph"><Server size={17} /></span>
        <span className={`m-cont-pill ${pillCls}`}><span className="m-cont-dot" /> {pillLabel}</span>
      </div>
      <button className="m-cont-addr" onClick={copy}>
        <span>{addr}</span>{copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <div className="m-acc-kv"><span>{t('cloud.plan')}</span><b style={{ textTransform: 'capitalize' }}>{c.plan}</b></div>
      <div className="m-acc-kv"><span><Power size={13} /> {t('cloud.containerUptime') || 'No ar há'}</span><b>{live ? fmtUptimeM(live.uptime) : (t('cloud.containerStarting') || 'Iniciando…')}</b></div>
      <div className="m-acc-kv"><span><HardDrive size={13} /> {t('cloud.containerStorage') || 'Armazenamento'}</span><b>{fmtBytesM(acc?.usedBytes || 0)}{quota > 0 ? ` / ${fmtBytesM(quota)}` : ''}</b></div>
      <div className="m-acc-kv"><span><Cpu size={13} /> {t('cloud.containerMemory') || 'Memória'}</span><b>{live ? `${live.memoryMB} MB${limMB > 0 ? ` / ${memLimLabel}` : ''}` : '—'}</b></div>
      <button className="m-acc-btn" style={{ marginTop: 12 }} onClick={() => window.open(c.url, '_blank')}>
        <ExternalLink size={16} /> {t('cloud.containerOpen') || 'Abrir no navegador'}
      </button>
    </div>
  );
}

function Account({ t, onClose, onLogout }: any) {
  const [acc, setAcc] = useState<any>(null);
  useEffect(() => {
    M().cloud.account().then(setAcc);
    M().cloud.validate().then((r: any) => { if (r && r.ok && r.account) setAcc(r.account); }).catch(() => {});
  }, []);
  return (
    <div className="m-screen m-account">
      <header className="m-top">
        <button className="m-link" onClick={onClose} aria-label="Close"><ChevronLeft size={22} /></button>
        <Logo size={20} textSize={16} />
        <span style={{ width: 28 }} />
      </header>
      <div className="m-acc-body">
        <div className="m-acc-card">
          <div className="m-acc-avatar"><User size={26} /></div>
          <div className="m-acc-name">{acc?.name || acc?.email || '—'}</div>
          <div className="m-acc-email">{acc?.email}</div>
          <div className="m-acc-kv"><span>{t('mobile.plan')}</span><b>{acc?.plan?.name || '—'}</b></div>
        </div>
        <ContainerCard t={t} acc={acc} />
        <PushToggle t={t} account={acc} />
        <button className="m-acc-btn" onClick={() => M().cloud.openPanel()}><ExternalLink size={16} /> {t('mobile.managePlan')}</button>
        <button className="m-acc-btn danger" onClick={onLogout}><LogOut size={16} /> {t('mobile.signOut')}</button>
      </div>
    </div>
  );
}

function Login({ t, onDone }: any) {
  const [email, setEmail] = useState(''); const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    const r = await M().cloud.login(email.trim(), pass);
    if (r.ok && r.account) onDone(r.account); else setErr(t('mobile.badCreds'));
    setBusy(false);
  }
  return (
    <div className="m-screen m-auth">
      <LangBar />
      <Logo size={56} textSize={40} />
      <p className="m-sub">{t('mobile.tagline')}</p>
      <form onSubmit={submit} className="m-form">
        {err && <div className="m-err">{err}</div>}
        <input type="email" placeholder={t('mobile.email')} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
        <input type="password" placeholder={t('mobile.password')} value={pass} onChange={(e) => setPass(e.target.value)} required autoComplete="current-password" />
        <button disabled={busy}>{busy ? t('mobile.signingIn') : t('mobile.signin')}</button>
      </form>
      <button className="m-link" onClick={() => window.open('https://maestrus.cloud/register.php', '_blank')}>
        {t('mobile.noAccount')} <u>{t('mobile.createAccount')}</u>
      </button>
    </div>
  );
}

function QrScanner({ t, onResult, onClose }: any) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null; let raf = 0; let stopped = false;
    const canvas = document.createElement('canvas');
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = videoRef.current!; (v as any).srcObject = stream; await v.play();
        const tick = () => {
          if (stopped) return;
          if (v.readyState >= 2 && v.videoWidth) {
            canvas.width = v.videoWidth; canvas.height = v.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height);
            if (code && code.data) { if (navigator.vibrate) navigator.vibrate(40); onResult(code.data.trim()); return; }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e: any) { setErr(e?.message || 'Câmera indisponível'); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((tk) => tk.stop()); };
  }, []);
  return (
    <div className="m-scan">
      <video ref={videoRef} playsInline muted className="m-scan-video" />
      <div className="m-scan-frame" />
      <div className="m-scan-hint">{t('mobile.scanHint')}</div>
      {err && <div className="m-err m-scan-err">{err}</div>}
      <button className="m-scan-close" onClick={onClose}><X size={22} /></button>
    </div>
  );
}

function Connect({ t, onAccount, onLogout }: any) {
  const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [scan, setScan] = useState(false);
  const [cloud, setCloud] = useState<any[]>([]); const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  // Descoberta por CONTA (igual o desktop): procura as máquinas/instância da
  // conta no relay e conecta sozinho. QR/código vira só alternativa.
  const [discovering, setDiscovering] = useState(true);
  const [manual, setManual] = useState(false);

  async function discover() {
    setDiscovering(true); setErr('');
    try {
      const r = await (M().remote.discover?.() ?? M().remote.ensureConnected?.());
      // se achou/conectou, o onClientState do pai troca de tela sozinho.
      if (!r || (r.ok === false) || (r.found === 0)) setManual(true);
    } catch { setManual(true); }
    finally { setDiscovering(false); }
  }
  useEffect(() => { discover(); M().cloud.cloudList?.().then((r: any) => { if (r && r.ok) setCloud(r.sessions || []); }).catch(() => {}); }, []);

  async function openCloud(s: any) {
    setCloudBusy(s.project_id); setErr('');
    if (s.status === 'paused') { await M().cloud.cloudResume?.(s.project_id); }  // descongela
    const r = await M().remote.connectHost?.(s.device_id, s.name);
    if (!r || !r.ok) setErr(t('mobile.badCode'));
    setCloudBusy(null);
  }
  // O código de conta é curto e maiúsculo; o convite é base64url e maiúsculo
  // QUEBRA ele. Normaliza pelo formato, não pelo hábito.
  function normCode(v: string) {
    const raw = String(v || '').trim();
    return (raw.length > 14 || /^maestrus:\/\//i.test(raw)) ? raw : raw.toUpperCase();
  }
  async function go(c?: string) {
    const val = normCode(c ?? code); if (!val) return; setBusy(true); setErr('');
    const r = await M().remote.connect(val);
    if (!r.ok) setErr(t('mobile.badCode'));
    setBusy(false);
  }
  if (scan) return <QrScanner t={t} onClose={() => setScan(false)} onResult={(c: string) => { setScan(false); setCode(normCode(c)); go(c); }} />;

  // Enquanto procura as máquinas da conta (primeira tentativa)
  if (discovering && !manual) return (
    <div className="m-screen m-auth">
      <LangBar />
      <Logo size={40} textSize={28} />
      <h1 style={{ fontSize: 19, marginTop: 12 }}>{t('mobile.connectTitle')}</h1>
      <div className="m-center" style={{ marginTop: 28, gap: 14 }}>
        <div className="m-spin" />
        <p className="m-hint" style={{ textAlign: 'center' }}>{t('mobile.searchingMachines')}</p>
      </div>
      <button className="m-link m-acc-link" onClick={onAccount}><User size={15} /> {t('mobile.account')}</button>
    </div>
  );

  return (
    <div className="m-screen m-auth">
      <LangBar />
      <Logo size={40} textSize={28} />
      <h1 style={{ fontSize: 19, marginTop: 12 }}>{t('mobile.connectTitle')}</h1>

      {/* Instâncias/sessões cloud da conta */}
      {cloud.length > 0 && (
        <div className="m-cloud-list">
          <div className="m-cloud-h">{t('mobile.cloudHeading')}</div>
          {cloud.map((s) => (
            <button key={s.project_id} className="m-cloud-item" disabled={cloudBusy === s.project_id} onClick={() => openCloud(s)}>
              <span className="m-cloud-ic"><CloudCog size={17} /></span>
              <span className="m-cloud-name">{s.name}<span className="m-cloud-sub">{t('mobile.cloudRuntime')}</span></span>
              <span className="m-cloud-go">{cloudBusy === s.project_id ? '…' : '›'}</span>
            </button>
          ))}
        </div>
      )}

      {/* Nenhuma máquina online encontrada → orienta e oferece nova busca */}
      <p className="m-hint" style={{ textAlign: 'center', marginTop: cloud.length ? 6 : 0 }}>{t('mobile.noMachines')}</p>
      <button type="button" className="m-scan-btn" style={{ marginBottom: 4 }} onClick={discover} disabled={discovering}>
        <RefreshCw size={17} /> {discovering ? t('mobile.searchingMachines') : t('mobile.searchAgain')}
      </button>

      {/* QR / código como ALTERNATIVA */}
      <form className="m-form" onSubmit={(e) => { e.preventDefault(); go(); }}>
        {err && <div className="m-err">{err}</div>}
        <button type="button" className="m-scan-btn" onClick={() => setScan(true)}><QrCode size={18} /> {t('mobile.scanQr')}</button>
        <label className="m-label">{t('mobile.codeLabel')}</label>
        <input className="m-code" value={code} onChange={(e) => setCode(normCode(e.target.value))} placeholder="XXXXXXXX" />
        <p className="m-hint">{t('mobile.codeHint')}</p>
        <button disabled={busy || !code.trim()}>{busy ? t('mobile.connecting') : t('mobile.connect')}</button>
      </form>
      <button className="m-link m-acc-link" onClick={onAccount}><User size={15} /> {t('mobile.account')}</button>
    </div>
  );
}

function Projects({ t, projects, host, onPick, onRefresh, onDisconnect, onAccount, onKanban }: any) {
  const maestrus = projects.find((p: any) => p.remoteProjectId === 'maestrus' || p.name === 'Maestrus');
  const others = projects.filter((p: any) => p !== maestrus && p.id !== 'starter');
  const activity = useActivityMap();
  // Forks (conversas) — accordion aberto por padrão pra o usuário ver e entrar direto.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('maestrus-m-conv-collapsed') || '{}'); } catch { return {}; }
  });
  const [forking, setForking] = useState<string | null>(null);
  const toggle = (id: string) => setCollapsed((c) => { const n = { ...c, [id]: !c[id] }; try { localStorage.setItem('maestrus-m-conv-collapsed', JSON.stringify(n)); } catch {} return n; });
  const convsOf = (p: any): any[] => Array.isArray(p.conversations) ? p.conversations : [];
  const openConv = (p: any, c: any) => onPick({ ...p, id: `${p.id}#${c.id}`, name: `${p.name} · ${c.title}`, conversations: [] });
  // bolinha do projeto pulsa se ele OU qualquer fork estiver trabalhando/não lido
  const aggAct = (p: any) => {
    let best = activity[p.id] || null;
    for (const c of convsOf(p)) {
      const a = activity[`${p.id}#${c.id}`];
      if (a && (a.status === 'working' || (a.status === 'unread' && best?.status !== 'working'))) best = a;
    }
    return best;
  };
  async function forkProject(p: any) {
    setForking(p.id);
    try {
      const n = convsOf(p).length + 1;
      await M().conversations?.create?.(p.id, t('conv.defaultTitle', { n }) || `Conversa ${n}`);
      await onRefresh?.();
      setCollapsed((c) => ({ ...c, [p.id]: false }));
    } catch {} finally { setForking(null); }
  }
  return (
    <div className="m-screen">
      <header className="m-top">
        <Logo size={22} textSize={17} />
        <span style={{ flex: 1 }} />
        <button className="m-icon-btn" onClick={onKanban} aria-label="kanban"><KanbanIcon size={19} /></button>
        <button className="m-icon-btn" onClick={onAccount} aria-label="account"><User size={19} /></button>
        <button className="m-link" onClick={onDisconnect}>{t('mobile.disconnect')}</button>
      </header>
      <div className="m-subbar">{t('mobile.connectedTo')} <b>{host}</b></div>
      <div className="m-list">
        {/* Maestrus — sessão principal, sempre no topo, destaque neon */}
        {maestrus && (
          <button className={`m-maestrus ${activity[maestrus.id]?.status === 'unread' ? 'has-unread' : ''}`} onClick={() => onPick(maestrus)}>
            <div className="m-maestrus-txt">
              <Logo size={30} textSize={26} />
              <span className="m-maestrus-desc">{t('mobile.maestrusDesc')}</span>
            </div>
            <ActivityIndicator activity={activity[maestrus.id] || null} />
            <span className="m-maestrus-go">›</span>
          </button>
        )}
        {others.length === 0 && !maestrus && <div className="m-empty">{t('mobile.noProjects')}</div>}
        {others.map((p: any) => {
          const convs = convsOf(p);
          const isOpen = convs.length > 0 && !collapsed[p.id];
          return (
            <div key={p.id} className="m-proj-group">
              <div className={`m-proj ${aggAct(p)?.status === 'unread' ? 'has-unread' : ''}`}>
                {convs.length > 0 ? (
                  <button className="m-proj-chev" onClick={() => toggle(p.id)} aria-label="toggle">
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                ) : <span className="m-proj-ic">▸</span>}
                <button className="m-proj-main" onClick={() => onPick(p)}>
                  <span className="m-proj-name">{p.name}{convs.length > 0 && <span className="m-proj-count"> · {convs.length + 1}</span>}</span>
                  <ActivityIndicator activity={aggAct(p) || null} />
                  <span className="m-proj-meta">{(p.engine === 'cloud' ? 'Claude API' : (p.model || 'default'))}</span>
                </button>
                <button className="m-proj-fork" disabled={forking === p.id} onClick={() => forkProject(p)} aria-label="fork" title={t('conv.fork')}>
                  <GitBranch size={15} />
                </button>
              </div>
              {isOpen && convs.map((c: any) => {
                const cid = `${p.id}#${c.id}`;
                return (
                  <button key={cid} className={`m-conv ${activity[cid]?.status === 'unread' ? 'has-unread' : ''}`} onClick={() => openConv(p, c)}>
                    <span className="m-conv-line" />
                    <MessageSquare size={13} className="m-conv-ic" />
                    <span className="m-conv-name">{c.title}</span>
                    <ActivityIndicator activity={activity[cid] || null} />
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <button className="m-refresh" onClick={onRefresh}>↻</button>
    </div>
  );
}

const THINK = ['none', 'low', 'medium', 'high'];
const PERMS: { id: string; icon: any; key: string }[] = [
  { id: 'default', icon: Shield, key: 'default' },
  { id: 'acceptEdits', icon: ShieldCheck, key: 'acceptEdits' },
  { id: 'plan', icon: ShieldAlert, key: 'plan' },
  { id: 'bypassPermissions', icon: ShieldOff, key: 'bypass' },
];

function Chat({ t, project, onBack, onPatch, connected }: any) {
  const { lang, setLang } = useT();
  const [msgs, setMsgs] = useState<any[]>([]);
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const [showSet, setShowSet] = useState(false);
  const [hasOaiKey, setHasOaiKey] = useState<boolean | null>(null);
  const [codexConn, setCodexConn] = useState(false); // overlay de login do Codex CLI
  const [oaiInput, setOaiInput] = useState('');
  const [oaiEditing, setOaiEditing] = useState(false);
  const [oaiBusy, setOaiBusy] = useState(false);
  const [oaiErr, setOaiErr] = useState('');
  const [showOaiUpsell, setShowOaiUpsell] = useState(false);
  const [windowSize, setWindowSize] = useState(200);
  const endRef = useRef<HTMLDivElement>(null);

  // ── Modo Voz (Jarvis): full-screen com maestro, música e tools. STT → envia
  // → TTS por sentença. Mic suspenso enquanto pensa/fala.
  const voiceOk = ttsSupported() && sttSupported();
  const [vmode, setVmode] = useState(false);
  const [vstate, setVstate] = useState<VoiceState>('idle');
  const [vcaption, setVcaption] = useState('');
  const [recentTools, setRecentTools] = useState<{ id: string; name: string; ts: number }[]>([]);
  const vmodeRef = useRef(false); const busyRef = useRef(false); const speakingRef = useRef(false); const lastEventRef = useRef(0);
  const msgQueueRef = useRef<string[]>([]);
  const stt = useRef(getSttEngine());
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);
  const ttsDoneRef = useRef(false);
  const ttsAccumRef = useRef('');
  useEffect(() => { vmodeRef.current = vmode; }, [vmode]);
  useEffect(() => {
    if (showSet && hasOaiKey === null) {
      M()?.openaiKey?.has?.().then((r: any) => setHasOaiKey(!!r?.has)).catch(() => setHasOaiKey(false));
    }
  }, [showSet, hasOaiKey]);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  // WATCHDOG do "pensando" (PWA): ao voltar de background/minimizar, ou se ficar
  // busy sem eventos, pergunta ao host se o turno AINDA roda. Se não → destrava e
  // recarrega o histórico (pega o que chegou enquanto estava em background). Fim
  // do "precisa fechar e abrir pra restaurar a conversa".
  async function reconcileBusyM() {
    try {
      const r: any = await (M() as any)?.claude?.isBusy?.(project.id);
      if (r && r.known && r.busy === false && busyRef.current) {
        setBusy(false); busyRef.current = false;
        if (vmodeRef.current) { resetTtsState(); speakingRef.current = false; setVstate('idle'); setTimeout(startListening, 400); }
      }
      // Recarrega o histórico ao voltar — restaura mensagens perdidas no background.
      try { const h = await M().claude.loadHistory(project.id); if (Array.isArray(h) && h.length) { mHistCache.set(project.id, h); setMsgs(h); } } catch {}
    } catch {}
  }
  useEffect(() => {
    const iv = setInterval(() => { if (busyRef.current && Date.now() - lastEventRef.current > 12000) reconcileBusyM(); }, 5000);
    const onVis = () => { if (!document.hidden) reconcileBusyM(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
  }, [project.id]);

  // Detecta reconexão ao relay enquanto busy=true: significa que o evento done
  // chegou enquanto o WebSocket estava caído. Reseta estado e recarrega histórico.
  const prevConnectedRef = useRef<boolean>(!!connected);
  useEffect(() => {
    if (!prevConnectedRef.current && connected && busyRef.current) {
      setBusy(false); busyRef.current = false;
      resetTtsState(); speakingRef.current = false; setVstate('idle'); setVcaption('');
      M().claude.loadHistory(project.id)
        .then((history: any[]) => { if (history?.length) setMsgs(history); })
        .catch(() => {});
    }
    prevConnectedRef.current = !!connected;
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetTtsState() {
    ttsQueueRef.current = []; ttsAccumRef.current = '';
    ttsDoneRef.current = false; ttsPlayingRef.current = false;
    resetSentenceSplitter();
  }

  function playTtsQueue() {
    if (ttsPlayingRef.current || !ttsQueueRef.current.length || !vmodeRef.current) return;
    const sentence = ttsQueueRef.current.shift()!;
    ttsPlayingRef.current = true; speakingRef.current = true; setVstate('speaking'); setVcaption(sentence);
    ttsSpeak(sentence, lang as any, () => {
      ttsPlayingRef.current = false;
      if (!vmodeRef.current) { speakingRef.current = false; return; }
      if (ttsQueueRef.current.length > 0) { playTtsQueue(); return; }
      if (ttsDoneRef.current) { speakingRef.current = false; setVstate('idle'); setVcaption(''); setTimeout(startListening, 200); }
    });
  }

  function flushTtsAccum(force = false) {
    const { sentences, remaining } = extractSentences(ttsAccumRef.current);
    sentences.forEach((s) => ttsQueueRef.current.push(s));
    ttsAccumRef.current = remaining;
    if (force && remaining.trim()) { ttsQueueRef.current.push(remaining.trim()); ttsAccumRef.current = ''; }
  }

  function startListening() {
    if (!vmodeRef.current || busyRef.current || speakingRef.current) return;
    setVstate('listening'); setVcaption('');
    stt.current.start(lang as any, {
      onInterim: (txt: string) => { setVcaption(txt); },
      onFinal: (txt: string) => { setVstate('thinking'); setVcaption(txt); send(txt); },
      onEnd: () => { if (vmodeRef.current && !busyRef.current && !speakingRef.current) setTimeout(startListening, 350); },
      // Falha REAL do STT vira legenda visível — antes voltava pra "Ouvindo"
      // mudo e parecia que o app tinha ficado surdo pra sempre.
      onError: (e: string) => {
        if (e === 'no_api_key') { setVcaption(t('byok.voiceNeedsKey') || 'Adicione sua chave OpenAI em Ajustes para usar a voz.'); return; }
        if (e === 'mic') { setVcaption(t('voice.micDenied') || 'Sem acesso ao microfone.'); return; }
        if (e && e !== 'rec') setVcaption(String(e).slice(0, 120));
        if (vmodeRef.current && !busyRef.current && !speakingRef.current) setTimeout(startListening, 900);
      },
    });
  }
  async function openJarvis() {
    if (vmode) return;
    // Mobile NÃO tem Realtime — usa STT/TTS SERVER-METERED (a chave OpenAI fica no
    // servidor; o fluxo usa a license_key da conta). Exigir uma chave OpenAI
    // PRÓPRIA — que nunca é usada no caminho mobile — bloqueava a voz grátis à toa.
    setVmode(true); vmodeRef.current = true;
    unlockAudio(); resetTtsState(); setRecentTools([]);
    startListening();
  }
  async function saveOaiKey() {
    setOaiBusy(true); setOaiErr('');
    try {
      const r: any = await M()?.openaiKey?.set?.(oaiInput.trim());
      if (r?.ok) { setHasOaiKey(true); setOaiEditing(false); setOaiInput(''); }
      else setOaiErr(r?.error === 'invalid_key_format' ? (t('byok.invalidFormat') || 'Invalid format (sk-…)') : (r?.error || t('byok.errSave') || 'Error'));
    } catch (e: any) { setOaiErr(e?.message || 'Error'); }
    finally { setOaiBusy(false); }
  }
  async function delOaiKey() {
    if (!confirm(t('byok.confirmDelete') || 'Delete your OpenAI key from all your devices?')) return;
    try {
      await M()?.openaiKey?.delete?.();
      setHasOaiKey(false); setOaiInput(''); setOaiEditing(false);
    } catch {}
  }
  function closeJarvis() {
    setVmode(false); vmodeRef.current = false;
    stt.current.stop();
    ttsCancel(); resetTtsState();
    speakingRef.current = false; setVstate('idle'); setVcaption('');
  }
  function pauseVoice() {
    ttsCancel(); resetTtsState();
    speakingRef.current = false;
    try { M().claude.stop && M().claude.stop(project.id); } catch {}
    setBusy(false); setVstate('idle'); setVcaption('');
    setTimeout(startListening, 200);
  }
  // Stop direto do chat (sem voz): mata o turno em andamento, libera o input.
  function stopAi() {
    try { M().claude.stop && M().claude.stop(project.id); } catch {}
    ttsCancel(); resetTtsState(); speakingRef.current = false;
    setBusy(false); busyRef.current = false;
    // Sem limpar a fila, o 'done' do turno morto dispara o próximo prompt
    // sozinho — a IA "parada" volta a responder.
    msgQueueRef.current = [];
    setMsgs((m) => m.map((x: any) => (x.queued ? { ...x, queued: false } : x)));
  }
  const jarvisState: VoiceState = busy && vstate !== 'speaking' ? 'thinking' : vstate;
  useEffect(() => () => { try { stt.current.stop(); ttsCancel(); } catch {} }, []);

  const slash = text.startsWith('/') && !text.includes(' ') ? filterCommands(text).slice(0, 6) : [];

  useEffect(() => {
    // Continuidade: se já está respondendo (turno iniciado antes de abrir),
    // mostra o "pensando" na hora em vez de parecer parado. Marca como lido.
    const act = getActivity()[project.id];
    if (act && act.status === 'working') setBusy(true);
    markRead(project.id);
    let mounted = true;
    { const c = mHistCache.get(project.id); if (c) setMsgs(c); }  // cache: mostra na hora
    M().claude.loadHistory(project.id).then((h: any[]) => {
      if (!mounted) return;
      if (Array.isArray(h) && h.length) { mHistCache.set(project.id, h); setMsgs(h); }
      else if (!mHistCache.get(project.id)) setMsgs(Array.isArray(h) ? h : []); // vazio de verdade
    });
    const off = M().claude.onEvent((e: any) => {
      if (e.projectId && e.projectId !== project.id) return;
      lastEventRef.current = Date.now();
      if (e.type === 'user') return;
      if (e.type === 'delta') {
        if (vmodeRef.current && e.text) {
          ttsAccumRef.current += e.text;
          flushTtsAccum();
          if (ttsQueueRef.current.length > 0) playTtsQueue();
        }
        setMsgs((m) => { const last = m[m.length - 1]; if (last && last.role === 'assistant' && last._live) return [...m.slice(0, -1), { ...last, text: (last.text || '') + (e.text || '') }]; return [...m, { role: 'assistant', text: e.text || '', _live: true }]; });
      } else if (e.type === 'assistant-text') {
        setMsgs((m) => { const last = m[m.length - 1]; if (last && last.role === 'assistant' && last._live) return [...m.slice(0, -1), { ...last, text: e.text || '', _live: false }]; return [...m, { role: 'assistant', text: e.text || '' }]; });
      } else if (e.type === 'thinking') {
        setMsgs((m) => [...m, { role: 'thinking', text: (e.text || '').slice(0, 200) }]);
      } else if (e.type === 'ask-user-question') {
        setMsgs((m) => {
          const last = m[m.length - 1];
          if (last && last.role === 'assistant' && last._live) {
            return [...m.slice(0, -1), { ...last, text: e.text || last.text, questions: e.questions, _live: false }];
          }
          return [...m, { role: 'assistant', text: e.text || '', questions: e.questions }];
        });
      } else if (e.type === 'tool-use') {
        setMsgs((m) => [...m, { role: 'tool-use', name: e.name || 'tool', input: e.input, id: e.id }]);
        if (vmodeRef.current && e.name) {
          setRecentTools((p) => {
            const next = [...p, { id: e.id || `${Date.now()}_${p.length}`, name: e.name, ts: Date.now() }];
            return next.length > 12 ? next.slice(-12) : next;
          });
        }
      } else if (e.type === 'tool-result') {
        setMsgs((m) => [...m, { role: 'tool-result', toolUseId: e.toolUseId, text: e.text, isError: e.isError }]);
      } else if (e.type === 'result' || e.type === 'done') {
        setMsgs((m) => m.map((x) => ({ ...x, _live: false })));
        setRecentTools([]);
        if (navigator.vibrate) navigator.vibrate(30);
        setBusy(false); busyRef.current = false;
        // Notificação LOCAL quando a IA termina E o app está em 2º plano — funciona
        // com o PWA/aba aberta (mesmo minimizado). Multi-idioma. (O caso "celular
        // bloqueado/app fechado" é o web push server-side, próxima etapa.)
        try {
          if (typeof document !== 'undefined' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const nTitle = project?.name ? `Maestrus · ${project.name}` : 'Maestrus';
            const nBody = e.type === 'done' ? (t('mobile.notifDone') || 'Resposta pronta') : (t('mobile.notifAsk') || 'O agente fez uma pergunta');
            navigator.serviceWorker?.ready
              .then((reg) => reg.showNotification(nTitle, { body: nBody, tag: `maestrus-${project?.id || ''}`, icon: '/app/icon-192.png', badge: '/app/icon-192.png', data: { url: '/app' }, renotify: true } as any))
              .catch(() => { try { new Notification(nTitle, { body: nBody }); } catch {} });
          }
        } catch {}
        // Turno parado pelo usuário: não continua a fila nem avisa que "terminou".
        if ((e as any).cancelled) return;
        // Drena fila de mensagens pendentes
        const nextQueued = msgQueueRef.current.shift();
        if (nextQueued) {
          setMsgs((m) => {
            const idx = [...m].reverse().findIndex((x: any) => x.queued && x.text === nextQueued);
            if (idx < 0) return m;
            const copy = [...m];
            copy[copy.length - 1 - idx] = { ...copy[copy.length - 1 - idx], queued: false };
            return copy;
          });
          setTimeout(() => send(nextQueued, { fromQueue: true }), 120);
        }
        if (vmodeRef.current) {
          ttsDoneRef.current = true;
          flushTtsAccum(true);
          if (ttsQueueRef.current.length > 0) { playTtsQueue(); }
          else if (!ttsPlayingRef.current) { speakingRef.current = false; setVstate('idle'); setVcaption(''); setTimeout(startListening, 200); }
        }
      } else if (e.type === 'error') {
        setBusy(false); busyRef.current = false; resetTtsState(); speakingRef.current = false; setVstate('idle'); setVcaption('');
        setMsgs((m) => [...m, { role: 'error', text: e.text || 'erro' }]);
        // Voz: devolve o mic após erro (antes o orb morria e o mic não voltava).
        if (vmodeRef.current) setTimeout(startListening, 500);
      }
    });
    return () => { mounted = false; off(); };
  }, [project.id]);

  // Janela visível: últimas N msgs. Botão "carregar mais" expande.
  const visibleMsgs = useMemo(() => {
    if (msgs.length <= windowSize) return { items: msgs, hidden: 0 };
    return { items: msgs.slice(msgs.length - windowSize), hidden: msgs.length - windowSize };
  }, [msgs, windowSize]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  async function patch(p: any) { onPatch(p); await M().projects.patch(project.id, p); }

  // ── Anexos no PWA (imagem/arquivo/câmera) — reusa o upload robusto do host ──
  const [atts, setAtts] = useState<{ name: string; dataB64: string; preview?: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  async function addFiles(fl: FileList | null) {
    if (!fl) return;
    for (const f of Array.from(fl)) {
      if (f.size > 25 * 1024 * 1024) { setMsgs((m) => [...m, { role: 'system', text: `📎 "${f.name}" grande demais (máx. 25MB).` }]); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      const name = f.name || `foto-${Date.now().toString(36)}.${(f.type.split('/')[1] || 'jpg')}`;
      const preview = f.type.startsWith('image/') ? `data:${f.type};base64,${b64}` : undefined;
      setAtts((a) => [...a, { name, dataB64: b64, preview }]);
    }
  }
  async function resolveAtts(): Promise<string> {
    if (!atts.length) return '';
    const refs: string[] = [];
    for (const a of atts) {
      try {
        const r: any = await (M() as any)?.files?.uploadToHost?.(project.id, { name: a.name, dataB64: a.dataB64 });
        if (r && r.ok && (r.rel || r.path)) refs.push('@' + (r.rel || r.path));
        else setMsgs((m) => [...m, { role: 'system', text: `📎 Não anexei "${a.name}"${r?.error ? ` (${r.error})` : ''}.` }]);
      } catch { setMsgs((m) => [...m, { role: 'system', text: `📎 Não anexei "${a.name}".` }]); }
    }
    return refs.join(' ');
  }

  async function send(over?: string, opts?: { fromQueue?: boolean }) {
    const fromVoice = typeof over === 'string' && !opts?.fromQueue;
    let raw = (over !== undefined ? over : text).trim();
    // Anexos: sobe pro host e prefixa @refs (só no envio manual, não por voz).
    if (!fromVoice && atts.length) {
      const refs = await resolveAtts();
      raw = refs ? (raw ? `${refs}\n\n${raw}` : refs) : raw;
      setAtts([]);
    }
    if (!raw) return;
    // slash que mapeiam pros pickers, resolvidos localmente
    const mModel = raw.match(/^\/model\s+(\S+)/); if (mModel) { if (!fromVoice) setText(''); return patch({ model: mModel[1] }); }
    const mTh = raw.match(/^\/thinking\s+(none|low|medium|high)/); if (mTh) { if (!fromVoice) setText(''); return patch({ thinkingMode: mTh[1] }); }
    // Enfileira se IA está respondendo (exceto voz e mensagens vindas da fila)
    if (busyRef.current && !opts?.fromQueue && !fromVoice) {
      if (!fromVoice) setText('');
      msgQueueRef.current.push(raw);
      setMsgs((m) => [...m, { role: 'user', text: raw, queued: true }]);
      return;
    }
    if (!fromVoice) setText('');
    if (vmodeRef.current) resetTtsState();
    setBusy(true); busyRef.current = true;
    setMsgs((m) => [...m, { role: 'user', text: raw }]);
    try { await M().claude.send(project.id, raw); } catch { setBusy(false); busyRef.current = false; }
  }

  return (
    <div className="m-screen m-chat">
      <header className="m-top">
        <button className="m-link" onClick={onBack} aria-label="Back"><ChevronLeft size={22} /></button>
        <span className="m-chat-id"><b className="m-chat-title">{project.name}</b><ConnectionStatus variant="pill" /></span>
        <button className="m-gear" onClick={() => setShowSet((v) => !v)} aria-label="Settings"><Settings size={17} /></button>
      </header>

      {showSet && (() => {
        const cloud = project.engine === 'cloud';
        const mInfo = getModelInfo(project.model || 'default');
        const ctxK = Math.round(mInfo.contextWindow / 1000);
        return (
        <div className="m-settings">
          <div className="m-set-sec">
            <div className="m-set-h">{t('mobile.engine')}</div>
            <div className="m-seg m-seg-wrap m-seg-eng">
              {[
                { id: 'claude', lb: t('mobile.cli') },
                { id: 'cloud', lb: t('mobile.cloudAi') },
                { id: 'codex', lb: 'Codex CLI' },
                { id: 'codex-api', lb: 'Codex API' },
              ].map(({ id, lb }) => (
                <button
                  key={id}
                  className={project.engine === id || (!project.engine && id === 'claude') ? 'on' : ''}
                  onClick={() => {
                    // Troca de provedor → reseta o modelo pro default do provedor.
                    const wantOpenai = id === 'codex' || id === 'codex-api';
                    const cur = project.model || '';
                    const isOai = cur.startsWith('gpt-') || cur.includes('codex');
                    patch(isOai !== wantOpenai ? { engine: id, model: defaultModelForEngine(id) } : { engine: id });
                  }}
                >
                  <EngineMark engine={id} size={12} /> {lb}
                </button>
              ))}
            </div>
            {project.engine === 'codex' && (
              <button className="m-codex-connect" onClick={() => setCodexConn(true)}>
                <EngineMark engine="codex" size={12} /> {t('codexCli.connect') || 'Connect Codex CLI'}
              </button>
            )}
          </div>

          <div className="m-set-sec">
            <div className="m-set-h"><Cpu size={13} /> {t('mobile.model')}</div>
            {cloud && <div className="m-set-note">{t('model.cloudCost')}</div>}
            <div className="m-model-list">
              {modelsForEngine(project.engine).map((mo) => {
                const sel = (project.model || 'default') === mo.id;
                const tier = costTier(mo.id);
                return (
                  <button key={mo.id} className={`m-model ${sel ? 'on' : ''}`} onClick={() => patch({ model: mo.id })}>
                    <span className="m-model-check">{sel && <Check size={14} />}</span>
                    <span className="m-model-body">
                      <span className="m-model-name">{mo.label}{cloud && <span className={`m-tier t${tier.length}`}>{tier}</span>}</span>
                      <span className="m-model-desc">{t(mo.descKey)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="m-set-sec">
            <div className="m-set-h"><Brain size={13} /> {t('mobile.thinking')}</div>
            <div className="m-seg">
              {THINK.map((th) => (<button key={th} className={(project.thinkingMode || 'medium') === th ? 'on' : ''} onClick={() => patch({ thinkingMode: th })} title={t('thinking.' + th + 'Desc')}>{t('thinking.' + th)}</button>))}
            </div>
          </div>

          <div className="m-set-sec">
            <div className="m-set-h"><Shield size={13} /> {t('mobile.permissions')}</div>
            <div className="m-seg m-seg-wrap">
              {PERMS.map((p) => {
                const sel = (project.permissionMode || 'bypassPermissions') === p.id;
                const PI = p.icon;
                return (<button key={p.id} className={`${sel ? 'on' : ''} ${p.id === 'bypassPermissions' && sel ? 'warn' : ''}`} onClick={() => patch({ permissionMode: p.id })} title={t('permission.' + p.key + 'Desc')}><PI size={12} /> {t('permission.' + p.key)}</button>);
              })}
            </div>
          </div>

          <div className="m-set-sec">
            <div className="m-set-h">{t('voice.language')}</div>
            <div className="m-seg">
              {LANGS.map((l) => (<button key={l.id} className={lang === l.id ? 'on' : ''} onClick={() => setLang(l.id)}>{l.flag} {l.id.toUpperCase()}</button>))}
            </div>
          </div>

          <div className="m-set-sec">
            <div className="m-set-h"><KeyRound size={13} /> {t('byok.title') || 'OpenAI Voice (BYOK)'}</div>
            <div className="m-set-note">{t('byok.desc') || 'Use your own OpenAI key to power the realtime voice assistant.'}</div>
            {hasOaiKey === true && !oaiEditing && (
              <div className="m-byok-row">
                <span className="m-byok-ok"><Check size={12} /> {t('byok.configured') || 'Key configured'}</span>
                <button className="m-byok-link" onClick={() => { setOaiEditing(true); setOaiInput(''); }}>{t('byok.change') || 'Change'}</button>
                <button className="m-byok-del" onClick={delOaiKey} aria-label={t('byok.delete') || 'Delete'}><Trash2 size={12} /></button>
              </div>
            )}
            {(hasOaiKey === false || oaiEditing) && (
              <div className="m-byok-form">
                <input type="password" value={oaiInput} onChange={(e) => setOaiInput(e.target.value)} placeholder="sk-…" autoComplete="off" />
                {oaiErr && <div className="m-byok-err"><AlertCircle size={11} /> {oaiErr}</div>}
                <div className="m-byok-actions">
                  <button className="m-byok-save" onClick={saveOaiKey} disabled={oaiBusy || !oaiInput.trim().startsWith('sk-')}>{oaiBusy ? '…' : (t('byok.save') || 'Save')}</button>
                  {oaiEditing && <button className="m-byok-cancel" onClick={() => { setOaiEditing(false); setOaiInput(''); setOaiErr(''); }}>{t('common.cancel') || 'Cancel'}</button>}
                </div>
                <a className="m-byok-help" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">platform.openai.com/api-keys <ExternalLink size={10} /></a>
              </div>
            )}
          </div>

          <div className="m-set-foot">
            <span>{mInfo.label} · {ctxK}K{cloud ? ' · Claude API' : ''}</span>
            {project.remoteHostName && <span>{t('mobile.host')}: <b>{project.remoteHostName}</b></span>}
            {project.sessionId && <span className="m-set-sid">{t('chat.session')}: <code>{String(project.sessionId).slice(0, 8)}</code></span>}
          </div>
        </div>
        );
      })()}

      <div className="m-msgs">
        {visibleMsgs.hidden > 0 && (
          <button className="m-load-more" onClick={() => setWindowSize((w) => w + 200)}>
            {t('chat.loadOlder', { n: Math.min(200, visibleMsgs.hidden) })}
          </button>
        )}
        {(() => {
          // Pareia cada tool-use com seu tool-result (mesma toolUseId) pra
          // mostrar como UM acordeão só, em vez de 2 bubbles separados.
          const resultById = new Map<string, any>();
          const consumed = new Set<string>();
          for (const x of visibleMsgs.items) {
            if (x.role === 'tool-result' && x.toolUseId) resultById.set(x.toolUseId, x);
          }
          return visibleMsgs.items.map((m, i) => {
            if (m.role === 'assistant') return (
              <div key={i} className="m-bubble assistant">
                {m.text && <span dangerouslySetInnerHTML={{ __html: md(m.text) }} />}
                {m.questions && m.questions.map((q: any, qi: number) => (
                  <div key={qi} className="aq-block">
                    {q.question && <div className="aq-q">{q.question}</div>}
                    <div className="aq-opts">
                      {(q.options || []).map((o: any, oi: number) => (
                        <button key={oi} className="aq-opt" title={o.description} onClick={() => send(o.label)}>{o.label}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
            if (m.role === 'tool-use') {
              const r = m.id ? resultById.get(m.id) : undefined;
              if (r && r.toolUseId) consumed.add(r.toolUseId);
              return <MobileToolAcc key={i} use={m} result={r} />;
            }
            if (m.role === 'tool-result') {
              if (m.toolUseId && consumed.has(m.toolUseId)) return null; // já dentro do tool-use acima
              return <MobileToolAcc key={i} use={null} result={m} />;
            }
            if (m.role === 'thinking') return <div key={i} className="m-bubble thinking"><Sparkles size={11} /> {m.text}</div>;
            if (m.role === 'error') return <div key={i} className="m-bubble error">{m.text}</div>;
            // /compact: divisor — o histórico anterior continua visível (linha contínua)
            if ((m as any).compactBoundary) return (
              <div key={i} className="compact-divider"><span>{String(m.text || '').replace(/^──\s*|\s*──$/g, '')}</span></div>
            );
            return <div key={i} className={`m-bubble ${m.role}${m.queued ? ' queued' : ''}`}>{m.queued ? '⏳ ' : ''}{m.text}</div>;
          });
        })()}
        {busy && <div className="m-busy-pill"><span>{t('voice.thinking')}</span></div>}
        <div ref={endRef} />
      </div>

      <Suspense fallback={null}>
      {vmode && <JarvisMode
        open={vmode}
        state={jarvisState}
        caption={vcaption}
        recentTools={recentTools}
        i18n={{
          listening: t('voice.listening'),
          thinking: t('voice.thinking'),
          speaking: t('voice.speaking'),
          ready: t('voice.ready'),
          pause: t('voice.pause'),
          exit: t('voice.exit'),
          musicOn: t('voice.musicOn'),
          musicOff: t('voice.musicOff'),
        }}
        onPause={pauseVoice}
        onClose={closeJarvis}
      />}
      </Suspense>

      {codexConn && (
        <CodexCliConnect
          onCancel={() => setCodexConn(false)}
          onConnected={() => setCodexConn(false)}
        />
      )}

      {showOaiUpsell && (
        <div className="m-byok-overlay" onClick={() => setShowOaiUpsell(false)}>
          <div className="m-byok-lock" onClick={(e) => e.stopPropagation()}>
            <div className="m-byok-lock-icon"><KeyRound size={22} /></div>
            <h3>{t('byok.voiceLocked') || 'Realtime voice needs an OpenAI key'}</h3>
            <p>{t('byok.voiceLockedDesc') || 'Set your key in Settings to enable the assistant.'}</p>
            <div className="m-byok-lock-actions">
              <button className="m-byok-cancel" onClick={() => setShowOaiUpsell(false)}>{t('common.cancel') || 'Cancel'}</button>
              <button className="m-byok-save" onClick={() => { setShowOaiUpsell(false); setShowSet(true); }}>{t('byok.goToSettings') || 'Open Settings'} <ArrowRight size={12} /></button>
            </div>
          </div>
        </div>
      )}

      <div className="m-inputwrap">
        {slash.length > 0 && (
          <div className="m-slash">
            {slash.map((c: any) => (
              <button key={c.name} onClick={() => setText(c.name + ' ')}>
                <b>{c.name}</b><span>{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        {atts.length > 0 && (
          <div className="m-atts">
            {atts.map((a, i) => (
              <div className="m-att" key={i}>
                {a.preview ? <img src={a.preview} alt={a.name} /> : <span className="m-att-file">📄</span>}
                <button className="m-att-x" onClick={() => setAtts((x) => x.filter((_, j) => j !== i))} aria-label="remover"><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.log,.zip" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ''; }} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ''; }} />
        <div className="m-input">
          <button className="m-attach-btn" onClick={() => fileRef.current?.click()} title="Anexar arquivo" aria-label="Anexar"><Paperclip size={17} /></button>
          <button className="m-attach-btn" onClick={() => camRef.current?.click()} title="Tirar foto" aria-label="Câmera"><Camera size={17} /></button>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            placeholder={busy ? t('mobile.queuePlaceholder') : t('mobile.placeholder')}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} rows={1} />
          {voiceOk && !text.trim() && !busy && (
            <button className="m-jarvis-btn" onClick={openJarvis} title={t('voice.start')} aria-label={t('voice.start')}><AudioLines size={18} /></button>
          )}
          {/* O stop fica visível enquanto a IA trabalha, mesmo com texto digitado:
              antes ele era substituído pelo enviar e não dava pra parar sem
              apagar o rascunho. Com texto, os dois aparecem (parar + enfileirar). */}
          {busy && (
            <button onClick={stopAi} className="m-stop-btn" title={t('mobile.stop') || 'Parar'} aria-label={t('mobile.stop') || 'Stop'}>
              <Square size={14} fill="currentColor" />
            </button>
          )}
          {!(busy && !text.trim() && !atts.length) && (
            <button onClick={() => send()} disabled={!text.trim() && !atts.length} aria-label={busy ? t('mobile.queueSend') : 'Send'}
              className={busy && (text.trim() || atts.length) ? 'queued' : ''}><ArrowUp size={18} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

// Pega o primeiro campo "interessante" do input pra mostrar como prévia.
function briefInputPreview(input: any): string {
  if (!input || typeof input !== 'object') return '';
  // payload truncado pelo host vem assim — mostra resumo amigável
  if (input.__truncated) return `(${Math.round((input.__originalSize || 0) / 1024)}KB)`;
  for (const k of ['command', 'file_path', 'path', 'prompt', 'query', 'url', 'pattern', 'description']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').slice(0, 60);
  }
  try { return JSON.stringify(input).slice(0, 60); } catch { return ''; }
}

// Accordion mobile pra tool call: combina tool-use com seu tool-result num
// único bloco. Head sempre mostra nome + prévia do input + status (✓/✗/…).
// Expandir mostra input completo e output completo.
function MobileToolAcc({ use, result }: { use: any; result?: any }) {
  const [open, setOpen] = useState(false);
  // result órfão (sem use): renderiza como bloco solo
  if (!use && result) {
    const isError = !!result.isError;
    const Icon = iconForTool(isError ? 'error' : 'result');
    const body = (result.text || '').slice(0, 4000);
    const lines = body ? body.split('\n').length : 0;
    return (
      <div className={`m-tool ${open ? 'open' : ''} ${isError ? 'err' : ''}`}>
        <button className="m-tool-head" onClick={() => setOpen((o) => !o)}>
          <ChevronRight size={11} className="m-tool-chev" />
          <Icon size={12} className="m-tool-ic" />
          <span className="m-tool-name">{isError ? 'error' : 'result'}</span>
          {lines > 0 && <span className="m-tool-meta">{lines} ln</span>}
        </button>
        {open && body && <pre className="m-tool-body">{body}</pre>}
      </div>
    );
  }
  const name = use?.name || 'tool';
  const Icon = iconForTool(name);
  const label = labelForTool(name);
  const inputPreview = briefInputPreview(use?.input);
  const inputBody = use?.input ? JSON.stringify(use.input, null, 2).slice(0, 4000) : '';
  const resultBody = result ? (result.text || '').slice(0, 6000) : '';
  const hasResult = !!result;
  const isError = !!result?.isError;
  const status = isError ? '✗' : hasResult ? '✓' : '…';
  return (
    <div className={`m-tool ${open ? 'open' : ''} ${isError ? 'err' : ''} ${hasResult ? '' : 'pending'}`}>
      <button className="m-tool-head" onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={11} className="m-tool-chev" />
        <Icon size={12} className="m-tool-ic" />
        <span className="m-tool-name">{label}</span>
        {inputPreview && <span className="m-tool-preview">{inputPreview}</span>}
        <span className="m-tool-status">{status}</span>
      </button>
      {open && (
        <>
          {inputBody && <pre className="m-tool-body">{inputBody}</pre>}
          {resultBody && <pre className={`m-tool-body out ${isError ? 'err' : ''}`}>{resultBody}</pre>}
        </>
      )}
    </div>
  );
}
