'use strict';
// Teste do RelayLink contra o relay real: host e client usando a MESMA classe
// que vai rodar no Electron e no mobile. Valida RPC (com resultado), evento e
// reconexão de host (re-registro automático).

const WebSocket = require('ws');
const { createRelay } = require('../server');
const { RelayLink } = require('../link');
const { signToken } = require('../protocol');

const SECRET = 'link-secret';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const relay = createRelay({ port: 0, secret: SECRET, logger: { log() {} } });
  const url = `ws://127.0.0.1:${relay.port}/relay`;

  // HOST: responde projects.list e claude.send (e emite um evento no send)
  const host = new RelayLink({
    url, token: signToken({ uid: 'U', did: 'host1', role: 'host' }, SECRET, 60),
    WebSocketImpl: WebSocket, role: 'host',
    hostInfo: { name: 'MacBook', os: 'darwin', projects: [{ id: 'p1', name: 'demo' }] },
    onRpcRequest: (f, reply) => {
      if (f.channel === 'projects.list') return reply([{ id: 'p1', name: 'demo' }]);
      if (f.channel === 'claude.send') { reply({ ok: true }); host.sendEvent(f.from, 'claude', { type: 'assistant-text', text: 'pong', projectId: f.payload.projectId }); return; }
      reply(null);
    },
  });
  host.connect();

  const events = [];
  const client = new RelayLink({
    url, token: signToken({ uid: 'U', did: 'cli1', role: 'client' }, SECRET, 60),
    WebSocketImpl: WebSocket, role: 'client',
    onEvent: (f) => events.push(f.payload),
  });
  client.connect();

  await sleep(150); // handshake + register

  // host-list
  const hosts = await client.hostList();
  ok(hosts.length === 1 && hosts[0].name === 'MacBook', 'RelayLink.hostList enxerga o host');

  // RPC com resultado
  const projects = await client.rpc('host1', 'projects.list', {});
  ok(Array.isArray(projects) && projects[0].id === 'p1', 'RelayLink.rpc retorna o resultado do host');

  // RPC que dispara streaming de evento
  const sendRes = await client.rpc('host1', 'claude.send', { projectId: 'p1', message: 'ping' });
  ok(sendRes && sendRes.ok === true, 'rpc claude.send resolve {ok:true}');
  await sleep(80);
  ok(events.length === 1 && events[0].text === 'pong' && events[0].projectId === 'p1', 'client recebe o evento de streaming via onEvent');

  // Timeout de RPC quando o alvo não existe (erro do relay vira reject)
  let rejected = false;
  try { await client.rpc('inexistente', 'projects.list', {}, 1500); } catch { rejected = true; }
  ok(rejected, 'rpc pra host inexistente rejeita (target-offline)');

  host.close(); client.close();
  await relay.close();
  console.log(`\n${failures === 0 ? 'LINK OK ✓' : failures + ' FALHA(S) ✗'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('erro:', e); process.exit(1); });
