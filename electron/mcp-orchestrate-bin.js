#!/usr/bin/env node
// MCP server stdio mínimo (JSON-RPC 2.0 + protocolo MCP) que faz proxy pra
// HTTP server do Maestrus. Lê CLAUI_ORCHESTRATE_URL e CLAUI_ORCHESTRATE_TOKEN
// (o app injeta no env do `claude` spawnado pro projeto maestrus).
//
// Tools expostas pro Claude usar dentro do Maestrus:
//   - claui_list_projects
//   - claui_dispatch
//   - claui_dispatch_parallel
//
// Não usa SDK MCP — implementa só o subset necessário (initialize, tools/list,
// tools/call) sobre stdio com line-delimited JSON-RPC.

const readline = require('readline');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const URL_ENV = process.env.CLAUI_ORCHESTRATE_URL || process.env.MAESTRUS_ORCHESTRATE_URL;
const TOKEN_ENV = process.env.CLAUI_ORCHESTRATE_TOKEN || process.env.MAESTRUS_ORCHESTRATE_TOKEN;

if (!URL_ENV || !TOKEN_ENV) {
  process.stderr.write('[maestrus-orchestrate-mcp] missing CLAUI_ORCHESTRATE_URL or CLAUI_ORCHESTRATE_TOKEN env\n');
  process.exit(1);
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'maestrus-orchestrate', version: '0.2.0' };

// Tools de orquestração: só aparecem no projeto Maestrus (orquestrador).
const IS_ORCHESTRATOR = process.env.MAESTRUS_IS_ORCHESTRATOR === '1';

// Navegador embutido (igual a um MCP de Chrome): dirige o <webview> do painel
// de preview. Disponível em todos os projetos.
const BROWSER_TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Abre uma URL no navegador embutido do Maestrus (painel à direita, visível pro usuário). Retorna url e título da página.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL (https:// é assumido se faltar)' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'browser_read',
    description: 'Lê o texto visível da página atual (innerText), truncado. Use pra entender o conteúdo antes de agir.',
    inputSchema: { type: 'object', properties: { max: { type: 'integer', description: 'máx. de caracteres (default 12000)' } }, additionalProperties: false },
  },
  {
    name: 'browser_snapshot',
    description: 'Lista os elementos interativos da página (links, botões, inputs) com um "ref" estável. Use o ref pra clicar/digitar com browser_click / browser_type.',
    inputSchema: { type: 'object', properties: { max: { type: 'integer' } }, additionalProperties: false },
  },
  {
    name: 'browser_click',
    description: 'Clica num elemento. Informe "ref" (de browser_snapshot) OU "selector" (CSS).',
    inputSchema: { type: 'object', properties: { ref: { type: 'integer' }, selector: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'browser_type',
    description: 'Digita texto num campo (input/textarea/contenteditable). Informe ref OU selector + text. submit=true envia o formulário.',
    inputSchema: { type: 'object', properties: { ref: { type: 'integer' }, selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'browser_screenshot',
    description: 'Tira um screenshot da página atual e retorna a imagem.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_current',
    description: 'Retorna a url e o título da página atual.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_back',
    description: 'Volta uma página no histórico do navegador embutido.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_forward',
    description: 'Avança uma página no histórico.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_reload',
    description: 'Recarrega a página atual.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_eval',
    description: 'Executa JavaScript na página e retorna o resultado (JSON). Use pra extrair dados específicos.',
    inputSchema: { type: 'object', properties: { js: { type: 'string', description: 'expressão JS (pode ser async)' } }, required: ['js'], additionalProperties: false },
  },
  {
    name: 'browser_wait',
    description: 'Espera N milissegundos (ex.: deixar a página carregar após uma ação).',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } }, additionalProperties: false },
  },
];

