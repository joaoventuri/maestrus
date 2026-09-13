'use strict';
// Teste E2E do relay: sobe o relay, conecta host + client de verdade (ws) e
// valida handshake, host-list, RPC ida/volta, streaming de evento, presença e
// ISOLAMENTO entre contas. Sai com código !=0 se algo falhar.

const WebSocket = require('ws');
const { createRelay } = require('../server');
const { signToken, frame, parseFrame, FRAME } = require('../protocol');

const SECRET = 'test-secret-123';
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cliente de teste: acumula frames e permite esperar por um predicado.
function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay?token=${encodeURIComponent(token)}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const f = parseFrame(raw);
    if (!f) return;
    inbox.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
    }
  });
  return {
    ws,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    closed: () => new Promise((res) => ws.on('close', (code) => res(code))),
    send: (type, fields) => ws.send(frame(type, fields)),
    waitFor: (pred, ms = 2000) => new Promise((res, rej) => {
      const hit = inbox.find(pred);
      if (hit) return res(hit);
      const w = { pred, resolve: res };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout waitFor')); } }, ms);
    }),
    close: () => ws.close(),
  };
}

(async () => {
  const relay = createRelay({ port: 0, secret: SECRET, logger: { log() {} } });
  const port = relay.port;
  console.log(`relay de teste em :${port}\n`);

  // 1) Token inválido é rejeitado
  {
    const bad = connect(port, 'lixo.invalido.token');
    const code = await bad.closed();
    ok(code === 4001, 'token inválido → fecha 4001');
  }

  // Conta A: host + client
  const hostTok = signToken({ uid: 'A', did: 'host-A', role: 'host' }, SECRET, 60);
  const cliTok = signToken({ uid: 'A', did: 'cli-A', role: 'client' }, SECRET, 60);

  const host = connect(port, hostTok);
  const cli = connect(port, cliTok);
  await Promise.all([host.open(), cli.open()]);
  ok(true, 'host e client (conta A) conectaram');

  // 2) Host registra; client lista e enxerga
  host.send(FRAME.REGISTER_HOST, { payload: { name: 'PC do Trabalho', os: 'win32', projects: [{ id: 'p1', name: 'api-gateway' }] } });
  await sleep(50);
  cli.send(FRAME.HOST_LIST, {});
  const list = await cli.waitFor((f) => f.type === FRAME.HOST_LIST && f.payload);
  const hosts = list.payload.hosts || [];
  ok(hosts.length === 1 && hosts[0].deviceId === 'host-A', 'host-list mostra o host da conta');
  ok(hosts[0].name === 'PC do Trabalho' && hosts[0].projects.length === 1, 'host-list traz nome + projetos');

  // 3) RPC ida e volta (client → host → client), com reqId casando
  cli.send(FRAME.RPC_REQUEST, { to: 'host-A', reqId: 'r1', channel: 'projects.list', payload: {} });
  const gotReq = await host.waitFor((f) => f.type === FRAME.RPC_REQUEST && f.reqId === 'r1');
  ok(gotReq.from === 'cli-A' && gotReq.channel === 'projects.list', 'host recebe rpc-request com from=cli-A');
  host.send(FRAME.RPC_RESPONSE, { to: 'cli-A', reqId: 'r1', payload: { projects: [{ id: 'p1' }] } });
  const gotResp = await cli.waitFor((f) => f.type === FRAME.RPC_RESPONSE && f.reqId === 'r1');
  ok(gotResp.from === 'host-A' && gotResp.payload.projects.length === 1, 'client recebe rpc-response casando reqId');

  // 4) Streaming de evento (host → client)
  host.send(FRAME.EVENT, { to: 'cli-A', channel: 'claude', payload: { type: 'assistant-text', text: 'oi', projectId: 'p1' } });
  const ev = await cli.waitFor((f) => f.type === FRAME.EVENT);
  ok(ev.payload.text === 'oi' && ev.payload.projectId === 'p1', 'client recebe evento de streaming do host');

  // 5) Isolamento entre contas: client da conta B não enxerga nem alcança host de A
  const cliBTok = signToken({ uid: 'B', did: 'cli-B', role: 'client' }, SECRET, 60);
  const cliB = connect(port, cliBTok);
  await cliB.open();
  cliB.send(FRAME.HOST_LIST, {});
  const listB = await cliB.waitFor((f) => f.type === FRAME.HOST_LIST);
  ok((listB.payload.hosts || []).length === 0, 'conta B NÃO vê hosts da conta A');
  cliB.send(FRAME.RPC_REQUEST, { to: 'host-A', reqId: 'x', channel: 'projects.list', payload: {} });
  const errB = await cliB.waitFor((f) => f.type === FRAME.ERROR);
  ok(errB.error === 'target-offline', 'conta B NÃO consegue rotear pro host de A (cross-account bloqueado)');
  // ...e o host de A não recebeu nada da conta B
  let leaked = false;
  try { await host.waitFor((f) => f.reqId === 'x', 300); leaked = true; } catch {}
  ok(!leaked, 'host de A não recebeu o request da conta B');

  // 6) Presença: host cai → client é avisado offline
  host.close();
  const pres = await cli.waitFor((f) => f.type === FRAME.PRESENCE && f.online === false);
  ok(pres.deviceId === 'host-A', 'client recebe presence offline quando host cai');

  // 7) EQUIPE (sala por convite): presença de MEMBROS com nome + roster WHO.
  // A sala é o hash do segredo; a prova de posse identifica o par — aqui só
  // interessa o comportamento social: quem entra é anunciado, quem pergunta
  // "quem está aí" recebe a lista com papéis e nomes.
  const { connectQuery } = require('../../electron/invite');
  const teamSecret = 'segredo-da-equipe-12345';
  const invConnect = (did, role, name) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay?${connectQuery(teamSecret, did, role)}&name=${encodeURIComponent(name)}`);
    const inbox = []; const waiters = [];
    ws.on('message', (raw) => {
      const f = parseFrame(raw); if (!f) return;
      inbox.push(f);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
    });
    return {
      ws,
      open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
      send: (type, fields) => ws.send(frame(type, fields)),
      waitFor: (pred, ms = 2000) => new Promise((res, rej) => {
        const hit = inbox.find(pred); if (hit) return res(hit);
        const w = { pred, resolve: res }; waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout waitFor')); } }, ms);
      }),
      close: () => ws.close(),
    };
  };
  const dono = invConnect('dev-dono', 'host', 'João');
  await dono.open();
  const maria = invConnect('dev-maria', 'client', 'Maria');
  await maria.open();
  // colega novo entra → quem JÁ estava na sala fica sabendo, com nome
  const pedro = invConnect('dev-pedro', 'client', 'Pedro');
  await pedro.open();
  const joinP = await maria.waitFor((f) => f.type === FRAME.PRESENCE && f.deviceId === 'dev-pedro' && f.online === true);
  ok(joinP.role === 'client' && joinP.name === 'Pedro', 'colega que entra é anunciado pra sala com papel e nome');
  const joinH = await dono.waitFor((f) => f.type === FRAME.PRESENCE && f.deviceId === 'dev-pedro' && f.online === true);
  ok(joinH.name === 'Pedro', 'host também vê o colega entrar (alimenta o roster do dono)');
  // WHO: roster completo com os três
  pedro.send(FRAME.WHO, {});
  const who = await pedro.waitFor((f) => f.type === FRAME.WHO);
  const names = (who.payload.members || []).map((m) => m.name).sort();
  ok(names.join(',') === 'João,Maria,Pedro', `WHO devolve a sala inteira com nomes (veio: ${names.join(',')})`);
  ok((who.payload.members || []).find((m) => m.deviceId === 'dev-dono').role === 'host', 'WHO distingue host de client');
  // saída também é anunciada aos colegas
  pedro.close();
  const left = await maria.waitFor((f) => f.type === FRAME.PRESENCE && f.deviceId === 'dev-pedro' && f.online === false);
  ok(left.role === 'client', 'colega que sai é anunciado pros demais clients');

  // 8) COMPAT: sala de CONTA (token) NÃO anuncia client pra client — o client
  // antigo instalado trata presence online como host e criaria um fantasma.
  const cliA2 = connect(port, signToken({ uid: 'A', did: 'cli-A2', role: 'client' }, SECRET, 60));
  await cliA2.open();
  let ghost = false;
  try { await cli.waitFor((f) => f.type === FRAME.PRESENCE && f.deviceId === 'cli-A2' && f.online === true, 400); ghost = true; } catch {}
  ok(!ghost, 'sala de conta NÃO anuncia client novo pra outros clients (compat com apps antigos)');
  cliA2.close();

  dono.close(); maria.close();
  cli.close(); cliB.close();
  await relay.close();

  console.log(`\n${failures === 0 ? 'TODOS OS TESTES PASSARAM ✓' : failures + ' FALHA(S) ✗'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('erro no teste:', e); process.exit(1); });
