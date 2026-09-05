// Lado browser do pareamento por convite — espelho de `electron/invite.js`.
//
// Vive separado do maestrus-web.ts porque é a parte que PRECISA bater bit a bit
// com o desktop: a sala é sha256(segredo) e a prova é HMAC(segredo). Qualquer
// divergência (um byte de padding, um slice a mais) não dá erro visível — dá
// "unauthorized" mudo no relay, que é o tipo de bug que custa uma tarde.

export type ParsedInvite =
  | { ok: true; relayUrl: string; secret: string; hostName: string | null; expiresAt: number | null }
  | { ok: false; error: string };

function b64url(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function inviteRoom(secret: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return b64url(h).slice(0, 22);
}

export async function inviteProof(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('maestrus-room-proof'));
  return b64url(sig).slice(0, 43);
}

// Aceita o código puro, a URL `maestrus://pair?c=…` ou qualquer coisa com `?c=`
// — o usuário cola o que o app dele deu, não o que a gente esperava.
export function parseInvite(input: string): ParsedInvite {
  let raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  const m = raw.match(/[?&]c=([A-Za-z0-9_-]+)/);
  if (m) raw = m[1];
  raw = raw.replace(/^maestrus:\/\/pair\/?/i, '').trim();

  let p: any;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    p = JSON.parse(new TextDecoder().decode(bytes));
  } catch { return { ok: false, error: 'malformed' }; }

  if (!p || p.v !== 1) return { ok: false, error: 'unsupported_version' };
  if (!p.u || !p.s) return { ok: false, error: 'incomplete' };
  // Convite vencido é um "não" claro: um código eterno vazado num grupo vira
  // porta aberta para sempre.
  if (p.e && Date.now() > p.e) return { ok: false, error: 'expired' };
  return { ok: true, relayUrl: String(p.u), secret: String(p.s), hostName: p.n || null, expiresAt: p.e || null };
}

// Query de conexão ao relay. Manda a PROVA, nunca o segredo.
export async function inviteConnectUrl(relayUrl: string, secret: string, deviceId: string, role: 'host' | 'client' = 'client'): Promise<string> {
  const q = `room=${await inviteRoom(secret)}&proof=${await inviteProof(secret)}&did=${encodeURIComponent(deviceId)}&role=${role === 'host' ? 'host' : 'client'}`;
  return `${relayUrl}${relayUrl.includes('?') ? '&' : '?'}${q}`;
}