const ORCH_TOOLS = [
  {
    name: 'claui_list_projects',
    description: 'Lista todos os projetos do Maestrus (com id, nome, modelo, codeDir e as sub-conversas/forks de cada um, com id e título) — exceto o próprio Maestrus. Os títulos das conversas dizem do que cada fork trata: use-os pra decidir pra qual conversa direcionar um prompt.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'claui_dispatch',
    description: 'Delega um prompt a um projeto (que tem contexto profundo do próprio código). Por padrão é ASSÍNCRONO (fire-and-forget): dispara e volta NA HORA — o projeto roda em segundo plano e a resposta dele aparece no chat DELE (não aqui). Use isso pra delegar e SEGUIR conversando/disparando sem travar. Use wait:true só quando você PRECISA da resposta agora pra encadear (ex: pegar a saída de A pra montar o prompt de B). Funciona pra projetos locais, cloud e remotos (cloud liga sozinho). Não dispare pra "maestrus". Com "conversation" você direciona o prompt pra uma SUB-CONVERSA (fork) específica do projeto — escolha pelo título (claui_list_projects mostra as conversas de cada projeto).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'ID do projeto-alvo (use claui_list_projects). Aceita também o nome exato.' },
        prompt: { type: 'string', description: 'O prompt a enviar. Formule auto-contido: "dado o módulo X, qual o estado de Y?"' },
        conversation: { type: 'string', description: 'Opcional: id ou TÍTULO da sub-conversa (fork) do projeto que deve receber o prompt. Sem isso, vai pra conversa principal.' },
        wait: { type: 'boolean', description: 'false (default) = assíncrono, volta na hora. true = espera a resposta completa (pra encadear).' },
        timeout_ms: { type: 'integer', description: 'Só com wait:true. Timeout em ms (default 300000 = 5min).' },
      },
      required: ['project_id', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'claui_dispatch_parallel',
    description: 'Dispara o MESMO prompt em vários projetos de uma vez. Por padrão ASSÍNCRONO (cada um roda em segundo plano; respostas vão pros chats deles) → ideal pra "manda isso pra todos e segue". wait:true espera todas as respostas e retorna juntas (pra comparar perspectivas).',
    inputSchema: {
      type: 'object',
      properties: {
        project_ids: { type: 'array', items: { type: 'string' }, description: 'IDs (ou nomes) dos projetos-alvo.' },
        prompt: { type: 'string' },
        wait: { type: 'boolean', description: 'false (default) = assíncrono. true = espera todas e retorna juntas.' },
        timeout_ms: { type: 'integer' },
      },
      required: ['project_ids', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'claui_enqueue_task',
    description: 'Enfileira uma tarefa no Kanban de um projeto (em vez de disparar direto). O worker do Kanban executa em segundo plano — UMA por projeto por vez — e GUARDA a resposta, que você colhe depois com claui_check_results. Use isto pra delegar SEM travar: enfileire várias, siga conversando/enfileirando, e cheque os resultados quando quiser. Devolve o task_id (guarde-o pra checar depois). Prefira isto a claui_dispatch quando o trabalho pode demorar e você não quer esperar.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'ID (ou nome exato) do projeto-alvo. Use claui_list_projects.' },
        prompt: { type: 'string', description: 'O que o projeto deve fazer. Formule auto-contido.' },
        title: { type: 'string', description: 'Título curto pro card do Kanban (opcional; default = início do prompt).' },
        max_iterations: { type: 'integer', description: 'Goal loop: se > 1, o projeto ITERA até cumprir o objetivo (realimentando o resultado a cada volta) ou até este teto. Ele declara conclusão escrevendo TASK_COMPLETE. Default 1 (uma passada). Use pra trabalho que precisa convergir (ex.: "implemente e faça os testes passarem", max 8).' },
      },
      required: ['project_id', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'claui_check_results',
    description: 'Colhe os resultados das tarefas enfileiradas (claui_enqueue_task) que já terminaram — sem travar. Passe os task_ids que você enfileirou (recomendado) ou nada pra ver todas. Retorna as concluídas/falhas com o texto da resposta e as que ainda estão rodando (pending). Chame quando quiser saber como foram; não bloqueia nada.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: { type: 'array', items: { type: 'string' }, description: 'IDs das tarefas a checar (os que claui_enqueue_task devolveu). Vazio = todas.' },
      },
      additionalProperties: false,
    },
  },
];

