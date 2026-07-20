import { useEffect, useMemo, useState } from 'react';
import { Plug, Search, Loader2, Check, Trash2, ExternalLink, Plus, X, Globe, TerminalSquare, AlertTriangle } from 'lucide-react';
import { useT } from '../lib/i18n';
import { McpConnector, McpSearchItem, McpField } from '../types';

// Tela ÚNICA de MCP: Ativos + Explorar (busca na MCP Registry oficial) +
// Populares (curados) + Personalizado. O usuário só preenche a autenticação; o
// servidor escolhido é instalado e ativado no .mcp.json de todo projeto.

type Draft = Record<string, string>;

function RequiresBadge({ requires }: { requires?: string }) {
  const { t } = useT();
  if (!requires || requires === 'node' || requires === 'none') return null;
  return <span className="mcpu-req"><AlertTriangle size={10} /> {t('mcp.requires', { what: requires })}</span>;
}

function TransportBadge({ transport }: { transport?: string }) {
  if (transport === 'http' || transport === 'sse') return <span className="mcpu-tp"><Globe size={10} /> remoto</span>;
  return <span className="mcpu-tp"><TerminalSquare size={10} /> local</span>;
}

// Form de campos de auth reutilizável.
function AuthFields({ fields, draft, setDraft }: { fields: McpField[]; draft: Draft; setDraft: (d: Draft) => void }) {
  if (!fields.length) return null;
  return (
    <>
      {fields.map((f) => (
        <label key={f.key} className="mcp-field">
          <span>{f.label}{f.required ? ' *' : ''}</span>
          <input
            type={f.secret ? 'password' : 'text'}
            placeholder={f.placeholder}
            value={draft[f.key] || ''}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            autoComplete="off"
          />
        </label>
      ))}
    </>
  );
}

