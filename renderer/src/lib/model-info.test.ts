import { describe, it, expect } from 'vitest';
import { setDiscoveredModels, modelsForEngine, defaultModelForEngine, MODEL_REGISTRY } from './model-info';

// A descoberta serve pra UMA coisa: lançamento que o registro curado ainda não
// tem. Se ela despejar o catálogo antigo do CLI no picker, virou ruído.
describe('modelos descobertos no CLI', () => {
  it('só entra o que é MAIS NOVO que o curado da família', () => {
    setDiscoveredModels(['claude-opus-4-1', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-1', 'claude-sonnet-4-0']);
    const ids = modelsForEngine('claude').map((m) => m.id);
    expect(ids).toContain('claude-opus-5-1');       // mais novo que Opus 5 curado
    expect(ids).not.toContain('claude-opus-4-1');   // museu
    expect(ids).not.toContain('claude-sonnet-4-0');
    expect(ids.filter((i) => i === 'claude-opus-5').length).toBe(1); // sem duplicar curado
    setDiscoveredModels([]);
  });

  it('descoberto entra colado na família, antes dos atalhos', () => {
    setDiscoveredModels(['claude-fable-5-2']);
    const ids = modelsForEngine('claude').map((m) => m.id);
    const at = ids.indexOf('claude-fable-5-2');
    expect(at).toBeGreaterThan(ids.indexOf('claude-fable-5-1'));
    expect(at).toBeLessThan(ids.indexOf('fable'));
    setDiscoveredModels([]);
  });

  it('rótulo gerado é legível: claude-opus-5-1 → Opus 5.1', () => {
    setDiscoveredModels(['claude-opus-5-1']);
    const m = modelsForEngine('claude').find((x) => x.id === 'claude-opus-5-1')!;
    expect(m.label).toBe('Opus 5.1');
    setDiscoveredModels([]);
  });
});

describe('defaults e registro', () => {
  it('default Anthropic é o alias opus (acompanha o último sozinho)', () => {
    expect(defaultModelForEngine('claude')).toBe('opus');
    expect(defaultModelForEngine(undefined)).toBe('opus');
    expect(defaultModelForEngine('codex')).toBe('gpt-5-codex');
  });
  it('Fable 5.1 está no registro com a janela certa', () => {
    expect(MODEL_REGISTRY.find((m) => m.id === 'claude-fable-5-1')).toBeTruthy();
    expect(MODEL_REGISTRY.find((m) => m.id === 'claude-fable-5-1[1m]')?.contextWindow).toBe(1_000_000);
    expect(MODEL_REGISTRY.find((m) => m.id === 'fable')).toBeTruthy();
  });
});