// Controle do computador do usuário (estilo JARVIS): ver a tela, clicar,
// digitar, atalhos. Só no orquestrador (o "JARVIS" do Maestrus).
const COMPUTER_TOOLS = [
  {
    name: 'computer_open',
    description: 'ABRE um programa, site ou arquivo DIRETO (jeito certo de "abrir X"). Ex: computer_open({target:"Mobirise"}) abre o app Mobirise; {target:"https://youtube.com"} abre no navegador; {target:"spotify:playlist:ID"} toca a playlist; {target:"C:\\\\caminho\\\\arquivo.pdf"} abre o arquivo. NÃO simule teclado (Win/Win+R) pra abrir programas — use SEMPRE esta tool, que lança o processo direto (sem depender de foco de janela).',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'Nome do programa, URL, URI de protocolo, ou caminho do arquivo.' } }, required: ['target'], additionalProperties: false },
  },
  {
    name: 'computer_list_windows',
    description: 'Lista as janelas ABERTAS agora (app + título). Use pra descobrir o que já está aberto antes de focar/agir — ex: achar a janela do Notepad/Chrome que o usuário já tem aberta.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'computer_focus',
    description: 'Traz uma janela JÁ ABERTA pra frente (foco), por título ou nome do app. É o passo CERTO pra "navegar numa janela existente": foque-a ANTES de computer_screenshot/click/type (que sempre agem na janela em foco). Ex: computer_focus({target:"Sem título - Notepad"}) ou {target:"notepad"}. NÃO use computer_open pra isso (abriria uma instância nova vazia).',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'Parte do título da janela ou nome do app.' } }, required: ['target'], additionalProperties: false },
  },
  {
    name: 'computer_uia_tree',
    description: '(Windows) Lista os elementos da interface de uma janela PELO NOME e tipo (Button, Edit, MenuItem, CheckBox…) com a posição central. É o jeito CONFIÁVEL de saber o que clicar — em vez de adivinhar coordenadas. window: título/app da janela (vazio = janela em foco). Depois use computer_click_element/set_value com o nome exato.',
    inputSchema: { type: 'object', properties: { window: { type: 'string', description: 'Título ou app da janela. Vazio = janela em foco.' } }, additionalProperties: false },
  },
  {
    name: 'computer_click_element',
    description: '(Windows) Clica num elemento da interface PELO NOME (clique de verdade via UIAutomation, robusto — não depende de coordenada). Ex: computer_click_element({window:"Notepad", name:"Salvar"}). Rode computer_uia_tree antes pra ver os nomes disponíveis.',
    inputSchema: { type: 'object', properties: { window: { type: 'string' }, name: { type: 'string', description: 'Nome do elemento (botão/menu/campo).' } }, required: ['name'], additionalProperties: false },
  },
  {
    name: 'computer_set_value',
    description: '(Windows) Preenche um campo PELO NOME com um texto (UIAutomation; substitui o conteúdo). Ex: computer_set_value({window:"Chrome", name:"Address and search bar", text:"youtube.com"}). name vazio = primeiro campo de edição da janela.',
    inputSchema: { type: 'object', properties: { window: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'computer_get_text',
    description: '(Windows) LÊ o conteúdo de texto de uma janela (campos de edição/documento). Resolve "lê o que tá escrito no meu Notepad". window: título/app (vazio = em foco).',
    inputSchema: { type: 'object', properties: { window: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'computer_screenshot',
    description: 'Captura a tela do usuário (todos os monitores) e retorna a imagem. Use pra VER o que está acontecendo na máquina antes de agir.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'computer_click',
    description: 'Clica numa coordenada da tela (x, y em pixels). Dê um computer_screenshot antes pra saber onde clicar. button: "left" (default) ou "right".',
    inputSchema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right'] } }, required: ['x', 'y'], additionalProperties: false },
  },
  {
    name: 'computer_type',
    description: 'Digita um texto na janela/campo em foco (como se o usuário digitasse).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'computer_key',
    description: 'Aperta uma tecla ou atalho. Ex: "enter", "esc", "tab", "ctrl+c", "alt+tab", "ctrl+shift+t".',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
  },
];

// Browser nativo só quando o backend é "maestrus" (env MAESTRUS_BROWSER_NATIVE).
// Quando o usuário escolhe um navegador real, o Playwright MCP provê as tools
// de browser — aí desligamos as nativas pra não colidir os nomes.
const BROWSER_NATIVE = process.env.MAESTRUS_BROWSER_NATIVE !== '0';
const BROWSERS = BROWSER_NATIVE ? BROWSER_TOOLS : [];

// O que o Claude vê: navegador (se nativo) + controle de PC em TODOS os
// projetos (pra a voz JARVIS ser poderosa). Orquestração (dispatch) só no Maestrus.
const TOOLS = IS_ORCHESTRATOR
  ? [...ORCH_TOOLS, ...COMPUTER_TOOLS, ...BROWSERS]
  : [...COMPUTER_TOOLS, ...BROWSERS];

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(URL_ENV);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path,
      headers: {
        authorization: `Bearer ${TOKEN_ENV}`,
        accept: 'application/json',
      },
    };
    if (body !== undefined) {
      const payload = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(payload);
      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`HTTP ${res.statusCode}: ${parsed ? parsed.error || data : data}`));
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    } else {
      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`HTTP ${res.statusCode}: ${parsed ? parsed.error || data : data}`));
        });
      });
      req.on('error', reject);
      req.end();
    }
  });
}

