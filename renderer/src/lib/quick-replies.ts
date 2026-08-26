import { ChatMessage } from '../types';

// Detecta quando o Claude fez uma pergunta com opções, pra mostrar botões de
// resposta rápida acima do campo de texto. Funciona com a tool AskUserQuestion
// (estruturada) e com texto livre (heurística conservadora). Clicar = mandar a
// opção como próxima mensagem; digitar continua funcionando normalmente.

export interface QuickReply {
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  question?: string;
}

export function fromAskUserQuestion(input: any): QuickReply | null {
  try {
    const q = input?.questions?.[0];
    if (!q || !Array.isArray(q.options)) return null;
    const options = q.options
      .map((o: any) => ({ label: String(o?.label || '').trim(), description: o?.description ? String(o.description) : undefined }))
      .filter((o: any) => o.label);
    if (!options.length) return null;
    return { options, multiSelect: !!q.multiSelect, question: q.question };
  } catch { return null; }
}

// Heurística: a mensagem termina como pergunta e tem uma lista curta de itens.
export function parseQuickReplies(text: string): QuickReply | null {
  if (!text) return null;
  const t = text.trim();
  if (!t.slice(-280).includes('?')) return null; // sem pergunta no fim → ignora
  const opts: { label: string; description?: string }[] = [];
  for (const raw of t.split(/\n/)) {
    const line = raw.trim();
    const m = line.match(/^(?:\d+[.)]|[-*•])\s+(.+)$/);
    if (!m) continue;
    const body = m[1].trim();
    let label = '', desc = '';
    const bold = body.match(/^\*\*(.+?)\*\*\s*[:\-—–]?\s*(.*)$/);
    if (bold) { label = bold[1]; desc = bold[2]; }
    else { const s = body.split(/\s+[—–]\s+|:\s+/); label = s[0]; desc = s.slice(1).join(' '); }
    label = label.replace(/[*`]/g, '').trim();
    desc = desc.replace(/[*`]/g, '').trim();
    if (label && label.length <= 64) opts.push({ label, description: desc || undefined });
  }
  if (opts.length >= 2 && opts.length <= 6) return { options: opts, multiSelect: false };
  return null;
}

// Tenta detectar se o último texto do assistant termina com uma lista de opções
// (heurística baseada em bullet/número + pergunta). A AskUserQuestion estruturada
// já é tratada diretamente no bubble via msg.questions — não precisa de heurística.
export function computeQuickReplies(messages: ChatMessage[]): QuickReply | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.pending) continue;
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.text && !m.questions) {
      return parseQuickReplies(m.text);
    }
  }
  return null;
}
