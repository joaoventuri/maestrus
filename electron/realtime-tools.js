'use strict';
// Ferramentas expostas pra OpenAI Realtime API via function calling. Cada tool é
// uma async function (args, ctx) → result. O `ctx.projectId` é o projeto ativo
// na UI no momento da chamada (default pra dispatch).
//
// Princípios:
//   - Mantenha as descrições CONCISAS — elas viram tokens no system prompt da
//     Realtime e custam dinheiro a cada turno.
//   - Result deve ser JSON-serializável e amigável pra falar (a Realtime vai
//     usar o output pra compor a resposta de voz).

const projectStore = require('./project-store');
const claudePty = require('./claude-pty');

let mcpCatalog = null; try { mcpCatalog = require('./mcp-catalog'); } catch {}
// O arquivo é task-store (singular). Com o nome errado o require caía no catch
// silencioso e as três tools de kanban respondiam 'tasks_unavailable' pra
// sempre — falhando de um jeito que parecia intencional.
let tasksStore = null; try { tasksStore = require('./task-store'); } catch {}
let remoteClient = null; try { remoteClient = require('./remote-client'); } catch {}
let cloud = null; try { cloud = require('./cloud'); } catch {}

// ─── Definições (formato JSON Schema da OpenAI Realtime) ────────────────────
function definitions() {
  return [
    {
      type: 'function',
      name: 'list_projects',
      description: 'Lista os projetos do usuário no Maestrus (locais, github, cloud, remotos e compartilhados).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'read_conversation',
      description: 'Lê as últimas mensagens de uma conversa/projeto. USE ANTES de despachar: se a resposta já está no histórico, responda direto em vez de gastar um turno novo do agente.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'ID do projeto. Omita para a conversa ativa.' },
          limit: { type: 'number', description: 'Quantas mensagens recentes (padrão 20, máx 60).' },
        },
      },
    },
    {
      type: 'function',
      name: 'work_status',
      description: 'Diz se o agente de um projeto AINDA está trabalhando. Consulte antes de afirmar que algo terminou ou que não houve resposta.',
      parameters: {
        type: 'object',
        properties: { project_id: { type: 'string', description: 'ID do projeto. Omita para a conversa ativa.' } },
      },
    },
    {
      type: 'function',
      name: 'dispatch_project',
      description: 'Envia um prompt pra Claude Code rodar em um projeto específico. Use isso pra executar tarefas de código, refactorings, debugs, builds.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'ID do projeto (ou nome aproximado — se faltar, lista os projetos primeiro com list_projects).' },
          prompt: { type: 'string', description: 'O prompt completo pra Claude executar no projeto.' },
        },
        required: ['project_id', 'prompt'],
      },
    },
    {
      type: 'function',
      name: 'list_tasks',
      description: 'Lista as tarefas do kanban do usuário (todo/in_progress/done).',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'all'], description: 'Filtro por status. Default: all.' } },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'create_task',
      description: 'Cria uma nova tarefa no kanban.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          project_id: { type: 'string', description: 'Opcional: associa a um projeto.' },
        },
        required: ['title'],
      },
    },
    {
      type: 'function',
      name: 'complete_task',
      description: 'Marca uma tarefa como concluída.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    {
      type: 'function',
      name: 'list_mcps',
      description: 'Lista os servidores MCP habilitados (e suas tools disponíveis, se conhecidas).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'call_mcp_tool',
      description: 'Invoca uma tool específica de um MCP do usuário. Use list_mcps primeiro pra ver os disponíveis.',
      parameters: {
        type: 'object',
        properties: {
          server_id: { type: 'string' },
          tool: { type: 'string' },
          input: { type: 'object', additionalProperties: true },
        },
        required: ['server_id', 'tool'],
      },
    },
  ];
}

// Resolve um projeto pelo id exato OU por nome aproximado (case-insensitive).
/** Todos os projetos visíveis: locais + do host conectado + compartilhados. */
function allProjects() {
  const merged = new Map();
  for (const p of projectStore.list()) merged.set(p.id, p);
  try { for (const p of (remoteClient?.listProjects?.() || [])) merged.set(p.id, p); } catch {}
  try { for (const p of (remoteClient?.listSharedProjects?.() || [])) merged.set(p.id, p); } catch {}
  return [...merged.values()].filter(Boolean);
}

function resolveProject(idOrName) {
  if (!idOrName) return null;
  // Inclui remotos e compartilhados: sem isso, pedir "manda no atlas-erp" (que
  // mora no host) não resolvia e a voz respondia project_not_found.
  const all = allProjects();
  let p = all.find((x) => x.id === idOrName);
  if (p) return p;
  const q = String(idOrName).toLowerCase();
  p = all.find((x) => String(x.name || '').toLowerCase() === q);
  if (p) return p;
  p = all.find((x) => String(x.name || '').toLowerCase().includes(q));
  return p || null;
}

