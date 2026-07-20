import { useEffect, useState } from 'react';
import { Zap, Sparkles, Bot, TerminalSquare, Plug, BookOpen, Users, Plus, Trash2, Loader2, Check, X, ExternalLink, Pencil, Search, RefreshCw } from 'lucide-react';
import { useT } from '../lib/i18n';
import McpScreen from './McpScreen';
import ClaudeAccounts from './ClaudeAccounts';

// Claude Powers — a central dos superpoderes do Claude dentro do Maestrus.
// Tudo que o Claude Code sabe usar, gerenciável numa tela só (desktop e web):
//   Skills (conta, sincronizadas) · Agents (subagentes) · Comandos (slash) ·
//   MCPs (conectores) · Regras globais (CLAUDE.md) · Contas (multi-assinatura).
// No web, agents/comandos/regras operam NO HOST conectado (máquina/container).

type Tab = 'skills' | 'agents' | 'commands' | 'mcp' | 'rules' | 'accounts';
type Item = { id: string; name: string; description: string; updatedAt?: number; cloud?: boolean };
type Draft = { id?: string; name: string; description: string; body: string };

const EMPTY_DRAFT: Draft = { name: '', description: '', body: '' };

function ItemEditor({ kind, draft, setDraft, onSave, onCancel, saving, error, t }: {
  kind: 'skill' | 'agent' | 'command';
  draft: Draft; setDraft: (d: Draft) => void;
  onSave: () => void; onCancel: () => void; saving: boolean; error: string | null; t: any;
}) {
  const bodyPh = kind === 'skill'
    ? (t('powers.skillBodyPh') || 'Instruções da skill em Markdown — o que a IA deve saber/fazer quando esta skill for usada…')
    : kind === 'agent'
      ? (t('powers.agentBodyPh') || 'System prompt do subagente — especialidade, tom, regras…')
      : (t('powers.commandBodyPh') || 'O prompt que roda quando você digita /nome-do-comando no chat…');
  return (
    <div className="pw-editor">
      <div className="pw-editor-row">
        <label className="pw-field">
          <span>{t('powers.name') || 'Nome'}</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60}
            placeholder={kind === 'command' ? 'deploy-producao' : (t('powers.namePh') || 'Ex: Especialista em SQL')} autoFocus />
        </label>
        <label className="pw-field pw-field-desc">
          <span>{t('powers.desc') || 'Descrição'}</span>
          <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={160}
            placeholder={t('powers.descPh') || 'Uma linha — quando a IA deve usar isto'} />
        </label>
      </div>
      <label className="pw-field">
        <span>{t('powers.content') || 'Conteúdo (Markdown)'}</span>
        <textarea className="pw-textarea" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder={bodyPh} rows={12} spellCheck={false} />
      </label>
      {error && <div className="byok-error">{error}</div>}
      <div className="pw-editor-actions">
        <button className="btn-primary" onClick={onSave} disabled={saving || !draft.name.trim()}>
          {saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {t('common.save') || 'Salvar'}
        </button>
        <button className="btn-secondary" onClick={onCancel}>{t('common.cancel') || 'Cancelar'}</button>
      </div>
    </div>
  );
}

