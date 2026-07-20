import { ChatMessage, ModelChoice, PermissionMode, Project, ThinkingMode } from '../types';

export interface SlashContext {
  project: Project;
  patchProject: (patch: Partial<Project>) => Promise<Project>;
  pushSystem: (text: string) => void;
  pushSystemHtml?: (html: string) => void;
  openMcp?: () => void;
  openSettings?: () => void;
  openRequirements?: () => void;
  clearMessages?: () => void;
  reloadHistory?: () => Promise<void> | void;
  // Pra Maestrus: re-injetar resposta como mensagem do user no próximo turno
  dispatchSeed?: (seed: string) => void;
  lastCostUsd: number | null;
  lastUsage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
}

export interface SlashResult {
  handled: boolean;
  rewriteTo?: string;
}

const VALID_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const VALID_THINKING: ThinkingMode[] = ['none', 'low', 'medium', 'high'];

const MAESTRUS_ID = 'maestrus';

const HELP_TEXT = [
  'Comandos disponíveis no Maestrus:',
  '',
  '  Tratados localmente:',
  '  /help                          Lista esses comandos',
  '  /status                        Estado atual do projeto',
  '  /model [<id>]                  Troca modelo (sonnet | opus | haiku | <id full>)',
  '  /thinking [<modo>]             none | low | medium | high',
  '  /permission-mode [<modo>]      default | acceptEdits | plan | bypassPermissions',
  '  /clear                         Limpa a sessão (próxima msg inicia nova)',
  '  /reset                         Igual /clear + limpa mensagens do chat',
  '  /compact [foco]                Resume a conversa e recomeça numa sessão leve',
  '  /cost                          Custo e tokens da última chamada',
  '  /usage                          Uso REAL da conta Claude (sessão 5h, semana, por modelo)',
  '  /version                       Versão do Claude Code CLI',
  '  /doctor                        Diagnóstico de requisitos',
  '  /agents                        Lista subagentes configurados',
  '  /memory                        Lista memórias salvas',
  '  /logout                        Encerra sessão da CLI (claude logout)',
  '  /mcp                           Abrir tela de MCP servers',
  '  /settings                      Abrir configurações',
  '  /bug                           Abrir issues no GitHub',
  '  /release-notes                 Abrir changelog do Claude Code',
  '  /exit                          Fecha o Maestrus',
  '',
  '  Só no Maestrus (orquestração):',
  '  /team                               Lista projetos disponíveis pra orquestrar',
  '  /ask <projeto> <prompt>             Dispatch único pro projeto-alvo (resposta vira contexto)',
  '  /parallel <p1>,<p2>… <prompt>       Dispatch paralelo em vários projetos',
  '  /task <projeto> [--loop N] <prompt> Enfileira no Kanban — não bloqueia, resultado volta aqui',
  '',
  '  Repassados ao claude (carregam skill via -p):',
  '  /review   /init   /security-review   /design',
  '',
  '  Não funcionam no modo headless (use o REPL do `claude` no terminal):',
  '  /login   /resume   /vim   /output-style',
].join('\n');

const PASSTHROUGH_COMMANDS = new Set([
  'review', 'init', 'security-review', 'design',
]);

const REPL_ONLY = new Set([
  'login', 'resume', 'vim', 'output-style', 'output_style',
]);

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `US$ ${n.toFixed(4)}`;
  return `US$ ${n.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}min`;
  return `${m}min`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function bar(pctRaw: number, color: string): string {
  const pct = Math.max(0, Math.min(100, pctRaw));
  return `<div class="usage-bar"><div class="usage-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div><span class="usage-bar-pct">${pct.toFixed(1)}%</span></div>`;
}

function colorForPct(p: number): string {
  if (p > 85) return '#e06c75';
  if (p > 70) return '#d8b657';
  return '#7bc16f';
}

type RealLimit = { kind: string; label: string; percent: number | null; severity: string; resetsAt: string | null; active: boolean };
type RealUsage = { ok: boolean; real?: boolean; error?: string; limits?: RealLimit[]; extra?: { utilization?: number | null } | null; fetchedAt?: number };

function fmtReset(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  const when = d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return ms > 0 ? `reseta ${when} · falta ${fmtDuration(ms)}` : `resetou ${when}`;
}

