// O scanner lê o BINÁRIO do CLI — a única fonte que sempre tem a lista real de
// modelos. O risco dele é regex: pegar lixo de string vizinha ou perder id na
// fronteira de bloco. É isso que se testa aqui.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ms = require('./model-scan');

test('extrai ids canonicos e ignora datados, -v1, fast e mythos', () => {
  // No binario real cada id canonico existe como string propria, alem das
  // variantes datadas/-v1/-fast — o scanner deve pegar SO as canonicas.
  const blob = Buffer.from([
    'xx claude-fable-5-1 yy claude-opus-5 zz claude-opus-4-5 claude-haiku-4-5',
    'claude-opus-4-5-20251101 claude-opus-4-5-20251101-v1',   // datado: rejeitado inteiro
    'claude-opus-4-6-fast claude-fable-5-mythos-5',           // variantes que --model nao usa
    'claude-sonnet-4-51',                                     // minor absurdo = lixo de string vizinha
  ].join('\0'));
  const ids = ms.extractIds(blob);
  assert.ok(ids.includes('claude-fable-5-1'));
  assert.ok(ids.includes('claude-opus-5'));
  assert.ok(ids.includes('claude-opus-4-5'));
  assert.ok(ids.includes('claude-haiku-4-5'));
  assert.ok(!ids.includes('claude-sonnet-4-51'));
  assert.ok(!ids.includes('claude-opus-4-6'));   // so a variante -fast presente ≠ canonico existente
  assert.ok(!ids.some((i) => i.includes('mythos') || i.includes('fast') || /\d{8}/.test(i)));
});

test('id na fronteira de dois blocos nao se perde (overlap)', () => {
  // Arquivo maior que um bloco, com o id atravessando exatamente a fronteira.
  const BLOCK = 8 * 1024 * 1024;
  const id = 'claude-opus-5-1';
  const buf = Buffer.alloc(BLOCK + 64, 0x20);
  buf.write(id, BLOCK - 7);                        // metade em cada bloco
  const f = path.join(os.tmpdir(), `maestrus-scan-${process.pid}.bin`);
  fs.writeFileSync(f, buf);
  try {
    assert.ok(ms.scanFile(f).includes(id));
  } finally { fs.unlinkSync(f); }
});

test('binario inexistente degrada pra lista vazia, nunca quebra', () => {
  assert.deepEqual(ms.discover('/nao/existe/claude'), []);
  assert.deepEqual(ms.discover(null), []);
});
