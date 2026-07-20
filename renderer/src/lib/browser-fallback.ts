import { ChatMessage, ClaudeEvent, Project, RequirementsReport } from '../types';

const LS_PROJECTS = 'maestrus_demo_projects';
const LS_MESSAGES = 'maestrus_demo_messages_';
const LS_ROOT = 'maestrus_demo_root';

const listeners = new Set<(evt: ClaudeEvent) => void>();
function emit(evt: ClaudeEvent) {
  for (const l of listeners) l(evt);
}

function loadProjects(): Project[] {
  try { return JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]'); } catch { return []; }
}
function saveProjects(p: Project[]) {
  localStorage.setItem(LS_PROJECTS, JSON.stringify(p));
}
function loadMsgs(id: string): ChatMessage[] {
  try { return JSON.parse(localStorage.getItem(LS_MESSAGES + id) || '[]'); } catch { return []; }
}
function saveMsgs(id: string, m: ChatMessage[]) {
  localStorage.setItem(LS_MESSAGES + id, JSON.stringify(m));
}

function rid() {
  return Math.random().toString(16).slice(2, 14);
}

function fakeRequirements(): RequirementsReport {
  return {
    platform: 'browser-demo',
    items: [
      { id: 'node', label: 'Node.js 18+', required: true, ok: false, hint: 'Modo demo: instale Node localmente e rode o Electron pra funcionar de verdade.' },
      { id: 'claude', label: 'Claude Code CLI', required: true, ok: false, hint: 'npm install -g @anthropic-ai/claude-code (depois rode no Electron)' },
      { id: 'git', label: 'Git', required: true, ok: false, hint: 'Modo demo: git só funciona no Electron real.' },
      { id: 'sshfs', label: 'SSH Mount (opcional)', required: false, ok: false },
    ],
  };
}

