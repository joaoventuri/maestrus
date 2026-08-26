/**
 * Gera renderer/src/lib/brand-icons-data.ts a partir do simple-icons.
 *
 * Por que gerar em vez de importar: o pacote é CJS e só expõe o índice com
 * ~3.400 ícones, então importar dele arrastaria tudo pro bundle. Aqui
 * extraímos só as marcas que o Maestrus usa (~35) e o resultado vira um
 * arquivo estático — zero dependência em runtime, ~10KB.
 *
 * Rodar quando adicionar um conector novo:  node scripts/gen-brand-icons.js
 */
const fs = require('fs');
const path = require('path');
const si = require('simple-icons');

// id no Maestrus → slug do simple-icons
const WANTED = {
  github: 'Github', gitlab: 'Gitlab', notion: 'Notion', stripe: 'Stripe',
  linear: 'Linear', figma: 'Figma', supabase: 'Supabase', discord: 'Discord',
  telegram: 'Telegram', gmail: 'Gmail', airtable: 'Airtable', sentry: 'Sentry',
  cloudflare: 'Cloudflare', hubspot: 'Hubspot', asana: 'Asana',
  postgres: 'Postgresql', jira: 'Jira', atlassian: 'Atlassian',
  whatsapp: 'Whatsapp', google: 'Google', gdrive: 'Googledrive',
  gcalendar: 'Googlecalendar', gsheets: 'Googlesheets', vercel: 'Vercel',
  zapier: 'Zapier', anthropic: 'Anthropic', docker: 'Docker',
  mongodb: 'Mongodb', redis: 'Redis', shopify: 'Shopify', trello: 'Trello',
  clickup: 'Clickup', obsidian: 'Obsidian', youtube: 'Youtube',
  spotify: 'Spotify', dropbox: 'Dropbox', salesforce: 'Salesforce',
};

const out = {};
const missing = [];
for (const [id, slug] of Object.entries(WANTED)) {
  const icon = si['si' + slug];
  if (!icon) { missing.push(id); continue; }
  out[id] = { p: icon.path, h: '#' + icon.hex, t: icon.title };
}

const header = `// GERADO por scripts/gen-brand-icons.js — não edite à mão.
// Fonte: simple-icons (CC0). Rode o script pra adicionar marcas novas.
// Marcas ausentes aqui (Slack, OpenAI, Microsoft…) foram removidas do
// simple-icons a pedido do titular; brand-icons.ts cobre com monograma.

export interface RawIcon { p: string; h: string; t: string }

export const BRAND_DATA: Record<string, RawIcon> = ${JSON.stringify(out, null, 2)};
`;

fs.writeFileSync(path.join(__dirname, '..', 'renderer', 'src', 'lib', 'brand-icons-data.ts'), header);
console.log(`✓ ${Object.keys(out).length} marcas geradas`);
if (missing.length) console.log(`  sem SVG (viram monograma): ${missing.join(', ')}`);
