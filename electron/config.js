// Configuração global interna do Maestrus.
// Tudo no maestrus.cloud agora — backend (API, IA, relay, sync) e o feed de
// updates (instaladores/latest.yml), servido pelo bind-mount /downloads/ via
// Caddy → container PHP.
const BASE = 'https://maestrus.cloud';
module.exports = {
  BASE,
  API_BASE: `${BASE}/api.php`,
  UPDATE_FEED: `${BASE}/downloads/`,
  // Proxy de IA gerenciada: claude usa ANTHROPIC_BASE_URL = `${AI_PROXY}` e
  // chama `${AI_PROXY}/v1/messages`. O ai-proxy.php lê o PATH_INFO.
  AI_PROXY: `${BASE}/ai-proxy.php`,
};
