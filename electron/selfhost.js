'use strict';
// Modo SELF-HOST — o Maestrus rodando na infra do PRÓPRIO usuário, sem
// maestrus.cloud, sem billing, sem licença. Zero dependência do control plane.
//
// Autenticação: um único SELFHOST_SECRET compartilhado entre o relay e o
// servidor (mesmo segredo do docker-compose). Quem conhece o segredo pode:
//   - registrar como HOST no relay (o próprio maestrus-server, no boot);
//   - pedir um token de CLIENT (desktop/web/PWA que apontam pra este servidor).
// Os tokens são JWT HS256 assinados LOCALMENTE (relay/protocol.signToken) — o
// mesmo formato que o relay já verifica. `uid` é fixo ('self'): um servidor =
// um tenant. Sem conta, sem sync entre contas, sem compartilhamento externo.

const ENABLED = process.env.MAESTRUS_SELFHOST === '1' || process.env.MAESTRUS_SELFHOST === 'true';
const SECRET = process.env.MAESTRUS_SELFHOST_SECRET || process.env.SELFHOST_SECRET || '';
const UID = 'self';

let _protocol = null;
function protocol() {
  if (_protocol) return _protocol;
  // relay/ fica ao lado de electron/ no dev e em /app/relay no container.
  const path = require('path');
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', 'relay', 'protocol.js'),
    path.join(__dirname, '..', '..', 'relay', 'protocol.js'),
    path.join(process.cwd(), 'relay', 'protocol.js'),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) { _protocol = require(c); return _protocol; } }
  _protocol = require('relay/protocol'); // fallback (se empacotado)
  return _protocol;
}

function isEnabled() { return ENABLED && !!SECRET; }

// Assina um token do relay pro role dado (host|client), TTL 10 min.
function signRelayToken(deviceId, role) {
  if (!isEnabled()) return null;
  const { signToken } = protocol();
  return signToken({ uid: UID, did: String(deviceId || 'device'), role: role === 'host' ? 'host' : 'client' }, SECRET, 600);
}

// Valida um secret apresentado por um client (comparação em tempo constante).
function checkSecret(candidate) {
  if (!isEnabled()) return false;
  try {
    const crypto = require('crypto');
    const a = Buffer.from(String(candidate || ''));
    const b = Buffer.from(SECRET);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

module.exports = { isEnabled, signRelayToken, checkSecret, UID, SECRET_SET: !!SECRET };
