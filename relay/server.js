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
  // room -> prova de posse do segredo. Em memória de propósito: o relay não
  // persiste nada, e reiniciar apenas refaz o TOFU na próxima conexão.
  const roomProofs = new Map();
  const timingSafeEq = (a, b) => {
    try {
      const A = Buffer.from(String(a)), B = Buffer.from(String(b));
      return A.length === B.length && require('crypto').timingSafeEqual(A, B);
    } catch { return false; }
  };

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
    let claims = verifyToken(token, secret);

    // ── Salas por CONVITE (sem conta) ────────────────────────────────────
    // O par host/client compartilha um segredo; a sala é o hash dele. O relay
    // nunca recebe o segredo — recebe só uma PROVA de posse, que é o mesmo
    // HMAC para todo mundo que tem o segredo. O primeiro a chegar fixa a prova
    // da sala; os seguintes precisam apresentar a mesma. Assim o encaminhador
    // continua burro (não sabe quem você é) e ainda assim ninguém entra numa
    // sala alheia sabendo apenas o id dela.
    if (!claims) {
      const room = q.searchParams.get('room');
      const proof = q.searchParams.get('proof');
      const did = q.searchParams.get('did');
      const wantRole = q.searchParams.get('role') === 'host' ? 'host' : 'client';
      if (room && proof && did && /^[A-Za-z0-9_-]{16,64}$/.test(room) && /^[A-Za-z0-9_-]{16,128}$/.test(proof)) {
        const known = roomProofs.get(room);
        if (!known) roomProofs.set(room, proof);                 // trust on first use
        else if (!timingSafeEq(known, proof)) { ws.close(4001, 'bad-proof'); return; }
        claims = { uid: room, did: String(did), role: wantRole, viaInvite: true };
      }
    }

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
          // SÓ quem tem role:'host' no TOKEN (e não é guest de share) pode se
          // anunciar como host. Antes qualquer client mandava REGISTER_HOST e
          // virava host na sala do dono → aparecia no HOST_LIST → os devices do
          // dono roteavam projects.list/claude.send pra ele = impersonação e MITM
          // dos prompts. O token manda: role vem das claims, não do frame.
          if (claims.role !== 'host' || claims.share) {
            send(ws, FRAME.ERROR, { error: 'not-authorized-as-host' });
            return;
          }
          member.role = 'host';
          member.info = {
            name: String(f.payload?.name || 'Host'),
            os: String(f.payload?.os || ''),
            projects: Array.isArray(f.payload?.projects) ? f.payload.projects : [],
          };
          // DEDUP por NOME de máquina: uma máquina física = UM host. Quando o
          // deviceId é regenerado (config clonada / auto-heal), a conexão do id
          // ANTIGO vira um zumbi que sobrevive no relay (não recebe close) → a
          // mesma máquina aparecia como 2, 3 hosts ("N máquinas conectadas").
          // Ao registrar, derruba qualquer OUTRO host da conta com o MESMO nome
          // (é a mesma máquina re-registrando sob um id novo) e avisa os clients
          // pra removê-lo da lista.
          const myName = member.info.name;
          if (myName && myName !== 'Host') {
            for (const other of room.values()) {
              if (other === member || other.role !== 'host') continue;
              if (other.info && other.info.name === myName) {
                try { other.ws.close(4004, 'replaced-same-host'); } catch {}
                room.delete(other.deviceId);
                broadcast(room, other.deviceId, FRAME.PRESENCE, { deviceId: other.deviceId, online: false }, 'client');
              }
            }
          }
          try { logger.log(`[relay]   host uid=${uid} dev=${deviceId} name="${myName}"`); } catch {}
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
        if (room.size === 0) { rooms.delete(uid); roomProofs.delete(uid); }
      }
      logger.log(`[relay] - ${member.role} uid=${uid} dev=${deviceId}`);
    });
  });

  // Heartbeat: derruba conexões mortas E conexões de SHARE com token expirado.
  // Só share: um guest revogado não recebe token novo no `share_relay_token`
  // (retorna erro), então quando o token de conexão expira o relay o derruba e
  // ele não consegue reconectar → a revogação passa a valer dentro do TTL do
  // token (curto). Host/client normais NÃO são dropados por exp aqui (renovam o
  // token in-place via updateToken sem reconectar — dropá-los geraria churn).
  const hb = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const room of rooms.values()) {
      for (const m of room.values()) {
        if (m.claims && m.claims.share && m.claims.exp && m.claims.exp < nowSec) {
          try { m.ws.close(4003, 'share-token-expired'); } catch {}
          continue;
        }
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
