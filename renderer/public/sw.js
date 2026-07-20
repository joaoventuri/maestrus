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

const SW_VERSION = 'v3-2026-05-30';
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
        if (fresh && fresh.ok) caches.open(ASSET_CACHE).then((c) => c.put(req, fresh));
      }).catch(() => {});
      return cached;
    }
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(ASSET_CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      return new Response('offline', { status: 503 });
    }
  })());
});
