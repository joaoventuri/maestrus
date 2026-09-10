import { ModelChoice } from '../types';

export type CostTier = '$' | '$$' | '$$$';

export interface ModelInfo {
  id: ModelChoice;
  label: string;
  family: 'fable' | 'opus' | 'sonnet' | 'haiku' | 'default' | 'codex' | 'gpt';
  /** Provedor do modelo — decide quais modelos aparecem por engine. */
  provider: 'anthropic' | 'openai';
  /** Chave i18n da descrição (resolvida com t() no componente). */
  descKey: string;
  contextWindow: number;
}

// Custo relativo na Maestrus Cloud AI (medido). Só importa no engine "cloud" —
// no Claude CLI a cobrança é o plano fixo do usuário. Opus » Sonnet » Haiku.
const TIER_BY_FAMILY: Record<ModelInfo['family'], CostTier> = {
  fable: '$',
  opus: '$$$',
  sonnet: '$$',
  haiku: '$',
  default: '$$',
  codex: '$$$',
  gpt: '$$',
};

export function costTier(id: ModelChoice | undefined): CostTier {
  return TIER_BY_FAMILY[getModelInfo(id).family];
}

// Janelas de contexto — família Claude 5 + 4.x (oficial Anthropic). Descrições via i18n.
// Reserva de output: o context_window do modelo cobre input+output combinados.
// Claude Code (e a UI dele) descontam ~8k tokens da janela pra deixar espaço
// pra resposta; replicamos pra contagem bater. `outputReserve` é o teto típico
// que a Anthropic deixa de output em modo headless do CLI.
// Organizado: versões ESPECÍFICAS primeiro (família, mais nova → mais antiga),
// depois os atalhos "(último)" que deixam o CLI escolher a versão atual. O "(1M)"
// no nome distingue a janela de 1M — sem badge separado (a descrição detalha).
export const MODEL_REGISTRY: ModelInfo[] = [
  { id: 'claude-fable-5-1',       label: 'Fable 5.1',         family: 'fable',  provider: 'anthropic', descKey: 'model.descFable51',      contextWindow: 200_000 },
  { id: 'claude-fable-5-1[1m]',   label: 'Fable 5.1 (1M)',    family: 'fable',  provider: 'anthropic', descKey: 'model.descFable51_1m',   contextWindow: 1_000_000 },
  { id: 'claude-fable-5',         label: 'Fable 5',           family: 'fable',  provider: 'anthropic', descKey: 'model.descFable5',       contextWindow: 200_000 },
  { id: 'claude-fable-5[1m]',     label: 'Fable 5 (1M)',      family: 'fable',  provider: 'anthropic', descKey: 'model.descFable5_1m',    contextWindow: 1_000_000 },
  { id: 'claude-opus-5',          label: 'Opus 5',            family: 'opus',   provider: 'anthropic', descKey: 'model.descOpus5',        contextWindow: 200_000 },
  { id: 'claude-opus-5[1m]',      label: 'Opus 5 (1M)',       family: 'opus',   provider: 'anthropic', descKey: 'model.descOpus5_1m',     contextWindow: 1_000_000 },
  { id: 'claude-opus-4-8',        label: 'Opus 4.8',          family: 'opus',   provider: 'anthropic', descKey: 'model.descOpus48',       contextWindow: 200_000 },
  { id: 'claude-opus-4-8[1m]',    label: 'Opus 4.8 (1M)',     family: 'opus',   provider: 'anthropic', descKey: 'model.descOpus48_1m',    contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5',        label: 'Sonnet 5',          family: 'sonnet', provider: 'anthropic', descKey: 'model.descSonnet5',      contextWindow: 200_000 },
  { id: 'claude-sonnet-5[1m]',    label: 'Sonnet 5 (1M)',     family: 'sonnet', provider: 'anthropic', descKey: 'model.descSonnet5_1m',   contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-6',      label: 'Sonnet 4.6',        family: 'sonnet', provider: 'anthropic', descKey: 'model.descSonnetLatest', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5',       label: 'Haiku 4.5',         family: 'haiku',  provider: 'anthropic', descKey: 'model.descHaikuLatest',  contextWindow: 200_000 },
  // Atalhos — o CLI resolve pra versão mais recente da família. São os únicos
  // ids que se ATUALIZAM SOZINHOS: sai um modelo novo, o alias já aponta pra ele.
  { id: 'fable',                  label: 'Fable (último)',    family: 'fable',  provider: 'anthropic', descKey: 'model.descFableAlias',   contextWindow: 200_000 },
  { id: 'opus',                   label: 'Opus (último)',     family: 'opus',   provider: 'anthropic', descKey: 'model.descOpus',         contextWindow: 200_000 },
  { id: 'sonnet',                 label: 'Sonnet (último)',   family: 'sonnet', provider: 'anthropic', descKey: 'model.descSonnet',       contextWindow: 200_000 },
  { id: 'haiku',                  label: 'Haiku (último)',    family: 'haiku',  provider: 'anthropic', descKey: 'model.descHaiku',        contextWindow: 200_000 },
  { id: 'default',                label: 'Padrão (automático)', family: 'default', provider: 'anthropic', descKey: 'model.descDefault',   contextWindow: 200_000 },
  // ─── OpenAI / Codex (engines 'codex' e 'codex-api') ───────────────────────
  { id: 'gpt-5-codex',            label: 'GPT-5 Codex',       family: 'codex',  provider: 'openai',    descKey: 'model.descGpt5Codex',    contextWindow: 400_000 },
  { id: 'gpt-5',                  label: 'GPT-5',             family: 'gpt',    provider: 'openai',    descKey: 'model.descGpt5',         contextWindow: 400_000 },
  { id: 'gpt-5-mini',             label: 'GPT-5 mini',        family: 'gpt',    provider: 'openai',    descKey: 'model.descGpt5Mini',     contextWindow: 400_000 },
  { id: 'codex-default',          label: 'Padrão (automático)', family: 'codex', provider: 'openai',   descKey: 'model.descCodexDefault', contextWindow: 400_000 },
];

/** Provedor de uma engine — Anthropic (claude/cloud) ou OpenAI (codex/codex-api). */
export function engineProvider(engine: string | undefined): 'anthropic' | 'openai' {
  return (engine === 'codex' || engine === 'codex-api') ? 'openai' : 'anthropic';
}

// ─── Modelos descobertos no binário do CLI ──────────────────────────────────
// O CLI instalado carrega a lista de modelos que conhece; o main extrai os ids
// (electron/model-scan.js) e o App injeta aqui no boot. Assim, CLI atualizado =
// picker atualizado, sem esperar release do Maestrus. O registro curado acima
// continua mandando em label/descrição — só entra aqui o que ele não conhece.
let _discovered: ModelInfo[] = [];
// [major, minor] de um id claude-<fam>-X(-Y). Alias e formatos estranhos → null.
function versionOf(id: string): [number, number] | null {
  const m = id.match(/^claude-(?:fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:\[1m\])?$/);
  return m ? [Number(m[1]), Number(m[2] || 0)] : null;
}
export function setDiscoveredModels(ids: string[]) {
  const known = new Set(MODEL_REGISTRY.map((m) => m.id));
  // Só entra o que for MAIS NOVO que o registro curado da mesma família — a
  // descoberta existe pra pegar lançamento, não pra despejar o catálogo antigo
  // inteiro (opus-4-0, 4-1… viraria um menu de museu).
  const maxCurated: Record<string, [number, number]> = {};
  for (const m of MODEL_REGISTRY) {
    const v = versionOf(m.id);
    if (!v) continue;
    const cur = maxCurated[m.family];
    if (!cur || v[0] > cur[0] || (v[0] === cur[0] && v[1] > cur[1])) maxCurated[m.family] = v;
  }
  _discovered = (ids || [])
    .filter((id) => {
      if (!/^claude-(fable|opus|sonnet|haiku)-\d+(-\d+)?$/.test(id) || known.has(id)) return false;
      const fam = id.match(/^claude-(\w+)-/)![1];
      const v = versionOf(id)!;
      const top = maxCurated[fam];
      return !top || v[0] > top[0] || (v[0] === top[0] && v[1] > top[1]);
    })
    .map((id) => {
      const fam = (id.match(/^claude-(\w+)-/)?.[1] || 'sonnet') as ModelInfo['family'];
      // claude-opus-5-1 → "Opus 5.1"
      const ver = id.replace(/^claude-\w+-/, '').replace(/-/g, '.');
      return {
        id,
        label: `${fam[0].toUpperCase()}${fam.slice(1)} ${ver}`,
        family: fam,
        provider: 'anthropic' as const,
        descKey: 'model.descDiscovered',
        contextWindow: 200_000,
      };
    });
}

/** Modelos que fazem sentido para a engine escolhida (filtra por provedor). */
export function modelsForEngine(engine: string | undefined): ModelInfo[] {
  const p = engineProvider(engine);
  const base = MODEL_REGISTRY.filter((m) => m.provider === p);
  if (p !== 'anthropic' || _discovered.length === 0) return base;
  // Descoberto entra logo após o último pinado da mesma família — a ordem
  // visual (Fable, Opus, Sonnet, Haiku, atalhos) se mantém.
  const out = [...base];
  for (const d of _discovered) {
    let at = -1;
    for (let i = 0; i < out.length; i++) if (out[i].family === d.family && !/^(fable|opus|sonnet|haiku|default)$/.test(out[i].id)) at = i;
    out.splice(at >= 0 ? at + 1 : out.length, 0, d);
  }
  return out;
}

/** Modelo default por engine (usado quando o projeto ainda não escolheu um). */
// Anthropic default = alias 'opus' (não um id pinado): acompanha sozinho o
// último Opus quando a Anthropic lança versão nova.
export function defaultModelForEngine(engine: string | undefined): ModelChoice {
  return engineProvider(engine) === 'openai' ? 'gpt-5-codex' : 'opus';
}

// Reserva de OUTPUT que o Claude Code desconta da janela visível. É o teto de
// max_tokens que o modelo pode gerar, então o contexto efetivo de INPUT é
// (contextWindow - outputReserve). Replica o cálculo da CLI pro indicador bater.
const OUTPUT_RESERVE_BY_FAMILY: Record<ModelInfo['family'], number> = {
  fable: 8_192,
  opus: 8_192,
  sonnet: 8_192,
  haiku: 8_192,
  default: 8_192,
  codex: 8_192,
  gpt: 8_192,
};

export function getEffectiveContextWindow(id: ModelChoice | undefined): number {
  const info = getModelInfo(id);
  const reserve = OUTPUT_RESERVE_BY_FAMILY[info.family] || 8_192;
  return Math.max(1, info.contextWindow - reserve);
}

export function getModelInfo(id: ModelChoice | undefined): ModelInfo {
  if (!id) return MODEL_REGISTRY[0];
  const isOpenai = id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4') || id.includes('codex');
  return MODEL_REGISTRY.find((m) => m.id === id) || {
    id,
    label: id,
    family: isOpenai ? (id.includes('codex') ? 'codex' : 'gpt')
      : id.includes('fable') ? 'fable' : id.includes('opus') ? 'opus' : id.includes('haiku') ? 'haiku' : 'sonnet',
    provider: isOpenai ? 'openai' : 'anthropic',
    descKey: 'model.descCustom',
    contextWindow: id.endsWith('[1m]') ? 1_000_000 : isOpenai ? 400_000 : 200_000,
  };
}

export function getContextWindow(id: ModelChoice | undefined): number {
  return getModelInfo(id).contextWindow;
}