export default function McpScreen() {
  const { t } = useT();
  const mcp = window.maestrus.mcp;
  // Descrição i18n por conector (fallback pro desc do catálogo p/ custom/registry).
  const desc = (c: any) => { const k = `mcp.cat.${c.id}`; const v = t(k); return v === k ? (c.desc || '') : v; };
  const [popular, setPopular] = useState<McpConnector[]>([]);
  const [installed, setInstalled] = useState<McpConnector[]>([]);
  const [encOk, setEncOk] = useState(true);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<McpSearchItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);

  async function load() {
    if (!mcp) { setLoading(false); return; }
    const r = await mcp.catalog();
    setPopular(r.popular || []);
    setInstalled(r.installed || []);
    setEncOk(r.encAvailable !== false);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // Ativos = curados habilitados + instalados.
  const active = useMemo(() => {
    const cur = popular.filter((p) => p.enabled);
    return [...cur, ...installed];
  }, [popular, installed]);

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!mcp) return;
    setSearching(true); setSearchErr(null);
    try {
      const r = await mcp.search(query.trim());
      if (r.ok) setResults(r.items || []);
      else { setResults([]); setSearchErr(r.error || t('mcp.searchErr')); }
    } catch (err: any) { setResults([]); setSearchErr(err?.message || t('mcp.searchErr')); }
    finally { setSearching(false); }
  }

  function expand(id: string) { setOpen(open === id ? null : id); setDraft({}); }

  // Instalar um resultado da busca.
  async function installResult(it: McpSearchItem) {
    if (!mcp) return;
    const required = (it.fields || []).filter((f) => f.required);
    if (required.length && open !== 'r:' + it.id) { setOpen('r:' + it.id); setDraft({}); return; }
    setBusy(it.id);
    try {
      await mcp.install(it, draft);
      setOpen(null); setDraft({});
      await load();
      // marca como instalado na lista de resultados
      setResults((rs) => rs ? rs.map((x) => x.id === it.id ? { ...x, installed: true } : x) : rs);
    } finally { setBusy(null); }
  }

  // Curado: conectar (auth) e ativar.
  async function connectCurated(c: McpConnector) {
    if (!mcp) return;
    const required = c.fields.filter((f) => f.secret);
    if (required.length && open !== 'c:' + c.id) { setOpen('c:' + c.id); setDraft({}); return; }
    setBusy(c.id);
    try {
      if (c.fields.length) await mcp.setAuth(c.id, draft);
      await mcp.enable(c.id);
      setOpen(null); setDraft({});
      await load();
    } finally { setBusy(null); }
  }

  async function toggle(c: McpConnector) {
    if (!mcp) return;
    setBusy(c.id);
    try {
      if (c.enabled) await mcp.disable(c.id);
      else if (c.kind === 'curated' && !c.configured && c.fields.length) { expand('c:' + c.id); return; }
      else await mcp.enable(c.id);
      await load();
    } finally { setBusy(null); }
  }

  async function remove(c: McpConnector) {
    if (!mcp) return;
    if (!window.confirm(t('mcp.confirmRemove2', { name: c.label }))) return;
    setBusy(c.id);
    try {
      if (c.kind === 'installed') await mcp.uninstall(c.id);
      else await mcp.removeAuth(c.id);
      await load();
    } finally { setBusy(null); }
  }

  if (loading) return <div className="page"><div className="page-head"><h1><Plug size={18} /> {t('mcp.title')}</h1></div><div className="page-sub"><Loader2 size={13} className="spin" /> {t('mcp.loading')}</div></div>;
  if (!mcp) return <div className="page"><div className="page-head"><h1><Plug size={18} /> {t('mcp.title')}</h1></div><div className="page-sub">{t('mcp.unavailable')}</div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <h1><Plug size={18} /> {t('mcp.title')}</h1>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => setShowCustom(true)}><Plus size={13} /> {t('mcp.addCustom')}</button>
        </div>
      </div>
      <p className="page-sub">{t('mcp.unifiedSub')}</p>
      {!encOk && <div className="cloud-error" style={{ margin: '8px 0' }}>{t('mcp.noCrypto')}</div>}

      {/* Explorar — busca na registry */}
      <form className="mcpu-search" onSubmit={runSearch}>
        <Search size={15} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('mcp.searchPlaceholder')} />
        <button className="btn-primary" type="submit" disabled={searching}>
          {searching ? <Loader2 size={13} className="spin" /> : <Search size={13} />} {t('mcp.searchBtn')}
        </button>
      </form>

      {searchErr && <div className="cloud-error" style={{ marginBottom: 10 }}>{searchErr}</div>}

      {results !== null && (
        <div className="mcpu-section">
          <div className="mcpu-section-title">{t('mcp.resultsTitle')} <span className="mcpu-count">{results.length}</span></div>
          {results.length === 0 && !searching && <div className="page-sub">{t('mcp.noResults')}</div>}
          <div className="mcpu-list">
            {results.map((it) => (
              <div key={it.id} className="mcpu-card">
                <div className="mcpu-card-main">
                  <div className="mcpu-card-name">
                    {it.label}
                    <TransportBadge transport={it.transport} />
                    <RequiresBadge requires={it.requires} />
                    {it.installed && <span className="mcpu-badge"><Check size={11} /> {t('mcp.installed')}</span>}
                  </div>
                  <div className="mcpu-card-desc">{it.description}</div>
                  <div className="mcpu-reg">{it.regName}{it.version ? ` · v${it.version}` : ''}</div>
                  {open === 'r:' + it.id && <div className="mcpu-form"><AuthFields fields={it.fields} draft={draft} setDraft={setDraft} /></div>}
                </div>
                <button className="btn-primary mcpu-install" disabled={busy === it.id || it.installed} onClick={() => installResult(it)}>
                  {busy === it.id ? <Loader2 size={12} className="spin" /> : it.installed ? <Check size={12} /> : <Plus size={12} />}
                  {it.installed ? t('mcp.installed') : (open === 'r:' + it.id ? t('mcp.confirmInstall') : t('mcp.install'))}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ativos */}
      {active.length > 0 && (
        <div className="mcpu-section">
          <div className="mcpu-section-title">{t('mcp.activeTitle')} <span className="mcpu-count">{active.length}</span></div>
          <div className="mcpu-list">
            {active.map((c) => (
              <div key={c.id} className="mcpu-card on">
                <div className="mcpu-card-main">
                  <div className="mcpu-card-name">{c.label} <TransportBadge transport={c.transport} /> <RequiresBadge requires={c.requires} /></div>
                  {desc(c) && <div className="mcpu-card-desc">{desc(c)}</div>}
                  {open === 'a:' + c.id && (
                    <div className="mcpu-form">
                      <AuthFields fields={c.fields} draft={draft} setDraft={setDraft} />
                      <button className="btn-primary" onClick={() => mcp.setAuth(c.id, draft).then(() => { setOpen(null); load(); })}><Check size={12} /> {t('mcp.save')}</button>
                    </div>
                  )}
                </div>
                <div className="mcpu-actions">
                  {c.fields.length > 0 && <button className="icon-btn" title={t('mcp.editAuth')} onClick={() => expand('a:' + c.id)}><Plug size={14} /></button>}
                  <button className={`mcp-toggle ${c.enabled ? 'on' : ''}`} disabled={busy === c.id} onClick={() => toggle(c)}>
                    {busy === c.id ? <Loader2 size={12} className="spin" /> : <span className="mcp-knob" />}
                  </button>
                  <button className="icon-btn danger" title={t('mcp.remove')} onClick={() => remove(c)}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Populares (curados) */}
      <div className="mcpu-section">
        <div className="mcpu-section-title">{t('mcp.popularTitle')}</div>
        <div className="mcpu-grid">
          {popular.map((c) => (
            <div key={c.id} className={`mcpu-pop ${c.enabled ? 'on' : ''}`}>
              <div className="mcpu-pop-head" onClick={() => expand('c:' + c.id)}>
                <span className="mcpu-card-name">{c.label}{c.enabled && <span className="mcpu-badge"><Check size={11} /> {t('mcp.on')}</span>}</span>
                <span className="mcpu-card-desc">{desc(c)}</span>
              </div>
              {open === 'c:' + c.id && (
                <div className="mcpu-form">
                  <AuthFields fields={c.fields} draft={draft} setDraft={setDraft} />
                  <div className="mcp-card-actions">
                    {c.docs && <a className="mcp-docs" href={c.docs} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {t('mcp.getToken')}</a>}
                    <div style={{ flex: 1 }} />
                    <button className="btn-primary" disabled={busy === c.id} onClick={() => connectCurated(c)}>
                      {busy === c.id ? <Loader2 size={12} className="spin" /> : <Check size={12} />} {t('mcp.connect')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {showCustom && <CustomModal onClose={() => setShowCustom(false)} onSaved={() => { setShowCustom(false); load(); }} />}
    </div>
  );
}

// Modal de servidor personalizado (stdio/http/sse manual).
function CustomModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const mcp = window.maestrus.mcp;
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!mcp) return;
    if (transport === 'stdio' && !command.trim()) return;
    if (transport !== 'stdio' && !url.trim()) return;
    setBusy(true);
    try {
      const values: Record<string, string> = {};
      const headerTemplates: { name: string; value: string }[] = [];
      if (transport === 'stdio') {
        for (const line of env.split('\n')) { const i = line.indexOf('='); if (i > 0) values[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      } else {
        for (const line of headers.split('\n')) { const i = line.indexOf(':'); if (i > 0) headerTemplates.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }); }
      }
      await mcp.install({
        label: label || command || url, transport, source: 'custom',
        command: transport === 'stdio' ? command.trim() : undefined,
        args: transport === 'stdio' ? args.trim() : undefined,
        url: transport !== 'stdio' ? url.trim() : undefined,
        headerTemplates: transport !== 'stdio' ? headerTemplates : undefined,
        fields: [],
      }, values);
      onSaved();
    } finally { setBusy(false); }
  }

  return (
    <div className="mcp-modal-backdrop" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-modal-head"><h3><Plug size={15} /> {t('mcp.customTitle')}</h3><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
        <p className="page-sub">{t('mcp.customDesc')}</p>
        <div className="mcpu-seg">
          {(['stdio', 'http', 'sse'] as const).map((tp) => (
            <button key={tp} className={transport === tp ? 'active' : ''} onClick={() => setTransport(tp)}>{tp === 'stdio' ? t('mcp.local') : tp.toUpperCase()}</button>
          ))}
        </div>
        <label className="mcp-field"><span>{t('mcp.customName')}</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="meu-conector" /></label>
        {transport === 'stdio' ? (
          <>
            <label className="mcp-field"><span>Command</span><input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" /></label>
            <label className="mcp-field"><span>Args</span><input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y algum-mcp-server" /></label>
            <label className="mcp-field"><span>{t('mcp.customEnv')}</span><textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder={'API_KEY=...'} /></label>
          </>
        ) : (
          <>
            <label className="mcp-field"><span>URL</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://servidor/mcp" /></label>
            <label className="mcp-field"><span>{t('mcp.customHeaders')}</span><textarea rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder={'Authorization: Bearer ...'} /></label>
          </>
        )}
        <div className="mcp-card-actions" style={{ marginTop: 10 }}>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={onClose}>{t('mcp.cancel')}</button>
          <button className="btn-primary" disabled={busy} onClick={save}>{busy ? <Loader2 size={12} className="spin" /> : <Check size={12} />} {t('mcp.save')}</button>
        </div>
      </div>
    </div>
  );
}
