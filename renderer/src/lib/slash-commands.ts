export interface SlashCommand {
  name: string;
  desc: string;
  example?: string;
}

export const BUILTIN_SLASH: SlashCommand[] = [
  { name: '/help', desc: 'Lista todos os comandos do Maestrus' },
  { name: '/status', desc: 'Estado atual do projeto (modelo, sessão, modo)' },
  { name: '/model', desc: '/model <sonnet|opus|haiku|id> — troca modelo' },
  { name: '/thinking', desc: '/thinking <none|low|medium|high>' },
  { name: '/permission-mode', desc: '/permission-mode <default|acceptEdits|plan|bypassPermissions>' },
  { name: '/clear', desc: 'Limpa a sessão (próxima mensagem inicia nova)' },
  { name: '/reset', desc: 'Limpa sessão E o chat' },
  { name: '/compact', desc: 'Resume a conversa e compacta a sessão (mesmo sessionId)' },
  { name: '/cost', desc: 'Custo e tokens da última chamada' },
  { name: '/usage', desc: 'Uso local agregado (janela 5h, mês, etc.)' },
  { name: '/version', desc: 'Versão do Claude Code CLI' },
  { name: '/doctor', desc: 'Diagnóstico de requisitos' },
  { name: '/agents', desc: 'Lista subagentes configurados' },
  { name: '/memory', desc: 'Lista memórias salvas' },
  { name: '/logout', desc: 'Encerra sessão da CLI' },
  { name: '/mcp', desc: 'Gerenciar MCP servers' },
  { name: '/settings', desc: 'Abrir configurações' },
  { name: '/bug', desc: 'Abrir issues no GitHub' },
  { name: '/release-notes', desc: 'Abrir changelog' },
  { name: '/review', desc: 'Pedir review (carrega skill via -p)' },
  { name: '/init', desc: 'Gerar CLAUDE.md (carrega skill via -p)' },
  { name: '/security-review', desc: 'Audit de segurança (carrega skill via -p)' },
  { name: '/team', desc: 'Lista projetos disponíveis pra orquestrar (Maestrus)' },
  { name: '/ask', desc: '/ask <projeto> <prompt> — dispatch único (Maestrus)' },
  { name: '/parallel', desc: '/parallel <p1>,<p2> <prompt> — dispatch paralelo (Maestrus)' },
  { name: '/task', desc: '/task <projeto> [--loop N] <prompt> — enfileira task no Kanban (não bloqueia)' },
  { name: '/exit', desc: 'Fecha o Maestrus' },
];

export function filterCommands(query: string): SlashCommand[] {
  const q = query.replace(/^\//, '').toLowerCase();
  if (!q) return BUILTIN_SLASH;
  return BUILTIN_SLASH.filter(
    (c) => c.name.slice(1).toLowerCase().includes(q) || c.desc.toLowerCase().includes(q),
  );
}
