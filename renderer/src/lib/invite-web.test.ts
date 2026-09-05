import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { parseInvite, inviteRoom, inviteProof, inviteConnectUrl } from './invite-web';

// O lado browser e o lado desktop são DUAS implementações do mesmo protocolo.
// Testar cada um contra si mesmo não prova nada: o que quebra o pareamento é
// eles discordarem. Então o teste roda os dois e compara.
const invite = createRequire(import.meta.url)('../../../electron/invite.js');

describe('convite: browser e desktop falam o mesmo protocolo', () => {
  it('parseia o código que o desktop gerou', () => {
    const c = invite.create({ relayUrl: 'wss://r/ws', hostName: 'Mac da sala' });
    const p = parseInvite(c.code);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.secret).toBe(c.secret);
    expect(p.relayUrl).toBe('wss://r/ws');
    expect(p.hostName).toBe('Mac da sala');
  });

  it('deriva a MESMA sala e a MESMA prova que o desktop', async () => {
    const c = invite.create({ relayUrl: 'wss://r/ws' });
    expect(await inviteRoom(c.secret)).toBe(invite.roomFromSecret(c.secret));
    expect(await inviteProof(c.secret)).toBe(invite.proofFor(c.secret));
  });

  it('monta a mesma URL de conexão que o desktop', async () => {
    const c = invite.create({ relayUrl: 'wss://r/ws' });
    expect(await inviteConnectUrl('wss://r/ws', c.secret, 'dev-1', 'client'))
      .toBe(invite.connectUrl('wss://r/ws', c.secret, 'dev-1', 'client'));
  });

  it('aceita a URL do QR e o link com querystring', () => {
    const c = invite.create({ relayUrl: 'wss://r/ws' });
    for (const form of [invite.toUrl(c.code), `https://exemplo/x?c=${c.code}`, c.code]) {
      const p = parseInvite(form);
      expect(p.ok).toBe(true);
      if (p.ok) expect(p.secret).toBe(c.secret);
    }
  });

  it('recusa convite vencido, lixo e versão desconhecida', () => {
    expect(parseInvite('')).toMatchObject({ ok: false, error: 'empty' });
    expect(parseInvite('nao-e-base64-valido!!')).toMatchObject({ ok: false });
    const old = invite.create({ relayUrl: 'wss://r/ws', ttlMs: 60_000 });
    const expired = Buffer.from(JSON.stringify({ v: 1, u: 'wss://r/ws', s: 'x', e: Date.now() - 1000 })).toString('base64url');
    expect(parseInvite(expired)).toMatchObject({ ok: false, error: 'expired' });
    const v9 = Buffer.from(JSON.stringify({ v: 9, u: 'wss://r/ws', s: 'x' })).toString('base64url');
    expect(parseInvite(v9)).toMatchObject({ ok: false, error: 'unsupported_version' });
    expect(parseInvite(old.code).ok).toBe(true);
  });

  it('nome do host com acento sobrevive à viagem', () => {
    const c = invite.create({ relayUrl: 'wss://r/ws', hostName: 'Máquina do João — sala 2' });
    const p = parseInvite(c.code);
    expect(p.ok && p.hostName).toBe('Máquina do João — sala 2');
  });
});
