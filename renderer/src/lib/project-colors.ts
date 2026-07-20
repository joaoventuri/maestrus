// Cor estável por projeto (hash do id → hue HSL). Usada pra colorir respostas
// orquestradas no chat do Maestrus.

const ORCHESTRATE_TOOLS = ['claui_dispatch', 'claui_dispatch_parallel', 'claui_list_projects'];

export function colorForProject(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 65% 58%)`;
}

// Versão com alpha pra fundo sutil do balão.
export function tintForProject(key: string, alpha = 0.1): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsla(${hue} 65% 58% / ${alpha})`;
}

// Detecta se um tool name é uma das tools de orquestração (com ou sem prefixo MCP).
export function isOrchestrateTool(name?: string): boolean {
  if (!name) return false;
  return ORCHESTRATE_TOOLS.some((t) => name === t || name.endsWith(`__${t}`) || name.includes(t));
}

// Extrai o(s) alvo(s) do input de uma tool de orquestração.
export function targetsFromInput(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input.project_ids)) return input.project_ids.map(String);
  if (input.project_id) return [String(input.project_id)];
  return [];
}
