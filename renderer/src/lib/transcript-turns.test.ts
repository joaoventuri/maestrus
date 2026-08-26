import { describe, it, expect } from 'vitest';
import { groupIntoTurns, countTools, hasVisibleText } from './transcript-turns';
import type { ChatMessage } from '../types';

const u = (text: string, ts = 1): ChatMessage => ({ role: 'user', text, timestamp: ts });
const a = (text: string): ChatMessage => ({ role: 'assistant', text });
const tuse = (id: string, name: string): ChatMessage => ({ role: 'tool-use', id, name, input: {} });
const tres = (toolUseId: string, text: string): ChatMessage => ({ role: 'tool-result', toolUseId, text });

describe('groupIntoTurns', () => {
  it('agrupa cada user com sua resposta', () => {
    const turns = groupIntoTurns([u('oi', 1), a('olá'), u('tchau', 2), a('até')]);
    expect(turns).toHaveLength(2);
    expect(turns[0].user?.text).toBe('oi');
    expect(turns[0].blocks[0]).toMatchObject({ kind: 'assistant', message: { text: 'olá' } });
    expect(turns[1].user?.text).toBe('tchau');
  });

  it('pareia tool-use com tool-result pelo id', () => {
    const turns = groupIntoTurns([u('roda'), tuse('t1', 'Bash'), tres('t1', 'saída'), a('feito')]);
    expect(turns).toHaveLength(1);
    const tool = turns[0].blocks.find((b) => b.kind === 'tool') as any;
    expect(tool.use.name).toBe('Bash');
    expect(tool.result.text).toBe('saída');
    expect(countTools(turns[0])).toBe(1);
  });

  it('pareia múltiplos tools sem misturar results', () => {
    const turns = groupIntoTurns([
      u('duas coisas'),
      tuse('t1', 'Read'), tuse('t2', 'Write'),
      tres('t2', 'escrito'), tres('t1', 'lido'),
      a('ok'),
    ]);
    const tools = turns[0].blocks.filter((b) => b.kind === 'tool') as any[];
    expect(tools).toHaveLength(2);
    expect(tools.find((t) => t.use.id === 't1').result.text).toBe('lido');
    expect(tools.find((t) => t.use.id === 't2').result.text).toBe('escrito');
  });

  it('conteúdo antes do primeiro user vira turno-órfão', () => {
    const turns = groupIntoTurns([a('bem-vindo'), u('oi'), a('olá')]);
    expect(turns).toHaveLength(2);
    expect(turns[0].user).toBeUndefined();
    expect(turns[0].blocks[0]).toMatchObject({ kind: 'assistant' });
  });

  it('compactBoundary vira bloco compact', () => {
    const turns = groupIntoTurns([u('x'), { role: 'system', text: '── compactado ──', compactBoundary: true }]);
    expect(turns[0].blocks[0].kind).toBe('compact');
  });

  it('thinking e error viram seus blocos', () => {
    const turns = groupIntoTurns([u('x'), { role: 'thinking', text: 'pensando' }, { role: 'error', text: 'falhou' }]);
    expect(turns[0].blocks.map((b) => b.kind)).toEqual(['thinking', 'error']);
  });

  it('hasVisibleText distingue turno só-tools de turno com texto', () => {
    const soTools = groupIntoTurns([u('x'), tuse('t1', 'Bash'), tres('t1', 'ok')])[0];
    const comTexto = groupIntoTurns([u('x'), a('resposta')])[0];
    expect(hasVisibleText(soTools)).toBe(false);
    expect(hasVisibleText(comTexto)).toBe(true);
  });

  it('lista vazia → sem turnos', () => {
    expect(groupIntoTurns([])).toEqual([]);
    expect(groupIntoTurns(null as any)).toEqual([]);
  });
});
