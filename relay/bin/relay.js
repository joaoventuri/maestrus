'use strict';
// Entrypoint de produção do relay. Roda no VPS atrás do nginx (wss://.../relay).
// Env: PORT (default 8787), RELAY_SECRET (mesmo segredo do backend PHP).
const { createRelay } = require('../server');

const port = parseInt(process.env.PORT || '8787', 10);
const secret = process.env.RELAY_SECRET;
if (!secret) { console.error('[relay] faltando RELAY_SECRET'); process.exit(1); }

const relay = createRelay({ port, secret });
console.log(`[relay] ouvindo em :${relay.port}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { console.log(`[relay] ${sig}, encerrando…`); await relay.close(); process.exit(0); });
}
