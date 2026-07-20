import { ModelChoice } from '../types';

export type CostTier = '$' | '$$' | '$$$';

export interface ModelInfo {
  id: ModelChoice;
  label: string;
  family: 'fable' | 'opus' | 'sonnet' | 'haiku' | 'default';
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
};

export function costTier(id: ModelChoice | undefined): CostTier {
  return TIER_BY_FAMILY[getModelInfo(id).family];
}

// Janelas de contexto — Claude 4.x (oficial Anthropic). Descrições via i18n.
// Reserva de output: o context_window do modelo cobre input+output combinados.
// Claude Code (e a UI dele) descontam ~8k tokens da janela pra deixar espaço
// pra resposta; replicamos pra contagem bater. `outputReserve` é o teto típico
// que a Anthropic deixa de output em modo headless do CLI.
// Organizado: versões ESPECÍFICAS primeiro (família, mais nova → mais antiga),
// depois os atalhos "(último)" que deixam o CLI escolher a versão atual. O "(1M)"
// no nome distingue a janela de 1M — sem badge separado (a descrição detalha).
export const MODEL_REGISTRY: ModelInfo[] = [
  { id: 'claude-fable-5',         label: 'Fable 5',           family: 'fable',  descKey: 'model.descFable5',       contextWindow: 200_000 },
  { id: 'claude-fable-5[1m]',     label: 'Fable 5 (1M)',      family: 'fable',  descKey: 'model.descFable5_1m',    contextWindow: 1_000_000 },
  { id: 'claude-opus-4-8',        label: 'Opus 4.8',          family: 'opus',   descKey: 'model.descOpus48',       contextWindow: 200_000 },
  { id: 'claude-opus-4-8[1m]',    label: 'Opus 4.8 (1M)',     family: 'opus',   descKey: 'model.descOpus48_1m',    contextWindow: 1_000_000 },
  { id: 'claude-opus-4-7',        label: 'Opus 4.7',          family: 'opus',   descKey: 'model.descOpusLatest',   contextWindow: 200_000 },
  { id: 'claude-opus-4-7[1m]',    label: 'Opus 4.7 (1M)',     family: 'opus',   descKey: 'model.descOpus1m',       contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-6',      label: 'Sonnet 4.6',        family: 'sonnet', descKey: 'model.descSonnetLatest', contextWindow: 200_000 },
  { id: 'claude-sonnet-4-6[1m]',  label: 'Sonnet 4.6 (1M)',   family: 'sonnet', descKey: 'model.descSonnet1m',     contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5',       label: 'Haiku 4.5',         family: 'haiku',  descKey: 'model.descHaikuLatest',  contextWindow: 200_000 },
  // Atalhos — o CLI resolve pra versão mais recente da família.
  { id: 'opus',                   label: 'Opus (último)',     family: 'opus',   descKey: 'model.descOpus',         contextWindow: 200_000 },
  { id: 'sonnet',                 label: 'Sonnet (último)',   family: 'sonnet', descKey: 'model.descSonnet',       contextWindow: 200_000 },
  { id: 'haiku',                  label: 'Haiku (último)',    family: 'haiku',  descKey: 'model.descHaiku',        contextWindow: 200_000 },
  { id: 'default',                label: 'Padrão (automático)', family: 'default', descKey: 'model.descDefault',   contextWindow: 200_000 },
];

// Reserva de OUTPUT que o Claude Code desconta da janela visível. É o teto de
// max_tokens que o modelo pode gerar, então o contexto efetivo de INPUT é
// (contextWindow - outputReserve). Replica o cálculo da CLI pro indicador bater.
const OUTPUT_RESERVE_BY_FAMILY: Record<ModelInfo['family'], number> = {
  fable: 8_192,
  opus: 8_192,
  sonnet: 8_192,
  haiku: 8_192,
  default: 8_192,
};

export function getEffectiveContextWindow(id: ModelChoice | undefined): number {
  const info = getModelInfo(id);
  const reserve = OUTPUT_RESERVE_BY_FAMILY[info.family] || 8_192;
  return Math.max(1, info.contextWindow - reserve);
}

export function getModelInfo(id: ModelChoice | undefined): ModelInfo {
  if (!id) return MODEL_REGISTRY[0];
  return MODEL_REGISTRY.find((m) => m.id === id) || {
    id,
    label: id,
    family: id.includes('fable') ? 'fable' : id.includes('opus') ? 'opus' : id.includes('haiku') ? 'haiku' : 'sonnet',
    descKey: 'model.descCustom',
    contextWindow: id.endsWith('[1m]') ? 1_000_000 : 200_000,
  };
}

export function getContextWindow(id: ModelChoice | undefined): number {
  return getModelInfo(id).contextWindow;
}