const BROWSER_OP = {
  browser_navigate: 'navigate', browser_read: 'read', browser_snapshot: 'snapshot',
  browser_click: 'click', browser_type: 'type', browser_screenshot: 'screenshot',
  browser_current: 'current', browser_back: 'back', browser_forward: 'forward',
  browser_reload: 'reload', browser_eval: 'eval', browser_wait: 'wait',
};

const COMPUTER_OP = {
  computer_open: 'open', computer_list_windows: 'list_windows', computer_focus: 'focus',
  computer_uia_tree: 'uia_tree', computer_click_element: 'click_element',
  computer_set_value: 'set_value', computer_get_text: 'get_text',
  computer_screenshot: 'screenshot', computer_click: 'click',
  computer_type: 'type', computer_key: 'key',
};

async function callTool(name, args) {
  if (BROWSER_OP[name]) {
    const res = await httpRequest('POST', '/browser', { op: BROWSER_OP[name], ...args });
    if (!res || res.ok === false) {
      return { content: [{ type: 'text', text: `(erro browser) ${(res && res.error) || 'falha'}` }], isError: true };
    }
    if (name === 'browser_screenshot' && res.base64) {
      return { content: [{ type: 'image', data: res.base64, mimeType: 'image/png' }] };
    }
    const { ok, ...rest } = res;
    return { content: [{ type: 'text', text: JSON.stringify(rest, null, 2) }] };
  }
  if (COMPUTER_OP[name]) {
    const res = await httpRequest('POST', '/computer', { op: COMPUTER_OP[name], ...args });
    if (!res || res.ok === false) {
      return { content: [{ type: 'text', text: `(erro computer) ${(res && res.error) || 'falha'}` }], isError: true };
    }
    if (name === 'computer_screenshot' && res.base64) {
      return { content: [{ type: 'image', data: res.base64, mimeType: 'image/png' }] };
    }
    const { ok, base64, ...rest } = res;
    return { content: [{ type: 'text', text: JSON.stringify(rest, null, 2) }] };
  }
  if (name === 'claui_list_projects') {
    const res = await httpRequest('GET', '/projects');
    const visible = (res.projects || []).filter((p) => !p.isMaestrus);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(visible, null, 2),
        },
      ],
    };
  }
  if (name === 'claui_dispatch') {
    const res = await httpRequest('POST', '/dispatch', {
      project_id: args.project_id,
      prompt: args.prompt,
      conversation: args.conversation || undefined,
      wait: args.wait === true,
      timeout_ms: args.timeout_ms,
    });
    if (!res.ok) {
      return { content: [{ type: 'text', text: `(erro) ${res.error || 'falha desconhecida'}` }], isError: true };
    }
    // async: confirma o disparo (a resposta vai pro chat do projeto). wait: traz o texto.
    const text = res.dispatched
      ? `✓ Disparado para "${res.project_name}" (rodando em segundo plano; a resposta aparece no chat do projeto).`
      : `[resposta de ${res.project_name}]\n\n${res.text || '(sem texto)'}`;
    return { content: [{ type: 'text', text }] };
  }
  if (name === 'claui_dispatch_parallel') {
    const ids = Array.isArray(args.project_ids) ? args.project_ids : [];
    const wait = args.wait === true;
    const results = await Promise.all(
      ids.map(async (pid) => {
        try {
          const r = await httpRequest('POST', '/dispatch', {
            project_id: pid,
            prompt: args.prompt,
            wait,
            timeout_ms: args.timeout_ms,
          });
          return { project: pid, ok: !!r.ok, dispatched: r.dispatched, text: r.text, name: r.project_name, error: r.error };
        } catch (e) {
          return { project: pid, ok: false, error: e.message };
        }
      })
    );
    const formatted = results.map((r) => {
      const tag = r.ok ? '✓' : '✗';
      const name = r.name || r.project;
      if (r.ok && r.dispatched) return `✓ ${name} — disparado (roda em segundo plano; resposta no chat do projeto)`;
      return `--- ${tag} ${name} ---\n${r.ok ? (r.text || '(sem texto)') : `ERRO: ${r.error}`}`;
    }).join('\n\n');
    return {
      content: [{ type: 'text', text: formatted }],
      isError: results.every((r) => !r.ok),
    };
  }
  if (name === 'claui_enqueue_task') {
    const res = await httpRequest('POST', '/enqueue', {
      project_id: args.project_id,
      prompt: args.prompt,
      title: args.title,
      max_iterations: args.max_iterations,
    });
    if (!res || !res.ok) {
      return { content: [{ type: 'text', text: `(erro) ${(res && res.error) || 'falha ao enfileirar'}` }], isError: true };
    }
    const loopMsg = res.loop ? ` 🔁 em loop até cumprir (máx ${res.loop} iterações)` : '';
    return { content: [{ type: 'text', text: `✓ Enfileirado no Kanban de "${res.project_name}" (task_id: ${res.task_id})${loopMsg}. Roda em segundo plano; colha depois com claui_check_results.` }] };
  }
  if (name === 'claui_check_results') {
    const res = await httpRequest('POST', '/results', {
      task_ids: Array.isArray(args.task_ids) && args.task_ids.length ? args.task_ids : undefined,
    });
    if (!res || !res.ok) {
      return { content: [{ type: 'text', text: `(erro) ${(res && res.error) || 'falha ao colher resultados'}` }], isError: true };
    }
    const done = res.results || [];
    const pending = res.pending || [];
    if (!done.length && !pending.length) {
      return { content: [{ type: 'text', text: 'Nenhuma tarefa enfileirada encontrada.' }] };
    }
    const doneStr = done
      .map((t) => `--- ${t.status === 'done' ? '✓' : '✗'} ${t.title} (${t.project_id}) ---\n${t.result || '(sem texto)'}`)
      .join('\n\n');
    const pendStr = pending.length
      ? `\n\n⏳ Ainda rodando: ${pending.map((t) => `${t.title} [${t.status}]`).join(', ')}`
      : '';
    return { content: [{ type: 'text', text: (doneStr || '(nenhuma concluída ainda)') + pendStr }] };
  }
  throw new Error(`unknown tool: ${name}`);
}

// ─── JSON-RPC loop ──────────────────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        return sendResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'notifications/initialized':
        return; // notification, no response
      case 'tools/list':
        return sendResult(id, { tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (!name) return sendError(id, -32602, 'missing tool name');
        try {
          const result = await callTool(name, args || {});
          return sendResult(id, result);
        } catch (e) {
          return sendResult(id, {
            content: [{ type: 'text', text: `(tool error) ${e.message || e}` }],
            isError: true,
          });
        }
      }
      case 'ping':
        return sendResult(id, {});
      default:
        if (id != null) sendError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id != null) sendError(id, -32603, `internal: ${e.message || e}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) {
    process.stderr.write(`[maestrus-orchestrate-mcp] invalid json: ${e.message}\n`);
    return;
  }
  handle(msg);
});

rl.on('close', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
