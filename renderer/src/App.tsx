import { useEffect, useState } from 'react';
import { Project, RequirementsReport } from './types';
import Sidebar from './components/Sidebar';
import ProjectChat from './components/ProjectChat';
import NewProjectModal from './components/NewProjectModal';
import RequirementsScreen from './components/RequirementsScreen';
import SettingsScreen from './components/SettingsScreen';
import ClaudePowersScreen from './components/ClaudePowersScreen';
import SelfhostConnect from './components/SelfhostConnect';
import CloudScreen from './components/CloudScreen';
import RemoteAccess from './components/RemoteAccess';
import ShareWorkspace from './components/ShareWorkspace';
import Kanban from './components/Kanban';
import StarterScreen from './components/StarterScreen';
import ModePicker from './components/ModePicker';
import LinkPreview from './components/LinkPreview';
import Logo from './components/Logo';
import UpdateBanner from './components/UpdateBanner';
import TitleBar from './components/TitleBar';
import Splash from './components/Splash';
import MarketingBanner from './components/MarketingBanner';
import { useT } from './lib/i18n';
import { noteEvent, setActiveProject } from './lib/activity-store';

// vosk-browser (~5.6MB com WASM) só carrega quando o wake word liga — fora do
// bundle principal.
let _wakeMod: typeof import('./lib/wake-word') | null = null;
async function getWakeMod() { if (!_wakeMod) _wakeMod = await import('./lib/wake-word'); return _wakeMod; }

type View = 'chat' | 'requirements' | 'settings' | 'cloud' | 'remote' | 'kanban' | 'starter' | 'mode' | 'empty' | 'powers' | 'selfhost';

