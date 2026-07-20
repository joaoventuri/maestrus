import React from 'react';

// Transforma URLs em texto puro em <a> clicáveis (abrem no preview embutido via
// o onClickCapture do MessageList). Tira pontuação final comum (., ), ] etc.).
const URL_RE = /(https?:\/\/[^\s<>()"'`]+)/g;

export function linkify(text: string | undefined): React.ReactNode {
  if (!text) return text ?? '';
  if (!text.includes('http')) return text; // atalho rápido
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0];
    let trailing = '';
    const trail = url.match(/[.,;:!?)\]}'"]+$/);
    if (trail) { trailing = trail[0]; url = url.slice(0, url.length - trailing.length); }
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<a key={`${m.index}-${url}`} href={url} className="chat-link">{url}</a>);
    if (trailing) parts.push(trailing);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
}
