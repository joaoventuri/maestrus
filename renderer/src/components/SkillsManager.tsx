import { useEffect, useState } from 'react';
import { Sparkles, Plus, Loader2, Trash2, Pencil, Check, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { SkillSummary } from '../types';

// Gerenciador de Skills do Claude. Skills ficam em ~/.claude/skills e valem em
// TODA sessão de TODO projeto automaticamente. CRUD simples: nome, descrição
// (quando usar) e instruções (corpo do SKILL.md).
const EMPTY = { id: '', name: '', description: '', body: '' };

export default function SkillsManager() {
  const { t } = useT();
  const [items, setItems] = useState<SkillSummary[] | null>(null);
  const [editing, setEditing] = useState<typeof EMPTY | null>(null);
  const [busy, setBusy] = useState(false);
  const skills = window.maestrus.skills;

  async function load() {
    if (!skills) { setItems([]); return; }
    const r = await skills.list();
    setItems(r.skills || []);
  }
  useEffect(() => { load(); }, []);

  async function openNew() { setEditing({ ...EMPTY }); }
  async function openEdit(id: string) {
    if (!skills) return;
    const s = await skills.get(id);
    if (s) setEditing({ id: s.id, name: s.name, description: s.description, body: s.body });
  }

  async function saveSkill() {
    if (!skills || !editing || !editing.name.trim()) return;
    setBusy(true);
    try {
      await skills.save({ id: editing.id || undefined, name: editing.name.trim(), description: editing.description.trim(), body: editing.body });
      setEditing(null);
      await load();
    } finally { setBusy(false); }
  }

  async function del(id: string) {
    if (!skills) return;
    if (!window.confirm(t('skills.confirmDelete'))) return;
    setBusy(true);
    try { await skills.delete(id); await load(); } finally { setBusy(false); }
  }

  if (items === null) return <div className="page-sub"><Loader2 size={13} className="spin" /> {t('skills.loading')}</div>;
  if (!skills) return <div className="page-sub">{t('skills.unavailable')}</div>;

  return (
    <div className="skills-mgr">
      {items.length === 0 && <div className="page-sub">{t('skills.empty')}</div>}
      <div className="skills-list">
        {items.map((s) => (
          <div key={s.id} className="skill-row">
            <div className="skill-info">
              <span className="skill-name"><Sparkles size={13} /> {s.name}</span>
              {s.description && <span className="skill-desc">{s.description}</span>}
            </div>
            <div className="skill-actions">
              <button className="icon-btn" onClick={() => openEdit(s.id)} title={t('skills.edit')}><Pencil size={14} /></button>
              <button className="icon-btn danger" onClick={() => del(s.id)} title={t('skills.delete')}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>

      <button className="btn-secondary mcp-add" onClick={openNew}>
        <Plus size={13} /> {t('skills.add')}
      </button>

      {editing && (
        <div className="mcp-modal-backdrop" onClick={() => setEditing(null)}>
          <div className="mcp-modal skill-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-modal-head">
              <h3><Sparkles size={15} /> {editing.id ? t('skills.editTitle') : t('skills.newTitle')}</h3>
              <button className="icon-btn" onClick={() => setEditing(null)}><X size={16} /></button>
            </div>
            <label className="mcp-field"><span>{t('skills.fieldName')}</span>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder={t('skills.namePlaceholder')} /></label>
            <label className="mcp-field"><span>{t('skills.fieldDesc')}</span>
              <textarea rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder={t('skills.descPlaceholder')} /></label>
            <label className="mcp-field"><span>{t('skills.fieldBody')}</span>
              <textarea rows={10} className="skill-body" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} placeholder={t('skills.bodyPlaceholder')} /></label>
            <div className="mcp-card-actions" style={{ marginTop: 10 }}>
              <div style={{ flex: 1 }} />
              <button className="btn-secondary" onClick={() => setEditing(null)}>{t('skills.cancel')}</button>
              <button className="btn-primary" onClick={saveSkill} disabled={!editing.name.trim() || busy}>
                {busy ? <Loader2 size={12} className="spin" /> : <Check size={12} />} {t('skills.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
