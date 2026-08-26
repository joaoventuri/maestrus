import { useEffect, useState } from 'react';
import { Folder, FolderOpen, ChevronRight, ArrowUp, Loader2, X, Check } from 'lucide-react';
import { SshConfig, SshDirEntry, SshSecret } from '../types';
import { useT } from '../lib/i18n';

interface Props {
  ssh: Omit<SshConfig, 'remotePath'>;
  secret: SshSecret;
  onPick: (path: string) => void;
  onClose: () => void;
}

function parentOf(p: string): string {
  if (!p || p === '/' || p === '.') return p;
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

export default function RemoteFolderPicker({ ssh, secret, onPick, onClose }: Props) {
  const { t } = useT();
  const [path, setPath] = useState<string>('');
  const [entries, setEntries] = useState<SshDirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(target?: string) {
    setLoading(true);
    setError(null);
    const r = await window.maestrus.ssh.listDir(ssh, secret, target);
    if (r.ok) {
      setPath(r.path || target || '.');
      setEntries((r.entries || []).filter((e) => e.isDir));
    } else {
      setError(r.error || t('ssh.browseError'));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2><FolderOpen size={16} /> {t('ssh.pickFolder')}</h2>
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
        </div>

        <div className="remote-bar">
          <button className="btn-secondary sm" onClick={() => load(parentOf(path))} disabled={loading || path === '/' || !path}>
            <ArrowUp size={13} /> {t('ssh.up')}
          </button>
          <code className="remote-path">{path || '~'}</code>
        </div>

        <div className="remote-list">
          {loading && <div className="remote-loading"><Loader2 size={16} className="spin" /> {t('ssh.loading')}</div>}
          {error && <div className="error-box">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="remote-empty">{t('ssh.noSubfolders')}</div>
          )}
          {!loading && !error && entries.map((e) => (
            <button
              key={e.name}
              className="remote-item"
              onClick={() => load((path.replace(/\/+$/, '') || '') + '/' + e.name)}
            >
              <Folder size={14} />
              <span className="remote-item-name">{e.name}</span>
              <ChevronRight size={13} className="remote-item-arrow" />
            </button>
          ))}
        </div>

        <div className="modal-foot">
          <div className="remote-foot-hint">{t('ssh.willLink')} <code>{path || '~'}</code></div>
          <div className="spacer" />
          <button className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" onClick={() => onPick(path)} disabled={loading || !path}>
            <Check size={14} /> {t('ssh.useThisFolder')}
          </button>
        </div>
      </div>
    </div>
  );
}
