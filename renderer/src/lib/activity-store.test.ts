// As tres bolinhas do sidebar ficavam piscando para sempre quando o evento
// 'done' se perdia (relay reconectou, maquina dormiu). O status e otimista por
// evento; estes testes cobrem a reconciliacao contra a verdade do host.
import { describe, it, expect, beforeEach } from 'vitest';
import { noteEvent, staleWorking, reconcile, getSnapshot, setActiveProject } from './activity-store';

const P = 'proj-1';

function work(id = P) { noteEvent({ projectId: id, type: 'delta', text: 'x' }); }

describe('activity-store: reconciliacao', () => {
  beforeEach(() => {
    setActiveProject(null);
    noteEvent({ projectId: P, type: 'done' });
    noteEvent({ projectId: 'proj-2', type: 'done' });
  });

  it('marca working ao receber evento', () => {
    work();
    expect(getSnapshot()[P].status).toBe('working');
  });

  it('nao considera stale o que acabou de comecar', () => {
    work();
    expect(staleWorking(15000)).not.toContain(P);
  });

  it('considera stale o working antigo', () => {
    work();
    // -1 em vez de 0: com limiar zero o teste roda no mesmo milissegundo do
    // evento e `now - since > 0` e falso — falharia por timing, nao por bug.
    expect(staleWorking(-1)).toContain(P);
  });

  it('host diz que terminou -> vira unread e some das bolinhas', () => {
    work();
    reconcile(P, false);
    expect(getSnapshot()[P].status).toBe('unread');
    expect(staleWorking(-1)).not.toContain(P);
  });

  it('projeto aberto que termina vira idle, nao unread', () => {
    work();
    setActiveProject(P);
    work();
    reconcile(P, false);
    expect(getSnapshot()[P].status).toBe('idle');
  });

  it('host diz que ainda roda -> continua working e renova o relogio', () => {
    work();
    reconcile(P, true);
    expect(getSnapshot()[P].status).toBe('working');
    // sem renovar o `since`, o watchdog reconciliaria em loop a cada tick
    expect(staleWorking(15000)).not.toContain(P);
  });

  it('nao mexe em quem nao esta working', () => {
    work();
    reconcile(P, false);           // vira unread
    reconcile(P, false);           // nao pode rebaixar de novo
    expect(getSnapshot()[P].status).toBe('unread');
  });
});
