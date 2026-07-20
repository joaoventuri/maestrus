import { useEffect, useRef, useState } from 'react';
import { LayoutGrid, FileText, Folder, Download, X } from 'lucide-react';
import { ModelChoice, PermissionMode, Project, ThinkingMode } from '../types';
import ModelPicker from './ModelPicker';
import ThinkingPicker from './ThinkingPicker';
import PermissionPicker from './PermissionPicker';
import ContextRing from './ContextRing';
import { useT } from '../lib/i18n';

interface Props {
  project: Project;
  contextUsed: number;
  contextTotal: number;
  engine?: 'claude' | 'cloud';
  onModel: (m: ModelChoice) => void;
  onThinking: (t: ThinkingMode) => void;
  onPermission: (p: PermissionMode) => void;
  onEditMd: () => void;
  onExportConfig: () => void;
  onOpenFolder: () => void;
}

export default function MetaPanel({
  project,
  contextUsed,
  contextTotal,
  engine,
  onModel,
  onThinking,
  onPermission,
  onEditMd,
  onExportConfig,
  onOpenFolder,
}: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      // Os menus de picker (modelo/thinking/permissão) são renderizados via
      // portal no document.body — ficam FORA da div do MetaPanel. Sem isto, um
      // clique numa option contava como "clique fora" e fechava o popover antes
      // de selecionar. Ignora cliques dentro de qualquer .picker-menu.
      if (target?.closest && target.closest('.picker-menu')) return;
      if (ref.current && !ref.current.contains(target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div className="meta-panel" ref={ref}>
      <ContextRing used={contextUsed} total={contextTotal} size={32} />
      <button
        className={`meta-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen(!open)}
        title={t('chat.openPanel')}
      >
        {open ? <X size={15} /> : <LayoutGrid size={15} />}
      </button>

      {open && (
        <div className="meta-popover">
          <div className="meta-popover-grid">
            <div className="meta-cell">
              <label className="meta-cell-label">{t('chat.model')}</label>
              <ModelPicker value={project.model || 'sonnet'} onChange={onModel} engine={engine} />
            </div>
            <div className="meta-cell">
              <label className="meta-cell-label">{t('chat.thinking')}</label>
              <ThinkingPicker value={project.thinkingMode || 'medium'} onChange={onThinking} />
            </div>
            <div className="meta-cell">
              <label className="meta-cell-label">{t('chat.permissions')}</label>
              <PermissionPicker value={project.permissionMode || 'bypassPermissions'} onChange={onPermission} />
            </div>
            {project.source !== 'maestrus' && (
              <div className="meta-cell">
                <label className="meta-cell-label">{t('chat.edit')}</label>
                <button className="chat-meta-btn full" onClick={() => { setOpen(false); onEditMd(); }}>
                  <FileText size={13} /> CLAUDE.md
                </button>
              </div>
            )}
            {project.codeDir && (
              <div className="meta-cell">
                <label className="meta-cell-label">{t('chat.code')}</label>
                <button className="chat-meta-btn full" onClick={() => { setOpen(false); onOpenFolder(); }}>
                  <Folder size={13} /> {t('chat.openFolder')}
                </button>
              </div>
            )}
            <div className="meta-cell">
              <label className="meta-cell-label">{t('chat.config')}</label>
              <button className="chat-meta-btn full" onClick={() => { setOpen(false); onExportConfig(); }}>
                <Download size={13} /> {t('chat.export')}
              </button>
            </div>
          </div>
          {project.sessionId && (
            <div className="meta-popover-footer">
              {t('chat.session')}: <code>{project.sessionId.slice(0, 8)}</code> · {t('chat.context')}:{' '}
              <code>{contextUsed.toLocaleString()} / {contextTotal.toLocaleString()}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
