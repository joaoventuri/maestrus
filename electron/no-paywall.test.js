// O Maestrus e open source e nao tem trava de uso. Este teste existe porque
// o codigo JA teve uma: FREE_REMOTE_LIMIT = 10 conexoes remotas/mes para quem
// nao fosse Pro. Num projeto aberto isso e pegadinha — quem clona espera que
// funcione. Se alguem reintroduzir um limite, isto quebra.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const main = fs.readFileSync(__dirname + '/main.js', 'utf8');

test('nao existe cota de uso remoto', () => {
  assert.ok(!/FREE_REMOTE_LIMIT\s*=\s*\d/.test(main), 'cota de acesso remoto reintroduzida');
  assert.ok(!/function\s+remoteAllowed/.test(main), 'gate remoteAllowed() de volta');
  assert.ok(!/freeRemoteConsume\s*\(\)/.test(main), 'consumo de cota gratuita de volta');
});

test('nenhuma funcionalidade responde free_limit ou cloud_required', () => {
  assert.ok(!/error:\s*'free_limit'/.test(main), "algum handler devolve 'free_limit'");
  assert.ok(!/error:\s*'cloud_required'/.test(main), "algum handler devolve 'cloud_required'");
});

test('entitlement libera tudo', () => {
  const i = main.indexOf("ipcMain.handle('app:entitlement'");
  assert.ok(i > 0, 'handler de entitlement sumiu');
  const block = main.slice(i, i + 400);
  assert.ok(/pro:\s*true/.test(block), 'entitlement deve reportar acesso total');
});

test('a UI nao tem banner de conversao', () => {
  assert.ok(!fs.existsSync(__dirname + '/../renderer/src/components/MarketingBanner.tsx'),
    'MarketingBanner voltou');
});
