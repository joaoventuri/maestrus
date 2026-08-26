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

// Conexão inline do Claude CLI dentro do chat.
//
// ATENÇÃO ao mecanismo real: o CLI NÃO sobe loopback. O redirect_uri que ele
// gera é https://platform.claude.com/oauth/code/callback e o processo fica
// bloqueado em "Paste code here" esperando stdin. Enquanto esta tela assumiu
// loopback, o usuário concluía no navegador, nada voltava, o login estourava e
// a tela dizia "não foi possível conectar" — com a conta perfeitamente válida
// do outro lado. Colar o código é o caminho NORMAL, não um fallback de
// firewall. Ao conectar, chama onConnected (reenvia a mensagem pendente).
export default function ClaudeCliConnect({
  onConnected, onCancel, onSwitchCloud, cloudAvailable, local, projectId,
}: {
  onConnected: () => void;
  onCancel: () => void;
  onSwitchCloud: () => void;
  cloudAvailable: boolean;
  /** Projeto roda NESTA máquina (ex: orquestrador) → login e status locais. */
  local?: boolean;
  /**
   * Quem executa o turno é quem precisa logar. Sem isto o main decidia por uma
   * heurística global e, com dois hosts conectados, mandava o login de um
   * projeto LOCAL para um host: o navegador autenticava a máquina errada e o
   * client dizia "não foi possível conectar".
   */
  projectId?: string;
}) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('opening');
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const startedRef = useRef(false);
  const doneRef = useRef(false);
  // O processo está parado em "Paste code here": não é falha, é a etapa normal.
  const awaitingCodeRef = useRef(false);
  const [awaitingCode, setAwaitingCode] = useState(false);

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
      setLog((l) => (l + line).slice(-4000));
      if (line && /paste code|cole o c[oó]digo/i.test(line)) {
        awaitingCodeRef.current = true;
        setAwaitingCode(true);
        setPhase('waiting');
      }
      const m = line && line.match(/https?:\/\/(?!localhost)[^\s'"]+/);
      if (m) { setUrl(m[0]); setPhase((p) => (p === 'opening' ? 'waiting' : p)); }
    });
    try {
      const r = await window.maestrus.claudeAuth.login(local ? { local: true } : { projectId });
      off();
      const s = r && r.ok ? await window.maestrus.claudeAuth.status(local ? { local: true } : { projectId }) : null;
      // Conectar no Console (API) em vez da assinatura passa despercebido e
      // cobra por token. Se acontecer, é melhor dizer do que só festejar.
      if (s && s.loggedIn && s.method && s.method !== 'claude.ai') setErrMsg(t('cli.warnApiAccount'));
      if (s && s.loggedIn) finishOk();
      // Saiu com sucesso mas nada foi gravado: tipicamente um CLI velho cujo
      // fluxo OAuth o servidor já não aceita. Dizer isso é mais util do que
      // "não foi possível conectar".
      else if (r && r.ok && !doneRef.current) { setErrMsg(t('cli.errExitNoAuth')); setPhase('failed'); }
      // Se ainda esperamos o código, o login "terminar" não é erro: seguimos
      // na tela de colar em vez de acusar falha em cima de um fluxo saudável.
      else if (!doneRef.current && !awaitingCodeRef.current) setPhase('failed');
    } catch {
      off();
      if (!doneRef.current && !awaitingCodeRef.current) setPhase('failed');
    }
  }

  // Backup: poll do status. O loopback completa sozinho e o processo encerra,
  // mas o poll garante a detecção mesmo se o encerramento atrasar.
  useEffect(() => {
    const id = setInterval(async () => {
      if (doneRef.current) return;
      try { const s = await window.maestrus.claudeAuth.status(local ? { local: true } : { projectId }); if (s && s.loggedIn) finishOk(); } catch {}
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
    setErrMsg('');
    try {
      const r = await window.maestrus.claudeAuth.submitCode(c, local ? { local: true } : { projectId });
      // Antes o retorno era ignorado: com o processo de login morto o main
      // devolvia { ok:false, error:'no_login' }, a tela não dizia nada e o
      // clique em Conectar parecia simplesmente não fazer efeito.
      if (r && r.ok === false) {
        setErrMsg(r.error === 'no_login' ? t('cli.errNoLogin') : String(r.error || ''));
        setSubmitting(false);
        return;
      }
      setTimeout(async () => {
        try {
          const s = await window.maestrus.claudeAuth.status(local ? { local: true } : { projectId });
          if (s && s.loggedIn) finishOk();
          else setErrMsg(t('cli.errCodeRejected'));
        } catch { setErrMsg(t('cli.errCodeRejected')); }
        setSubmitting(false);
      }, 2500);
    } catch (e: any) { setErrMsg(e?.message || 'erro'); setSubmitting(false); }
  }

  // Sem isto o clique chamava `maestrus.app.openExternal` (inexistente) e
  // estourava em silêncio: o botão de abrir o navegador não fazia NADA.
  // Se abrir falhar, ao menos deixamos o link no clipboard.
  const [copied, setCopied] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [log, setLog] = useState('');
  const [showLog, setShowLog] = useState(false);
  async function openLink(u: string) {
    try {
      await window.maestrus.shell.openExternal(u);
    } catch {
      try { await navigator.clipboard.writeText(u); setCopied(true); } catch {}
    }
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

        {errMsg && <p className="cli-connect-body err"><AlertTriangle size={15} /> {errMsg}</p>}
        {/* O que o CLI realmente imprimiu. Sem isto, qualquer falha aqui vira
            adivinhação: a tela dizia "não foi possível conectar" e ponto. */}
        {log && (
          <>
            <button className="cli-connect-logtoggle" onClick={() => setShowLog((v) => !v)}>
              {showLog ? t('cli.hideLog') : t('cli.showLog')}
            </button>
            {showLog && <pre className="cli-connect-log">{log}</pre>}
          </>
        )}

        {phase === 'connected' ? (
          <p className="cli-connect-body ok"><CheckCircle2 size={15} /> {t('cli.connected')}</p>
        ) : phase === 'failed' ? (
          <>
            <p className="cli-connect-body err"><AlertTriangle size={15} /> {t('cli.failed')}</p>
            <button className="cli-connect-retry" onClick={start}>{t('cli.retry')}</button>
            {/* O código continua valendo depois do erro: quem concluiu no
                navegador precisa poder colar aqui em vez de recomeçar. */}
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
          </>
        ) : (
          <>
            <p className="cli-connect-body">
              {!awaitingCode && <Loader2 size={15} className="spin" />}
              {awaitingCode ? t('cli.needCode') : phase === 'opening' ? t('cli.opening') : t('cli.waiting')}
            </p>
            {url && (
              <button className="cli-connect-link" onClick={() => openLink(url)}>
                <ExternalLink size={14} /> {t('cli.openLink')}
              </button>
            )}
            {url && (
              <button className="cli-connect-copy" onClick={async () => {
                try { await navigator.clipboard.writeText(url); setCopied(true); } catch {}
              }}>{copied ? t('cli.copied') : t('cli.copyLink')}</button>
            )}
            <div className="cli-connect-fallback">
              <span className="cli-connect-hint">{awaitingCode ? t('cli.needCodeHint') : t('cli.pasteHint')}</span>
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
