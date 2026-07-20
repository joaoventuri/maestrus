'use strict';
// Protocolo do relay do Maestrus remoto.
// - Tokens estilo JWT HS256 (assinados com um segredo compartilhado com o
//   backend PHP, que os emite por licença). Sem dependências externas.
// - Frames: envelopes JSON trafegados sobre WebSocket.

const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64url(Buffer.from(JSON.stringify(obj)));

// ─── Tokens (HS256) ────────────────────────────────────────────────────────
function signToken(payload, secret, ttlSec = 300) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const head = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const data = head + '.' + b64urlJson(body);
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + sig;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  if (typeof body.exp === 'number' && body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

// ─── Tipos de frame ──────────────────────────────────────────────────────────
const FRAME = {
  REGISTER_HOST: 'register-host', // host → relay: anuncia nome/os/projetos
  HOST_LIST: 'host-list',         // client → relay → client: hosts online da conta
  RPC_REQUEST: 'rpc-request',     // client → host
  RPC_RESPONSE: 'rpc-response',   // host → client
  EVENT: 'event',                 // host → client (streaming de claude.onEvent)
  PRESENCE: 'presence',           // relay → membros: host entrou/saiu
  ERROR: 'error',                 // relay → membro
  PING: 'ping',
  PONG: 'pong',
};

function frame(type, fields = {}) {
  return JSON.stringify({ v: 1, type, ...fields });
}

function parseFrame(raw) {
  try {
    const f = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    if (!f || typeof f !== 'object' || typeof f.type !== 'string') return null;
    return f;
  } catch { return null; }
}

module.exports = { signToken, verifyToken, FRAME, frame, parseFrame };
