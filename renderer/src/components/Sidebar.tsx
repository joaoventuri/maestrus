import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, ListChecks, Settings, X, FolderGit2, HardDrive, Globe, Folder, Plug, Music4, Sun, Moon, Cloud, Server, RefreshCw, Loader2, Kanban as KanbanIcon, Zap, Power, Share2, ChevronRight, ChevronDown, GitBranch, Pencil, Trash2, MessageSquare } from 'lucide-react';
import { Project, ProjectSource } from '../types';
import Logo from './Logo';
import { useTheme } from '../lib/theme';
import { useT } from '../lib/i18n';
import { playMaestrusOpen } from '../lib/sound';
import { useActivityMap } from '../lib/activity-store';
import ActivityIndicator from './ActivityDot';

interface Props {
  projects: Project[];
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onRequirements: () => void;
  onSettings: () => void;
  onMcp: () => void;
  onPowers?: () => void;
  onCloud: () => void;
  onRemote: () => void;
  onKanban: () => void;
  onStarter: () => void;
  onDelete: (id: string) => void;
  // Ações de conversas (forks) e rename — executadas pelo App (dono do estado).
  onConvAction?: (action: 'fork' | 'forkConv' | 'renameProject' | 'renameConv' | 'deleteConv', projectId: string, convId?: string, value?: string) => void;
  onShare?: () => void;
  mode?: 'server' | 'client' | null;
  cloudFirst?: boolean;   // web = "a cara" do container: esconde banner/badges de conexão
  clientHostName?: string | null;
  clientConnected?: boolean;
  clientSyncing?: boolean;
  clientHostCount?: number;
  clientProjectCount?: number;
}

function SourceIcon({ source }: { source: ProjectSource }) {
  const props = { size: 13 };
  if (source === 'github') return <FolderGit2 {...props} />;
  if (source === 'local') return <HardDrive {...props} />;
  if (source === 'production') return <Globe {...props} />;
  if (source === 'maestrus') return <Music4 {...props} />;
  return <Folder {...props} />;
}

