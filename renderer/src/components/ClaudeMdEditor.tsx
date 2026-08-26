import { useEffect, useState } from 'react';
import { Save, FileText, Eye, Code2, ExternalLink } from 'lucide-react';
import { marked } from 'marked';
import { Project } from '../types';
import { useT } from '../lib/i18n';

interface Props {
  project: Project;
  onClose: () => void;
}

marked.setOptions({ gfm: true, breaks: true });

export default function ClaudeMdEditor({ project, onClose }: Props) {
  const { t } = useT();
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview' | 'split'>('split');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const f = await window.maestrus.claudeMd.ensure(project.id);
      setContent(f.content);
      setOriginal(f.content);
      setPath(f.path);
    })();
  }, [project.id]);

  const dirty = content !== original;

  async function save() {
    setSaving(true);
    try {
      const f = await window.maestrus.claudeMd.write(project.id, content);
      setOriginal(f.content);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, content]);

  return (
    <div className="md-editor">
      <header className="md-head">
        <div className="md-head-left">
          <FileText size={15} />
          <span className="md-title">CLAUDE.md</span>
          {path && (
            <button
              className="md-path"
              title={t('claudeMd.openFolder')}
              onClick={() => path && window.maestrus.shell.openFolder(path.replace(/[\\/][^\\/]+$/, ''))}
            >
              {path}
              <ExternalLink size={11} />
            </button>
          )}
          {dirty && <span className="md-dirty">● {t('claudeMd.unsaved')}</span>}
          {!dirty && savedAt && (
            <span className="md-saved">{t('claudeMd.savedAt', { time: new Date(savedAt).toLocaleTimeString() })}</span>
          )}
        </div>
        <div className="md-head-right">
          <div className="md-tabs">
            <button
              className={`md-tab ${mode === 'edit' ? 'active' : ''}`}
              onClick={() => setMode('edit')}
              title={t('claudeMd.edit')}
            ><Code2 size={13} /></button>
            <button
              className={`md-tab ${mode === 'split' ? 'active' : ''}`}
              onClick={() => setMode('split')}
              title={t('claudeMd.split')}
            >split</button>
            <button
              className={`md-tab ${mode === 'preview' ? 'active' : ''}`}
              onClick={() => setMode('preview')}
              title={t('claudeMd.preview')}
            ><Eye size={13} /></button>
          </div>
          <button className="btn-primary md-save" onClick={save} disabled={!dirty || saving}>
            <Save size={13} /> {t('common.save')}
          </button>
          <button className="btn-secondary" onClick={onClose}>{t('claudeMd.backToChat')}</button>
        </div>
      </header>

      <div className={`md-body md-mode-${mode}`}>
        {(mode === 'edit' || mode === 'split') && (
          <textarea
            className="md-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            placeholder={t('claudeMd.placeholder')}
          />
        )}
        {(mode === 'preview' || mode === 'split') && (
          <div
            className="md-preview markdown"
            dangerouslySetInnerHTML={{ __html: marked.parse(content || '', { async: false }) as string }}
          />
        )}
      </div>
    </div>
  );
}
