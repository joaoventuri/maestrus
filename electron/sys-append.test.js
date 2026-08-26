// O prefixo do system prompt é a chave do prompt cache do servidor. send() e
// dispatchOneShot() rodam com --resume na MESMA sessão, então qualquer
// divergência entre os dois faz cada alternância refazer o cache e cobrar o
// contexto inteiro como input novo. Este teste tranca a igualdade.
const test = require('node:test');
const assert = require('node:assert');
const { buildSysAppend } = require('./claude-pty');

test('mesmo projeto e mesma memoria produzem prefixo identico', () => {
  const project = { id: 'p1', voiceMode: false };
  assert.equal(buildSysAppend(project, '', ''), buildSysAppend(project, '', ''));
});

test('memoria ausente e memoria vazia sao equivalentes', () => {
  const project = { id: 'p1', voiceMode: false };
  // dispatchOneShot passa _memBlock.get() que pode ser undefined; send passa ''
  assert.equal(buildSysAppend(project, '', undefined), buildSysAppend(project, '', ''));
});

test('modo voz muda o prefixo (invalidacao esperada e consciente)', () => {
  const p1 = { id: 'p1', voiceMode: false };
  const p2 = { id: 'p1', voiceMode: true };
  assert.notEqual(buildSysAppend(p1, '', ''), buildSysAppend(p2, '', ''));
});

test('memoria travada entra no prefixo dos dois caminhos', () => {
  const project = { id: 'p1', voiceMode: false };
  const mem = '<memoria>fato relevante</memoria>';
  const withMem = buildSysAppend(project, '', mem);
  assert.ok(withMem.includes(mem));
  assert.notEqual(withMem, buildSysAppend(project, '', ''));
});

// Os testes acima validam a função; este valida que os dois caminhos REALMENTE
// a usam. Sem ele, alguém volta a montar o append na mão dentro do
// dispatchOneShot e nada acusa.
test('send e dispatchOneShot montam o append pela funcao compartilhada', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(__dirname + '/claude-pty.js', 'utf8');
  const oneShot = src.slice(src.indexOf('function dispatchOneShot'));
  assert.ok(oneShot.includes('buildSysAppend('),
    'dispatchOneShot deve usar buildSysAppend');
  assert.ok(!/'--append-system-prompt', ASK_GUIDANCE/.test(oneShot),
    'dispatchOneShot nao pode passar ASK_GUIDANCE cru: divergiria do send e derrubaria o cache');
  assert.ok(oneShot.includes('maestrusMcpConfig()'),
    'dispatchOneShot deve carregar o mesmo MCP do send: a lista de tools tambem compoe o prefixo');
});
