import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, CircleDashed, RefreshCw, ListChecks, Download, Loader2 } from 'lucide-react';
import { RequirementsReport } from '../types';
import { useT } from '../lib/i18n';

interface Props {
  report: RequirementsReport;
  onRecheck: () => void;
  onGoSettings: () => void;
}

export default function RequirementsScreen({ report, onRecheck }: Props) {
  const { t } = useT();
  const blockers = report.items.filter((i) => i.required && !i.ok);

  const [installing, setInstalling] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, { ok: boolean; manual?: boolean; error?: string } | null>>({});
  const [autoMode, setAutoMode] = useState(false);
  const logRefs = useRef<Record<string, HTMLPreElement | null>>({});
  const autoRanRef = useRef(false);

  useEffect(() => {
    return window.maestrus.requirements.onInstallLog(({ id, line }) => {
      setLogs((prev) => ({ ...prev, [id]: (prev[id] || '') + line }));
      // auto-scroll do log
      requestAnimationFrame(() => {
        const el = logRefs.current[id];
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }, []);

  async function runInstall(id: string) {
    setInstalling(id);
    setLogs((prev) => ({ ...prev, [id]: '' }));
    setDone((prev) => ({ ...prev, [id]: null }));
    const res = await window.maestrus.requirements.install(id);
    setDone((prev) => ({ ...prev, [id]: res }));
    setInstalling(null);
    return res;
  }

  async function startInstall(id: string) {
    if (installing) return;
    await runInstall(id);
    // Re-checa requisitos depois de qualquer install (mesmo manual — usuário
    // pode ter completado no GUI da Apple/Node).
    setTimeout(() => onRecheck(), 800);
  }

  // Auto-instalação no ato de abrir: assim que a tela aparece com pendências
  // instaláveis, dispara os instaladores em sequência (1x por sessão do app).
  // O Claude Code instala silencioso; Node/Git abrem o instalador nativo.
  useEffect(() => {
    if (autoRanRef.current) return;
    const installable = report.items.filter((i) => i.required && !i.ok && i.installable !== false);
    if (installable.length === 0) return;
    try { if (sessionStorage.getItem('maestrus.autoinstall')) return; } catch {}
    autoRanRef.current = true;
    try { sessionStorage.setItem('maestrus.autoinstall', '1'); } catch {}
    setAutoMode(true);
    (async () => {
      for (const item of installable) {
        await runInstall(item.id);
      }
      setTimeout(() => onRecheck(), 1000);
    })();
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1><ListChecks size={18} /> {t('req.title')}</h1>
        <button className="btn-secondary" onClick={onRecheck}>
          <RefreshCw size={13} /> {t('req.recheck')}
        </button>
      </div>

      <p className="page-sub">
        {t('req.platform', { platform: report.platform })}
        {blockers.length > 0 && t('req.missing', { count: blockers.length })}
      </p>

      {autoMode && (
        <div className="req-auto">
          <Loader2 size={14} className="spin" /> {t('req.autoInstalling')}
        </div>
      )}

      <div className="reqs">
        {report.items.map((it) => {
          const isInstalling = installing === it.id;
          const result = done[it.id];
          const showLog = !!logs[it.id];
          return (
            <div key={it.id} className={`req ${it.ok ? 'ok' : 'missing'} ${it.required ? '' : 'optional'}`}>
              <div className="req-status">
                {it.ok
                  ? <CheckCircle2 size={18} />
                  : it.required
                    ? <XCircle size={18} />
                    : <CircleDashed size={18} />}
              </div>
              <div className="req-body">
                <div className="req-name">
                  {it.label}
                  {!it.required && <span className="req-tag">{t('req.optional')}</span>}
                </div>
                {it.version && <div className="req-version">{it.version}</div>}
                {it.path && <div className="req-path">{it.path}</div>}
                {it.found && it.found.length > 0 && (
                  <div className="req-found">
                    {t('req.foundAt')}
                    <ul>{it.found.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
                  </div>
                )}
                {!it.ok && it.hint && (
                  <div className="req-hint">
                    <strong>{t('req.howToFix')}</strong> {it.hint}
                  </div>
                )}
                {!it.ok && it.installable !== false && (
                  <div className="req-actions" style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="btn-primary"
                      disabled={!!installing}
                      onClick={() => startInstall(it.id)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      {isInstalling
                        ? <><Loader2 size={13} className="spin" /> Instalando…</>
                        : <><Download size={13} /> Instalar {it.label}</>}
                    </button>
                    {result && (
                      <span style={{ fontSize: 12, color: result.ok ? 'var(--success)' : 'var(--error)' }}>
                        {result.ok
                          ? (result.manual ? 'Continue no instalador que abriu.' : 'Pronto! Re-verificando…')
                          : `Falhou: ${result.error || 'erro desconhecido'}`}
                      </span>
                    )}
                  </div>
                )}
                {showLog && (
                  <pre
                    ref={(el) => { logRefs.current[it.id] = el; }}
                    style={{
                      marginTop: 10,
                      maxHeight: 220,
                      overflow: 'auto',
                      background: 'var(--bg-0)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 10,
                      fontSize: 11,
                      lineHeight: 1.4,
                      color: 'var(--fg-1)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >{logs[it.id]}</pre>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
