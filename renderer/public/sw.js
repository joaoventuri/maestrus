// Maestrus PWA Service Worker.
//
// Estrategia:
// - "App shell" (HTML, manifest, sw.js): NETWORK-FIRST. Sempre tenta a rede
//   primeiro; se offline, usa o que ta cacheado. Garante que voce ve a versao
//   nova logo que esta no ar.
// - Bundles com hash no nome (mobile-XXXXXXXX.js/css): CACHE-FIRST com cache
//   eterno (sao imutaveis — mudanca de codigo = novo nome de arquivo).
// - Demais (icones, fontes, sons): CACHE-FIRST com fallback de rede.
//
// O SW chama skipWaiting + clients.claim → toma controle imediato. A
// pagina recarrega 1 vez (via 'controllerchange' no mobile.html) e ja
// pega tudo novo. NAO toca em localStorage/cookies/IndexedDB → login
// preservado.
//
// Pra forcar invalidacao geral, bump o SW_VERSION abaixo: na ativacao
// novos caches sao criados e os antigos sao apagados.

const SW_VERSION = 'v5-2026-08-11-cache206';

// So vai pro Cache o que o Cache aceita: resposta completa (200) e mesma origem.
// 206 (range/parcial, tipico de audio) e opaque quebram o cache.put().
function cacheable(res) {
  return !!res && res.ok && res.status === 200 && res.type !== 'opaque';
}
const SHELL_CACHE = `maestrus-shell-${SW_VERSION}`;
const ASSET_CACHE = `maestrus-assets-${SW_VERSION}`;

// install: pula a fila de espera (assume controle assim que ativar).
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

// activate: limpa caches de versoes anteriores e reivindica clients
// (browsers/PWAs ja abertos) sem precisar de reload manual.
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// fetch: roteia por tipo de recurso.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Apenas mesma origem (nao tenta interceptar fontes do googleapis etc).
  if (url.origin !== self.location.origin) return;

  // Fora do escopo /app/ → nao mexe (rota PHP, etc).
  if (!url.pathname.startsWith('/app/')) return;

  // App shell: HTML / manifest / sw.js → NETWORK-FIRST.
  const isShell = url.pathname === '/app/' ||
                  url.pathname.endsWith('/app/index.html') ||
                  url.pathname.endsWith('/app/mobile.html') ||
                  url.pathname.endsWith('/app/manifest.webmanifest') ||
                  url.pathname.endsWith('/app/sw.js');

  if (isShell) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Ultima cartada: cache da raiz
        return (await caches.match('/app/')) || new Response('offline', { status: 503 });
      }
    })());
    return;
  }

  // Bundles com hash no nome (mobile-XXXXXXXX.js/css/etc) → CACHE-FIRST eterno.
  const isHashed = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|map)$/.test(url.pathname);
  if (isHashed) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      const cache = await caches.open(ASSET_CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    })());
    return;
  }

  // Outros assets (icones, voice/, etc) → cache-first com fallback de rede.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      // Em background, tenta atualizar (stale-while-revalidate light).
      fetch(req).then((fresh) => {
        if (cacheable(fresh)) caches.open(ASSET_CACHE).then((c) => c.put(req, fresh));
      }).catch(() => {});
      return cached;
    }
    try {
      const fresh = await fetch(req);
      // 206 (Partial Content) NAO pode ir pro Cache — o put() lanca
      // "Partial response is unsupported" (aparecia no console em audio/video,
      // que o navegador busca por range). Responde normal, so nao cacheia.
      if (cacheable(fresh)) {
        const cache = await caches.open(ASSET_CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      return new Response('offline', { status: 503 });
    }
  })());
});

// ─── Web Push ────────────────────────────────────────────────────────────────
// Payload JSON enviado pelo backend (api.php push_notify via container):
// { title, body, tag, url }. Mostra a notificacao mesmo com o app fechado.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch { try { data = { body: e.data ? e.data.text() : '' }; } catch { data = {}; } }
  const title = data.title || 'Maestrus';
  e.waitUntil((async () => {
    // O DEVICE é a fonte da verdade: só engole a notificação se o app estiver
    // ABERTO E VISÍVEL na frente do usuário (aí ele já vê ao vivo). Fechado, em
    // background ou minimizado → MOSTRA. (O host não sabe disso — por isso a
    // decisão é aqui, não lá.)
    try {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visivel = wins.some((c) => c.visibilityState === 'visible' && (c.url || '').includes('/app'));
      if (visivel) return;
    } catch {}
    await self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'maestrus',
      icon: '/app/icon-192.png',
      badge: '/app/icon-192.png',
      data: { url: data.url || '/app/' },
    });
  })());
});

// Clique na notificacao: foca uma janela do app ja aberta, ou abre uma nova.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (c.url && c.url.includes('/app') && 'focus' in c) {
        try { await c.focus(); return; } catch {}
      }
    }
    if (self.clients.openWindow) { try { await self.clients.openWindow(url); } catch {} }
  })());
});
