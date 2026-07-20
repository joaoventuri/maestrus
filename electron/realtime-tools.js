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
let tasksStore = null; try { tasksStore = require('./tasks-store'); } catch {}
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
function resolveProject(idOrName) {
  if (!idOrName) return null;
  const all = projectStore.list();
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
      const list = projectStore.list().map((p) => ({
        id: p.id, name: p.name, source: p.source,
        engine: p.engine || 'claude',
        remote: !!p.remoteHostId,
        shared: !!p.shareId,
      }));
      return { projects: list, count: list.length };
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
        return { dispatched: true, project: p.name, mode: 'shared' };
      }
      if (remoteClient && (remoteClient.isRemote && remoteClient.isRemote(p.id))) {
        await remoteClient.send(p.id, prompt);
        return { dispatched: true, project: p.name, mode: 'remote' };
      }
      await claudePty.send(p, prompt);
      return { dispatched: true, project: p.name, mode: 'local' };
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
