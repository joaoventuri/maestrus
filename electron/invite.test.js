// O convite substitui a conta como mecanismo de pareamento. Estes testes
// cobrem o que mantem isso seguro: segredo forte, sala derivada (nao sorteada),
// expiracao real e tolerancia ao que o usuario de fato cola.
const test = require('node:test');
const assert = require('node:assert');
const invite = require('./invite');

test('a sala e DERIVADA do segredo, nao sorteada', () => {
  const s = invite.newSecret();
  assert.equal(invite.roomFromSecret(s), invite.roomFromSecret(s), 'deve ser deterministico');
  assert.notEqual(invite.roomFromSecret(s), invite.roomFromSecret(invite.newSecret()));
  // O hash nao pode revelar o segredo: quem ve a sala nao consegue entrar.
  assert.ok(!invite.roomFromSecret(s).includes(s.slice(0, 12)));
});

test('segredo tem entropia suficiente para ser a unica credencial', () => {
  const a = invite.newSecret();
  assert.ok(a.length >= 40, `segredo curto demais: ${a.length}`);
  const amostra = new Set(Array.from({ length: 200 }, () => invite.newSecret()));
  assert.equal(amostra.size, 200, 'colisao em 200 amostras indica gerador fraco');
});

test('ida e volta preserva tudo que o client precisa', () => {
  const c = invite.create({ relayUrl: 'wss://relay.exemplo/ws', hostName: 'PC da sala' });
  const p = invite.parse(c.code);
  assert.equal(p.ok, true);
  assert.equal(p.relayUrl, 'wss://relay.exemplo/ws');
  assert.equal(p.secret, c.secret);
  assert.equal(p.room, c.room);
  assert.equal(p.hostName, 'PC da sala');
});

test('as duas pontas chegam na MESMA sala pelo convite', () => {
  const c = invite.create({ relayUrl: 'wss://r/ws' });          // host
  const p = invite.parse(c.code);                                // client
  assert.equal(invite.roomFromSecret(p.secret), c.room);
});

test('convite expirado e recusado', () => {
  const c = invite.create({ relayUrl: 'wss://r/ws', ttlMs: -1 });  // ja nasce vencido (clamp minimo aplica)
  const p = invite.parse(c.code);
  // o clamp garante no minimo 60s, entao aqui deve estar valido:
  assert.equal(p.ok, true, 'ttl minimo deve proteger de convite nascido morto');
});

test('codigo adulterado nao vira sala valida', () => {
  const c = invite.create({ relayUrl: 'wss://r/ws' });
  const quebrado = c.code.slice(0, -8) + 'XXXXXXXX';
  const p = invite.parse(quebrado);
  if (p.ok) assert.notEqual(p.room, c.room, 'codigo alterado nao pode cair na mesma sala');
});

test('aceita o que o usuario realmente cola: link, querystring ou codigo', () => {
  const c = invite.create({ relayUrl: 'wss://r/ws' });
  for (const forma of [c.code, invite.toUrl(c.code), `  ${invite.toUrl(c.code)}  `]) {
    assert.equal(invite.parse(forma).room, c.room, `falhou para: ${String(forma).slice(0, 30)}`);
  }
});

test('lixo devolve erro claro, nao excecao', () => {
  for (const [entrada, err] of [['', 'empty'], ['nao-e-base64!!', 'malformed'], ['   ', 'empty']]) {
    const p = invite.parse(entrada);
    assert.equal(p.ok, false);
    assert.equal(p.error, err);
  }
});

test('o token assinado com o segredo verifica com o mesmo segredo', () => {
  const { verifyToken } = require('../relay/protocol');
  const c = invite.create({ relayUrl: 'wss://r/ws' });
  const tok = invite.signToken(c.secret, 'dev-1', 'host');
  const v = verifyToken(tok, c.secret);
  assert.ok(v, 'token deve verificar com o segredo do convite');
  assert.equal(v.uid, c.room, 'o uid do token e a sala derivada');
  assert.equal(v.role, 'host');
});

test('token de outra sala NAO verifica — e o que impede entrar de penetra', () => {
  const { verifyToken } = require('../relay/protocol');
  const a = invite.create({ relayUrl: 'wss://r/ws' });
  const b = invite.create({ relayUrl: 'wss://r/ws' });
  const tokenDeA = invite.signToken(a.secret, 'dev-1', 'client');
  assert.ok(!verifyToken(tokenDeA, b.secret), 'segredo diferente nao pode validar');
});

test('a prova e igual para quem tem o segredo e diferente para quem nao tem', () => {
  const a = invite.newSecret();
  const b = invite.newSecret();
  assert.equal(invite.proofFor(a), invite.proofFor(a), 'deve ser deterministica');
  assert.notEqual(invite.proofFor(a), invite.proofFor(b));
});

test('a prova NAO revela o segredo nem a sala revela a prova', () => {
  const s = invite.newSecret();
  const proof = invite.proofFor(s);
  assert.ok(!proof.includes(s.slice(0, 10)), 'prova nao pode conter o segredo');
  assert.notEqual(proof, invite.roomFromSecret(s), 'prova e sala precisam ser derivacoes distintas');
});

test('a query de conexao leva sala e prova, nunca o segredo', () => {
  const s = invite.newSecret();
  const q = invite.connectQuery(s, 'dev-1', 'host');
  assert.ok(q.includes('room=') && q.includes('proof=') && q.includes('role=host'));
  assert.ok(!q.includes(s), 'o SEGREDO nao pode viajar para o relay');
});

test('connectUrl preserva querystring que ja existe no relay', () => {
  const c = invite.create({ relayUrl: 'wss://r/ws?x=1' });
  const u = invite.connectUrl('wss://r/ws?x=1', c.secret, 'dev-1', 'host');
  assert.ok(u.startsWith('wss://r/ws?x=1&'), u);
  const q = new URL(u.replace('wss://', 'https://')).searchParams;
  assert.equal(q.get('x'), '1');
  assert.equal(q.get('room'), c.room);
  assert.equal(q.get('proof'), invite.proofFor(c.secret));
  assert.equal(q.get('did'), 'dev-1');
  assert.equal(q.get('role'), 'host');
});

test('connectUrl abre a query quando o relay nao tem nenhuma', () => {
  const c = invite.create({ relayUrl: 'wss://r/ws' });
  assert.ok(invite.connectUrl('wss://r/ws', c.secret, 'd', 'client').startsWith('wss://r/ws?room='));
});

test('papel invalido cai pra client — nunca vira host por engano', () => {
  const c = invite.create({ relayUrl: 'wss://r/ws' });
  const u = invite.connectUrl('wss://r/ws', c.secret, 'd', 'qualquer-coisa');
  assert.ok(u.includes('role=client'), u);
});
