import { useEffect, useMemo, useRef, useState } from 'react';
import AudioBubble from './AudioBubble';
import { AlertOctagon, Sparkles, Terminal, Music4, ChevronRight, Wrench, Asterisk, Clock } from 'lucide-react';
import { ChatMessage } from '../types';
import { marked } from 'marked';
import { colorForProject, tintForProject, isOrchestrateTool, targetsFromInput } from '../lib/project-colors';
import { linkify } from '../lib/linkify';
import { iconForTool, labelForTool } from '../lib/tool-icons';
import { groupIntoTurns, countTools, type TurnBlock } from '../lib/transcript-turns';
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

const WINDOW = 200;
const PAGE = 200;

function projectNameFromResult(text: string | undefined, fallback: string): string {
  if (!text) return fallback;
  const single = text.match(/^\[resposta de ([^\]\(]+?)(?:\s*\()?\]/);
  if (single) return single[1].trim();
  return fallback;
}

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

// Acordeão de ferramenta: tool-use + tool-result num bloco colapsável (Kanna-style
// chip). Head sempre visível com ícone + nome + prévia + status.
function ToolBlock({ use, result }: { use: ChatMessage | null; result?: ChatMessage }) {
  const [open, setOpen] = useState(false);
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

// Card colorido de orquestração (dispatch → resposta de outro projeto).
function OrchestrationCard({ result, input }: { result: ChatMessage; input: any }) {
  const targets = targetsFromInput(input);
  const fallback = targets[0] || 'projeto';
  const name = projectNameFromResult(result.text, fallback);
  const color = colorForProject(targets[0] || name);
  return (
    <div className="msg orchestration-result"
      style={{ borderLeftColor: color, background: tintForProject(targets[0] || name, 0.08) }}>
      <div className="orchestration-head" style={{ color }}>
        <Music4 size={12} />
        <span className="orchestration-project">{name}</span>
      </div>
      <pre className="tool-output">{linkify((result.text || '').slice(0, 8000))}</pre>
    </div>
  );
}

export default function MessageList({ messages, streaming, onOpenLink, onSend }: Props) {
  const { t } = useT();
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState(WINDOW);
  const [stickToBottom, setStickToBottom] = useState(true);

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

  const visible = useMemo(() => {
    if (messages.length <= windowSize) return { items: messages, hiddenAtStart: 0 };
    const start = messages.length - windowSize;
    return { items: messages.slice(start), hiddenAtStart: start };
  }, [messages, windowSize]);

  // Agrupa em TURNOS (lógica pura testada) → cada turno vira um turn-card.
  const turns = useMemo(() => groupIntoTurns(visible.items), [visible.items]);

  // Renderiza UM bloco do turno reusando os renderizadores existentes (nenhum
  // recurso se perde — só a moldura muda pro layout em cards).
  function renderBlock(b: TurnBlock, key: string) {
    if (b.kind === 'assistant') {
      const msg = b.message;
      return (
        <div key={key} className="msg assistant">
          {msg.text && <div className="msg-body markdown" dangerouslySetInnerHTML={{ __html: renderMd(msg.text || '') }} />}
          {msg.questions && msg.questions.map((q, qi) => (
            <div key={qi} className="aq-block">
              {q.question && <div className="aq-q">{q.question}</div>}
              <div className="aq-opts">
                {q.options.map((o, oi) => (
                  <button key={oi} className="aq-opt" title={o.description} onClick={() => onSend?.(o.label)}>{o.label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (b.kind === 'thinking') {
      return (
        <div key={key} className="msg thinking">
          <div className="thinking-label"><Sparkles size={11} /> Thinking</div>
          <div className="thinking-body">{b.message.text}</div>
        </div>
      );
    }
    if (b.kind === 'compact') {
      return <div key={key} className="compact-divider"><span>{b.message.text?.replace(/^──\s*|\s*──$/g, '') || 'Conversa compactada'}</span></div>;
    }
    if (b.kind === 'system') {
      const msg = b.message;
      return (
        <div key={key} className="msg system">
          <div className="system-label"><Terminal size={11} /> maestrus</div>
          {msg.html ? <div className="system-body" dangerouslySetInnerHTML={{ __html: msg.html }} />
            : <pre className="system-body">{linkify(msg.text)}</pre>}
        </div>
      );
    }
    if (b.kind === 'error') {
      return <div key={key} className="msg error"><pre><AlertOctagon size={12} /> {b.message.text}</pre></div>;
    }
    // tool
    const use = b.use;
    if (use.role === 'tool-result') return <ToolBlock key={key} use={null} result={use} />;
    if (isOrchestrateTool(use.name)) {
      return (
        <div key={key}>
          <ToolBlock use={use} />
          {b.result && <OrchestrationCard result={b.result} input={use.input} />}
        </div>
      );
    }
    return <ToolBlock key={key} use={use} result={b.result} />;
  }

  return (
    <div className="messages transcript" ref={scrollerRef} onClickCapture={onClickCapture} onScroll={onScroll}>
      {visible.hiddenAtStart > 0 && (
        <button className="load-more" onClick={() => setWindowSize((w) => w + PAGE)}>
          {t('chat.loadOlder', { n: Math.min(PAGE, visible.hiddenAtStart) })}
        </button>
      )}
      {turns.map((turn, ti) => {
        // Turno só com divisor de compactação → linha full-width, sem card.
        if (!turn.user && turn.blocks.length === 1 && turn.blocks[0].kind === 'compact') {
          return renderBlock(turn.blocks[0], `c-${ti}`);
        }
        const nTools = countTools(turn);
        return (
          <div key={`${turn.id}-${ti}`} className="turn">
            {turn.user && (
              <div className={`turn-user ${turn.user.queued ? 'queued' : ''}`}>
                {turn.user.queued && <span className="turn-user-glyph"><Clock size={12} /></span>}
                {turn.user.audioUrl ? (
                  /* Nota de voz: o player mostra o áudio original e, embaixo, o
                     texto que foi de fato enviado ao agente. */
                  <AudioBubble src={turn.user.audioUrl} durationMs={turn.user.audioDurationMs} text={turn.user.text} />
                ) : (
                  <div className="turn-user-text">{linkify(turn.user.text)}</div>
                )}
              </div>
            )}
            {turn.blocks.length > 0 && (
              <div className="turn-response">
                <span className="turn-mark"><Asterisk size={15} /></span>
                <div className="turn-body">
                  {nTools >= 3 && <div className="turn-card-meta">{nTools} {t('chat.toolsRan') || 'ferramentas'}</div>}
                  {turn.blocks.map((b, bi) => renderBlock(b, `${ti}-${bi}`))}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {streaming && <div className="msg streaming-dots"><span /><span /><span /></div>}
      <div ref={endRef} />
    </div>
  );
}
