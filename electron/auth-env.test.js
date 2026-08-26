// O CLI deriva ONDE grava/lê a credencial a partir do CLAUDE_CONFIG_DIR (no
// macOS, o nome da entrada no Keychain). Se login e status resolverem esse env
// de formas diferentes, o login conclui com "Login successful" e a tela insiste
// que não conectou. Aconteceu em producao; este teste tranca a resolucao unica.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const src = fs.readFileSync(__dirname + '/main.js', 'utf8');

test('status local resolve o env pelo mesmo helper do login', () => {
  const h = src.slice(src.indexOf("ipcMain.handle('claude:authStatus'"));
  const handler = h.slice(0, h.indexOf("ipcMain.handle('claude:authLogin'"));
  assert.ok(handler.includes('authEnvFor('),
    'authStatus deve usar authEnvFor');
  assert.ok(!/claudeAuth\.status\(\)/.test(handler),
    'authStatus nao pode chamar status() sem env: leria a credencial base enquanto o login grava no perfil');
});

test('login usa o mesmo resolvedor', () => {
  const from = src.indexOf("ipcMain.handle('claude:authLogin'");
  const to = src.indexOf("ipcMain.handle('claude:authSubmitCode'", from);
  const handler = src.slice(from, to > from ? to : from + 4000);
  assert.ok(handler.includes('authEnvFor('), 'authLogin deve usar authEnvFor');
});

test('o turno usa o perfil ativo, como login e status', () => {
  const pty = fs.readFileSync(__dirname + '/claude-pty.js', 'utf8');
  const be = pty.slice(pty.indexOf('function buildEnv'));
  assert.ok(be.slice(0, 1500).includes('claudeProfiles.envVars('),
    'buildEnv deve aplicar o env do perfil: senao o turno roda numa conta e a auth noutra');
});
