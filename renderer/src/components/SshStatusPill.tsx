import { useEffect, useState, useCallback } from 'react';
import { Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Props {
  projectId: string;
  host: string;
  busy: boolean;
}

export default function SshStatusPill({ projectId, host, busy }: Props) {
  const { t } = useT();
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await window.maestrus.ssh.status(projectId);
    setConnected(!!s.connected);
  }, [projectId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh, busy]);

  async function sync() {
    setSyncing(true);
    setSyncMsg(null);
    const r = await window.maestrus.ssh.pull(projectId);
    setSyncing(false);
    if (r.ok) {
      setSyncMsg(t('ssh.synced', { files: r.files ?? 0 }));
      setConnected(true);
      setTimeout(() => setSyncMsg(null), 4000);
    } else {
      setSyncMsg(r.error || 'erro');
    }
  }

  return (
    <div className="ssh-pill" title={host}>
      <span className={`ssh-dot ${connected ? 'on' : 'off'}`}>
        {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
      </span>
      <span className="ssh-pill-label">{connected ? t('ssh.connOk') : 'SSH'}</span>
      <button className="ssh-sync-btn" onClick={sync} disabled={syncing} title={t('ssh.syncNow')}>
        {syncing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
      </button>
      {syncMsg && <span className="ssh-sync-msg">{syncMsg}</span>}
    </div>
  );
}
