import { useEffect, useMemo, useState, DragEvent } from 'react';
import { KanbanTask, TaskStatus, TaskSettings, Project } from '../types';
import { Plus, Pencil, Trash2, Power, PowerOff, Loader2 } from 'lucide-react';
import { useT } from '../lib/i18n';
import TaskModal from './TaskModal';

interface Props {
  projects: Project[];
}

const COLUMNS: TaskStatus[] = ['backlog', 'ready', 'doing', 'done'];

export default function Kanban({ projects }: Props) {
  const { t } = useT();
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [settings, setSettings] = useState<TaskSettings>({ enabled_global: true, enabled_projects: {} });
  const [filterProject, setFilterProject] = useState<string>('all');
  const [editing, setEditing] = useState<KanbanTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    const [r, s] = await Promise.all([
      window.maestrus.tasks.list(),
      window.maestrus.tasks.settingsGet(),
    ]);
    if (r.ok && r.tasks) setTasks(r.tasks);
    if (s.ok && s.settings) setSettings(s.settings);
    setLoading(false);
  }

  useEffect(() => {
    reload();
    const off = window.maestrus.tasks.onChanged?.(reload);
    const id = setInterval(reload, 10000);
    return () => { clearInterval(id); off && off(); };
  }, []);

  const visibleTasks = useMemo(() => {
    if (filterProject === 'all') return tasks;
    return tasks.filter((tk) => tk.project_id === filterProject);
  }, [tasks, filterProject]);

  function byColumn(status: TaskStatus): KanbanTask[] {
    return visibleTasks
      .filter((tk) => tk.status === status)
      .sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  }

  function projectName(id: string): string {
    return projects.find((p) => p.id === id)?.name || id;
  }

  async function toggleGlobal() {
    const next = !settings.enabled_global;
    setSettings((s) => ({ ...s, enabled_global: next }));
    await window.maestrus.tasks.settingsSet({ enabled_global: next });
  }

  async function toggleProject(projectId: string) {
    const cur = settings.enabled_projects[projectId];
    const isOn = cur === undefined ? true : !!cur;
    const next = { ...settings.enabled_projects, [projectId]: !isOn };
    setSettings((s) => ({ ...s, enabled_projects: next }));
    await window.maestrus.tasks.settingsSet({ enabled_projects: next });
  }

  function isProjectEnabled(projectId: string): boolean {
    if (!settings.enabled_global) return false;
    const v = settings.enabled_projects[projectId];
    return v === undefined ? true : !!v;
  }

  async function moveTask(taskId: string, toStatus: TaskStatus) {
    const tk = tasks.find((x) => x.id === taskId);
    if (!tk || tk.status === toStatus) return;
    const colTasks = byColumn(toStatus);
    const newPos = colTasks.length;
    // optimistic
    setTasks((prev) => prev.map((x) => x.id === taskId ? { ...x, status: toStatus, position: newPos } : x));
    await window.maestrus.tasks.reorder([{ id: taskId, status: toStatus, position: newPos }]);
    reload();
  }

  async function deleteTask(id: string) {
    if (!confirm(t('kanban.confirmDelete'))) return;
    setTasks((prev) => prev.filter((x) => x.id !== id));
    await window.maestrus.tasks.delete(id);
  }

  function onDragStart(e: DragEvent<HTMLDivElement>, id: string) {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  function onDrop(e: DragEvent<HTMLDivElement>, status: TaskStatus) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    if (id) moveTask(id, status);
  }

  return (
    <div className="kanban">
      <header className="kanban-header">
        <div className="kanban-title">
          <h2>{t('kanban.title')}</h2>
          <button
            className={`kanban-master ${settings.enabled_global ? 'on' : 'off'}`}
            onClick={toggleGlobal}
            title={t(settings.enabled_global ? 'kanban.pauseAll' : 'kanban.resumeAll')}
          >
            {settings.enabled_global ? <Power size={13} /> : <PowerOff size={13} />}
            {settings.enabled_global ? t('kanban.running') : t('kanban.paused')}
          </button>
        </div>

        <div className="kanban-filters">
          <select
            className="kanban-filter"
            value={filterProject}
            onChange={(e) => setFilterProject(e.target.value)}
          >
            <option value="all">{t('kanban.allProjects')}</option>
            {projects.filter((p) => p.id !== 'maestrus').map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {filterProject !== 'all' && (
            <button
              className={`kanban-project-toggle ${isProjectEnabled(filterProject) ? 'on' : 'off'}`}
              onClick={() => toggleProject(filterProject)}
              title={t(isProjectEnabled(filterProject) ? 'kanban.pauseProject' : 'kanban.resumeProject')}
            >
              {isProjectEnabled(filterProject) ? <Power size={12} /> : <PowerOff size={12} />}
              {isProjectEnabled(filterProject) ? t('kanban.projectOn') : t('kanban.projectOff')}
            </button>
          )}
          <button className="kanban-new" onClick={() => setCreating(true)}>
            <Plus size={13} /> {t('kanban.newTask')}
          </button>
        </div>
      </header>

      {loading ? (
        <div className="kanban-loading"><Loader2 size={18} className="spin" /></div>
      ) : (
        <div className="kanban-board">
          {COLUMNS.map((status) => {
            const col = byColumn(status);
            return (
              <div
                key={status}
                className={`kanban-col kanban-col-${status}`}
                onDragOver={onDragOver}
                onDrop={(e) => onDrop(e, status)}
              >
                <div className="kanban-col-head">
                  <span className="kanban-col-name">{t(`kanban.col.${status}`)}</span>
                  <span className="kanban-col-count">{col.length}</span>
                </div>
                <div className="kanban-col-body">
                  {col.map((tk) => {
                    const enabled = isProjectEnabled(tk.project_id);
                    return (
                      <div
                        key={tk.id}
                        className={`kanban-card ${tk.status === 'doing' ? 'doing' : ''} ${!enabled ? 'paused' : ''}`}
                        draggable
                        onDragStart={(e) => onDragStart(e, tk.id)}
                      >
                        <div className="kanban-card-title">{tk.title}</div>
                        <div className="kanban-card-meta">
                          <span className="kanban-card-proj">{projectName(tk.project_id)}</span>
                          {!enabled && <span className="kanban-card-paused">{t('kanban.paused')}</span>}
                        </div>
                        <div className="kanban-card-actions">
                          <button onClick={() => setEditing(tk)} title={t('common.edit')}><Pencil size={11} /></button>
                          <button onClick={() => deleteTask(tk.id)} title={t('common.delete')}><Trash2 size={11} /></button>
                        </div>
                      </div>
                    );
                  })}
                  {col.length === 0 && <div className="kanban-col-empty">—</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <TaskModal
          task={editing}
          projects={projects.filter((p) => p.id !== 'maestrus')}
          defaultProjectId={filterProject !== 'all' ? filterProject : undefined}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}
