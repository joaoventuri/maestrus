'use strict';
// Relay WebSocket do Maestrus remoto.
//
// Conexão: wss://.../relay?token=<jwt>&device=<id>&role=host|client
//   - token (HS256) carrega { uid, did, role } — emitido pelo backend por licença.
//   - device/role da query são CONFERIDOS contra o token (token manda).
//
// Roteamento: por CONTA (uid). Um frame com `to=<deviceId>` é entregue ao membro
// daquele device DENTRO da mesma conta. Cross-account é impossível por
// construção (só procuramos alvos na sala do remetente). O relay NÃO persiste
// conteúdo — só presença/roteamento.

const { WebSocketServer } = require('ws');
const { verifyToken, FRAME, frame, parseFrame } = require('./protocol');

// rooms: Map<uid, Map<deviceId, member>>
//   member = { ws, uid, deviceId, role, info }
// 16 MB por frame: a payload de loadHistory de uma sessao com tool-results
// grandes (Bash com saida de dumps, MCP de muitos resultados, etc.) facilmente
// passa de 1 MB e fechava a conexao do host com o client (frame-too-large →
// disconnect → loop de reconexao). 16 MB cobre histories grandes e ainda
// mantem teto sao contra abuso.
function createRelay({ port = 0, secret, logger = console, maxFrameBytes = 16 << 20 } = {}) {
  if (!secret) throw new Error('relay: secret obrigatório');
  const rooms = new Map();

  const roomOf = (uid) => {
    let r = rooms.get(uid);
    if (!r) { r = new Map(); rooms.set(uid, r); }
    return r;
  };
  const send = (ws, type, fields) => { try { ws.send(frame(type, fields)); } catch {} };

  const wss = new WebSocketServer({ port, maxPayload: maxFrameBytes });

  wss.on('connection', (ws, req) => {
    let q;
    try { q = new URL(req.url, 'http://x'); } catch { ws.close(4000, 'bad-url'); return; }
    const token = q.searchParams.get('token');
    const claims = verifyToken(token, secret);
    if (!claims || !claims.uid || !claims.did) { ws.close(4001, 'unauthorized'); return; }

    const uid = String(claims.uid);
    const deviceId = String(claims.did);
    const role = claims.role === 'host' ? 'host' : 'client';
    const room = roomOf(uid);

    // Um device só tem uma conexão viva; derruba a anterior.
    const prev = room.get(deviceId);
    if (prev && prev.ws !== ws) { try { prev.ws.close(4002, 'replaced'); } catch {} }

    const member = { ws, uid, deviceId, role, info: null, alive: true, claims };
    room.set(deviceId, member);
    logger.log(`[relay] + ${role} uid=${uid} dev=${deviceId} (sala=${room.size})`);

    ws.on('pong', () => { member.alive = true; });

    ws.on('message', (raw) => {
      if (typeof raw !== 'string' && raw.length > maxFrameBytes) { send(ws, FRAME.ERROR, { error: 'frame-too-large' }); return; }
      const f = parseFrame(raw);
      if (!f) { send(ws, FRAME.ERROR, { error: 'bad-frame' }); return; }

      switch (f.type) {
        case FRAME.REGISTER_HOST: {
          member.role = 'host';
          member.info = {
            name: String(f.payload?.name || 'Host'),
            os: String(f.payload?.os || ''),
            projects: Array.isArray(f.payload?.projects) ? f.payload.projects : [],
          };
          // avisa clients da conta que esse host está online
          broadcast(room, deviceId, FRAME.PRESENCE, { deviceId, online: true, host: hostBrief(member) }, 'client');
          return;
        }
        case FRAME.HOST_LIST: {
          send(ws, FRAME.HOST_LIST, { payload: { hosts: listHosts(room) } });
          return;
        }
        case FRAME.PING: { send(ws, FRAME.PONG, {}); return; }
        case FRAME.RPC_REQUEST:
        case FRAME.RPC_RESPONSE:
        case FRAME.EVENT: {
          // Roteia pro alvo na MESMA sala (conta). Cross-account impossível.
          const to = String(f.to || '');
          const target = room.get(to);
          if (!target) { send(ws, FRAME.ERROR, { error: 'target-offline', to, reqId: f.reqId }); return; }
          // Injeta shareClaims no frame quando o remetente é um guest de workspace sharing.
          const extra = (f.type === FRAME.RPC_REQUEST && member.claims && member.claims.share)
            ? { shareClaims: member.claims.share }
            : {};
          try { target.ws.send(frame(f.type, { ...f, from: deviceId, ...extra })); } catch {}
          return;
        }
        default:
          send(ws, FRAME.ERROR, { error: 'unknown-type', type: f.type });
      }
    });

    ws.on('close', () => {
      if (room.get(deviceId) === member) {
        room.delete(deviceId);
        if (member.role === 'host') {
          broadcast(room, deviceId, FRAME.PRESENCE, { deviceId, online: false }, 'client');
        } else {
          // Client caiu → avisa os hosts pra removerem este device dos seus
          // subscribers (sem isso, host vaza memória mandando events pra
          // deviceIds mortos, e _send falha em silêncio).
          broadcast(room, deviceId, FRAME.PRESENCE, { deviceId, online: false }, 'host');
        }
        if (room.size === 0) rooms.delete(uid);
      }
      logger.log(`[relay] - ${member.role} uid=${uid} dev=${deviceId}`);
    });
  });

  // Heartbeat: derruba conexões mortas.
  const hb = setInterval(() => {
    for (const room of rooms.values()) {
      for (const m of room.values()) {
        if (!m.alive) { try { m.ws.terminate(); } catch {} continue; }
        m.alive = false; try { m.ws.ping(); } catch {}
      }
    }
  }, 30000);
  hb.unref?.();

  function listHosts(room) {
    const out = [];
    for (const m of room.values()) if (m.role === 'host' && m.info) out.push(hostBrief(m));
    return out;
  }
  function hostBrief(m) {
    return { deviceId: m.deviceId, name: m.info?.name || 'Host', os: m.info?.os || '', projects: m.info?.projects || [], online: true };
  }
  function broadcast(room, exceptDeviceId, type, fields, roleFilter) {
    for (const m of room.values()) {
      if (m.deviceId === exceptDeviceId) continue;
      if (roleFilter && m.role !== roleFilter) continue;
      send(m.ws, type, fields);
    }
  }

  const actualPort = wss.address() ? wss.address().port : port;
  return {
    wss,
    port: actualPort,
    rooms,
    close: () => new Promise((res) => { clearInterval(hb); wss.close(() => res()); }),
  };
}

module.exports = { createRelay };
