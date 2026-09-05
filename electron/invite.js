/**
 * Convite de pareamento — host e client se acham SEM conta em servidor algum.
 *
 * Hoje o que junta as duas máquinas é o `uid` de uma conta: o backend assina
 * `{ uid, did, role }` e o relay agrupa por `uid`. Funciona, mas amarra o
 * projeto a um cadastro — e num projeto aberto quem instala do zero fica sem
 * conseguir parear.
 *
 * Aqui a sala deixa de ser "sua conta no meu servidor" e passa a ser **um
 * segredo que as duas pontas compartilham**. O host gera o convite, o client
 * cola (ou lê o QR), e ambos assinam o próprio token com aquele segredo. O
 * relay vira o que deve ser num projeto aberto: um encaminhador que verifica
 * assinatura e não sabe quem você é.
 *
 * Efeito colateral bem-vindo: como a sala é o segredo e não o deviceId, o host
 * trocar de identidade deixa de derrubar o pareamento — que foi exatamente o
 * bug do "crachá trocado".
 */
const crypto = require('crypto');

const VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;   // convite é efêmero por padrão

/** Segredo forte. É a única credencial da sala: quem o tem, entra. */
function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * O id da sala é DERIVADO do segredo, nunca sorteado à parte.
 *
 * Assim o relay agrupa por algo público (o hash) sem nunca receber o segredo,
 * e não existe o caso "sei a sala mas não o segredo" virar acesso — provar
 * posse ainda exige assinar com o segredo.
 */
function roomFromSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('base64url').slice(0, 22);
}

/**
 * Empacota o convite. Formato compacto de propósito: cabe num QR pequeno e
 * numa mensagem de texto sem quebrar em várias linhas.
 */
function create({ relayUrl, hostName, ttlMs = DEFAULT_TTL_MS, secret = null } = {}) {
  if (!relayUrl) throw new Error('relayUrl_required');
  const s = secret || newSecret();
  const payload = {
    v: VERSION,
    u: String(relayUrl),
    s,
    n: hostName ? String(hostName).slice(0, 60) : null,
    e: Date.now() + Math.max(60_000, ttlMs),
  };
  const code = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { code, secret: s, room: roomFromSecret(s), expiresAt: payload.e, relayUrl: payload.u, hostName: payload.n };
}

/**
 * Lê um convite. Aceita o código puro ou uma URL `maestrus://pair?c=...`, para
 * o mesmo dado servir a colar, QR e link clicável.
 */
function parse(input) {
  let raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty' };

  // Tolerante ao que o usuário realmente cola: link, querystring ou só o código.
  const m = raw.match(/[?&]c=([A-Za-z0-9_-]+)/);
  if (m) raw = m[1];
  raw = raw.replace(/^maestrus:\/\/pair\/?/i, '').trim();

  let p;
  try {
    p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (!p || p.v !== VERSION) return { ok: false, error: 'unsupported_version' };
  if (!p.u || !p.s) return { ok: false, error: 'incomplete' };
  // Expirado é um "não" claro: um código eterno vazado num chat vira porta
  // aberta para sempre.
  if (p.e && Date.now() > p.e) return { ok: false, error: 'expired', expiredAt: p.e };

  return {
    ok: true,
    relayUrl: p.u,
    secret: p.s,
    room: roomFromSecret(p.s),
    hostName: p.n || null,
    expiresAt: p.e || null,
  };
}

/** URL para QR code e link clicável — mesmo dado, outra embalagem. */
function toUrl(code) {
  return `maestrus://pair?c=${code}`;
}

/**
 * Token que a ponta assina sozinha, com o segredo do convite. Substitui o
 * `cloud.relayToken()` — nenhuma chamada a servidor.
 */
function signToken(secret, deviceId, role, ttlSec = 600) {
  const { signToken: sign } = require('../relay/protocol');
  return sign(
    { uid: roomFromSecret(secret), did: String(deviceId || 'device'), role: role === 'host' ? 'host' : 'client' },
    secret,
    ttlSec,
  );
}

/**
 * Prova de posse do segredo, apresentada ao relay no lugar do segredo em si.
 *
 * É determinística: todas as pontas com o mesmo segredo produzem a mesma
 * prova, e é isso que permite ao relay confirmar que pertencem à mesma sala
 * sem nunca aprender o segredo.
 */
function proofFor(secret) {
  return crypto.createHmac('sha256', String(secret)).update('maestrus-room-proof').digest('base64url').slice(0, 43);
}

/** Query string de conexão ao relay usando convite (sem conta, sem backend). */
function connectQuery(secret, deviceId, role) {
  const room = roomFromSecret(secret);
  return `room=${room}&proof=${proofFor(secret)}&did=${encodeURIComponent(deviceId)}&role=${role === 'host' ? 'host' : 'client'}`;
}

module.exports = { proofFor, connectQuery, VERSION, newSecret, roomFromSecret, create, parse, toUrl, signToken, DEFAULT_TTL_MS };