export default function App() {
  const { t, lang } = useT();
  // Web app (maestrus.cloud/web): mesmo App, sem o que é exclusivo do Electron
  // (barra de janela, banner demo/marketing, wake word). O shim web seta isWeb.
  // IMPORTANTE: avaliar em tempo de RENDER — no nível de módulo isto rodaria
  // antes de installMaestrusWeb() (imports são içados), capturando false e
  // jogando o web no modo demo por engano.
  const isWeb = !!(window as any).maestrus?.isWeb;
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>('empty');
  const [selfhost, setSelfhost] = useState<any>(null);
  const [showNew, setShowNew] = useState(false);
  const [showShare, setShowShare] = useState(false);
  // Quando o Inicializador roda o fluxo com o marcador de voz, alvo = id do
  // Maestrus; o ProjectChat correspondente abre o modo voz ao montar e limpa.
  const [voiceTarget, setVoiceTarget] = useState<string | null>(null);
  // Wake word (Inicializador por voz). Roda no nível do app (qualquer tela).
  const [wakePhrase, setWakePhrase] = useState('Hello Maestrus');
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const [requirements, setRequirements] = useState<RequirementsReport | null>(null);
  const [appMode, setAppMode] = useState<'server' | 'client' | null>(null);
  const [clientHost, setClientHost] = useState<string | null>(null);
  const [clientConnected, setClientConnected] = useState(false);
  const [clientSync, setClientSync] = useState<{ syncing: boolean; hostCount: number; projectCount: number }>({ syncing: false, hostCount: 0, projectCount: 0 });
  const [booting, setBooting] = useState(true);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  // Intro toca uma vez por abertura do app (sessionStorage zera a cada relaunch).
  const [showSplash, setShowSplash] = useState(() => {
    try { return !sessionStorage.getItem('maestrus.splash'); } catch { return true; }
  });
  function dismissSplash() {
    try { sessionStorage.setItem('maestrus.splash', '1'); } catch {}
    setShowSplash(false);
  }

  async function refresh() {
    const [list, req] = await Promise.all([
      window.maestrus.projects.list(),
      window.maestrus.requirements.check(),
    ]);
    setProjects(list);
    setRequirements(req);
    return { list, req };
  }

  function enterApp(list: Project[]) {
    if (list.length > 0) { setActiveId(list[0].id); setView('chat'); }
    else setView('empty');
  }

  // Gate de auth do Claude. authed: null=desconhecido, true=ok, false=bloqueado.
  // Em erro de checagem (timeout etc.) NÃO trava — só bloqueia quando temos
  // certeza de que está deslogado (ok && !loggedIn).
  async function checkAuth(): Promise<boolean> {
    try {
      const s = await window.maestrus.claudeAuth.status();
      const a = !(s.ok && !s.loggedIn);
      setAuthed(a);
      return a;
    } catch { setAuthed(true); return true; }
  }

  // mac: marca o root pra reservar o respiro dos controles nativos (traffic
  // lights) no topo da sidebar — senão eles ficam por cima do logo.
  useEffect(() => {
    try { if ((window as any).maestrus?.platform === 'darwin') document.documentElement.classList.add('is-mac'); } catch {}
  }, []);

  useEffect(() => {
    (async () => {
      const { list, req } = await refresh();
      const blockers = req.items.filter((i) => i.required && !i.ok);
      // Modo do app (server/client). Se nunca foi escolhido, mostra o picker
      // depois de resolver requisitos. Existentes já têm projetos → default server.
      let mode: 'server' | 'client' | null = null;
      try { const r = await window.maestrus.app.getMode?.(); mode = (r && r.mode) || null; setAppMode(mode); } catch {}
      // Sem tela inicial de modo: default = servidor (trocável no Remote Control).
      if (!mode) { try { await window.maestrus.app.setMode?.('server'); } catch {} mode = 'server'; setAppMode('server'); }
      if (blockers.length > 0) setView('requirements');
      // Modo Cliente: tenta reconectar no host salvo (sem novo código). Se der
      // certo, os projetos do host aparecem; senão cai na tela Remoto pra parear.
      else if (mode === 'client') {
        // Web: tudo é cloud/remote, então login na conta é obrigatório e
        // independe de desktop. Sem conta → tela de login (CloudScreen).
        if (isWeb) {
          // SELF-HOST: se este web app é servido por um servidor próprio do
          // usuário, o fluxo é conectar por SECRET (sem conta/cadastro cloud).
          const shInfo = await (window.maestrus.remote as any).selfhostInfo?.().catch(() => null);
          if (shInfo && shInfo.selfhost) {
            setSelfhost(shInfo);
            const rr = await (window.maestrus.remote as any).selfhostResume?.().catch(() => null);
            if (!rr || !rr.ok) { setView('selfhost'); setBooting(false); return; }
            await reloadProjects();
            const fresh = await window.maestrus.projects.list().catch(() => []);
            setProjects(fresh);
            enterApp(fresh);
            setBooting(false);
            return;
          }
          const acc = await window.maestrus.cloud.account().catch(() => null);
          if (!acc) { setView('cloud'); setBooting(false); return; }
          // Cloud-first: o web é "a cara" do container do usuário. Auto-conecta
          // no container (u{id}.maestrus.cloud, host cloud-u{id} no relay) e entra
          // direto no app — sem tela de pareamento. Os projetos do container
          // aparecem transparentes, como se fossem locais.
          try { await (window.maestrus.remote as any).autoConnectCloud?.(); } catch {}
          // Preferência híbrida: se há uma MÁQUINA online (ex: Mac mini host), o
          // link ativo fica NELA — os projetos do container aparecem via stubs de
          // qualquer forma, então "soma" tudo. Evita grudar no container "Maestrus".
          try { await (window.maestrus.remote as any).preferMachine?.(); } catch {}
          await reloadProjects();
          const fresh = await window.maestrus.projects.list().catch(() => []);
          setProjects(fresh);
          // Se conectou e tem projetos → entra no app; senão mostra a tela
          // remota (fallback: parear máquina / provisionar container).
          if (fresh.length > 0) { enterApp(fresh); }
          else { setView('remote'); }
          setBooting(false);
          return;
        }
        checkAuth();
        // Self-host: se o desktop está vinculado a um servidor próprio, reconecta
        // nele (URL+secret salvos). Não bloqueia o boot.
        (window.maestrus as any).selfhost?.info?.().then((i: any) => {
          if (i && i.configured) (window.maestrus as any).selfhost.reconnect().catch(() => {});
        }).catch(() => {});
        // Reconecta no host salvo sem bloquear o boot. Projetos remotos chegam
        // via onClientState → reloadProjects assim que a conexão se estabelece.
        window.maestrus.remote.reconnect?.().catch(() => {});
        // Recarrega para pegar quaisquer projetos remotos já no cache.
        const fresh = await window.maestrus.projects.list().catch(() => list);
        setProjects(fresh);
        enterApp(fresh.length > 0 ? fresh : list);
      }
      // Não trancamos o app no login do Claude: o engine pode ser o Maestrus AI
      // (cloud) ou o tier free local. O login do Claude CLI é tratado inline no
      // chat quando o usuário escolhe esse engine. checkAuth só informa o estado.
      else { checkAuth(); enterApp(list); }
      setBooting(false);
    })();
  }, []);

  // Maestrus Cloud: ao terminar um sync (boot ou pós-login), recarrega a lista
  // de projetos sem precisar reabrir o app.
  useEffect(() => {
    return window.maestrus.claude.onEvent((evt) => {
      if (evt.type === 'system' && evt.subtype === 'cloud') refresh();
    });
  }, []);

  // Status global de atividade: UM listener no nível do App que sobrevive à
  // troca de aba/conversa e alimenta o activity-store (working/unread/idle) de
  // TODOS os projetos — mesmo os que não estão abertos. A sidebar lê daqui.
  useEffect(() => {
    return window.maestrus.claude.onEvent((evt: any) => { noteEvent(evt); });
  }, []);
  // Projeto aberto: limpa o "não lido" dele e marca como o ativo (terminar com
  // ele aberto = idle; com outro aberto = unread).
  useEffect(() => { setActiveProject(view === 'chat' ? activeId : null); }, [activeId, view]);

  // Soft-lock cross-device: quando outra máquina adquire/libera um lock, o sync
  // engine emite projects:changed. Re-fetcha pra UI desabilitar/reabilitar o
  // input com o banner "Rodando em <hostName>".
  useEffect(() => {
    // refresh() inclui projetos remotos (chama projects.list que mescla local + remote cache)
    return window.maestrus.projects.onChanged(() => { reloadProjects(); });
  }, []);

  // O main pede pra abrir o navegador embutido (MCP browser_navigate etc.).
  useEffect(() => {
    return window.maestrus.browser.onOpen(({ url }) => setBrowserUrl(url || 'about:blank'));
  }, []);

  // Estado da conexão de cliente (modo client): atualiza o banner "Conectado a X"
  // e recarrega os projetos do host quando (re)conecta.
  // Estado da conexão de cliente + AUTO-DISCOVERY (Fase 3): ao logar, puxa
  // automaticamente os projetos de TODAS as máquinas online da conta — em
  // qualquer modo, sem código de pareamento. O relay roteia por conta, então só
  // aparecem máquinas da mesma licença. (Web já auto-lista os projetos cloud à
  // parte; relay-no-browser é um follow-up.)
  useEffect(() => {
    const web = !!(window as any).maestrus?.isWeb;
    const applySync = (s: any) => setClientSync({ syncing: !!s.syncing, hostCount: s.hostCount || 0, projectCount: s.projectCount || 0 });
    window.maestrus.remote.clientState?.().then((s) => { setClientConnected(!!s.connected); setClientHost(s.hostName); applySync(s); }).catch(() => {});
    const off = window.maestrus.remote.onClientState?.((s) => {
      setClientConnected(!!s.connected);
      setClientHost(s.hostName);
      applySync(s);
      reloadProjects();
    });
    // Auto-discovery por login (desktop E web). No desktop acha outras máquinas
    // da conta; no web acha a sua máquina ligada ("Be a Host always on") sem
    // código de pareamento. O `web` acima fica só pra referência.
    void web;
    (async () => {
      const acc = await window.maestrus.cloud.account().catch(() => null);
      if (!acc) return;
      // Auto-discovery é OPT-IN ("Procurar outras instâncias", OFF por padrão).
      // Sem isso ligado, não há tráfego de descoberta — evita loops de rede.
      const d = await window.maestrus.remote.getDiscovery?.().catch(() => ({ enabled: false }));
      if (d?.enabled) { try { await window.maestrus.remote.discover?.(); } catch {} }
    })();
    return () => { try { off?.(); } catch {} };
  }, []);

  // ─── Wake word (Inicializador por voz) ─────────────────────────────────────
  // Carrega as settings no boot.
  useEffect(() => {
    window.maestrus.starter.get().then((s) => { setWakePhrase(s.wakePhrase || 'Hello Maestrus'); setWakeEnabled(!!s.wakeEnabled); }).catch(() => {});
  }, []);

  // Disparo: roda o launcher e abre a voz se o fluxo terminar com o marcador.
  async function onWakeDetect() {
    try { await window.maestrus.app.showWindow?.(); } catch {}
    try {
      const r = await window.maestrus.starter.run();
      if (r && r.ok && r.startVoice) {
        const maestrus = projects.find((p) => p.id === 'maestrus');
        if (maestrus) { setActiveId(maestrus.id); setVoiceTarget(maestrus.id); setView('chat'); }
      }
    } catch {}
  }

  // Liga/desliga o engine conforme a config. backgroundThrottling=false no main
  // mantém isso vivo mesmo com a janela escondida na bandeja.
  useEffect(() => {
    let cancelled = false;
    if (!wakeEnabled) { getWakeMod().then((m) => m.stopWakeWord()).catch(() => {}); return; }
    getWakeMod().then((m) => {
      if (cancelled || !m.wakeSupported()) return;
      m.startWakeWord({
        phrase: wakePhrase, lang: lang as string,
        onDetect: () => { if (!cancelled) onWakeDetect(); },
        onError: (e) => console.warn('[wake] erro:', e),
      });
    }).catch((e) => console.warn('[wake] load:', e));
    return () => { cancelled = true; getWakeMod().then((m) => m.stopWakeWord()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeEnabled, wakePhrase, lang]);

  // O sync contínuo agora roda no main process (sync-engine). A UI só recarrega
  // os projetos quando o engine emite o evento 'cloud' (acima).

  function openProject(id: string) {
    setActiveId(id);
    setView('chat');
  }

  async function deleteProject(id: string) {
    // Aviso condicional: só fala dos arquivos da nuvem se logado COM plano.
    const acc = await window.maestrus.cloud.account().catch(() => null);
    const cloudPaid = !!(acc && (acc as any).plan);
    if (!confirm(cloudPaid ? t('nav.deleteConfirmCloud') : t('nav.deleteConfirmLocal'))) return;
    await window.maestrus.projects.delete(id);
    const list = await window.maestrus.projects.list();
    setProjects(list);
    if (activeId === id) {
      setActiveId(list[0]?.id || null);
      setView(list[0] ? 'chat' : 'empty');
    }
  }

  async function handleCreated(p: Project) {
    setShowNew(false);
    const list = await window.maestrus.projects.list();
    setProjects(list);
    setActiveId(p.id);
    setView('chat');
  }

  // Recarrega a lista (inclui projetos remotos do host conectado).
  async function reloadProjects() {
    const list = await window.maestrus.projects.list();
    setProjects(list);
  }

  // Ações de conversas (forks) vindas da sidebar (botão direito / accordion).
  async function handleConvAction(action: 'fork' | 'forkConv' | 'renameProject' | 'renameConv' | 'deleteConv', projectId: string, convId?: string, value?: string) {
    const conv = (window.maestrus as any).conversations;
    try {
      if (action === 'fork' || action === 'forkConv') {
        const p = safeProjects.find((pp) => pp.id === projectId);
        const src = action === 'forkConv'
          ? ((p as any)?.conversations || []).find((c: any) => c.id === convId)
          : null;
        const title = src ? `${src.title} (fork)` : t('conv.defaultTitle', { n: (((p as any)?.conversations || []).length + 1) });
        const created = await conv?.create?.(projectId, title, action === 'forkConv' ? convId : 'main');
        await reloadProjects();
        if (created && created.id) { setActiveId(`${projectId}#${created.id}`); setView('chat'); }
      } else if (action === 'renameProject' && value) {
        const updated = await window.maestrus.projects.patch(projectId, { name: value } as any);
        if (updated) handleProjectUpdate(updated as any);
        await reloadProjects();
      } else if (action === 'renameConv' && convId && value) {
        await conv?.rename?.(projectId, convId, value);
        await reloadProjects();
      } else if (action === 'deleteConv' && convId) {
        if (!confirm(t('conv.deleteConfirm'))) return;
        await conv?.delete?.(projectId, convId);
        await reloadProjects();
        if (activeId === `${projectId}#${convId}`) setActiveId(projectId);
      }
    } catch (e) { console.error('[conv]', action, e); }
  }

  function handleProjectUpdate(updated: Project) {
    if (!updated || !updated.id) return; // patch pode voltar vazio (stub cloud / rpc falhou)
    setProjects((list) => (list || []).filter(Boolean).map((p) => (p.id === updated.id ? updated : p)));
  }

  if (booting) {
    return (
      <div className="app-wrap">
        {showSplash && <Splash onDone={dismissSplash} />}
        {!isWeb && <TitleBar />}
        <div className="boot">
          <Logo size={40} textSize={28} />
          <div className="boot-spinner" />
        </div>
      </div>
    );
  }

  const safeProjects = (projects || []).filter(Boolean);
  // Id composto `projeto#conversa` (fork): monta um projeto VIRTUAL herdando o
  // pai — o ProjectChat funciona sem saber de conversas (send/history/eventos
  // já falam o id composto de ponta a ponta).
  const activeProject = (() => {
    const direct = safeProjects.find((p) => p && p.id === activeId) || null;
    if (direct || !activeId || !activeId.includes('#')) return direct;
    const hi = activeId.indexOf('#');
    const base = safeProjects.find((p) => p && p.id === activeId.slice(0, hi));
    if (!base) return null;
    const conv = ((base as any).conversations || []).find((c: any) => c.id === activeId.slice(hi + 1));
    if (!conv) return null;
    return { ...base, id: activeId, name: `${base.name} · ${conv.title}` } as Project;
  })();
  const isDemo = !isWeb && !(window as any).__maestrus_electron;
  // Mostra todos os projetos (locais + remotos de qualquer máquina descoberta).
  // O modo não mais filtra — todas as sessões acessíveis aparecem mescladas.
  const displayProjects = safeProjects;

  return (
    <div className={`app-wrap ${isDemo ? 'with-banner' : ''}`}>
      {showSplash && <Splash onDone={dismissSplash} />}
      {view === 'mode' && (
        <ModePicker
          current={appMode}
          onDone={(mode) => {
            setAppMode(mode);
            if (mode === 'client') setView('remote');
            else { checkAuth(); enterApp(projects); }
          }}
        />
      )}
      {!isWeb && <TitleBar />}
      <UpdateBanner />
      {!isWeb && <MarketingBanner onOpen={() => setView('cloud')} />}
      {isDemo && (
        <div className="demo-banner">
          <strong>{t('demo.title')}</strong> — {t('demo.body', { cmd: 'npm run dev' })}
        </div>
      )}
      <div className="app">
      <Sidebar
        projects={displayProjects}
        mode={appMode}
        cloudFirst={isWeb}
        clientHostName={clientHost}
        clientConnected={clientConnected}
        clientSyncing={clientSync.syncing}
        clientHostCount={clientSync.hostCount}
        clientProjectCount={clientSync.projectCount}
        activeId={activeId}
        onPick={openProject}
        onNew={() => setShowNew(true)}
        onRequirements={() => setView('requirements')}
        onSettings={() => setView('settings')}
        onMcp={() => setView('powers')}
        onPowers={() => setView('powers')}
        onCloud={() => setView('cloud')}
        onRemote={() => setView('remote')}
        onKanban={() => setView('kanban')}
        onStarter={() => setView('starter')}
        onShare={() => setShowShare(true)}
        onDelete={deleteProject}
        onConvAction={handleConvAction}
      />

      <main className="main">
        {view === 'requirements' && requirements && (
          <RequirementsScreen
            report={requirements}
            onRecheck={async () => {
              const r = await window.maestrus.requirements.check();
              setRequirements(r);
              // Resolvido? passa pelo gate de auth do Claude e entra no app.
              const stillBlocked = r.items.filter((i) => i.required && !i.ok);
              if (stillBlocked.length === 0) {
                const list = await window.maestrus.projects.list();
                checkAuth(); enterApp(list);
              }
            }}
            onGoSettings={() => setView('settings')}
          />
        )}

        {view === 'settings' && <SettingsScreen
          onGoRemote={() => setView('remote')}
          onModeChange={(mode) => {
            // Troca o modo NA HORA (fonte da verdade do appMode vive aqui e
            // filtra a sidebar). Recarrega a lista pra refletir local vs host —
            // sem precisar reiniciar o app. A sidebar reflete na hora.
            setAppMode(mode);
            reloadProjects();
          }}
        />}

        {view === 'powers' && <ClaudePowersScreen />}
        {view === 'selfhost' && <SelfhostConnect info={selfhost} onConnected={async () => { await reloadProjects(); const fresh = await window.maestrus.projects.list().catch(() => []); setProjects(fresh); enterApp(fresh); }} />}
        {view === 'cloud' && <CloudScreen onAuthed={isWeb ? () => { setAppMode('client'); reloadProjects(); setView('remote'); } : undefined} />}
        {view === 'remote' && <RemoteAccess onConnected={reloadProjects} />}
        {showShare && <ShareWorkspace onClose={() => setShowShare(false)} projects={projects} />}
        {view === 'kanban' && <Kanban projects={projects} />}

        {view === 'starter' && (
          <StarterScreen
            onStartVoice={() => {
              const maestrus = projects.find((p) => p.id === 'maestrus');
              if (maestrus) { setActiveId(maestrus.id); setVoiceTarget(maestrus.id); setView('chat'); }
            }}
            onWakeChanged={(phrase, enabled) => { setWakePhrase(phrase); setWakeEnabled(enabled); }}
            onOpenLink={(url) => setBrowserUrl(url)}
          />
        )}

        {view === 'chat' && activeProject && (
          <ProjectChat
            key={activeProject.id}
            project={activeProject}
            onProjectUpdate={handleProjectUpdate}
            onOpenSettings={() => setView('settings')}
            onOpenLink={(url) => setBrowserUrl(url)}
            openVoiceOnMount={voiceTarget === activeProject.id}
            onVoiceOpened={() => setVoiceTarget(null)}
          />
        )}

        {view === 'empty' && (
          <div className="empty-state">
            <Logo size={56} textSize={36} />
            <div className="empty-sub">{t('empty.subtitle')}</div>
            <p>{t('empty.hint')}</p>
            <button className="btn-primary" onClick={() => setShowNew(true)}>
              {t('empty.cta')}
            </button>
          </div>
        )}
      </main>

      {browserUrl && <LinkPreview url={browserUrl} onClose={() => setBrowserUrl(null)} />}

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreated={handleCreated} />}
      </div>
    </div>
  );
}
