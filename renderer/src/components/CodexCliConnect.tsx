import { useEffect, useRef, useState } from 'react';
import { Loader2, ExternalLink, CheckCircle2, AlertTriangle, Download, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { OpenAIMark } from './BrandMarks';

type Phase = 'installing' | 'opening' | 'waiting' | 'connected' | 'failed';

function extractCode(input: string): string {
  const s = (input || '').trim();
  const m = s.match(/[?&](code|user_code)=([^&\s]+)/);
  if (m) return decodeURIComponent(m[2]);
  return s;
}

// Conexão inline do Codex CLI (OpenAI) — espelha o ClaudeCliConnect:
//  1) AUTO-INSTALA o Codex CLI se faltar (npm i -g @openai/codex);
//  2) dispara `codex login` (browser loopback no desktop) e detecta a URL;
//  3) o usuário aprova; código/link como fallback (copia-e-cola);
//  4) ao conectar, chama onConnected (reenvia a mensagem pendente).
export default function CodexCliConnect({
  onConnected, onCancel,
}: {
  onConnected: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('installing');
  const [url, setUrl] = useState<string | null>(null);
  const [logTail, setLogTail] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failMsg, setFailMsg] = useState('');
  const startedRef = useRef(false);
  const doneRef = useRef(false);

  function finishOk() {
    if (doneRef.current) return;
    doneRef.current = true;
    setPhase('connected');
    setTimeout(onConnected, 700);
  }

  async function start() {
    setUrl(null); setFailMsg('');
    doneRef.current = false;
    const off = window.maestrus.codexAuth.onLog(({ line }: { line: string }) => {
      setLogTail((prev) => (prev + line).slice(-400));
      // device-auth mostra uma verification URL; login browser também loga a URL.
      const m = line && line.match(/https?:\/\/(?!localhost|127\.0\.0\.1)[^\s'"]+/);
      if (m) { setUrl(m[0]); setPhase((p) => (p === 'opening' || p === 'installing' ? 'waiting' : p)); }
    });
    try {
      // 1) garante o binário (auto-instala se preciso).
      setPhase('installing');
      const inst = await window.maestrus.codexAuth.install?.();
      if (inst && inst.ok === false) { off(); setFailMsg(inst.error ? String(inst.error) : (t('codexCli.installFailed') || 'Could not install the Codex CLI. Check your internet and try again.')); setPhase('failed'); return; }
      // 2) login.
      setPhase('opening');
      const r: any = await window.maestrus.codexAuth.login({});
      off();
      const s = r && r.ok ? await window.maestrus.codexAuth.status() : null;
      if (s && s.loggedIn) finishOk();
      else if (!doneRef.current) { if (r && r.error) setFailMsg(String(r.error)); setPhase('failed'); }
    } catch (e: any) {
      off();
      if (!doneRef.current) { setFailMsg(e?.message || ''); setPhase('failed'); }
    }
  }

  useEffect(() => {
    const id = setInterval(async () => {
      if (doneRef.current) return;
      try { const s = await window.maestrus.codexAuth.status(); if (s && s.loggedIn) finishOk(); } catch {}
    }, 2500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
    return () => { try { window.maestrus.codexAuth.cancel(); } catch {} };
  }, []);

  async function submitPasted() {
    const c = extractCode(code);
    if (!c) return;
    setSubmitting(true);
    try {
      await window.maestrus.codexAuth.submitCode(c);
      setTimeout(async () => {
        try { const s = await window.maestrus.codexAuth.status(); if (s && s.loggedIn) finishOk(); } catch {}
        setSubmitting(false);
      }, 1500);
    } catch { setSubmitting(false); }
  }

  function cancel() {
    try { window.maestrus.codexAuth.cancel(); } catch {}
    onCancel();
  }

  return (
    <div className="cli-connect-overlay">
      <div className="cli-connect-card prov-codex">
        <button className="cli-connect-close" onClick={cancel} title={t('cli.cancel')}><X size={16} /></button>
        <div className="cli-connect-brand"><OpenAIMark size={30} /></div>
        <h3 className="cli-connect-title">{t('codexCli.title') || 'Connect Codex CLI'}</h3>

        {phase === 'connected' ? (
          <p className="cli-connect-body ok"><CheckCircle2 size={15} /> {t('codexCli.connected') || 'Codex connected!'}</p>
        ) : phase === 'failed' ? (
          <>
            <p className="cli-connect-body err"><AlertTriangle size={15} /> {t('codexCli.failed') || 'Could not connect. Try again.'}</p>
            {failMsg && <p className="cli-connect-failmsg">{failMsg}</p>}
            <button className="cli-connect-retry" onClick={start}>{t('cli.retry') || 'Try again'}</button>
          </>
        ) : (
          <>
            <p className="cli-connect-body">
              {phase === 'installing'
                ? <><Download size={15} className="spin" /> {t('codexCli.installing') || 'Installing Codex CLI…'}</>
                : <><Loader2 size={15} className="spin" /> {phase === 'opening' ? (t('codexCli.opening') || 'Opening your browser to sign in to ChatGPT…') : (t('codexCli.waiting') || 'Waiting for you to approve…')}</>}
            </p>
            {phase === 'installing' && <p className="cli-connect-hint">{t('codexCli.installHint') || 'First time only — downloading the latest Codex CLI (~30s).'}</p>}
            {url && (
              <button className="cli-connect-link" onClick={() => { const u = url!; try { (window as any).maestrus?.app?.openExternal?.(u); } catch {} if (!(window as any).maestrus?.app?.openExternal) window.open(u, '_blank', 'noopener'); }}>
                <ExternalLink size={14} /> {t('cli.openLink') || 'Open the link'}
              </button>
            )}
            <div className="cli-connect-fallback">
              <span className="cli-connect-hint">{t('codexCli.pasteHint') || 'Blocked? Paste the code or callback link here:'}</span>
              <div className="cli-connect-paste">
                <input
                  type="text"
                  value={code}
                  placeholder={t('cli.pastePlaceholder') || 'Paste code / link'}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitPasted(); }}
                />
                <button onClick={submitPasted} disabled={!code.trim() || submitting}>
                  {submitting ? <Loader2 size={14} className="spin" /> : (t('cli.pasteSubmit') || 'Submit')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
