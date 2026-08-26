// Store global de atividade por projeto. Vive FORA da árvore React (singleton),
// então sobrevive à troca de aba/conversa — o ProjectChat/Chat desmonta, mas o
// rastreamento continua por baixo dos panos. Um único listener no nível do App
// alimenta este store com TODOS os eventos do Claude (de qualquer projeto), e a
// sidebar + os chats leem daqui via useSyncExternalStore.
//
// Status por projeto:
//   working — turno em andamento (recebendo thinking/tool/texto). 3 bolinhas.
//   unread  — terminou de responder enquanto o projeto NÃO estava aberto. badge.
//   idle    — nada acontecendo / já lido.
//
// Isso resolve dois sintomas: (1) a conversa "parava" ao trocar de aba porque o
// componente que escutava desmontava; (2) abrir um projeto que parecia parado e
// 3s depois ele começar a falar sem aviso de que estava trabalhando.

import { useSyncExternalStore } from 'react';

export type ActivityStatus = 'idle' | 'working' | 'unread';
export type ActivityPhase = 'thinking' | 'tool' | 'typing' | null;

export interface Activity {
  status: ActivityStatus;
  phase: ActivityPhase;
  since: number;       // timestamp da última transição
  toolName?: string;   // nome da tool em uso (phase==='tool')
}

const map = new Map<string, Activity>();
let activeId: string | null = null;
const listeners = new Set<() => void>();
let snapshot: Record<string, Activity> = {};

function rebuild() {
  const o: Record<string, Activity> = {};
  for (const [k, v] of map) o[k] = v;
  snapshot = o;
}
function emit() { rebuild(); listeners.forEach((l) => { try { l(); } catch {} }); }

// Tipos de evento que indicam trabalho ativo e os que encerram o turno.
const WORKING = new Set(['user', 'delta', 'assistant-text', 'thinking', 'tool-use', 'tool-result']);
const TERMINAL = new Set(['done', 'result', 'error']);

function phaseOf(type: string): ActivityPhase {
  if (type === 'thinking') return 'thinking';
  if (type === 'tool-use' || type === 'tool-result') return 'tool';
  return 'typing';
}

// Alimentado pelo listener global do App. `evt` é o ClaudeEvent cru.
export function noteEvent(evt: any): void {
  const id = evt && evt.projectId;
  if (!id || id === '*') return;
  const type = String(evt.type || '');

  if (WORKING.has(type)) {
    const prev = map.get(id);
    const phase = phaseOf(type);
    // Evita re-render por delta: só emite se status/phase realmente mudou.
    if (prev && prev.status === 'working' && prev.phase === phase && type !== 'tool-use') return;
    map.set(id, { status: 'working', phase, since: Date.now(), toolName: type === 'tool-use' ? evt.name : prev?.toolName });
    emit();
    return;
  }

  if (TERMINAL.has(type)) {
    const prev = map.get(id);
    // Terminou: se está aberto/ativo → idle (já está vendo). Senão, e estava
    // mesmo trabalhando, marca unread (terminou mas ninguém leu).
    const status: ActivityStatus = id === activeId ? 'idle' : (prev?.status === 'working' ? 'unread' : 'idle');
    map.set(id, { status, phase: null, since: Date.now() });
    emit();
  }
}

// Chamado pelo App/MobileApp quando o projeto aberto muda. Abrir um projeto
// limpa o unread dele na hora.
export function setActiveProject(id: string | null): void {
  activeId = id;
  if (id) markRead(id);
}

export function markRead(id: string): void {
  const prev = map.get(id);
  if (prev && prev.status === 'unread') {
    map.set(id, { ...prev, status: 'idle', phase: null });
    emit();
  }
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getSnapshot(): Record<string, Activity> { return snapshot; }

// ─── Hooks ──────────────────────────────────────────────────────────────────
export function useActivityMap(): Record<string, Activity> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
export function useActivity(id: string | null | undefined): Activity | null {
  const m = useActivityMap();
  return (id && m[id]) || null;
}
