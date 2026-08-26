import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Plus, Pencil, Trash2, Power, PowerOff, X } from 'lucide-react';
import Logo from '../components/Logo';
import { useT } from '../lib/i18n';

const M = () => (window as any).maestrus;
const COLUMNS = ['backlog', 'ready', 'doing', 'done'] as const;
type Status = (typeof COLUMNS)[number] | 'failed';

interface Props {
  onBack: () => void;
  projects: any[];
}

export default function MobileKanban({ onBack, projects }: Props) {
  const { t } = useT();
  const [tasks, setTasks] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({ enabled_global: true, enabled_projects: {} });
  const [tab, setTab] = useState<Status>('ready');
  const [filterProject, setFilterProject] = useState<string>('all');
  const [editing, setEditing] = useState<any>(null);
  const [creating, setCreating] = useState(false);

  async function reload() {
    const [r, s] = await Promise.all([M().tasks.list(), M().tasks.settingsGet()]);
    if (r && r.ok && r.tasks) setTasks(r.tasks);
    if (s && s.ok && s.settings) setSettings(s.settings);
  }
  useEffect(() => { reload(); const id = setInterval(reload, 12000); return () => clearInterval(id); }, []);

  const visible = useMemo(() => {
    const arr = filterProject === 'all' ? tasks : tasks.filter((tk) => tk.project_id === filterProject);
    return arr.filter((tk) => tk.status === tab).sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  }, [tasks, filterProject, tab]);

  function projectName(id: string): string {
    return projects.find((p) => p.id === id)?.name || id;
  }
  function isProjectOn(id: string): boolean {
    if (!settings.enabled_global) return false;
    const v = settings.enabled_projects[id];
    return v === undefined ? true : !!v;
  }

  async function toggleGlobal() {
    const next = !settings.enabled_global;
    setSettings((s: any) => ({ ...s, enabled_global: next }));
    await M().tasks.settingsSet({ enabled_global: next });
  }
  async function moveTo(id: string, status: Status) {
    setTasks((prev) => prev.map((x) => x.id === id ? { ...x, status } : x));
    await M().tasks.update(id, { status });
    reload();
  }
  async function deleteTask(id: string) {
    if (!confirm(t('kanban.confirmDelete'))) return;
    setTasks((prev) => prev.filter((x) => x.id !== id));
    await M().tasks.delete(id);
  }

  return (
    <div className="m-screen m-kanban">
      <header className="m-top">
        <button className="m-link" onClick={onBack} aria-label="Back"><ChevronLeft size={22} /></button>
        <Logo size={20} textSize={16} />
        <button
          className={`m-kanban-master ${settings.enabled_global ? 'on' : 'off'}`}
          onClick={toggleGlobal}
          aria-label={settings.enabled_global ? 'pause' : 'resume'}
        >
          {settings.enabled_global ? <Power size={16} /> : <PowerOff size={16} />}
        </button>
      </header>

      <div className="m-kanban-controls">
        <select
          className="m-kanban-filter"
          value={filterProject}
          onChange={(e) => setFilterProject(e.target.value)}
        >
          <option value="all">{t('kanban.allProjects')}</option>
          {projects.filter((p) => p.id !== 'maestrus').map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button className="m-kanban-new" onClick={() => setCreating(true)}>
          <Plus size={16} />
        </button>
      </div>

      <div className="m-kanban-tabs">
        {COLUMNS.map((s) => {
          const count = (filterProject === 'all' ? tasks : tasks.filter((tk) => tk.project_id === filterProject))
            .filter((tk) => tk.status === s).length;
          return (
            <button
              key={s}
              className={`m-kanban-tab ${tab === s ? 'on' : ''}`}
              onClick={() => setTab(s)}
            >
              <span>{t(`kanban.col.${s}`)}</span>
              <span className="m-kanban-tab-n">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="m-kanban-list">
        {visible.length === 0 && <div className="m-kanban-empty">{t('kanban.col.' + tab)} — —</div>}
        {visible.map((tk) => {
          const on = isProjectOn(tk.project_id);
          return (
            <div key={tk.id} className={`m-kanban-card ${tk.status === 'doing' ? 'doing' : ''} ${!on ? 'paused' : ''}`}>
              <div className="m-kanban-card-row">
                <div className="m-kanban-card-title">{tk.title}</div>
                <div className="m-kanban-card-act">
                  <button onClick={() => setEditing(tk)} aria-label="edit"><Pencil size={14} /></button>
                  <button onClick={() => deleteTask(tk.id)} aria-label="del"><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="m-kanban-card-meta">
                <span className="m-kanban-card-proj">{projectName(tk.project_id)}</span>
                {!on && <span className="m-kanban-card-paused">{t('kanban.paused')}</span>}
              </div>
              <div className="m-kanban-move">
                {COLUMNS.filter((s) => s !== tk.status).map((s) => (
                  <button key={s} onClick={() => moveTo(tk.id, s)}>→ {t(`kanban.col.${s}`)}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {(creating || editing) && (
        <MobileTaskSheet
          task={editing}
          projects={projects.filter((p) => p.id !== 'maestrus')}
          defaultProjectId={filterProject !== 'all' ? filterProject : undefined}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); reload(); }}
          t={t}
        />
      )}
    </div>
  );
}

function MobileTaskSheet({ task, projects, defaultProjectId, onClose, onSaved, t }: any) {
  const isEdit = !!task;
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [projectId, setProjectId] = useState(task?.project_id || defaultProjectId || projects[0]?.id || '');
  const [status, setStatus] = useState<string>(task?.status || 'ready');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) { setErr(t('kanban.titleRequired')); return; }
    if (!projectId) { setErr(t('kanban.projectRequired')); return; }
    setSaving(true);
    try {
      if (isEdit) await M().tasks.update(task.id, { title: title.trim(), description, project_id: projectId, status });
      else        await M().tasks.create({ title: title.trim(), description, project_id: projectId, status });
      onSaved();
    } catch (e: any) {
      setErr(e.message || 'erro');
    } finally { setSaving(false); }
  }

  return (
    <div className="m-sheet-bg" onClick={onClose}>
      <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="m-sheet-head">
          <h3>{isEdit ? t('kanban.editTask') : t('kanban.newTask')}</h3>
          <button onClick={onClose} aria-label="x"><X size={18} /></button>
        </header>
        <div className="m-sheet-body">
          <label>{t('kanban.title')}</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('kanban.titlePlaceholder')} autoFocus />

          <label>{t('kanban.project')}</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 && <option value="">{t('kanban.noProjects')}</option>}
            {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <label>{t('kanban.status')}</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['backlog', 'ready', 'doing', 'done', 'failed'].map((s) => (
              <option key={s} value={s}>{t(`kanban.col.${s}`)}</option>
            ))}
          </select>

          <label>{t('kanban.description')}</label>
          <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('kanban.descPlaceholder')} />

          {err && <div className="m-sheet-err">{err}</div>}
        </div>
        <footer className="m-sheet-foot">
          <button className="m-btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="m-btn-primary" disabled={saving} onClick={save}>{saving ? '…' : t('common.save')}</button>
        </footer>
      </div>
    </div>
  );
}
