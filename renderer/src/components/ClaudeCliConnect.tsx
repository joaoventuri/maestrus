import { useEffect, useRef, useState } from 'react';
import { Loader2, ExternalLink, CheckCircle2, AlertTriangle, Cloud, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import Logo from './Logo';

type Phase = 'opening' | 'waiting' | 'connected' | 'failed';

// Extrai o código OAuth do que o usuário colar: aceita o código puro OU a URL
// de callback (http://localhost:PORT/callback?code=...&state=...).
function extractCode(input: string): string {
  const s = (input || '').trim();
  const m = s.match(/[?&]code=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return s;
}

// Conexão inline do Claude CLI dentro do chat. Dispara o OAuth (abre o navegador),
// e o CLI sobe um servidor loopback que captura o callback AUTOMATICAMENTE — a
// gente detecta sozinho (poll de status + a Promise de login resolvendo). Se o
// loopback for bloqueado (firewall/AV), o usuário cola o código/link como
// fallback. Ao conectar, chama onConnected (reenvia a mensagem pendente).
export default function ClaudeCliConnect({
  onConnected, onCancel, onSwitchCloud, cloudAvailable,
}: {
  onConnected: () => void;
  onCancel: () => void;
  onSwitchCloud: () => void;
  cloudAvailable: boolean;
}) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('opening');
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const startedRef = useRef(false);
  const doneRef = useRef(false);

  function finishOk() {
    if (doneRef.current) return;
    doneRef.current = true;
    setPhase('connected');
    setTimeout(onConnected, 700);
  }

  async function start() {
    setPhase('opening');
    setUrl(null);
    doneRef.current = false;
    const off = window.maestrus.claudeAuth.onLog(({ line }: { line: string }) => {
      const m = line && line.match(/https?:\/\/(?!localhost)[^\s'"]+/);
      if (m) { setUrl(m[0]); setPhase((p) => (p === 'opening' ? 'waiting' : p)); }
    });
    try {
      const r = await window.maestrus.claudeAuth.login({});
      off();
      const s = r && r.ok ? await window.maestrus.claudeAuth.status() : null;
      if (s && s.loggedIn) finishOk();
      else if (!doneRef.current) setPhase('failed');
    } catch {
      off();
      if (!doneRef.current) setPhase('failed');
    }
  }

  // Backup: poll do status. O loopback completa sozinho e o processo encerra,
  // mas o poll garante a detecção mesmo se o encerramento atrasar.
  useEffect(() => {
    const id = setInterval(async () => {
      if (doneRef.current) return;
      try { const s = await window.maestrus.claudeAuth.status(); if (s && s.loggedIn) finishOk(); } catch {}
    }, 2500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
    return () => { try { window.maestrus.claudeAuth.cancel(); } catch {} };
  }, []);

  async function submitPasted() {
    const c = extractCode(code);
    if (!c) return;
    setSubmitting(true);
    try {
      await window.maestrus.claudeAuth.submitCode(c);
      // a Promise de login resolve quando o processo valida o código; o poll
      // também pega. Damos um respiro e confirmamos.
      setTimeout(async () => {
        try { const s = await window.maestrus.claudeAuth.status(); if (s && s.loggedIn) finishOk(); } catch {}
        setSubmitting(false);
      }, 1500);
    } catch { setSubmitting(false); }
  }

  function cancel() {
    try { window.maestrus.claudeAuth.cancel(); } catch {}
    onCancel();
  }

  return (
    <div className="cli-connect-overlay">
      <div className="cli-connect-card">
        <button className="cli-connect-close" onClick={cancel} title={t('cli.cancel')}><X size={16} /></button>
        <Logo size={34} textSize={22} />
        <h3 className="cli-connect-title">{t('cli.title')}</h3>

        {phase === 'connected' ? (
          <p className="cli-connect-body ok"><CheckCircle2 size={15} /> {t('cli.connected')}</p>
        ) : phase === 'failed' ? (
          <>
            <p className="cli-connect-body err"><AlertTriangle size={15} /> {t('cli.failed')}</p>
            <button className="cli-connect-retry" onClick={start}>{t('cli.retry')}</button>
          </>
        ) : (
          <>
            <p className="cli-connect-body">
              <Loader2 size={15} className="spin" /> {phase === 'opening' ? t('cli.opening') : t('cli.waiting')}
            </p>
            {url && (
              <button className="cli-connect-link" onClick={() => window.maestrus.app.openExternal(url)}>
                <ExternalLink size={14} /> {t('cli.openLink')}
              </button>
            )}
            <div className="cli-connect-fallback">
              <span className="cli-connect-hint">{t('cli.pasteHint')}</span>
              <div className="cli-connect-paste">
                <input
                  type="text"
                  value={code}
                  placeholder={t('cli.pastePlaceholder')}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitPasted(); }}
                />
                <button onClick={submitPasted} disabled={!code.trim() || submitting}>
                  {submitting ? <Loader2 size={14} className="spin" /> : t('cli.pasteSubmit')}
                </button>
              </div>
            </div>
          </>
        )}

        {phase !== 'connected' && cloudAvailable && (
          <button className="cli-connect-cloud" onClick={onSwitchCloud}>
            <Cloud size={14} /> {t('cli.switchCloud')}
          </button>
        )}
      </div>
    </div>
  );
}
