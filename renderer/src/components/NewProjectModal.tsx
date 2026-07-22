import { useState } from 'react';
import { FolderGit2, HardDrive, Globe, Folder, X, Plug, KeyRound, Lock, CheckCircle2, Loader2, FolderOpen } from 'lucide-react';
import { Project, ProjectSource, SshSecret } from '../types';
import { useT } from '../lib/i18n';
import RemoteFolderPicker from './RemoteFolderPicker';

interface Props {
  onClose: () => void;
  onCreated: (p: Project) => void;
}

export default function NewProjectModal({ onClose, onCreated }: Props) {
  const { t } = useT();
  // No web não há sistema de arquivos local nem desktop: criar projeto = subir
  // um sandbox na nuvem (de um repo GitHub ou em branco). Esconde pasta local/SSH.
  const isWeb = !!(window as any).maestrus?.isWeb;
  const [name, setName] = useState('');
  const [source, setSource] = useState<ProjectSource>('github');
  const [repoUrl, setRepoUrl] = useState('');
  const [gitToken, setGitToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [localPath, setLocalPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SSH (produção)
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('');
  const [sshAuth, setSshAuth] = useState<'password' | 'key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [sshRemotePath, setSshRemotePath] = useState('');
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  function sshMeta() {
    return { host: sshHost.trim(), port: parseInt(sshPort, 10) || 22, username: sshUser.trim() };
  }
  function sshSecret(): SshSecret {
    return sshAuth === 'key'
      ? { authType: 'key', privateKeyPath: sshKeyPath.trim(), passphrase: sshPassphrase || undefined }
      : { authType: 'password', password: sshPassword };
  }
  function sshReady() {
    if (!sshHost.trim() || !sshUser.trim()) return false;
    return sshAuth === 'key' ? !!sshKeyPath.trim() : !!sshPassword;
  }

  async function pickLocal() {
    const p = await window.maestrus.dialog.pickFolder();
    if (p) setLocalPath(p);
  }

  async function pickKey() {
    const p = await window.maestrus.dialog.pickFile([{ name: 'Chave', extensions: ['pem', 'ppk', 'key', '*'] }]);
    if (p) { setSshKeyPath(p); setTested(false); }
  }

  async function testSsh() {
    setTesting(true);
    setError(null);
    const r = await window.maestrus.ssh.test(sshMeta(), sshSecret());
    setTesting(false);
    if (r.ok) { setTested(true); }
    else { setTested(false); setError(t('ssh.testFail', { msg: r.error || '' })); }
  }

  async function importConfig() {
    const p = await window.maestrus.dialog.pickFile([{ name: 'config.json', extensions: ['json'] }]);
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      const project = await window.maestrus.projects.import(p);
      onCreated(project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!name.trim()) return setError(t('newProject.errName'));
    if (source === 'github' && !repoUrl.trim()) return setError(t('newProject.errRepo'));
    if (source === 'local' && !localPath) return setError(t('newProject.errLocal'));
    if (source === 'production') {
      if (!sshReady()) return setError(t('ssh.errCreds'));
      if (!sshRemotePath) return setError(t('ssh.errFolder'));
      setBusy(true);
      setError(null);
      try {
        const project = await window.maestrus.ssh.createProject(
          name.trim(),
          { ...sshMeta(), remotePath: sshRemotePath },
          sshSecret(),
        );
        onCreated(project);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const project = await window.maestrus.projects.create({
        name: name.trim(),
        source,
        repoUrl: repoUrl.trim() || null,
        gitToken: gitToken.trim() || null,
        localPath: localPath || null,
        mountPath: null,
      });
      onCreated(project);
    } catch (e: any) {
      const m = String(e?.message || '');
      if (m === 'repo_auth_required') setShowToken(true);
      setError(
        m === 'repo_auth_required' ? t('newProject.errRepoAuth')
        : m === 'container_starting' ? t('newProject.errContainerStarting')
        : m === 'cloud_required' ? t('newProject.errCloudRequired')
        : m.startsWith('clone_failed') ? t('newProject.errClone')
        : e.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('newProject.title')}</h2>
          <button className="btn-icon" onClick={onClose}><X size={15} /></button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span>{t('newProject.name')}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('newProject.namePlaceholder')}
              autoFocus
            />
          </label>

          <div className="field">
            <span>{t('newProject.source')}</span>
            <div className="source-tabs">
              <button
                className={`source-tab ${source === 'github' ? 'active' : ''}`}
                onClick={() => setSource('github')}
              ><FolderGit2 size={14} /> {t('newProject.github')}</button>
              {!isWeb && (
                <button
                  className={`source-tab ${source === 'local' ? 'active' : ''}`}
                  onClick={() => setSource('local')}
                ><HardDrive size={14} /> {t('newProject.local')}</button>
              )}
              {!isWeb && (
                <button
                  className={`source-tab ${source === 'production' ? 'active' : ''}`}
                  onClick={() => setSource('production')}
                ><Globe size={14} /> {t('newProject.production')}</button>
              )}
              <button
                className={`source-tab ${source === 'empty' ? 'active' : ''}`}
                onClick={() => setSource('empty')}
              ><Folder size={14} /> {t('newProject.empty')}</button>
            </div>
          </div>

          {isWeb && <p className="hint"><Globe size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />{t('cloud.cloudSub')}</p>}

          {source === 'github' && (
            <label className="field">
              <span>{t('newProject.repoUrl')}</span>
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
              />
              <small>{t('newProject.repoHint')}</small>
            </label>
          )}

          {source === 'github' && !showToken && (
            <p className="hint" style={{ marginTop: -6 }}>
              <Lock size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              <a href="#" onClick={(e) => { e.preventDefault(); setShowToken(true); }}>{t('newProject.privateRepo')}</a>
            </p>
          )}
          {source === 'github' && showToken && (
            <label className="field">
              <span>{t('newProject.gitToken')}</span>
              <input
                type="password"
                value={gitToken}
                onChange={(e) => setGitToken(e.target.value)}
                placeholder="ghp_… / github_pat_…"
                autoComplete="off"
              />
              <small>{t('newProject.gitTokenHint')}</small>
            </label>
          )}

          {source === 'local' && (
            <label className="field">
              <span>{t('newProject.localFolder')}</span>
              <div className="field-row">
                <input type="text" value={localPath} readOnly placeholder={t('newProject.select')} />
                <button className="btn-secondary" onClick={pickLocal}>{t('common.choose')}</button>
              </div>
              <small>{t('newProject.localHint')}</small>
            </label>
          )}

          {source === 'production' && (
            <div className="ssh-form">
              <div className="field-grid">
                <label className="field" style={{ flex: 2 }}>
                  <span>{t('ssh.host')}</span>
                  <input type="text" value={sshHost} onChange={(e) => { setSshHost(e.target.value); setTested(false); }} placeholder="ex: 203.0.113.10 ou servidor.com" />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span>{t('ssh.port')}</span>
                  <input type="text" value={sshPort} onChange={(e) => setSshPort(e.target.value)} placeholder="22" />
                </label>
              </div>
              <label className="field">
                <span>{t('ssh.user')}</span>
                <input type="text" value={sshUser} onChange={(e) => { setSshUser(e.target.value); setTested(false); }} placeholder="ex: root, ubuntu, deploy" />
              </label>

              <div className="field">
                <span>{t('ssh.auth')}</span>
                <div className="source-tabs">
                  <button className={`source-tab ${sshAuth === 'password' ? 'active' : ''}`} onClick={() => { setSshAuth('password'); setTested(false); }}>
                    <Lock size={14} /> {t('ssh.password')}
                  </button>
                  <button className={`source-tab ${sshAuth === 'key' ? 'active' : ''}`} onClick={() => { setSshAuth('key'); setTested(false); }}>
                    <KeyRound size={14} /> {t('ssh.key')}
                  </button>
                </div>
              </div>

              {sshAuth === 'password' ? (
                <label className="field">
                  <span>{t('ssh.password')}</span>
                  <input type="password" value={sshPassword} onChange={(e) => { setSshPassword(e.target.value); setTested(false); }} placeholder="••••••••" />
                </label>
              ) : (
                <>
                  <label className="field">
                    <span>{t('ssh.keyFile')}</span>
                    <div className="field-row">
                      <input type="text" value={sshKeyPath} readOnly placeholder={t('newProject.select')} />
                      <button className="btn-secondary" onClick={pickKey}>{t('common.choose')}</button>
                    </div>
                  </label>
                  <label className="field">
                    <span>{t('ssh.passphrase')}</span>
                    <input type="password" value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} placeholder={t('ssh.passphraseOpt')} />
                  </label>
                </>
              )}

              <div className="ssh-actions">
                <button className="btn-secondary" onClick={testSsh} disabled={!sshReady() || testing}>
                  {testing ? <Loader2 size={13} className="spin" /> : <Plug size={13} />} {t('ssh.testConn')}
                </button>
                {tested && <span className="ssh-ok"><CheckCircle2 size={13} /> {t('ssh.connOk')}</span>}
              </div>

              <label className="field">
                <span>{t('ssh.remoteFolder')}</span>
                <div className="field-row">
                  <input type="text" value={sshRemotePath} readOnly placeholder={t('ssh.noFolderYet')} />
                  <button className="btn-secondary" onClick={() => setShowPicker(true)} disabled={!sshReady()}>
                    <FolderOpen size={13} /> {t('ssh.browse')}
                  </button>
                </div>
                <small>{t('ssh.hint')}</small>
              </label>

              {showPicker && (
                <RemoteFolderPicker
                  ssh={sshMeta()}
                  secret={sshSecret()}
                  onPick={(p) => { setSshRemotePath(p); setShowPicker(false); setTested(true); }}
                  onClose={() => setShowPicker(false)}
                />
              )}
            </div>
          )}

          {source === 'empty' && (
            <p className="hint">{t('newProject.emptyHint')}</p>
          )}

          {error && <div className="error-box">{error}</div>}
        </div>

        <div className="modal-foot">
          {!isWeb && (
            <button className="btn-link" onClick={importConfig} disabled={busy}>
              {t('newProject.importConfig')}
            </button>
          )}
          <div className="spacer" />
          <button className="btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button className="btn-primary" onClick={create} disabled={busy}>
            {busy ? t('newProject.creating') : t('newProject.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
