import { useState, useEffect, useCallback } from 'react';
import { X, Share2, Copy, Check, Trash2, UserPlus, Link2, ShieldCheck, Eye } from 'lucide-react';
import { useT } from '../lib/i18n';

const ipc = (window as any).electronAPI || (window as any).maestrus;

interface Share {
  id: number;
  guest_email: string;
  project_ids: string[];
  permissions: string;
  status: string;
  created_at: string;
}

interface ReceivedShare {
  id: number;
  owner_id: number;
  owner_email: string;
  project_ids: string[];
  permissions: string;
  status: string;
}

interface Project {
  id: string;
  name: string;
}

interface Props {
  onClose: () => void;
  projects: Project[];
}

export default function ShareWorkspace({ onClose, projects }: Props) {
  const { t } = useT();

  const [guestEmail, setGuestEmail] = useState('');
  const [selectedPids, setSelectedPids] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<'write' | 'read'>('write');
  const [inviteUrl, setInviteUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const [acceptToken, setAcceptToken] = useState('');
  const [accepting, setAccepting] = useState(false);
  const [acceptResult, setAcceptResult] = useState<ReceivedShare | null>(null);
  const [acceptError, setAcceptError] = useState('');

  const [sentShares, setSentShares] = useState<Share[]>([]);
  const [receivedShares, setReceivedShares] = useState<ReceivedShare[]>([]);
  const [connectedShares, setConnectedShares] = useState<{ shareId: number; ownerUid: string }[]>([]);
  const [tab, setTab] = useState<'send' | 'receive'>('send');

  const localProjects = projects.filter((p) => !p.id.startsWith('remote:') && !p.id.startsWith('shared:') && p.id !== 'maestrus' && p.id !== 'starter');

  const invoke = useCallback(async (channel: string, payload?: any) => {
    if (ipc?.invoke) return ipc.invoke(channel, payload);
    if (ipc?.ipcRenderer?.invoke) return ipc.ipcRenderer.invoke(channel, payload);
    return null;
  }, []);

  const loadShares = useCallback(async () => {
    try {
      const r = await invoke('share:list');
      if (r?.ok) {
        setSentShares(r.sent || []);
        setReceivedShares(r.received || []);
      }
      const rc = await invoke('share:listConnected');
      if (rc?.ok) setConnectedShares(rc.shares || []);
    } catch {}
  }, [invoke]);

  useEffect(() => { loadShares(); }, [loadShares]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const togglePid = (id: string) => {
    setSelectedPids((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const create = async () => {
    if (!guestEmail.trim()) return;
    setCreating(true); setCreateError(''); setInviteUrl('');
    try {
      const r = await invoke('share:create', { projectIds: selectedPids, guestEmail: guestEmail.trim(), permissions });
      if (r?.ok) {
        setInviteUrl(r.invite_url || '');
        setGuestEmail(''); setSelectedPids([]);
        loadShares();
      } else {
        setCreateError(r?.error || t('share.error') || 'Error');
      }
    } catch (e: any) {
      setCreateError(e?.message || 'Error');
    } finally { setCreating(false); }
  };

  const revoke = async (shareId: number) => {
    try {
      await invoke('share:revoke', { shareId });
      loadShares();
    } catch {}
  };

  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(inviteUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  const accept = async () => {
    const token = acceptToken.trim().replace(/.*[?&]t=/, '');
    if (!token) return;
    setAccepting(true); setAcceptError(''); setAcceptResult(null);
    try {
      const r = await invoke('share:accept', { shareToken: token });
      if (r?.ok) {
        setAcceptResult(r.share);
        setAcceptToken('');
        loadShares();
      } else {
        setAcceptError(r?.error || t('share.error') || 'Error');
      }
    } catch (e: any) { setAcceptError(e?.message || 'Error'); }
    finally { setAccepting(false); }
  };

  const connect = async (share: ReceivedShare) => {
    try {
      await invoke('share:connect', { shareId: share.id, ownerUid: String(share.owner_id) });
      loadShares();
    } catch {}
  };

  const disconnect = async (shareId: number) => {
    try {
      await invoke('share:disconnect', { shareId });
      loadShares();
    } catch {}
  };

  const isConnected = (shareId: number) => connectedShares.some((s) => Number(s.shareId) === shareId);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2><Share2 size={16} /> {t('share.title') || 'Workspace Sharing'}</h2>
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
        </div>

        <div className="share-tabs">
          <button className={`share-tab ${tab === 'send' ? 'active' : ''}`} onClick={() => setTab('send')}>
            <UserPlus size={13} /> {t('share.tabSend') || 'Share my workspace'}
          </button>
          <button className={`share-tab ${tab === 'receive' ? 'active' : ''}`} onClick={() => setTab('receive')}>
            <Link2 size={13} /> {t('share.tabReceive') || 'Accept invite'}
            {receivedShares.length > 0 && <span className="share-badge">{receivedShares.length}</span>}
          </button>
        </div>

        <div className="modal-body">
          {tab === 'send' && (
            <>
              <label className="field">
                <span>{t('share.guestEmail') || 'Guest email (Maestrus account)'}</span>
                <input
                  type="email"
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                  placeholder="guest@example.com"
                  onKeyDown={(e) => e.key === 'Enter' && create()}
                  autoFocus
                />
              </label>

              <div className="field">
                <span>{t('share.projects') || 'Projects to share'} <em className="share-hint">{t('share.projectsHint') || '(empty = all)'}</em></span>
                <div className="share-pid-list">
                  {localProjects.map((p) => (
                    <label key={p.id} className="share-pid-item">
                      <input
                        type="checkbox"
                        checked={selectedPids.includes(p.id)}
                        onChange={() => togglePid(p.id)}
                      />
                      <span>{p.name}</span>
                    </label>
                  ))}
                  {localProjects.length === 0 && <span className="share-pid-empty">{t('share.noLocalProjects') || 'No local projects'}</span>}
                </div>
              </div>

              <div className="field">
                <span>{t('share.permissions') || 'Permissions'}</span>
                <div className="share-perms">
                  <button
                    type="button"
                    className={`share-perm-btn ${permissions === 'write' ? 'active' : ''}`}
                    onClick={() => setPermissions('write')}
                  >
                    <ShieldCheck size={14} /> {t('share.permWrite') || 'Can send messages'}
                  </button>
                  <button
                    type="button"
                    className={`share-perm-btn ${permissions === 'read' ? 'active' : ''}`}
                    onClick={() => setPermissions('read')}
                  >
                    <Eye size={14} /> {t('share.permRead') || 'View only'}
                  </button>
                </div>
              </div>

              {createError && <div className="share-error">{createError}</div>}

              {inviteUrl && (
                <div className="share-invite-box">
                  <span className="share-invite-url">{inviteUrl}</span>
                  <button className="btn-icon" onClick={copyInvite} title={copied ? 'Copiado' : 'Copiar'}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              )}

              {sentShares.length > 0 && (
                <div className="share-list">
                  <div className="share-list-title">{t('share.sentInvites') || 'Active invites'}</div>
                  {sentShares.map((s) => (
                    <div key={s.id} className="share-row">
                      <div className="share-row-info">
                        <span className="share-row-email">{s.guest_email}</span>
                        <span className={`share-row-status ${s.status}`}>{s.status}</span>
                        <span className="share-row-perm">{s.permissions}</span>
                      </div>
                      <button className="btn-icon danger" onClick={() => revoke(s.id)} title={t('share.revoke') || 'Revoke'}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'receive' && (
            <>
              <label className="field">
                <span>{t('share.pasteInvite') || 'Paste invite link or token'}</span>
                <div className="share-accept-row">
                  <input
                    type="text"
                    value={acceptToken}
                    onChange={(e) => setAcceptToken(e.target.value)}
                    placeholder="https://maestrus.cloud/share?t=…"
                    onKeyDown={(e) => e.key === 'Enter' && accept()}
                    autoFocus
                  />
                  <button className="btn-primary" onClick={accept} disabled={accepting || !acceptToken.trim()}>
                    {accepting ? '…' : (t('share.accept') || 'Accept')}
                  </button>
                </div>
              </label>
              {acceptError && <div className="share-error">{acceptError}</div>}
              {acceptResult && (
                <div className="share-accept-ok">
                  <Check size={14} /> {t('share.acceptedFrom') || 'Accepted from'} <strong>{acceptResult.owner_email}</strong>
                </div>
              )}

              {receivedShares.length > 0 ? (
                <div className="share-list">
                  <div className="share-list-title">{t('share.receivedShares') || 'Shared workspaces'}</div>
                  {receivedShares.map((s) => (
                    <div key={s.id} className="share-row">
                      <div className="share-row-info">
                        <span className="share-row-email">{s.owner_email}</span>
                        <span className="share-row-perm">{s.permissions}</span>
                        {s.project_ids.length > 0 && <span className="share-row-pids">{s.project_ids.length} projects</span>}
                      </div>
                      {isConnected(s.id)
                        ? <button className="btn-secondary" onClick={() => disconnect(s.id)}>{t('share.disconnect') || 'Disconnect'}</button>
                        : <button className="btn-primary" onClick={() => connect(s)}>{t('share.connect') || 'Connect'}</button>
                      }
                    </div>
                  ))}
                </div>
              ) : (
                <div className="share-empty-state">
                  <Share2 size={28} />
                  <p>{t('share.noShares') || 'No shared workspaces yet. Ask a colleague to invite you.'}</p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          {tab === 'send' && (
            <>
              <span className="spacer" />
              <button className="btn-secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</button>
              <button className="btn-primary" onClick={create} disabled={creating || !guestEmail.trim()}>
                {creating ? (t('share.creating') || 'Creating…') : (t('share.createInvite') || 'Create invite link')}
              </button>
            </>
          )}
          {tab === 'receive' && (
            <>
              <span className="spacer" />
              <button className="btn-secondary" onClick={onClose}>{t('common.close') || 'Close'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