async function run(name, args, ctx) {
  switch (name) {
    case 'list_projects': {
      // Só projectStore.list() = só os LOCAIS. Conectado como client, os
      // projetos que moram no host (e os de workspace compartilhado) ficavam
      // invisíveis pra voz, então ela dizia que não existiam. Mesma união que
      // a sidebar já faz em projects:list.
      const list = allProjects()
        .filter((p) => p.id !== 'starter')
        .map((p) => ({
          id: p.id, name: p.name, source: p.source,
          engine: p.engine || 'claude',
          // Onde o projeto vive — o modelo usa isto pra falar com precisão
          // ("o que roda no seu servidor") em vez de tratar tudo como local.
          location: p.shareId ? 'compartilhado' : (p.remoteHostId ? `host ${p.remoteHostName || ''}`.trim() : 'local'),
          remote: !!p.remoteHostId,
          shared: !!p.shareId,
        }));
      return { projects: list, count: list.length };
    }

    case 'read_conversation': {
      // Sem isto o modelo de voz não enxergava o que já foi conversado e
      // despachava um turno novo pra perguntar algo que já estava respondido.
      const p = resolveProject(args.project_id) || (ctx.projectId ? projectStore.get(ctx.projectId) : null);
      if (!p) return { error: 'project_not_found' };
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 60);
      try {
        const hist = await claudePty.loadHistory(p);
        const msgs = (Array.isArray(hist) ? hist : [])
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
          .slice(-limit)
          .map((m) => ({ role: m.role, text: String(m.text).slice(0, 1500) }));
        return { project: p.name, count: msgs.length, messages: msgs };
      } catch (e) { return { error: String(e && e.message) }; }
    }

    case 'work_status': {
      // O modelo dizia "não veio resposta" com o agente ainda trabalhando.
      // Aqui ele consulta o estado REAL do processo antes de concluir.
      const p = resolveProject(args.project_id) || (ctx.projectId ? projectStore.get(ctx.projectId) : null);
      if (!p) return { error: 'project_not_found' };
      let busy = false;
      try { busy = !!claudePty.isBusy(p.id); } catch {}
      if (!busy) { try { busy = !!require('./codex-pty').isBusy(p.id); } catch {} }
      return {
        project: p.name,
        working: busy,
        hint: busy
          ? 'Ainda trabalhando. NÃO diga que terminou nem que não houve resposta — espere o resultado chegar.'
          : 'Não há trabalho em andamento neste projeto.',
      };
    }

    case 'dispatch_project': {
      const p = resolveProject(args.project_id) || (ctx.projectId ? projectStore.get(ctx.projectId) : null);
      if (!p) return { error: 'project_not_found', hint: 'Call list_projects first.' };
      const prompt = String(args.prompt || '').trim();
      if (!prompt) return { error: 'empty_prompt' };
      // Local: dispara via claude-pty (stream vai pra UI normal do chat).
      // Remoto/shared: roteia via relay.
      if (remoteClient && (remoteClient.isShared && remoteClient.isShared(p.id))) {
        await remoteClient.sendShared(p.id, prompt);
        try { require('./openai-realtime').watchDispatch(p.id, p.name); } catch {}
        return { dispatched: true, project: p.name, mode: 'shared', note: 'Rodando em background — siga a conversa.' };
      }
      if (remoteClient && (remoteClient.isRemote && remoteClient.isRemote(p.id))) {
        await remoteClient.send(p.id, prompt);
        try { require('./openai-realtime').watchDispatch(p.id, p.name); } catch {}
        return { dispatched: true, project: p.name, mode: 'remote', note: 'Rodando em background — siga a conversa.' };
      }
      await claudePty.send(p, prompt);
      // Avisa a sessão de voz pra acompanhar este turno: quando terminar, o
      // resultado volta pra ela RESUMIR em fala (openai-realtime.watchDispatch).
      try { require('./openai-realtime').watchDispatch(p.id, p.name); } catch {}
      return {
        dispatched: true, project: p.name, mode: 'local',
        note: 'Rodando em background. Diga uma linha curta e siga a conversa — o resultado chega depois pra você resumir.',
      };
    }

    case 'list_tasks': {
      if (!tasksStore) return { error: 'tasks_unavailable' };
      try {
        const all = await tasksStore.list();
        const filter = args.status && args.status !== 'all' ? args.status : null;
        const filtered = filter ? all.filter((t) => (t.status || '') === filter) : all;
        return { tasks: filtered.map((t) => ({ id: t.id, title: t.title, status: t.status, project_id: t.project_id || null })), count: filtered.length };
      } catch (e) { return { error: String(e && e.message) }; }
    }

    case 'create_task': {
      if (!tasksStore) return { error: 'tasks_unavailable' };
      try {
        const r = await tasksStore.create({ title: args.title, description: args.description || '', project_id: args.project_id || null });
        return { created: true, task: r };
      } catch (e) { return { error: String(e && e.message) }; }
    }

    case 'complete_task': {
      if (!tasksStore) return { error: 'tasks_unavailable' };
      try {
        await tasksStore.update(args.task_id, { status: 'done' });
        return { completed: true, task_id: args.task_id };
      } catch (e) { return { error: String(e && e.message) }; }
    }

    case 'list_mcps': {
      if (!mcpCatalog) return { error: 'mcp_unavailable' };
      try {
        const list = (mcpCatalog.listEnabled && mcpCatalog.listEnabled()) || [];
        return { servers: list, count: list.length };
      } catch (e) { return { error: String(e && e.message) }; }
    }

    case 'call_mcp_tool': {
      if (!mcpCatalog) return { error: 'mcp_unavailable' };
      try {
        if (!mcpCatalog.callTool) return { error: 'call_not_supported_in_this_build' };
        const r = await mcpCatalog.callTool(args.server_id, args.tool, args.input || {});
        return r;
      } catch (e) { return { error: String(e && e.message) }; }
    }

    default:
      return { error: 'unknown_tool: ' + name };
  }
}

module.exports = { definitions, run };
