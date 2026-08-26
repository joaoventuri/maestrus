/**
 * Logomarcas dos conectores (MCPs e Canais).
 *
 * Vêm do simple-icons: SVG oficial de ~3.400 marcas, licença CC0, com a cor
 * hex oficial de cada uma. É melhor que PNG baixado à mão — escala em qualquer
 * tela, herda cor no tema claro/escuro, pesa ~1KB e não tem dúvida de licença.
 *
 * Os dados vêm de brand-icons-data.ts, gerado por scripts/gen-brand-icons.js:
 * o pacote é CJS e só expõe o índice completo, então importar dele arrastaria
 * as 3.400 marcas pro bundle. Gerando, ficam só as ~36 que usamos.
 *
 * Algumas marcas foram REMOVIDAS do simple-icons a pedido do titular (Slack,
 * OpenAI, Microsoft). Pra essas, um monograma com a cor oficial — melhor que
 * ícone genérico e sem risco de usar arte que a marca não autoriza.
 */
import { BRAND_DATA } from './brand-icons-data';

export interface BrandIcon {
  /** Caminho do SVG (viewBox 0 0 24 24). Ausente quando é monograma. */
  path?: string;
  /** Cor oficial da marca, em hex. */
  hex: string;
  title: string;
  /** Usado quando não há SVG — 1 ou 2 letras. */
  mono?: string;
}

function of(id: string): BrandIcon | null {
  const r = BRAND_DATA[id];
  return r ? { path: r.p, hex: r.h, title: r.t } : null;
}

// Marcas sem SVG no simple-icons: monograma com a cor oficial.
const MONO: Record<string, BrandIcon> = {
  slack: { hex: '#4A154B', title: 'Slack', mono: 'S' },
  openai: { hex: '#412991', title: 'OpenAI', mono: 'AI' },
  microsoft: { hex: '#5E5E5E', title: 'Microsoft', mono: 'MS' },
  imap: { hex: '#6E7B8B', title: 'IMAP', mono: '@' },
  brave: { hex: '#FB542B', title: 'Brave', mono: 'B' },
  meta: { hex: '#0866FF', title: 'Meta', mono: 'M' },
  aws: { hex: '#FF9900', title: 'AWS', mono: 'AW' },
};

const ICONS: Record<string, BrandIcon> = { ...MONO };
for (const id of Object.keys(BRAND_DATA)) {
  const ic = of(id);
  if (ic) ICONS[id] = ic;
}
// Apelidos: o mesmo visual serve mais de um id do catálogo.
const ALIAS: Record<string, string> = {
  postgresql: 'postgres', claude: 'anthropic', confluence: 'atlassian',
  googledrive: 'gdrive', googlecalendar: 'gcalendar', googlesheets: 'gsheets',
};
for (const [from, to] of Object.entries(ALIAS)) if (ICONS[to]) ICONS[from] = ICONS[to];


/**
 * Acha a marca pelo id do conector. Tolera sufixos e variações comuns
 * ('gmail-mcp', 'server-github', 'Notion') porque os ids do catálogo e do
 * registry oficial não seguem um padrão único.
 */
export function brandIcon(id: string): BrandIcon | null {
  if (!id) return null;
  const key = String(id).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ICONS[key]) return ICONS[key];
  for (const k of Object.keys(ICONS)) {
    if (key.includes(k)) return ICONS[k];
  }
  return null;
}

/** Iniciais coloridas quando a marca é desconhecida — nunca fica sem visual. */
export function fallbackMono(label: string): BrandIcon {
  const s = String(label || '?').trim();
  // Hash estável do nome → matiz: o mesmo conector tem sempre a mesma cor.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return { hex: `hsl(${h % 360} 55% 55%)`, title: s, mono: s.slice(0, 2).toUpperCase() };
}
