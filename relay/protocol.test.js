// Testes do protocolo do relay — assinatura/verificação de token (HS256) é
// crítica de segurança: token forjado ou de outro segredo NÃO pode passar.
const { test } = require('node:test');
const assert = require('node:assert');
const { signToken, verifyToken, frame, parseFrame, FRAME } = require('./protocol');

test('token válido faz roundtrip e preserva o payload', () => {
  const tok = signToken({ uid: 42, role: 'host' }, 'segredo', 300);
  const v = verifyToken(tok, 'segredo'); // retorna o payload, ou null
  assert.ok(v, 'deveria verificar');
  assert.strictEqual(v.uid, 42);
  assert.strictEqual(v.role, 'host');
});

test('token com SEGREDO errado é rejeitado', () => {
  const tok = signToken({ uid: 1 }, 'segredo-certo', 300);
  assert.strictEqual(verifyToken(tok, 'segredo-errado'), null);
});

test('token ADULTERADO é rejeitado', () => {
  const tok = signToken({ uid: 1, role: 'client' }, 's', 300);
  const [h, , sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 1, role: 'host', exp: 9999999999 })).toString('base64url');
  assert.strictEqual(verifyToken(`${h}.${forged}.${sig}`, 's'), null);
});

test('token EXPIRADO é rejeitado', () => {
  const tok = signToken({ uid: 1 }, 's', -10); // já expirado
  assert.strictEqual(verifyToken(tok, 's'), null);
});

test('frame/parseFrame roundtrip', () => {
  const f = frame(FRAME.RPC_REQUEST, { reqId: 'abc', channel: 'ping', payload: { x: 1 } });
  const parsed = parseFrame(typeof f === 'string' ? f : JSON.stringify(f));
  assert.ok(parsed);
  assert.strictEqual(parsed.type, FRAME.RPC_REQUEST);
  assert.strictEqual(parsed.reqId, 'abc');
});
