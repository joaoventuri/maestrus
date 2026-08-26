// Fase B — agrupamento do transcript em TURNOS (base dos turn-cards estilo
// Kanna). Lógica PURA e testável (vitest): pega a lista plana de ChatMessage
// (mesma que loadHistory produz) e agrupa por turno, pareando cada tool-use
// com seu tool-result. Não altera nada da leitura do .jsonl — é só uma view.
import type { ChatMessage } from '../types';

export interface ToolBlock { kind: 'tool'; use: ChatMessage; result?: ChatMessage }
export interface MsgBlock { kind: 'assistant' | 'thinking' | 'system' | 'error' | 'compact'; message: ChatMessage }
export type TurnBlock = ToolBlock | MsgBlock;

export interface Turn {
  id: string;
  /** A mensagem do usuário que abriu o turno (ausente no turno-órfão inicial). */
  user?: ChatMessage;
  blocks: TurnBlock[];
}

function turnId(user: ChatMessage | undefined, index: number): string {
  if (user) return `turn-${user.timestamp ?? ''}-${index}`;
  return `turn-orphan-${index}`;
}

// Agrupa a lista plana em turnos. Um turno começa numa mensagem 'user' e vai até
// a próxima. tool-use e tool-result são pareados por id/toolUseId dentro do turno.
export function groupIntoTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  const pushBlock = (b: TurnBlock) => {
    if (!current) { current = { id: turnId(undefined, turns.length), blocks: [] }; turns.push(current); }
    current.blocks.push(b);
  };

  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'user') {
      current = { id: turnId(m, turns.length), user: m, blocks: [] };
      turns.push(current);
      continue;
    }
    switch (m.role) {
      case 'assistant': pushBlock({ kind: 'assistant', message: m }); break;
      case 'thinking': pushBlock({ kind: 'thinking', message: m }); break;
      case 'tool-use': pushBlock({ kind: 'tool', use: m }); break;
      case 'tool-result': {
        // Pareia com o tool-use correspondente (por id) no turno atual; senão,
        // o último tool sem result; senão, vira um bloco de tool só-result.
        const blocks = current?.blocks || [];
        let target: ToolBlock | undefined;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && !b.result && (!m.toolUseId || b.use.id === m.toolUseId)) { target = b; break; }
        }
        if (target) target.result = m;
        else pushBlock({ kind: 'tool', use: m, result: m });
        break;
      }
      case 'system': pushBlock({ kind: m.compactBoundary ? 'compact' : 'system', message: m }); break;
      case 'error': pushBlock({ kind: 'error', message: m }); break;
      default: pushBlock({ kind: 'system', message: m }); break;
    }
  }
  return turns;
}

// Conta tools num turno (pro cabeçalho "N ferramentas" do turn-card colapsável).
export function countTools(turn: Turn): number {
  return turn.blocks.reduce((n, b) => n + (b.kind === 'tool' ? 1 : 0), 0);
}

// Um turno está "vazio de conteúdo visível" (só tools/system) — útil pra decidir
// se colapsa por padrão.
export function hasVisibleText(turn: Turn): boolean {
  return turn.blocks.some((b) => (b.kind === 'assistant' || b.kind === 'thinking') && !!(b as MsgBlock).message.text?.trim());
}
