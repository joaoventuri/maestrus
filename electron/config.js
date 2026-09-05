// Configuração global interna do Maestrus.
// Tudo no maestrus.cloud agora — backend (API, IA, relay, sync) e o feed de
// updates (instaladores/latest.yml), servido pelo bind-mount /downloads/ via
// Caddy → container PHP.
const BASE = 'https://maestrus.cloud';

// Distribuição vive no GitHub Releases: o projeto é aberto e não deve depender
// da infraestrutura de uma pessoa só para entregar atualização. Quem forkar
// muda GH_REPO e passa a distribuir pelo próprio repositório, sem servidor.
const GH_REPO = process.env.MAESTRUS_GH_REPO || 'joaoventuri/maestrus';
const GH_LATEST = `https://github.com/${GH_REPO}/releases/latest/download`;
const GH_API = `https://api.github.com/repos/${GH_REPO}/releases/latest`;
// Relay público padrão. É só um encaminhador burro (não vê o conteúdo nem sabe
// quem você é quando o pareamento é por convite), mas ainda assim é um ponto
// central: quem quiser outro muda MAESTRUS_RELAY_URL ou o ajuste `relay_url`.
const RELAY_URL = process.env.MAESTRUS_RELAY_URL || 'wss://maestrus.cloud/relay';

module.exports = {
  BASE,
  RELAY_URL,
  GH_REPO,
  GH_LATEST,
  GH_API,
  API_BASE: `${BASE}/api.php`,
  UPDATE_FEED: `${BASE}/downloads/`,
};
