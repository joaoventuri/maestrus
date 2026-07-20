import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertOctagon, Sparkles, Terminal, Music4, ChevronRight, Wrench } from 'lucide-react';
import { ChatMessage } from '../types';
import { marked } from 'marked';
import { colorForProject, tintForProject, isOrchestrateTool, targetsFromInput } from '../lib/project-colors';
import { linkify } from '../lib/linkify';
import { iconForTool, labelForTool } from '../lib/tool-icons';
import { useT } from '../lib/i18n';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onOpenLink?: (url: string) => void;
  onSend?: (text: string) => void;
}

marked.setOptions({ gfm: true, breaks: true });
function renderMd(text: string): string {
  return marked.parse(text || '', { async: false }) as string;
}

// Quantas mensagens renderizar de uma vez (janela). Conversas longas viram
// "carregue mais" no topo — assim aguenta milhares sem virar pudim.
const WINDOW = 200;
const PAGE = 200;

function projectNameFromResult(text: string | undefined, fallback: string): string {
  if (!text) return fallback;
  const single = text.match(/^\[resposta de ([^\]\(]+?)(?:\s*\()?\]/);
  if (single) return single[1].trim();
  return fallback;
}

// Resumo curto do input pra mostrar na lateral do head.
function briefInputPreview(input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (input.__truncated) return `(${Math.round((input.__originalSize || 0) / 1024)}KB)`;
  for (const k of ['command', 'file_path', 'path', 'prompt', 'query', 'url', 'pattern', 'description']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').slice(0, 120);
  }
  try { return JSON.stringify(input).slice(0, 120); } catch { return ''; }
}

function safeJsonShort(o: any, cap = 8000): string {
  try {
    const s = JSON.stringify(o, null, 2);
    return s.length > cap ? s.slice(0, cap) + '\n…' : s;
  } catch { return ''; }
}

// Acordeão unificado: combina tool-use + tool-result num único bloco.
// Head sempre visível com nome + prévia do input + status (✓/✗/…).
function ToolBlock({ use, result }: { use: ChatMessage | null; result?: ChatMessage }) {
  const [open, setOpen] = useState(false);
  // Result órfão (sem use): bloco solo
  if (!use && result) {
    const isError = !!result.isError;
    const txt = (result.text || '').slice(0, 8000);
    const lines = txt ? txt.split('\n').length : 0;
    return (
      <div className={`tool-acc ${open ? 'open' : ''} ${isError ? 'err' : ''}`}>
        <button className="tool-acc-head" onClick={() => setOpen((o) => !o)} type="button">
          <ChevronRight size={12} className="tool-chev" />
          <Wrench size={13} className="tool-icon" />
          <span className="tool-name">{isError ? 'error' : 'result'}</span>
          {lines > 0 && <span className="tool-meta">{lines} ln</span>}
        </button>
        {open && txt && <pre className="tool-acc-body">{linkify(txt)}</pre>}
      </div>
    );
  }
  if (!use) return null;
  const name = use.name || 'tool';
  const orchestrate = isOrchestrateTool(name);
  const Icon = orchestrate ? Music4 : iconForTool(name);
  const label = orchestrate ? 'maestrus · dispatch' : labelForTool(name);
  const preview = briefInputPreview(use.input);
  const inputBody = use.input ? safeJsonShort(use.input) : '';
  const resultBody = result ? (result.text || '').slice(0, 8000) : '';
  const hasResult = !!result;
  const isError = !!result?.isError;
  return (
    <div className={`tool-acc ${open ? 'open' : ''} ${isError ? 'err' : ''} ${hasResult ? '' : 'pending'} ${orchestrate ? 'orchestrate' : ''}`}>
      <button className="tool-acc-head" onClick={() => setOpen((o) => !o)} type="button">
        <ChevronRight size={12} className="tool-chev" />
        <Icon size={13} className="tool-icon" />
        <span className="tool-name">{label}</span>
        {preview && <span className="tool-preview">{preview}</span>}
        <span className="tool-status">{isError ? '✗' : hasResult ? '✓' : '…'}</span>
      </button>
      {open && (
        <>
          {inputBody && <pre className="tool-acc-body">{inputBody}</pre>}
          {hasResult && resultBody && (
            <pre className={`tool-acc-body out ${isError ? 'err' : ''}`}>{linkify(resultBody)}</pre>
          )}
        </>
      )}
    </div>
  );
}

interface OrchestrationMeta { key: string; name: string }

export default function MessageList({ messages, streaming, onOpenLink, onSend }: Props) {
  const { t } = useT();
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState(WINDOW);
  // Quando o usuário rola pra cima, paramos o auto-scroll pra não atropelar.
  const [stickToBottom, setStickToBottom] = useState(true);

  // Reseta janela se trocar conversa (heurística: queda drástica no length).
  useEffect(() => {
    setWindowSize(WINDOW);
    setStickToBottom(true);
  }, [messages.length === 0]);

  useEffect(() => {
    if (stickToBottom) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming, stickToBottom]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setStickToBottom(nearBottom);
  }

  function onClickCapture(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (href && /^https?:\/\//i.test(href)) {
      e.preventDefault();
      onOpenLink?.(href);
    }
  }

  // Slice da janela: últimas N. Botão "carregar mais" expande a janela.
  const visible = useMemo(() => {
    if (messages.length <= windowSize) return { items: messages, hiddenAtStart: 0 };
    const start = messages.length - windowSize;
    return { items: messages.slice(start), hiddenAtStart: start };
  }, [messages, windowSize]);

  // Map global → mapa de orquestração (precisa ver TUDO pra colorir results
  // mesmo se o tool-use ficou fora da janela).
  const orchestrateByToolId = useMemo(() => {
    const m = new Map<string, { input: any }>();
    for (const x of messages) {
      if (x.role === 'tool-use' && x.id && isOrchestrateTool(x.name)) {
        m.set(x.id, { input: x.input });
      }
    }
    return m;
  }, [messages]);

  // Map de tool-result por toolUseId (na janela visivel) pra parear no acordeao.
  const resultByToolId = useMemo(() => {
    const m = new Map<string, ChatMessage>();
    for (const x of visible.items) {
      if (x.role === 'tool-result' && x.toolUseId) m.set(x.toolUseId, x);
    }
    return m;
  }, [visible.items]);
  // Set acumulado dentro do map JSX pra pular results que ja foram renderizados
  // dentro de um tool-use anterior. (Mutavel no escopo da render — ok pra
  // unica execucao do map; React re-render limpa.)
  const consumedResultIds = new Set<string>();

  return (
    <div className="messages" ref={scrollerRef} onClickCapture={onClickCapture} onScroll={onScroll}>
      {visible.hiddenAtStart > 0 && (
        <button className="load-more" onClick={() => setWindowSize((w) => w + PAGE)}>
          {t('chat.loadOlder', { n: Math.min(PAGE, visible.hiddenAtStart) })}
        </button>
      )}
      {visible.items.map((msg, i) => {
        const key = `${visible.hiddenAtStart}-${i}`;
        if (msg.role === 'user') {
          return (
            <div key={key} className={`msg user${msg.queued ? ' queued' : ''}`}>
              <div className="msg-prefix">{msg.queued ? '⏳' : '>'}</div>
              <div className="msg-body">{linkify(msg.text)}</div>
            </div>
          );
        }
        if (msg.role === 'assistant') {
          return (
            <div key={key} className="msg assistant">
              {msg.text && <div className="msg-body markdown"
                dangerouslySetInnerHTML={{ __html: renderMd(msg.text || '') }} />}
              {msg.questions && msg.questions.map((q, qi) => (
                <div key={qi} className="aq-block">
                  {q.question && <div className="aq-q">{q.question}</div>}
                  <div className="aq-opts">
                    {q.options.map((o, oi) => (
                      <button key={oi} className="aq-opt" title={o.description} onClick={() => onSend?.(o.label)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        }
        if (msg.role === 'thinking') {
          return (
            <div key={key} className="msg thinking">
              <div className="thinking-label"><Sparkles size={11} /> Thinking</div>
              <div className="thinking-body">{msg.text}</div>
            </div>
          );
        }
        if (msg.role === 'tool-use') {
          const r = msg.id ? resultByToolId.get(msg.id) : undefined;
          if (r && r.toolUseId) consumedResultIds.add(r.toolUseId);
          // Orquestração: tool-result vira o card colorido (orchestration-result),
          // NÃO entra no acordeão — preserva o destaque visual por projeto.
          if (msg.id && orchestrateByToolId.has(msg.id)) {
            return <ToolBlock key={key} use={msg} />;
          }
          return <ToolBlock key={key} use={msg} result={r} />;
        }
        if (msg.role === 'tool-result') {
          if (msg.toolUseId && consumedResultIds.has(msg.toolUseId)) return null;
          const orch = msg.toolUseId ? orchestrateByToolId.get(msg.toolUseId) : undefined;
          if (orch) {
            const targets = targetsFromInput(orch.input);
            const fallback = targets[0] || 'projeto';
            const name = projectNameFromResult(msg.text, fallback);
            const color = colorForProject(targets[0] || name);
            return (
              <div key={key} className="msg orchestration-result"
                style={{ borderLeftColor: color, background: tintForProject(targets[0] || name, 0.08) }}>
                <div className="orchestration-head" style={{ color }}>
                  <Music4 size={12} />
                  <span className="orchestration-project">{name}</span>
                </div>
                <pre className="tool-output">{linkify((msg.text || '').slice(0, 8000))}</pre>
              </div>
            );
          }
          return <ToolBlock key={key} use={null} result={msg} />;
        }
        if (msg.role === 'system' && msg.compactBoundary) {
          // Linha contínua: o histórico ANTES do compact continua visível; este
          // divisor só marca onde o contexto ativo do Claude recomeça.
          return (
            <div key={key} className="compact-divider">
              <span>{msg.text?.replace(/^──\s*|\s*──$/g, '') || 'Conversa compactada'}</span>
            </div>
          );
        }
        if (msg.role === 'system') {
          return (
            <div key={key} className="msg system">
              <div className="system-label"><Terminal size={11} /> maestrus</div>
              {msg.html ? (
                <div className="system-body" dangerouslySetInnerHTML={{ __html: msg.html }} />
              ) : (
                <pre className="system-body">{linkify(msg.text)}</pre>
              )}
            </div>
          );
        }
        if (msg.role === 'error') {
          return (
            <div key={key} className="msg error">
              <pre><AlertOctagon size={12} /> {msg.text}</pre>
            </div>
          );
        }
        return null;
      })}
      {streaming && <div className="msg streaming-dots"><span /><span /><span /></div>}
      <div ref={endRef} />
    </div>
  );
}
