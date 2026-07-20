import { useEffect, useState } from 'react';
import { Settings as SettingsIcon, Languages, Cloud, RefreshCw, Loader2, DownloadCloud, Check, FolderInput, Timer, MonitorCog, Globe, Server, MonitorSmartphone, KeyRound, Trash2, Mic, AlertCircle, ExternalLink } from 'lucide-react';
import { useT, LANGS } from '../lib/i18n';
import { ClaudeSession } from '../types';
import ClaudeAccounts from './ClaudeAccounts';

function fmtDate(ms: number): string {
  try { return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return ''; }
}

export default function SettingsScreen({ onGoRemote, onModeChange }: { onGoRemote?: () => void; onModeChange?: (mode: 'server' | 'client') => void } = {}) {
  const { t, lang, setLang } = useT();
  // No web só faz sentido idioma/sobre — o resto (navegador do agente, modo
  // server/client, importar sessões locais, gráficos) é da MÁQUINA local.
  // Config por-projeto (modelo/thinking/permissão) fica no painel do chat.
  const isWeb = !!(window as any).maestrus?.isWeb;
  // Self-host: os cofres BYOK (Claude API / OpenAI voz) são sincronizados pela
  // conta gerenciada — não existem no self-host. No self-host a IA é o Claude
  // CLI (login OAuth no servidor, via Claude Powers → Contas).
  const isSelfhost = !!(window as any).maestrus?.isSelfhost;
  const [appMode, setAppMode] = useState<'server' | 'client' | null>(null);
  const [hostAlways, setHostAlways] = useState(true);

  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [imported, setImported] = useState<Record<string, boolean>>({});
  const [importErr, setImportErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const [gfxCompat, setGfxCompat] = useState(false);
  const [gfxNeedsRestart, setGfxNeedsRestart] = useState(false);

  // BYOK OpenAI
  const [hasOpenaiKey, setHasOpenaiKey] = useState<boolean | null>(null);
  const [oaiInput, setOaiInput] = useState('');
  const [oaiSaving, setOaiSaving] = useState(false);
  const [oaiError, setOaiError] = useState('');
  const [oaiEditing, setOaiEditing] = useState(false);

  // BYOK Anthropic — engine "Claude API"
  const [hasAntKey, setHasAntKey] = useState<boolean | null>(null);
  const [antInput, setAntInput] = useState('');
  const [antSaving, setAntSaving] = useState(false);
  const [antError, setAntError] = useState('');
  const [antEditing, setAntEditing] = useState(false);

  const [browsers, setBrowsers] = useState<Array<{ id: string; label: string; desc: string; beta: boolean }>>([]);
  const [browserBackend, setBrowserBackend] = useState('maestrus');

  useEffect(() => {
    window.maestrus.app.getGraphicsCompat?.().then((r) => setGfxCompat(!!r.enabled)).catch(() => {});
    window.maestrus.app.listBrowserBackends?.().then((r) => { setBrowsers(r.backends || []); setBrowserBackend(r.current || 'maestrus'); }).catch(() => {});
    window.maestrus.app.getMode?.().then((r) => setAppMode(r.mode)).catch(() => {});
    window.maestrus.app.getHostAlways?.().then((r) => setHostAlways(!!r.enabled)).catch(() => {});
    (window as any).maestrus?.openaiKey?.has?.().then((r: any) => setHasOpenaiKey(!!r?.has)).catch(() => setHasOpenaiKey(false));
    (window as any).maestrus?.anthropicKey?.has?.().then((r: any) => setHasAntKey(!!r?.has)).catch(() => setHasAntKey(false));
  }, []);

  async function saveAntKey() {
    setAntError(''); setAntSaving(true);
    try {
      const r: any = await (window as any).maestrus?.anthropicKey?.set?.(antInput.trim());
      if (r?.ok) { setHasAntKey(true); setAntEditing(false); setAntInput(''); }
      else setAntError(r?.error === 'invalid_key_format' ? (t('claudeApi.invalidFormat') || 'Formato inválido — a chave começa com sk-ant-…') : (r?.error || t('claudeApi.errSave') || 'Erro ao salvar'));
    } catch (e: any) { setAntError(e?.message || 'Erro'); }
    finally { setAntSaving(false); }
  }
  async function deleteAntKey() {
    if (!confirm(t('claudeApi.confirmDelete') || 'Remover sua chave da Anthropic de todos os seus dispositivos?')) return;
    await (window as any).maestrus?.anthropicKey?.delete?.().catch(() => {});
    setHasAntKey(false); setAntEditing(false); setAntInput('');
  }

  async function saveOpenaiKey() {
    setOaiError(''); setOaiSaving(true);
    try {
      const r: any = await (window as any).maestrus?.openaiKey?.set?.(oaiInput.trim());
      if (r?.ok) {
        setHasOpenaiKey(true); setOaiEditing(false); setOaiInput('');
      } else {
        setOaiError(r?.error === 'invalid_key_format' ? (t('byok.invalidFormat') || 'Invalid OpenAI key format (sk-…)') : (r?.error || t('byok.errSave') || 'Error saving'));
      }
    } catch (e: any) { setOaiError(e?.message || 'Error'); }
    finally { setOaiSaving(false); }
  }
  async function deleteOpenaiKey() {
    if (!confirm(t('byok.confirmDelete') || 'Delete your OpenAI key from all your devices?')) return;
    try {
      const r: any = await (window as any).maestrus?.openaiKey?.delete?.();
      if (r?.ok) { setHasOpenaiKey(false); setOaiInput(''); setOaiEditing(false); }
    } catch {}
  }

  async function toggleHostAlways() {
    const next = !hostAlways;
    setHostAlways(next);
    try { await window.maestrus.app.setHostAlways?.(next); } catch {}
  }

  async function pickMode(mode: 'server' | 'client') {
    setAppMode(mode);
    try { await window.maestrus.app.setMode?.(mode); } catch {}
    // Propaga pro App (fonte da verdade do appMode que filtra a sidebar) pra
    // trocar NA HORA — sem precisar reiniciar o app.
    onModeChange?.(mode);
    if (mode === 'client') onGoRemote?.();
  }

  async function pickBrowser(id: string) {
    setBrowserBackend(id);
    try { await window.maestrus.app.setBrowserBackend?.(id); } catch {}
  }

  async function toggleGfxCompat() {
    const next = !gfxCompat;
    setGfxCompat(next);
    try {
      const r = await window.maestrus.app.setGraphicsCompat?.(next);
      setGfxNeedsRestart(!!(r && r.needsRestart));
    } catch {}
  }

  async function loadSessions() {
    setLoadingSessions(true); setImportErr(null);
    const r = await window.maestrus.cloud.listSessions();
    setLoadingSessions(false);
    setSessions(r.ok ? r.sessions : []);
  }

  async function importOne(s: ClaudeSession) {
    setImporting(s.sessionId); setImportErr(null);
    const r = await window.maestrus.cloud.importSession({ sessionId: s.sessionId, cwd: s.cwd, name: s.name });
    setImporting(null);
    if (r.ok) setImported((m) => ({ ...m, [s.sessionId]: true }));
    else setImportErr(r.error === 'not_logged_in' ? t('settings.importLoginFirst') : (r.error || 'erro'));
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1><SettingsIcon size={18} /> {t('settings.title')}</h1>
      </div>

      <section className="settings-section">
        <h2><Languages size={15} /> {t('settings.languageTitle')}</h2>
        <p className="page-sub">{t('settings.languageDesc')}</p>
        <div className="lang-row">
          {LANGS.map((l) => (
            <button key={l.id} className={`lang-btn ${lang === l.id ? 'active' : ''}`} onClick={() => setLang(l.id)}>
              <span className="lang-flag">{l.flag}</span> {l.label}
            </button>
          ))}
        </div>
      </section>

      <ClaudeAccounts />

      {!isSelfhost && (
      <section className="settings-section">
        <h2><KeyRound size={15} /> {t('claudeApi.title') || 'Claude API'}</h2>
        <p className="page-sub">{t('claudeApi.desc') || 'Use sua própria API key da Anthropic como engine alternativa (switch Claude CLI × Claude API no topo do chat). A chave é criptografada com sua licença e vale em todos os seus dispositivos — inclusive no seu Maestrus na nuvem.'}</p>

        {hasAntKey === null && <div className="page-sub"><Loader2 size={13} className="spin" /> {t('common.loading') || 'Carregando…'}</div>}

        {hasAntKey === true && !antEditing && (
          <div className="byok-status">
            <span className="byok-status-ok"><Check size={14} /> {t('claudeApi.configured') || 'Chave da Anthropic configurada'}</span>
            <div className="byok-actions">
              <button className="btn-secondary" onClick={() => { setAntEditing(true); setAntInput(''); }}>{t('byok.change') || 'Trocar'}</button>
              <button className="btn-icon danger" onClick={deleteAntKey} title={t('byok.delete') || 'Remover chave'}><Trash2 size={14} /></button>
            </div>
          </div>
        )}

        {(hasAntKey === false || antEditing) && (
          <div className="byok-form">
            <label className="field">
              <span>{t('claudeApi.label') || 'Anthropic API key'}</span>
              <input
                type="password"
                value={antInput}
                onChange={(e) => setAntInput(e.target.value)}
                placeholder="sk-ant-…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="byok-hint">
              <span>{t('byok.where') || 'Não tem uma?'}</span>
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); (window as any).maestrus?.shell?.openExternal?.('https://console.anthropic.com/settings/keys'); }}>
                console.anthropic.com/settings/keys <ExternalLink size={11} />
              </a>
            </div>
            {antError && <div className="byok-error"><AlertCircle size={13} /> {antError}</div>}
            <div className="byok-actions">
              <button className="btn-primary" onClick={saveAntKey} disabled={antSaving || !antInput.trim().startsWith('sk-ant-')}>
                {antSaving ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {t('byok.save') || 'Salvar'}
              </button>
              {antEditing && (
                <button className="btn-secondary" onClick={() => { setAntEditing(false); setAntInput(''); setAntError(''); }}>{t('common.cancel') || 'Cancelar'}</button>
              )}
            </div>
          </div>
        )}
      </section>
      )}

      {!isSelfhost && (
      <section className="settings-section">
        <h2><KeyRound size={15} /> {t('byok.title') || 'OpenAI Voice (BYOK)'}</h2>
        <p className="page-sub">{t('byok.desc') || 'Use your own OpenAI key to power the realtime voice assistant. The key is encrypted with your license and stored on your Maestrus account — works across desktop, PWA and web.'}</p>

        {hasOpenaiKey === null && <div className="page-sub"><Loader2 size={13} className="spin" /> {t('common.loading') || 'Loading…'}</div>}

        {hasOpenaiKey === true && !oaiEditing && (
          <div className="byok-status">
            <span className="byok-status-ok"><Check size={14} /> {t('byok.configured') || 'OpenAI key configured'}</span>
            <div className="byok-actions">
              <button className="btn-secondary" onClick={() => { setOaiEditing(true); setOaiInput(''); }}>{t('byok.change') || 'Change'}</button>
              <button className="btn-icon danger" onClick={deleteOpenaiKey} title={t('byok.delete') || 'Delete key'}><Trash2 size={14} /></button>
            </div>
          </div>
        )}

        {(hasOpenaiKey === false || oaiEditing) && (
          <div className="byok-form">
            <label className="field">
              <span>{t('byok.label') || 'OpenAI API key'}</span>
              <input
                type="password"
                value={oaiInput}
                onChange={(e) => setOaiInput(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="byok-hint">
              <span>{t('byok.where') || "Don't have one?"}</span>
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); (window as any).maestrus?.shell?.openExternal?.('https://platform.openai.com/api-keys'); }}>
                platform.openai.com/api-keys <ExternalLink size={11} />
              </a>
            </div>
            {oaiError && <div className="byok-error"><AlertCircle size={13} /> {oaiError}</div>}
            <div className="byok-actions">
              <button className="btn-primary" onClick={saveOpenaiKey} disabled={oaiSaving || !oaiInput.trim().startsWith('sk-')}>
                {oaiSaving ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {t('byok.save') || 'Save'}
              </button>
              {oaiEditing && (
                <button className="btn-secondary" onClick={() => { setOaiEditing(false); setOaiInput(''); setOaiError(''); }}>{t('common.cancel') || 'Cancel'}</button>
              )}
            </div>
            <div className="byok-footnote"><Mic size={11} /> {t('byok.footnote') || 'Enables realtime voice (gpt-4o-realtime) with full access to Maestrus tools, MCPs, project dispatch and computer use.'}</div>
          </div>
        )}
      </section>
      )}

      {!isWeb && (<>
      <section className="settings-section">
        <h2><Globe size={15} /> {t('settings.browserTitle')}</h2>
        <p className="page-sub">{t('settings.browserDesc')}</p>
        <div className="browser-list">
          {browsers.map((b) => (
            <button
              key={b.id}
              className={`browser-opt ${browserBackend === b.id ? 'active' : ''}`}
              onClick={() => pickBrowser(b.id)}
            >
              <span className="browser-radio">{browserBackend === b.id ? <Check size={13} /> : null}</span>
              <span className="browser-info">
                <span className="browser-label">{b.label} {b.beta && <span className="browser-beta">beta</span>}</span>
                <span className="browser-desc">{b.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2><Server size={15} /> {t('mode.settingsTitle')}</h2>
        <p className="page-sub">{t('mode.settingsDesc')}</p>
        <div className="browser-list">
          <button className={`browser-opt ${appMode === 'server' ? 'active' : ''}`} onClick={() => pickMode('server')}>
            <span className="browser-radio">{appMode === 'server' ? <Check size={13} /> : null}</span>
            <span className="browser-info">
              <span className="browser-label"><Server size={13} /> {t('mode.serverTitle')}</span>
              <span className="browser-desc">{t('mode.serverDesc')}</span>
            </span>
          </button>
          <button className={`browser-opt ${appMode === 'client' ? 'active' : ''}`} onClick={() => pickMode('client')}>
            <span className="browser-radio">{appMode === 'client' ? <Check size={13} /> : null}</span>
            <span className="browser-info">
              <span className="browser-label"><MonitorSmartphone size={13} /> {t('mode.clientTitle')}</span>
              <span className="browser-desc">{t('mode.clientDesc')}</span>
            </span>
          </button>
        </div>
        {appMode === 'client' && <p className="page-sub" style={{ marginTop: 8 }}>{t('mode.clientHint')}</p>}
        <button
          className={`browser-opt ${hostAlways ? 'active' : ''}`}
          style={{ marginTop: 12, width: '100%' }}
          onClick={toggleHostAlways}
        >
          <span className="browser-radio">{hostAlways ? <Check size={13} /> : null}</span>
          <span className="browser-info">
            <span className="browser-label"><Server size={13} /> {t('mode.hostAlwaysTitle')}</span>
            <span className="browser-desc">{t('mode.hostAlwaysDesc')}</span>
          </span>
        </button>
      </section>

      <section className="settings-section">
        <h2><FolderInput size={15} /> {t('settings.importTitle')}</h2>
        <p className="page-sub">{t('settings.importDesc')}</p>
        <button className="btn-secondary" onClick={loadSessions} disabled={loadingSessions} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {loadingSessions ? <Loader2 size={13} className="spin" /> : <DownloadCloud size={13} />} {t('settings.importLoad')}
        </button>
        {importErr && <div className="cloud-error" style={{ marginTop: 10 }}>{importErr}</div>}

        {sessions && sessions.length === 0 && <div className="page-sub" style={{ marginTop: 10 }}>{t('settings.noSessions')}</div>}
        {sessions && sessions.length > 0 && (
          <input
            className="sess-search"
            placeholder={t('settings.searchSessions')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {sessions && sessions.length > 0 && (
          <div className="sess-list">
            {sessions
              .filter((s) => {
                const q = query.trim().toLowerCase();
                if (!q) return true;
                return s.name.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q) || (s.branch || '').toLowerCase().includes(q);
              })
              .map((s) => (
              <div className="sess-item" key={s.sessionId}>
                <div className="sess-info">
                  <div className="sess-name">{s.name}{s.archived && <span className="sess-badge">arquivada</span>}</div>
                  <div className="sess-meta">
                    {s.cwd && <span className="sess-cwd" title={s.cwd}>{s.cwd}</span>}
                    {s.branch && <span className="sess-branch">⌥ {s.branch}</span>}
                    <span>{s.messages} msgs · {fmtDate(s.modified)}</span>
                  </div>
                </div>
                {imported[s.sessionId] ? (
                  <span className="sess-done"><Check size={14} /> {t('settings.importDone')}</span>
                ) : (
                  <button className="btn-secondary sess-import" disabled={importing === s.sessionId || !s.cwd} onClick={() => importOne(s)}>
                    {importing === s.sessionId ? <Loader2 size={13} className="spin" /> : <DownloadCloud size={13} />} {t('settings.import')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2><MonitorCog size={15} /> {t('settings.graphicsTitle')}</h2>
        <p className="page-sub">{t('settings.graphicsDesc')}</p>
        <label className="set-toggle">
          <input type="checkbox" checked={gfxCompat} onChange={toggleGfxCompat} />
          <span>{t('settings.graphicsToggle')}</span>
        </label>
        {gfxNeedsRestart && (
          <div className="set-row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
            <span className="page-sub" style={{ margin: 0 }}>{t('settings.graphicsRestartHint')}</span>
            <button className="btn-primary" onClick={() => window.maestrus.app.relaunch?.()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <RefreshCw size={13} /> {t('settings.graphicsRestart')}
            </button>
          </div>
        )}
      </section>
      </>)}

      <section className="settings-section">
        <h2>{t('settings.aboutTitle')}</h2>
        <p className="page-sub">{t('settings.aboutText')}</p>
      </section>
    </div>
  );
}