async function simulateAssistant(projectId: string, userText: string) {
  const msgs = loadMsgs(projectId);
  emit({ projectId, type: 'user', text: userText, timestamp: Date.now() });

  const responses = [
    `Você está no **modo demo de navegador** — o Claude Code real não tá conectado.`,
    ``,
    `Pra usar de verdade:`,
    `1. Feche essa aba`,
    `2. Rode \`npm run dev\` no diretório \`maestrus/\` (não só \`dev:renderer\`)`,
    `3. A janela Electron vai abrir com o IPC real conectado`,
    ``,
    `Sua mensagem foi: _"${userText}"_`,
  ].join('\n');

  await new Promise((r) => setTimeout(r, 300));

  for (const chunk of responses.match(/.{1,40}/g) || []) {
    emit({ projectId, type: 'delta', text: chunk, timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
  }

  emit({ projectId, type: 'assistant-text', text: responses, timestamp: Date.now() });

  msgs.push({ role: 'user', text: userText, timestamp: Date.now() });
  msgs.push({ role: 'assistant', text: responses, timestamp: Date.now() });
  saveMsgs(projectId, msgs);

  emit({ projectId, type: 'done', exitCode: 0, timestamp: Date.now() });
}

export function installBrowserFallback() {
  if (window.maestrus) return;

  window.maestrus = {
    requirements: {
      check: async () => fakeRequirements(),
    },
    app: {
      notify: async () => ({ ok: true }),
    },
    update: {
      check: async () => ({}),
      download: async () => ({}),
      install: async () => ({ ok: true }),
      onEvent: () => () => {},
    },
    projects: {
      list: async () => loadProjects(),
      get: async (id) => loadProjects().find((p) => p.id === id) || null,
      patch: async (id, patchData) => {
        const list = loadProjects();
        const idx = list.findIndex((p) => p.id === id);
        if (idx < 0) throw new Error('not found');
        list[idx] = { ...list[idx], ...patchData, updatedAt: Date.now() };
        saveProjects(list);
        return list[idx];
      },
      create: async (input) => {
        const list = loadProjects();
        const now = Date.now();
        const project: Project = {
          id: rid(),
          name: input.name,
          source: input.source,
          repoUrl: input.repoUrl || null,
          localPath: input.localPath || null,
          mountPath: input.mountPath || null,
          sessionId: 'demo-' + rid(),
          codeDir: input.localPath || input.mountPath || `/demo/${input.name}`,
          driveDir: `/demo/maestrus/${input.name}`,
          sessionDir: `/demo/maestrus/${input.name}/session`,
          createdAt: now,
          updatedAt: now,
        };
        list.push(project);
        saveProjects(list);
        return project;
      },
      import: async (configPath) => {
        const list = loadProjects();
        const project: Project = {
          id: rid(),
          name: `imported-${rid().slice(0, 4)}`,
          source: 'github',
          repoUrl: 'https://demo/imported',
          localPath: null,
          mountPath: null,
          sessionId: 'demo-imported',
          codeDir: configPath,
          driveDir: '/demo/imported',
          sessionDir: '/demo/imported/session',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        list.push(project);
        saveProjects(list);
        return project;
      },
      delete: async (id) => {
        saveProjects(loadProjects().filter((p) => p.id !== id));
        localStorage.removeItem(LS_MESSAGES + id);
        return true;
      },
      exportConfig: async (id) => {
        const p = loadProjects().find((x) => x.id === id);
        if (!p) return null;
        const json = JSON.stringify(p, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `maestrus-${p.name}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return `maestrus-${p.name}.json`;
      },
    },
    claude: {
      send: async (projectId, message) => {
        simulateAssistant(projectId, message);
        return { ok: true };
      },
      stop: async () => true,
      loadHistory: async (projectId) => loadMsgs(projectId),
      usage: async () => ({
        scope: 'all',
        files: 0,
        total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 },
        today: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 },
        last24h: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 },
        last7d: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 },
        thisMonth: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 },
        window5h: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0, windowStart: null, windowEnd: null },
        byModel: {},
        firstCallAt: null,
        lastCallAt: null,
      }),
      version: async () => 'demo-browser (sem acesso ao CLI)',
      logout: async () => ({ code: 0, output: 'demo: nada a fazer' }),
      listAgents: async () => [],
      listMemories: async () => [],
      dispatch: async () => ({ text: '(demo: dispatch indisponível sem Electron)', cost: 0, sessionId: null }),
      compact: async () => ({ ok: false, error: 'demo: compact indisponível sem Electron' }),
      onEvent: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
    dialog: {
      pickFolder: async () => {
        const v = prompt('Caminho de pasta (modo demo):', '/demo/folder');
        return v || null;
      },
      pickFile: async () => {
        const v = prompt('Caminho de arquivo (modo demo):', '/demo/config.json');
        return v || null;
      },
    },
    shell: {
      openFolder: async (p) => {
        alert(`Modo demo: abriria ${p}`);
        return p;
      },
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
    cloud: {
      account: async () => null,
      login: async () => ({ ok: false, error: 'demo: cloud indisponível sem Electron' }),
      validate: async () => ({ ok: false }),
      logout: async () => ({ ok: true }),
      checkUpdate: async () => ({ ok: false }),
      sync: async () => ({ ok: false, error: 'demo' }),
      syncState: async () => ({ loggedIn: false, states: {} }),
      syncProject: async () => ({ ok: false, error: 'demo' }),
    },
    ssh: {
      available: async () => ({ ok: false }),
      test: async () => ({ ok: false, error: 'demo: SSH indisponível sem Electron' }),
      listDir: async () => ({ ok: false, error: 'demo: SSH indisponível sem Electron' }),
      listKeys: async () => ({ keys: [] }),
      createProject: async () => { throw new Error('demo: SSH indisponível sem Electron'); },
      pull: async () => ({ ok: false, error: 'demo' }),
      status: async () => ({ connected: false, isSsh: false }),
      saveCreds: async () => ({ ok: false, error: 'demo' }),
    },
    mcp: {
      list: async () => ({ ok: false, servers: [], error: 'MCP indisponível em modo demo' }),
      get: async () => ({ ok: false, error: 'MCP indisponível em modo demo' }),
      add: async () => ({ ok: false, error: 'MCP indisponível em modo demo' }),
      remove: async () => ({ ok: false, error: 'MCP indisponível em modo demo' }),
    },
    claudeMd: {
      read: async (id) => {
        const c = localStorage.getItem(`maestrus_md_${id}`) || '';
        return { exists: !!c, path: '/demo/CLAUDE.md', content: c };
      },
      write: async (id, content) => {
        localStorage.setItem(`maestrus_md_${id}`, content);
        return { exists: true, path: '/demo/CLAUDE.md', content };
      },
      ensure: async (id) => {
        const existing = localStorage.getItem(`maestrus_md_${id}`);
        if (existing) return { exists: true, path: '/demo/CLAUDE.md', content: existing };
        const tpl = `# CLAUDE.md\n\nProjeto demo.`;
        localStorage.setItem(`maestrus_md_${id}`, tpl);
        return { exists: true, path: '/demo/CLAUDE.md', content: tpl };
      },
    },
  };

  console.info('[maestrus] browser fallback ativo — Electron não detectado.');
}

export function isBrowserDemo() {
  return !(window as any).__maestrus_electron;
}