function sevColor(sev: string, pct: number): string {
  if (sev === 'critical' || sev === 'exceeded') return '#e06c75';
  if (sev === 'warning' || sev === 'elevated') return '#d8b657';
  return colorForPct(pct);
}

// Uso REAL da conta Claude — mesmo dado do /usage oficial do Claude Code
// (endpoint OAuth da Anthropic), consultado no HOST onde o CLI roda.
function renderUsageHtml(u: RealUsage): string {
  if (!u || u.ok === false) {
    const msg = u?.error === 'no_credentials'
      ? 'Nenhuma conta Claude conectada neste host — conecte em Configurações → Contas do Claude.'
      : u?.error === 'auth_expired'
        ? 'O login do Claude expirou — envie qualquer mensagem (o CLI renova o token) e rode /usage de novo.'
        : `Não consegui consultar o uso agora (${esc(String(u?.error || 'erro'))}).`;
    return `<div class="usage-report"><div class="usage-block muted">${msg}</div></div>`;
  }
  const sec: string[] = [];
  sec.push(`<div class="usage-header">Uso da conta Claude · dado oficial em tempo real</div>`);
  for (const l of u.limits || []) {
    const pct = typeof l.percent === 'number' ? l.percent : 0;
    sec.push(`
      <div class="usage-block">
        <div class="usage-title">${esc(l.label)}${l.active ? ' · <span class="usage-active">limite ativo</span>' : ''}</div>
        <div class="usage-row"><span class="usage-label">uso</span>${bar(pct, sevColor(l.severity, pct))}</div>
        <div class="usage-sub">${esc(fmtReset(l.resetsAt))}</div>
      </div>`);
  }
  if (!u.limits || u.limits.length === 0) {
    sec.push(`<div class="usage-block muted">A conta não reportou limites de assinatura.</div>`);
  }
  if (u.extra && typeof u.extra.utilization === 'number') {
    sec.push(`<div class="usage-block"><div class="usage-title">Uso extra (créditos)</div><div class="usage-row"><span class="usage-label">uso</span>${bar(u.extra.utilization, colorForPct(u.extra.utilization))}</div></div>`);
  }
  sec.push(`<div class="usage-footer">Fonte: conta conectada neste host — igual ao /usage do Claude Code. Painel: <a href="https://claude.ai/settings/usage" target="_blank">claude.ai/settings/usage</a></div>`);
  return `<div class="usage-report">${sec.join('')}</div>`;
}
export async function handleSlash(text: string, ctx: SlashContext): Promise<SlashResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const m = trimmed.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return { handled: false };

  const cmd = m[1].toLowerCase();
  const arg = (m[2] || '').trim();

  switch (cmd) {
    case 'help':
    case '?': {
      ctx.pushSystem(HELP_TEXT);
      return { handled: true };
    }

    case 'status': {
      const p = ctx.project;
      ctx.pushSystem([
        `Projeto: ${p.name}`,
        `Source: ${p.source}`,
        `Code dir: ${p.codeDir || '(sem código)'}`,
        `Modelo: ${p.model || 'sonnet'}`,
        `Thinking: ${p.thinkingMode || 'medium'}`,
        `Permission mode: ${p.permissionMode || 'default'}`,
        `Session: ${p.sessionId || '(nova — próxima mensagem cria)'}`,
      ].join('\n'));
      return { handled: true };
    }

    case 'model': {
      if (!arg) {
        ctx.pushSystem(`Modelo atual: ${ctx.project.model || 'sonnet'}\nUso: /model <sonnet | opus | haiku | claude-opus-4-7 | …>`);
        return { handled: true };
      }
      const next = await ctx.patchProject({ model: arg as ModelChoice });
      ctx.pushSystem(`Modelo atualizado: ${next.model}`);
      return { handled: true };
    }

    case 'thinking': {
      if (!arg) {
        ctx.pushSystem(`Thinking atual: ${ctx.project.thinkingMode || 'medium'}\nUso: /thinking <none | low | medium | high>`);
        return { handled: true };
      }
      if (!VALID_THINKING.includes(arg as ThinkingMode)) {
        ctx.pushSystem(`Modo inválido: "${arg}". Use: none | low | medium | high.`);
        return { handled: true };
      }
      const next = await ctx.patchProject({ thinkingMode: arg as ThinkingMode });
      ctx.pushSystem(`Thinking atualizado: ${next.thinkingMode}`);
      return { handled: true };
    }

    case 'permission-mode':
    case 'permissions':
    case 'perm': {
      if (!arg) {
        ctx.pushSystem(`Permission mode atual: ${ctx.project.permissionMode || 'default'}\nUso: /permission-mode <default | acceptEdits | plan | bypassPermissions>`);
        return { handled: true };
      }
      if (!VALID_PERMISSION_MODES.includes(arg as PermissionMode)) {
        ctx.pushSystem(`Modo inválido: "${arg}". Use: ${VALID_PERMISSION_MODES.join(' | ')}.`);
        return { handled: true };
      }
      const next = await ctx.patchProject({ permissionMode: arg as PermissionMode });
      ctx.pushSystem(`Permission mode: ${next.permissionMode}`);
      return { handled: true };
    }

    case 'clear':
    case 'new': {
      await ctx.patchProject({ sessionId: null });
      ctx.pushSystem('Sessão limpa. A próxima mensagem inicia uma nova conversa.');
      return { handled: true };
    }

    case 'reset': {
      await ctx.patchProject({ sessionId: null });
      if (ctx.clearMessages) ctx.clearMessages();
      return { handled: true };
    }

    case 'compact': {
      const proj = ctx.project;
      if (arg === 'restore') {
        try {
          const r = await (window.maestrus.claude as any).compactRestore(proj.id);
          if (!r.ok) { ctx.pushSystem(`Não restaurou: ${r.error || 'erro desconhecido'}`); return { handled: true }; }
          if (ctx.reloadHistory) await ctx.reloadHistory();
          ctx.pushSystem('✓ Sessão restaurada do backup .bak. O contexto anterior foi recuperado.');
        } catch (e: any) { ctx.pushSystem(`Erro ao restaurar: ${e?.message || e}`); }
        return { handled: true };
      }
      if (!proj.sessionId) {
        ctx.pushSystem('Nada pra compactar — a sessão ainda não começou.');
        return { handled: true };
      }
      ctx.pushSystem('⊙ Compactando a sessão… resumindo o contexto e reescrevendo a sessão (mesmo sessionId). Pode levar alguns segundos.');
      try {
        const r = await window.maestrus.claude.compact(proj.id, { focus: arg || undefined });
        if (!r.ok) {
          ctx.pushSystem(`Não compactou: ${r.error || 'erro desconhecido'}`);
          return { handled: true };
        }
        // Recarrega o histórico — agora começa do compact_boundary (contexto leve).
        if (ctx.reloadHistory) await ctx.reloadHistory();
        ctx.pushSystem('✓ Sessão compactada in-place (mesmo sessionId). O contexto agora parte do resumo acima. Backup .bak salvo — use /compact restore para desfazer.');
      } catch (e: any) {
        ctx.pushSystem(`Erro ao compactar: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'cost': {
      if (ctx.lastCostUsd == null && !ctx.lastUsage) {
        ctx.pushSystem('Sem dados de custo ainda — envie uma mensagem primeiro.');
        return { handled: true };
      }
      const lines: string[] = [];
      if (ctx.lastCostUsd != null) lines.push(`Custo da última chamada: ${fmtUsd(ctx.lastCostUsd)}`);
      if (ctx.lastUsage) {
        const u = ctx.lastUsage;
        lines.push(
          `Tokens — in: ${u.input_tokens ?? 0} · out: ${u.output_tokens ?? 0}` +
          (u.cache_read_input_tokens ? ` · cache read: ${u.cache_read_input_tokens}` : '') +
          (u.cache_creation_input_tokens ? ` · cache create: ${u.cache_creation_input_tokens}` : ''),
        );
      }
      ctx.pushSystem(lines.join('\n'));
      return { handled: true };
    }

    case 'usage': {
      try {
        const scope: 'all' | 'project' = arg === 'project' ? 'project' : 'all';
        const report = await window.maestrus.claude.usage({ scope, projectId: ctx.project.id });
        if (ctx.pushSystemHtml) ctx.pushSystemHtml(renderUsageHtml(report));
        else ctx.pushSystem('Uso agregado (sem HTML disponível)');
      } catch (e: any) {
        ctx.pushSystem(`Erro ao agregar uso: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'version': {
      try {
        const v = await window.maestrus.claude.version();
        ctx.pushSystem(`Claude Code: ${v || '(sem resposta)'}`);
      } catch (e: any) {
        ctx.pushSystem(`Erro ao obter versão: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'doctor':
    case 'diagnose': {
      try {
        const report = await window.maestrus.requirements.check();
        const version = await window.maestrus.claude.version().catch(() => '(falhou)');
        const lines: string[] = [];
        lines.push(`Plataforma: ${report.platform}`);
        lines.push(`Claude CLI: ${version}`);
        lines.push(`Projeto: ${ctx.project.name} · codeDir=${ctx.project.codeDir}`);
        lines.push(`Sessão: ${ctx.project.sessionId || '(nova)'}`);
        lines.push('');
        for (const item of report.items) {
          const mark = item.ok ? 'OK' : (item.required ? 'FAIL' : 'warn');
          lines.push(`  [${mark.padEnd(4)}] ${item.label}` + (item.version ? ` (${item.version})` : ''));
          if (!item.ok && item.hint) lines.push(`         → ${item.hint}`);
        }
        const blockers = report.items.filter((i) => i.required && !i.ok);
        if (blockers.length > 0) {
          lines.push('');
          lines.push(`${blockers.length} blocker(s) — abra Requirements pra resolver.`);
        }
        ctx.pushSystem(lines.join('\n'));
      } catch (e: any) {
        ctx.pushSystem(`Erro no doctor: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'agents': {
      try {
        const agents = await window.maestrus.claude.listAgents(ctx.project.id);
        if (agents.length === 0) {
          ctx.pushSystem('Nenhum subagente encontrado em ~/.claude/agents/ ou .claude/agents/ do projeto.');
        } else {
          const lines = ['Subagentes disponíveis:', ''];
          for (const a of agents) {
            lines.push(`  [${a.scope}] ${a.name}`);
            if (a.description) lines.push(`           ${a.description}`);
          }
          ctx.pushSystem(lines.join('\n'));
        }
      } catch (e: any) {
        ctx.pushSystem(`Erro ao listar agentes: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'memory': {
      try {
        const mem = await window.maestrus.claude.listMemories();
        if (mem.length === 0) {
          ctx.pushSystem('Nenhuma memória em ~/.claude/memory/.');
        } else {
          const lines = ['Memórias salvas:', ''];
          for (const m of mem) {
            lines.push(`  [${m.type || '?'}] ${m.name}`);
            if (m.description) lines.push(`         ${m.description}`);
          }
          ctx.pushSystem(lines.join('\n'));
        }
      } catch (e: any) {
        ctx.pushSystem(`Erro ao listar memórias: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'logout': {
      const ok = confirm('Encerrar sessão do Claude Code? Você vai precisar logar de novo.');
      if (!ok) return { handled: true };
      try {
        const r = await window.maestrus.claude.logout();
        ctx.pushSystem(`Logout exit=${r.code}\n${r.output || ''}`.trim());
      } catch (e: any) {
        ctx.pushSystem(`Erro no logout: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'bug': {
      await window.maestrus.shell.openExternal('https://github.com/anthropics/claude-code/issues');
      ctx.pushSystem('Abrindo issues no GitHub.');
      return { handled: true };
    }

    case 'release-notes':
    case 'changelog': {
      await window.maestrus.shell.openExternal('https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md');
      ctx.pushSystem('Abrindo changelog no GitHub.');
      return { handled: true };
    }

    case 'team': {
      try {
        const projects = await window.maestrus.projects.list();
        const lines = ['Time disponível pra orquestrar:', ''];
        for (const p of projects) {
          const tag = p.id === MAESTRUS_ID ? '🎼 ' : '   ';
          const sess = p.sessionId ? ` · session ${p.sessionId.slice(0, 8)}` : '';
          lines.push(`${tag}[${p.id}] ${p.name} · model=${p.model || 'sonnet'}${sess}`);
        }
        lines.push('');
        lines.push('Use: /ask <id-ou-nome> <prompt>  ou  /parallel <id1>,<id2> <prompt>');
        ctx.pushSystem(lines.join('\n'));
      } catch (e: any) {
        ctx.pushSystem(`Erro listando time: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'ask': {
      if (ctx.project.id !== MAESTRUS_ID) {
        ctx.pushSystem(`/ask só funciona dentro do Maestrus (este projeto é "${ctx.project.name}").`);
        return { handled: true };
      }
      const parts = arg.split(/\s+/);
      const target = parts.shift();
      const prompt = parts.join(' ').trim();
      if (!target || !prompt) {
        ctx.pushSystem('Uso: /ask <projeto-id-ou-nome> <prompt>');
        return { handled: true };
      }
      try {
        const projects = await window.maestrus.projects.list();
        const t = projects.find((p) => p.id === target || p.name.toLowerCase() === target.toLowerCase());
        if (!t) {
          ctx.pushSystem(`Projeto não encontrado: "${target}". Use /team pra listar.`);
          return { handled: true };
        }
        if (t.id === MAESTRUS_ID) {
          ctx.pushSystem('Não dá pra Maestrus pedir pra ele mesmo. Tente outro projeto.');
          return { handled: true };
        }
        ctx.pushSystem(`▶ Dispatching pra "${t.name}" (${t.id})…\n   prompt: ${prompt}`);
        const t0 = Date.now();
        const res = await window.maestrus.claude.dispatch(t.id, prompt);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        ctx.pushSystem(
          `◀ Resposta de "${t.name}" em ${dt}s:\n\n${res.text || '(sem texto)'}`
        );
        // Reinjeta como mensagem do user no Maestrus pra entrar no contexto da próxima turn
        if (ctx.dispatchSeed) {
          ctx.dispatchSeed(`[orquestração] Acabei de consultar o projeto "${t.name}" com: "${prompt}"\n\nResposta dele:\n\n${res.text}\n\n(Use isso como contexto pro próximo passo.)`);
        }
      } catch (e: any) {
        ctx.pushSystem(`Erro no dispatch: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'parallel': {
      if (ctx.project.id !== MAESTRUS_ID) {
        ctx.pushSystem(`/parallel só funciona dentro do Maestrus.`);
        return { handled: true };
      }
      const match = arg.match(/^([^\s]+)\s+([\s\S]+)$/);
      if (!match) {
        ctx.pushSystem('Uso: /parallel <id1>,<id2>,<id3> <prompt>');
        return { handled: true };
      }
      const targetsCsv = match[1];
      const prompt = match[2].trim();
      const ids = targetsCsv.split(',').map((s) => s.trim()).filter(Boolean);
      try {
        const projects = await window.maestrus.projects.list();
        const targets = ids.map((id) => projects.find((p) => p.id === id || p.name.toLowerCase() === id.toLowerCase())).filter(Boolean) as typeof projects;
        if (targets.length === 0) {
          ctx.pushSystem('Nenhum projeto válido na lista.');
          return { handled: true };
        }
        ctx.pushSystem(`▶ Dispatching em paralelo pra ${targets.length} projeto(s)…`);
        const t0 = Date.now();
        const results = await Promise.all(targets.map(async (t) => {
          try {
            const res = await window.maestrus.claude.dispatch(t.id, prompt);
            return { name: t.name, text: res.text, ok: true as const };
          } catch (e: any) {
            return { name: t.name, text: e?.message || String(e), ok: false as const };
          }
        }));
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const summary = results.map((r) => {
          const tag = r.ok ? '✓' : '✗';
          return `${tag} ${r.name}:\n${r.text}\n`;
        }).join('\n---\n\n');
        ctx.pushSystem(`◀ Paralelo concluído em ${dt}s\n\n${summary}`);
        if (ctx.dispatchSeed) {
          const seed = [
            `[orquestração paralela] Consultei ${targets.length} projetos com:`,
            `"${prompt}"\n`,
            ...results.map((r) => `--- ${r.name} ${r.ok ? '(ok)' : '(erro)'} ---\n${r.text}`),
            '',
            '(Sintetize esses retornos.)',
          ].join('\n');
          ctx.dispatchSeed(seed);
        }
      } catch (e: any) {
        ctx.pushSystem(`Erro no parallel: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'task': {
      if (ctx.project.id !== MAESTRUS_ID) {
        ctx.pushSystem(`/task só funciona dentro do Maestrus (este projeto é "${ctx.project.name}").`);
        return { handled: true };
      }
      // Sintaxe: /task <projeto> [--loop N] <prompt>
      const loopM = arg.match(/--loop\s+(\d+)\s*/i);
      let maxIter = 1;
      let rest = arg;
      if (loopM) {
        maxIter = Math.min(25, Math.max(2, parseInt(loopM[1], 10)));
        rest = arg.replace(loopM[0], ' ').replace(/\s+/g, ' ').trim();
      }
      const tParts = rest.trim().split(/\s+/);
      const tTarget = tParts.shift() || '';
      const tPrompt = tParts.join(' ').trim();
      if (!tTarget || !tPrompt) {
        ctx.pushSystem(
          'Uso: /task <projeto> [--loop N] <prompt>\n' +
          '  Exemplos:\n' +
          '    /task meu-site Adicione testes de regressão\n' +
          '    /task api --loop 5 Implemente e garanta que todos os testes passem\n' +
          '\n' +
          'A task é enfileirada no Kanban e executada de forma assíncrona.\n' +
          'O resultado volta aqui quando concluir. Use /team para listar projetos.'
        );
        return { handled: true };
      }
      try {
        const tProjects = await window.maestrus.projects.list();
        const tProj = tProjects.find((p) => p.id === tTarget || p.name.toLowerCase() === tTarget.toLowerCase());
        if (!tProj) {
          ctx.pushSystem(`Projeto não encontrado: "${tTarget}". Use /team pra listar.`);
          return { handled: true };
        }
        if (tProj.id === MAESTRUS_ID) {
          ctx.pushSystem('Não dá pra enfileirar task no próprio Maestrus. Escolha um projeto-alvo.');
          return { handled: true };
        }
        const taskTitle = tPrompt.slice(0, 120);
        const taskDesc = maxIter > 1 ? `[LOOP:${maxIter}]\n${tPrompt}` : tPrompt;
        const cr = await window.maestrus.tasks.create({
          title: taskTitle,
          description: taskDesc,
          project_id: tProj.id,
          status: 'ready',
        });
        if (!cr.ok) throw new Error(cr.error || 'create_failed');
        const loopInfo = maxIter > 1 ? ` · loop automático até ${maxIter}x` : '';
        ctx.pushSystem(
          `▶ Task enfileirada no Kanban:\n` +
          `   Projeto: ${tProj.name}\n` +
          `   Tarefa: "${taskTitle}"${loopInfo}\n\n` +
          `O agente vai executar assim que a fila liberar. O resultado aparecerá aqui quando concluir.`
        );
      } catch (e: any) {
        ctx.pushSystem(`Erro ao criar task: ${e?.message || e}`);
      }
      return { handled: true };
    }

    case 'mcp': {
      if (ctx.openMcp) ctx.openMcp();
      else ctx.pushSystem('Use o ícone "mcp" na sidebar pra gerenciar servers.');
      return { handled: true };
    }

    case 'settings':
    case 'config': {
      if (ctx.openSettings) ctx.openSettings();
      else ctx.pushSystem('Use o ícone de configurações na sidebar.');
      return { handled: true };
    }

    case 'requirements': {
      if (ctx.openRequirements) ctx.openRequirements();
      else ctx.pushSystem('Use o ícone de requisitos na sidebar.');
      return { handled: true };
    }

    case 'exit':
    case 'quit': {
      window.close();
      return { handled: true };
    }

    default: {
      if (REPL_ONLY.has(cmd)) {
        ctx.pushSystem(`/${cmd} só funciona no REPL interativo do Claude Code, não no modo headless usado pelo Maestrus. Rode \`claude\` no terminal pra usar.`);
        return { handled: true };
      }
      if (PASSTHROUGH_COMMANDS.has(cmd)) return { handled: false };
      return { handled: false };
    }
  }
}

export function makeSystemMessage(text: string): ChatMessage {
  return { role: 'system', text, timestamp: Date.now() };
}