// Lista + CRUD genérico (usado por Skills, Agents e Comandos — só muda a API).
function CrudList({ kind, api, t }: { kind: 'skill' | 'agent' | 'command'; api: { list: () => Promise<any>; get: (id: string) => Promise<any>; save: (d: Draft) => Promise<any>; remove: (id: string) => Promise<any> }; t: any }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await api.list();
      const arr = Array.isArray(r) ? r : (r?.items || r?.skills || []);
      if (r && r.ok === false) { setErr(r.error === 'not_connected' ? (t('powers.notConnected') || 'Conecte a um host pra gerenciar.') : (r.error || 'erro')); setItems([]); return; }
      setItems(arr.map((x: any) => ({ id: x.id, name: x.name || x.id, description: x.description || '', updatedAt: x.updatedAt, cloud: !!x.cloud })));
    } catch (e: any) { setErr(e?.message || 'erro'); setItems([]); }
  }
  useEffect(() => { load(); }, []);

  async function openEdit(id: string) {
    setErr(null);
    const r = await api.get(id).catch(() => null);
    if (r && (r.ok !== false)) setEditing({ id: r.id || id, name: r.name || id, description: r.description || '', body: r.body || r.content || '' });
  }
  async function save() {
    if (!editing) return;
    setSaving(true); setErr(null);
    try {
      const r = await api.save(editing);
      if (r && r.ok === false) setErr(r.error || 'erro');
      else { setEditing(null); load(); }
    } finally { setSaving(false); }
  }
  async function remove(id: string, name: string) {
    if (!confirm((t('powers.confirmDelete') || 'Excluir') + ` "${name}"?`)) return;
    await api.remove(id).catch(() => {});
    load();
  }

  const filtered = (items || []).filter((i) => !query.trim() || (i.name + ' ' + i.description).toLowerCase().includes(query.toLowerCase()));

  if (editing) return <ItemEditor kind={kind} draft={editing} setDraft={setEditing} onSave={save} onCancel={() => { setEditing(null); setErr(null); }} saving={saving} error={err} t={t} />;

  return (
    <div className="pw-crud">
      <div className="pw-toolbar">
        <div className="pw-search">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('powers.search') || 'Buscar…'} />
        </div>
        <button className="btn-primary" onClick={() => { setErr(null); setEditing({ ...EMPTY_DRAFT }); }}>
          <Plus size={13} /> {kind === 'skill' ? (t('powers.newSkill') || 'Nova skill') : kind === 'agent' ? (t('powers.newAgent') || 'Novo agent') : (t('powers.newCommand') || 'Novo comando')}
        </button>
      </div>
      {err && <div className="byok-error">{err}</div>}
      {items === null && <div className="page-sub"><Loader2 size={13} className="spin" /> {t('common.loading') || 'Carregando…'}</div>}
      {items !== null && filtered.length === 0 && !err && (
        <div className="pw-empty">
          {kind === 'skill' ? (t('powers.emptySkills') || 'Nenhuma skill ainda. Skills ensinam a IA a fazer algo do SEU jeito — e valem em todos os seus dispositivos.')
            : kind === 'agent' ? (t('powers.emptyAgents') || 'Nenhum subagente ainda. Agents são especialistas que o Claude convoca para tarefas específicas.')
            : (t('powers.emptyCommands') || 'Nenhum comando ainda. Comandos viram /atalhos no chat — ex: /revisar, /deploy.')}
        </div>
      )}
      <div className="pw-list">
        {filtered.map((i) => (
          <div key={i.id} className="pw-item">
            <div className="pw-item-info">
              <div className="pw-item-name">
                {kind === 'command' ? '/' + i.id : i.name}
                {i.cloud && <span className="pw-badge-cloud">{t('powers.syncedBadge') || 'sincronizada'}</span>}
              </div>
              <div className="pw-item-desc">{i.description || '—'}</div>
            </div>
            <div className="pw-item-actions">
              <button className="btn-icon" onClick={() => openEdit(i.id)} title={t('common.edit') || 'Editar'}><Pencil size={14} /></button>
              <button className="btn-icon danger" onClick={() => remove(i.id, i.name)} title={t('common.delete') || 'Excluir'}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// MCPs JÁ conectados no Claude do host — fonte: `claude mcp list` (o CLI é a
// verdade). Mostra tudo, inclusive o que foi adicionado fora do Maestrus.
function McpConnectedList({ t }: { t: any }) {
  const [items, setItems] = useState<Array<{ name: string; target: string; status: string | null; connected: boolean | null }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const api = (window as any).maestrus?.claudePowers;

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api?.mcpList?.();
      if (r?.ok === false) { setErr(r.error === 'not_connected' ? (t('powers.notConnected') || 'Conecte a um host pra gerenciar.') : (r.error || 'erro')); setItems([]); }
      else setItems(r?.items || []);
    } catch (e: any) { setErr(e?.message || 'erro'); setItems([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function remove(name: string) {
    if (!confirm((t('powers.confirmDelete') || 'Excluir') + ` MCP "${name}"?`)) return;
    await api?.mcpRemove?.(name).catch(() => {});
    load();
  }

  return (
    <div className="pw-mcp-connected">
      <div className="pw-mcp-head">
        <span>{t('powers.mcpConnectedTitle') || 'Conectados no seu Claude agora'}</span>
        <button className="btn-icon" onClick={load} disabled={loading} title={t('powers.refresh') || 'Atualizar'}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
      <p className="page-sub">{t('powers.mcpConnectedDesc') || 'Direto do `claude mcp list` — a fonte da verdade. Inclui o que foi adicionado fora do Maestrus.'}</p>
      {err && <div className="byok-error">{err}</div>}
      {items === null && <div className="page-sub"><Loader2 size={13} className="spin" /> {t('common.loading') || 'Carregando…'}</div>}
      {items !== null && items.length === 0 && !err && <div className="pw-empty">{t('powers.mcpConnectedEmpty') || 'Nenhum MCP conectado no Claude deste host ainda.'}</div>}
      <div className="pw-list">
        {(items || []).map((m) => (
          <div key={m.name} className="pw-item">
            <span className={`pw-mcp-dot ${m.connected === true ? 'ok' : m.connected === false ? 'bad' : ''}`} />
            <div className="pw-item-info">
              <div className="pw-item-name">{m.name}</div>
              <div className="pw-item-desc">{m.target}{m.status ? ` · ${m.status}` : ''}</div>
            </div>
            <div className="pw-item-actions">
              <button className="btn-icon danger" onClick={() => remove(m.name)} title={t('common.delete') || 'Excluir'}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RulesTab({ t }: { t: any }) {
  const [content, setContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const api = (window as any).maestrus?.claudePowers;

  useEffect(() => {
    api?.globalMdGet?.().then((r: any) => {
      if (r?.ok === false) { setErr(r.error === 'not_connected' ? (t('powers.notConnected') || 'Conecte a um host pra gerenciar.') : r.error); setContent(''); }
      else setContent(r?.content ?? '');
    }).catch(() => setContent(''));
  }, []);

  async function save() {
    setSaving(true); setErr(null); setSaved(false);
    try {
      const r = await api?.globalMdSet?.(content || '');
      if (r?.ok === false) setErr(r.error || 'erro');
      else { setSaved(true); setTimeout(() => setSaved(false), 2500); }
    } finally { setSaving(false); }
  }

  return (
    <div className="pw-rules">
      <p className="page-sub">{t('powers.rulesDesc') || 'Regras globais (CLAUDE.md) — valem para TODOS os projetos deste host. Convenções, tom, o que nunca fazer. Cada projeto ainda tem o CLAUDE.md próprio (editável no chat do projeto).'}</p>
      {err && <div className="byok-error">{err}</div>}
      {content === null ? (
        <div className="page-sub"><Loader2 size={13} className="spin" /> {t('common.loading') || 'Carregando…'}</div>
      ) : (
        <>
          <textarea className="pw-textarea pw-rules-ta" value={content} onChange={(e) => setContent(e.target.value)} rows={18} spellCheck={false}
            placeholder={t('powers.rulesPh') || '# Minhas regras globais\n\n- Sempre responda em português\n- Commits em conventional commits\n- Nunca use emojis em código…'} />
          <div className="pw-editor-actions">
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={13} className="spin" /> : saved ? <Check size={13} /> : <Check size={13} />} {saved ? (t('powers.saved') || 'Salvo!') : (t('common.save') || 'Salvar')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function ClaudePowersScreen() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('skills');
  const isWeb = !!(window as any).maestrus?.isWeb;
  const M: any = (window as any).maestrus;

  // Skills: no WEB opera o filesystem DO HOST via RPC (fonte da verdade = o que
  // o CLI usa); no desktop o IPC já lê o filesystem local (com badge cloud).
  const skillsApi = isWeb && M.claudePowers?.skillsList ? {
    list: () => M.claudePowers.skillsList(),
    get: (id: string) => M.claudePowers.skillsGet(id),
    save: (d: Draft) => M.claudePowers.skillsSave(d),
    remove: (id: string) => M.claudePowers.skillsDelete(id),
  } : {
    list: async () => { const r = await M.skills.list(); return r?.skills || r || []; },
    get: (id: string) => M.skills.get(id),
    save: (d: Draft) => M.skills.save(d),
    remove: (id: string) => M.skills.delete(id),
  };
  const agentsApi = {
    list: () => M.claudePowers.agentsList(),
    get: (id: string) => M.claudePowers.agentsGet(id),
    save: (d: Draft) => M.claudePowers.agentsSave(d),
    remove: (id: string) => M.claudePowers.agentsDelete(id),
  };
  const commandsApi = {
    list: () => M.claudePowers.commandsList(),
    get: (id: string) => M.claudePowers.commandsGet(id),
    save: (d: Draft) => M.claudePowers.commandsSave(d),
    remove: (id: string) => M.claudePowers.commandsDelete(id),
  };

  const TABS: Array<{ id: Tab; icon: any; label: string }> = [
    { id: 'skills', icon: Sparkles, label: t('powers.tabSkills') || 'Skills' },
    { id: 'agents', icon: Bot, label: t('powers.tabAgents') || 'Agents' },
    { id: 'commands', icon: TerminalSquare, label: t('powers.tabCommands') || 'Comandos' },
    { id: 'mcp', icon: Plug, label: 'MCPs' },
    { id: 'rules', icon: BookOpen, label: t('powers.tabRules') || 'Regras' },
    { id: 'accounts', icon: Users, label: t('powers.tabAccounts') || 'Contas' },
  ];

  return (
    <div className="page pw-page">
      <div className="page-head">
        <h1><Zap size={18} /> Claude Powers</h1>
        <p className="page-sub">{t('powers.sub') || 'Tudo que o Claude sabe usar, num lugar só — skills, subagentes, comandos, conectores MCP, regras globais e suas contas. Vale para todos os projetos.'}</p>
      </div>

      <div className="pw-tabs">
        {TABS.map(({ id, icon: Ic, label }) => (
          <button key={id} className={`pw-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            <Ic size={14} /> {label}
          </button>
        ))}
      </div>

      <div className="pw-body">
        {tab === 'skills' && (
          <>
            <p className="page-sub">{t('powers.skillsDesc') || 'Skills ensinam a IA a trabalhar do SEU jeito. Ficam na sua conta — valem no desktop, no web e no seu Maestrus na nuvem.'}</p>
            <CrudList kind="skill" api={skillsApi} t={t} />
          </>
        )}
        {tab === 'agents' && (
          <>
            <p className="page-sub">{t('powers.agentsDesc') || 'Subagentes são especialistas que o Claude convoca em paralelo — um revisor, um documentador, um caçador de bugs. Cada um com seu próprio prompt.'}</p>
            <CrudList kind="agent" api={agentsApi} t={t} />
          </>
        )}
        {tab === 'commands' && (
          <>
            <p className="page-sub">{t('powers.commandsDesc') || 'Comandos viram /atalhos no chat de qualquer projeto — o prompt que você usa toda hora, a um "/" de distância.'}</p>
            <CrudList kind="command" api={commandsApi} t={t} />
          </>
        )}
        {tab === 'mcp' && (
          <>
            <McpConnectedList t={t} />
            {isWeb ? (
              <div className="pw-mcp-web">
                <p className="page-sub">{t('powers.mcpWebDesc') || 'Pra INSTALAR novos conectores no host use o app desktop. Conectores da sua conta Claude (Gmail, Drive…) são gerenciados no site do Claude.'}</p>
                <button className="btn-primary" onClick={() => window.open('https://claude.ai/settings/connectors', '_blank', 'noopener')}>
                  <ExternalLink size={13} /> {t('powers.mcpOpenClaude') || 'Conectores do Claude no navegador'}
                </button>
              </div>
            ) : (
              <McpScreen />
            )}
          </>
        )}
        {tab === 'rules' && <RulesTab t={t} />}
        {tab === 'accounts' && <ClaudeAccounts />}
      </div>
    </div>
  );
}
