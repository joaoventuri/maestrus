import { useEffect, useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { KanbanTask, Project, TaskStatus } from '../types';
import { useT } from '../lib/i18n';

interface Props {
  task: KanbanTask | null;
  projects: Project[];
  defaultProjectId?: string;
  onClose: () => void;
  onSaved: () => void;
}

const STATUSES: TaskStatus[] = ['backlog', 'ready', 'doing', 'done', 'failed'];

export default function TaskModal({ task, projects, defaultProjectId, onClose, onSaved }: Props) {
  const { t } = useT();
  const isEdit = !!task;
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [projectId, setProjectId] = useState(task?.project_id || defaultProjectId || projects[0]?.id || '');
  const [status, setStatus] = useState<TaskStatus>(task?.status || 'ready');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Loop automático: extrai de description existente ou inicia desligado
  const existingLoop = task?.description?.match(/^\[LOOP:(\d+)\]/i);
  const [loopEnabled, setLoopEnabled] = useState(!!existingLoop);
  const [loopMax, setLoopMax] = useState(existingLoop ? parseInt(existingLoop[1], 10) : 3);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    if (!title.trim()) { setErr(t('kanban.titleRequired')); return; }
    if (!projectId) { setErr(t('kanban.projectRequired')); return; }
    setSaving(true);
    setErr(null);
    try {
      // Prepend [LOOP:N] no description se loop estiver ativo
      const baseDesc = (description || '').replace(/^\[LOOP:\d+\]\n?/i, '');
      const finalDesc = loopEnabled && loopMax > 1 ? `[LOOP:${loopMax}]\n${baseDesc}` : baseDesc;
      if (isEdit && task) {
        const r = await window.maestrus.tasks.update(task.id, {
          title: title.trim(),
          description: finalDesc,
          project_id: projectId,
          status,
        });
        if (!r.ok) throw new Error(r.error || 'update_failed');
      } else {
        const r = await window.maestrus.tasks.create({
          title: title.trim(),
          description: finalDesc,
          project_id: projectId,
          status,
        });
        if (!r.ok) throw new Error(r.error || 'create_failed');
      }
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal task-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{isEdit ? t('kanban.editTask') : t('kanban.newTask')}</h3>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">
          <label className="form-label">{t('kanban.title')}</label>
          <input
            className="form-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('kanban.titlePlaceholder')}
            autoFocus
          />

          <label className="form-label">{t('kanban.project')}</label>
          <select
            className="form-input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={projects.length === 0}
          >
            {projects.length === 0 && <option value="">{t('kanban.noProjects')}</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <label className="form-label">{t('kanban.status')}</label>
          <select
            className="form-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{t(`kanban.col.${s}`)}</option>
            ))}
          </select>

          <label className="form-label">{t('kanban.description')}</label>
          <textarea
            className="form-input"
            rows={6}
            value={description || ''}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('kanban.descPlaceholder')}
          />

          <div className="task-loop-row">
            <button
              type="button"
              className={`task-loop-toggle ${loopEnabled ? 'on' : ''}`}
              onClick={() => setLoopEnabled((v) => !v)}
              title={t('kanban.loopTooltip')}
            >
              <RefreshCw size={13} />
              {t('kanban.loop')}
            </button>
            {loopEnabled && (
              <label className="task-loop-iter">
                {t('kanban.loopMax')}
                <input
                  type="number"
                  min={2}
                  max={25}
                  value={loopMax}
                  onChange={(e) => setLoopMax(Math.min(25, Math.max(2, parseInt(e.target.value) || 2)))}
                  className="task-loop-num"
                />
                {t('kanban.loopTimes')}
              </label>
            )}
          </div>

          {err && <div className="form-error">{err}</div>}
        </div>
        <footer className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={saving} onClick={save}>
            {saving ? '…' : t('common.save')}
          </button>
        </footer>
      </div>
    </div>
  );
}