export default function Sidebar({
  projects, activeId, onPick, onNew, onRequirements, onSettings, onMcp, onPowers, onCloud, onRemote, onKanban, onStarter, onDelete, onConvAction, onShare,
  mode, cloudFirst, clientHostName, clientConnected, clientSyncing, clientHostCount, clientProjectCount,
}: Props) {
  const maestrus = projects.find((p) => p.id === 'maestrus');
  // Esconde orquestrador e Inicializador — inclusive os vindos de um host remoto
  // (ids "remote:<hostId>:maestrus" / ":starter"), que não são sessões reais.
  const others = projects.filter((p) => {
    if (p.id === 'maestrus' || p.id === 'starter') return false;
    const rpid = (p as any).remoteProjectId;
    return rpid !== 'maestrus' && rpid !== 'starter';
  });
  const { theme, toggle } = useTheme();
  const { t } = useT();
  const activity = useActivityMap();
  // Web: esconde ferramentas puramente desktop (Voice Launcher/wake word,
  // checagem de Requisitos locais, MCP do CLI local). Kanban roda via tasks.
  const isWeb = !!(window as any).maestrus?.isWeb;

  // ── Conversas (forks): accordion + menu de contexto + rename inline ──────
  const convsOf = (p: Project): any[] => ((p as any).conversations || []);
  const convKey = (p: Project, cid: string) => `${p.id}#${cid}`;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('maestrus-conv-expanded') || '{}'); } catch { return {}; }
  });
  function toggleExpand(id: string) {
    setExpanded((e) => {
      const n = { ...e, [id]: !e[id] };
      try { localStorage.setItem('maestrus-conv-expanded', JSON.stringify(n)); } catch {}
      return n;
    });
  }
  const [menu, setMenu] = useState<{ x: number; y: number; projectId: string; convId?: string } | null>(null);
  const [editing, setEditing] = useState<{ projectId: string; convId?: string } | null>(null);
  const [editText, setEditText] = useState('');
  const editRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) setTimeout(() => editRef.current?.select(), 30); }, [editing]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [menu]);
  function openMenu(e: React.MouseEvent, projectId: string, convId?: string) {
    if (!onConvAction) return;
    e.preventDefault(); e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, projectId, convId });
  }
  function startRename(projectId: string, convId?: string, current?: string) {
    setEditing({ projectId, convId });
    setEditText(current || '');
    setMenu(null);
  }
  function commitRename() {
    if (!editing || !onConvAction) return setEditing(null);
    const text = editText.trim();
    if (text) onConvAction(editing.convId ? 'renameConv' : 'renameProject', editing.projectId, editing.convId, text);
    setEditing(null);
  }
  // Atividade agregada do projeto = a própria conversa principal OU qualquer fork
  // trabalhando (a bolinha do projeto continua pulsando mesmo com o fork fechado).
  function aggActivity(p: Project) {
    const keys = [p.id, ...convsOf(p).map((c) => convKey(p, c.id))];
    let agg: any = null;
    for (const k of keys) {
      const a = (activity as any)[k];
      if (!a) continue;
      if (a.status === 'working') return a;
      if (!agg || (a.status === 'unread' && agg.status !== 'unread')) agg = a;
    }
    return agg;
  }

  // Liga/desliga do projeto cloud direto na lista (resume/pause do sandbox).
  // Status OTIMISTA: muda a cor na hora; trava clique enquanto transiciona (sem
  // loop); erro ao ligar → volta cinza (não pinta verde mentiroso).
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [statusOverride, setStatusOverride] = useState<Record<string, string>>({});
  function cloudStatusOf(p: Project): string { return statusOverride[p.id] || (p as any).cloudStatus || ''; }
  function setOverride(id: string, s: string, clearMs = 12000) {
    setStatusOverride((o) => ({ ...o, [id]: s }));
    if (clearMs) setTimeout(() => setStatusOverride((o) => { const n = { ...o }; delete n[id]; return n; }), clearMs);
  }
  async function toggleCloud(p: Project) {
    const cloud = (window as any).maestrus?.cloud;
    if (!cloud || cloudBusy) return;                  // já transicionando → ignora clique (sem loop)
    const pid = (p as any).remoteProjectId || String((p as any).remoteHostId || '').replace(/^cloud-\d+-/, '') || p.id;
    const running = cloudStatusOf(p) === 'running';
    setCloudBusy(p.id);
    setStatusOverride((o) => ({ ...o, [p.id]: running ? 'paused' : 'starting' })); // otimista imediato
    try {
      const r = running ? await cloud.cloudPause?.(pid) : await cloud.cloudResume?.(pid);
      const ok = !(r && r.ok === false);
      setOverride(p.id, running ? 'paused' : (ok ? 'running' : 'stopped'));         // erro ao ligar → cinza
    } catch { setOverride(p.id, running ? 'paused' : 'stopped'); }
    finally {
      setCloudBusy(null);
      try { (window as any).maestrus?.remote?.refreshProjects?.(); } catch {}
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <Logo size={30} textSize={21} />
        <button className="btn-icon" title={t('nav.newProject')} onClick={onNew}>
          <Plus size={15} />
        </button>
      </div>

      {/* cloudFirst (web): o container é transparente — não mostra banner de conexão. */}
      {!cloudFirst && (mode === 'client' || clientConnected || clientSyncing) && (
        <button
          className={`client-banner ${clientConnected ? 'on' : 'off'}`}
          onClick={onRemote}
          title={t('mode.clientManage')}
        >
          {clientSyncing ? <Loader2 size={13} className="spin" /> : <Server size={13} />}
          <span className="client-banner-text">
            {clientSyncing
              ? t('mode.syncing')
              : clientConnected
                ? <>{t('mode.connectedTo')} <strong>{clientHostName || t('mode.host')}</strong>{(clientProjectCount ?? 0) > 0 ? <span className="client-banner-count"> · {t('mode.projectsCount', { n: clientProjectCount ?? 0 })}</span> : null}</>
                : t('mode.clientConnect')}
          </span>
          <span className={`client-dot ${clientSyncing ? 'sync' : clientConnected ? 'on' : 'off'}`} />
        </button>
      )}

      <nav className="sidebar-nav">
        {maestrus && (
          <>
            <div className="nav-section-title">{t('nav.orchestrator')}</div>
            <div
              className={`nav-item maestrus ${activeId === maestrus.id ? 'active' : ''} ${activity[maestrus.id]?.status === 'unread' ? 'has-unread' : ''}`}
              onClick={() => { playMaestrusOpen(); onPick(maestrus.id); }}
              title={t('nav.orchestratorTooltip')}
            >
              <span className="nav-item-icon" data-source="maestrus">
                <Logo size={16} showText={false} />
              </span>
              <span className="nav-item-name">{maestrus.name}</span>
              <ActivityIndicator activity={activity[maestrus.id] || null} />
            </div>
          </>
        )}

        <div className="nav-section-title">{t('nav.projects')}</div>
        {others.length === 0 && (
          <div className="nav-empty">{t('nav.noProjects')}</div>
        )}
        {others.map((p) => {
          const convs = convsOf(p);
          const isOpen = convs.length > 0 && (expanded[p.id] !== false);
          const isEditingProj = editing && editing.projectId === p.id && !editing.convId;
          return (
          <div key={p.id} className="nav-project-group">
          <div
            className={`nav-item ${activeId === p.id ? 'active' : ''} ${aggActivity(p)?.status === 'unread' ? 'has-unread' : ''}`}
            onClick={() => onPick(p.id)}
            onContextMenu={(e) => openMenu(e, p.id)}
          >
            {convs.length > 0 && (
              <button className="nav-conv-chevron" onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }} title={isOpen ? '' : `${convs.length}`}>
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            )}
            <span className="nav-item-icon" data-source={p.source}>
              {/* cloudFirst: o container é transparente — ícone da origem REAL do
                  projeto (github/local/…), sem tratar como cloud/remote. */}
              {cloudFirst
                ? <SourceIcon source={((p as any).realSource || p.source) as ProjectSource} />
                : (p as any).shareId
                  ? <Share2 size={13} />
                  : (p as any).cloud || p.source === 'cloud'
                    ? <Cloud size={13} />
                    : p.remoteHostId ? <Server size={13} /> : <SourceIcon source={p.source} />}
            </span>
            {isEditingProj ? (
              <input
                ref={editRef}
                className="nav-rename-input"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(null); }}
                onBlur={commitRename}
              />
            ) : (
              <span className="nav-item-name">{p.name}</span>
            )}
            <ActivityIndicator activity={aggActivity(p) || null} />
            {!cloudFirst && ((p as any).cloud || p.source === 'cloud') && (() => {
              const cs = cloudStatusOf(p);
              return <>
                <span className={`nav-cloud-dot ${cs === 'running' ? 'on' : (cs === 'paused' ? 'paused' : (cs === 'starting' ? 'starting' : ''))}`} title={cs} />
                <button
                  className={`nav-cloud-power ${cs === 'running' ? 'on' : ''}`}
                  title={cs === 'running' ? t('cloud.powerOff') : t('cloud.powerOn')}
                  onClick={(e) => { e.stopPropagation(); toggleCloud(p); }}
                >
                  {cloudBusy === p.id || cs === 'starting' ? <Loader2 size={12} className="spin" /> : <Power size={12} />}
                </button>
              </>;
            })()}
            {!cloudFirst && ((p as any).shareId
              ? <span className="nav-remote-badge shared" title={`Shared · ${(p as any).remoteHostName || ''}`}><Share2 size={11} /></span>
              : ((p as any).cloud || p.source === 'cloud')
                ? <span className="nav-remote-badge cloud" title={t('remote.cloudBadge') || 'Cloud'}><Cloud size={11} /></span>
                : p.remoteHostId && <span className="nav-remote-badge" title={`${t('remote.badge')} · ${p.remoteHostName || ''}`}><Server size={11} /></span>)}
            <button
              className="nav-item-del"
              title={t('common.remove')}
              onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
            >
              <X size={13} />
            </button>
          </div>
          {isOpen && convs.map((c: any) => {
            const cid = convKey(p, c.id);
            const isEditingConv = editing && editing.projectId === p.id && editing.convId === c.id;
            return (
              <div
                key={cid}
                className={`nav-item nav-conv ${activeId === cid ? 'active' : ''} ${activity[cid]?.status === 'unread' ? 'has-unread' : ''}`}
                onClick={() => onPick(cid)}
                onContextMenu={(e) => openMenu(e, p.id, c.id)}
              >
                <span className="nav-conv-line" />
                <span className="nav-item-icon nav-conv-icon"><MessageSquare size={12} /></span>
                {isEditingConv ? (
                  <input
                    ref={editRef}
                    className="nav-rename-input"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(null); }}
                    onBlur={commitRename}
                  />
                ) : (
                  <span className="nav-item-name">{c.title}</span>
                )}
                <ActivityIndicator activity={activity[cid] || null} />
                <button
                  className="nav-item-del"
                  title={t('common.remove')}
                  onClick={(e) => { e.stopPropagation(); onConvAction && onConvAction('deleteConv', p.id, c.id); }}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
          </div>
          );
        })}

        {menu && (() => {
          const mp = projects.find((pp) => pp.id === menu.projectId);
          const mc = mp ? convsOf(mp).find((c: any) => c.id === menu.convId) : null;
          if (!mp) return null;
          return (
            <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
              {!menu.convId && <>
                <button className="ctx-item" onClick={() => { setMenu(null); onConvAction && onConvAction('fork', mp.id); }}>
                  <GitBranch size={13} /> {t('conv.fork')}
                </button>
                <button className="ctx-item" onClick={() => startRename(mp.id, undefined, mp.name)}>
                  <Pencil size={13} /> {t('conv.renameProject')}
                </button>
                <button className="ctx-item danger" onClick={() => { setMenu(null); onDelete(mp.id); }}>
                  <Trash2 size={13} /> {t('common.remove')}
                </button>
              </>}
              {menu.convId && mc && <>
                <button className="ctx-item" onClick={() => { setMenu(null); onConvAction && onConvAction('forkConv', mp.id, mc.id); }}>
                  <GitBranch size={13} /> {t('conv.fork')}
                </button>
                <button className="ctx-item" onClick={() => startRename(mp.id, mc.id, mc.title)}>
                  <Pencil size={13} /> {t('conv.rename')}
                </button>
                <button className="ctx-item danger" onClick={() => { setMenu(null); onConvAction && onConvAction('deleteConv', mp.id, mc.id); }}>
                  <Trash2 size={13} /> {t('conv.delete')}
                </button>
              </>}
            </div>
          );
        })()}

        <button className="nav-new" onClick={onNew}>
          <Plus size={14} /> {t('nav.newProject')}
        </button>
      </nav>

      <div className="sidebar-footer">
        {!isWeb && (
          <button className="nav-tool" onClick={onStarter}>
            <Zap size={13} /> {t('nav.starter')}
          </button>
        )}
        {onPowers && (
          <button className="nav-tool nav-powers" onClick={onPowers}>
            <Zap size={13} /> Claude Powers
          </button>
        )}
        <button className="nav-tool" onClick={onKanban}>
          <KanbanIcon size={13} /> {t('nav.kanban')}
        </button>
        {!(window as any).maestrus?.isSelfhost && (
          <button className="nav-tool" onClick={onCloud}>
            <Cloud size={13} /> Maestrus Cloud
          </button>
        )}
        <button className="nav-tool" onClick={onRemote}>
          <Server size={13} /> {t('nav.remote')}
        </button>
        {onShare && (
          <button className="nav-tool" onClick={onShare}>
            <Share2 size={13} /> {t('nav.share') || 'Share Workspace'}
          </button>
        )}
        {!isWeb && (
          <button className="nav-tool" onClick={onRequirements}>
            <ListChecks size={13} /> {t('nav.requirements')}
          </button>
        )}
        <button className="nav-tool" onClick={onSettings}>
          <Settings size={13} /> {t('nav.settings')}
        </button>
        <button
          className="nav-tool theme-toggle"
          onClick={toggle}
          title={t('nav.themeTooltip', { theme })}
        >
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
          {theme === 'dark' ? t('nav.lightMode') : t('nav.darkMode')}
        </button>
      </div>
    </aside>
  );
}
