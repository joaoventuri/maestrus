export type ProjectSource = 'github' | 'local' | 'production' | 'empty' | 'maestrus';
export type ModelChoice = 'sonnet' | 'opus' | 'haiku' | 'default' | string;
export type ThinkingMode = 'none' | 'low' | 'medium' | 'high';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  remotePath: string;
}

export interface CloudSession {
  project_id: string;
  name: string;
  device_id: string;
  sandbox_id: string | null;
  status: 'starting' | 'running' | 'stopped' | 'error';
  preview_url: string | null;
  preview_port: number;
  updated_at: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  hasBody: boolean;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
}

export interface McpField {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  required?: boolean;
}
export interface McpConnector {
  id: string;
  label: string;
  desc: string;
  docs?: string;
  cat?: string;
  fields: McpField[];
  enabled: boolean;
  configured: boolean;
  kind: 'curated' | 'installed';
  transport?: 'stdio' | 'http' | 'sse';
  requires?: 'node' | 'none' | 'python' | 'docker';
  source?: string;
}
export interface McpSearchItem {
  id: string;
  regName: string;
  label: string;
  description: string;
  version: string;
  transport: 'stdio' | 'http' | 'sse';
  requires: 'node' | 'none' | 'python' | 'docker';
  fields: McpField[];
  command?: string;
  args?: string[];
  url?: string;
  headerTemplates?: { name: string; value: string }[];
  installed: boolean;
}

export interface Project {
  id: string;
  name: string;
  source: ProjectSource;
  repoUrl: string | null;
  localPath: string | null;
  mountPath: string | null;
  sessionId: string | null;
  codeDir: string | null;
  driveDir: string | null;
  sessionDir: string | null;
  ssh?: SshConfig;
  model?: ModelChoice;
  thinkingMode?: ThinkingMode;
  permissionMode?: PermissionMode;
  engine?: 'claude' | 'cloud';
  isPinned?: boolean;
  // Projeto remoto (vive num host de outra máquina, via relay):
  remoteHostId?: string;
  remoteHostName?: string;
  remoteProjectId?: string;
  // Soft-lock cross-device: marca qual máquina está rodando um turno do Claude
  // AGORA. Pushado no manifesto na hora do spawn, liberado no close. Outras
  // máquinas veem e bloqueiam o envio (banner "Rodando em X"). TTL 5 min — se
  // expirar é porque o host crashou; libera automaticamente.
  lock?: { hostId: string; hostName: string; at: number } | null;
  createdAt: number;
  updatedAt: number;
}

export interface SshSecret {
  authType: 'password' | 'key';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface SshDirEntry {
  name: string;
  isDir: boolean;
}

export interface CloudAccount {
  email: string;
  name: string | null;
  licenseKey: string;
  plan: { name: string; quota_bytes: number } | null;
  usedBytes: number;
  capBytes?: number;
  overageCentsPerGb?: number;
  ai?: { enabled: boolean; balance_usd: number; spent_month_usd: number; included_usd?: number; included_remaining_usd?: number };
  loggedAt: number;
}

export interface RemoteHostState {
  running: boolean;
  status: 'idle' | 'connecting' | 'online' | 'offline' | 'error';
  error?: string | null;
}

export interface RemoteClientState {
  connected: boolean;
  status: 'idle' | 'connecting' | 'online' | 'offline' | 'error';
  hostName: string | null;
  hosts?: Array<{ deviceId: string; name: string; os: string }>;
  hostCount?: number;
  syncing?: boolean;
  projectCount?: number;
  lastSyncAt?: number;
}

export interface ClaudeSession {
  sessionId: string;
  name: string;
  cwd: string | null;
  branch: string | null;
  archived: boolean;
  hasTitle: boolean;
  messages: number;
  sizeBytes: number;
  modified: number;
}

export interface RequirementItem {
  id: string;
  label: string;
  required: boolean;
  ok: boolean;
  hint?: string;
  version?: string;
  path?: string;
  found?: string[];
  installable?: boolean;
}

export interface RequirementsReport {
  platform: string;
  items: RequirementItem[];
}

export type ChatRole = 'user' | 'assistant' | 'tool-use' | 'tool-result' | 'thinking' | 'system' | 'error';

export interface ChatMessage {
  role: ChatRole;
  text?: string;
  html?: string;
  name?: string;
  input?: any;
  id?: string;
  toolUseId?: string;
  isError?: boolean;
  timestamp?: number;
  pending?: boolean;
  queued?: boolean;
  compactBoundary?: boolean;   // divisor "contexto ativo recomeça aqui" (/compact)
  questions?: Array<{ question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
}

export interface ClaudeEvent {
  projectId: string;
  type:
    | 'user' | 'assistant-text' | 'tool-use' | 'tool-result'
    | 'thinking' | 'system' | 'delta' | 'result'
    | 'done' | 'error' | 'raw' | 'ask-user-question';
  questions?: Array<{ question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
  text?: string;
  name?: string;
  input?: any;
  id?: string;
  toolUseId?: string;
  isError?: boolean;
  sessionId?: string;
  subtype?: string;
  exitCode?: number;
  timestamp?: number;
  evt?: any;
}

export interface McpServer {
  name: string;
  command: string;
  status: string;
  raw: string;
}

export interface McpListResult {
  ok: boolean;
  servers: McpServer[];
  raw?: string;
  error?: string;
}

export interface McpAddInput {
  name: string;
  command: string;
  scope?: 'local' | 'user' | 'project';
  transport?: 'stdio' | 'sse' | 'http';
  env?: Record<string, string>;
}

export interface ClaudeMdFile {
  exists: boolean;
  path: string | null;
  content: string;
}

export interface UsageSlot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  calls: number;
}

export interface UsageReport {
  scope: 'all' | 'project';
  files: number;
  total: UsageSlot;
  today: UsageSlot;
  last24h: UsageSlot;
  last7d: UsageSlot;
  thisMonth: UsageSlot;
  window5h: UsageSlot & { windowStart: number | null; windowEnd: number | null };
  byModel: Record<string, UsageSlot>;
  firstCallAt: number | null;
  lastCallAt: number | null;
}

export interface AgentDef {
  name: string;
  description: string;
  scope: 'user' | 'project';
  file: string;
}

export interface DispatchResult {
  text: string;
  usage?: any;
  cost?: number | null;
  sessionId?: string | null;
}

export interface MemoryDef {
  name: string;
  description: string;
  type: string;
  file: string;
}

export type TaskStatus = 'backlog' | 'ready' | 'doing' | 'done' | 'failed';

export interface KanbanTask {
  id: string;
  project_id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  position: number;
  result_note?: string | null;
  created_at: number;
  updated_at: number;
  started_at?: number | null;
  finished_at?: number | null;
}

export interface TaskSettings {
  enabled_global: boolean;
  enabled_projects: Record<string, boolean>;
}

declare global {
  interface Window {
    maestrus: {
      platform: string;
      win: {
        minimize: () => Promise<void>;
        maximize: () => Promise<void>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        onMaximizeChange: (handler: (isMax: boolean) => void) => () => void;
      };
      requirements: {
        check: () => Promise<RequirementsReport>;
        install: (id: string) => Promise<{ ok: boolean; manual?: boolean; error?: string }>;
        onInstallLog: (handler: (payload: { id: string; line: string }) => void) => () => void;
      };
      app: {
        notify: (title: string, body: string) => Promise<{ ok: boolean }>;
        config: () => Promise<{ base: string; hostId: string }>;
        showWindow?: () => Promise<{ ok: boolean }>;
        getGraphicsCompat?: () => Promise<{ enabled: boolean }>;
        setGraphicsCompat?: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; needsRestart: boolean }>;
        getHostAlways?: () => Promise<{ enabled: boolean }>;
        setHostAlways?: (on: boolean) => Promise<{ ok: boolean; enabled: boolean }>;
        relaunch?: () => Promise<void>;
        listBrowserBackends?: () => Promise<{ backends: Array<{ id: string; label: string; desc: string; available: boolean; beta: boolean; path?: string }>; current: string }>;
        setBrowserBackend?: (id: string) => Promise<{ ok: boolean; id: string }>;
        getMode?: () => Promise<{ mode: 'server' | 'client' | null; host: { id: string; name: string } | null }>;
        setMode?: (mode: 'server' | 'client', host?: { id: string; name: string } | null) => Promise<{ ok: boolean; mode?: string; error?: string }>;
        entitlement?: () => Promise<{ pro: boolean; remoteFreeRemaining: number | null; remoteFreeLimit: number }>;
      };
      mcp?: {
        // Tela MCP "crua" (claude mcp list/add/remove)
        list: () => Promise<McpListResult>;
        get: (name: string) => Promise<{ ok: boolean; raw?: string; error?: string }>;
        add: (input: McpAddInput) => Promise<{ ok: boolean; raw?: string; error?: string }>;
        remove: (name: string, scope?: string) => Promise<{ ok: boolean; raw?: string; error?: string }>;
        // Biblioteca de conectores (curado + busca na registry + remoto)
        catalog: () => Promise<{ popular: McpConnector[]; installed: McpConnector[]; encAvailable: boolean }>;
        search: (query: string, cursor?: string | null) => Promise<{ ok: boolean; items: McpSearchItem[]; nextCursor: string | null; error?: string }>;
        setAuth: (id: string, values: Record<string, string>) => Promise<{ ok: boolean; configured?: boolean }>;
        enable: (id: string) => Promise<{ ok: boolean }>;
        disable: (id: string) => Promise<{ ok: boolean }>;
        removeAuth: (id: string) => Promise<{ ok: boolean }>;
        install: (descriptor: McpSearchItem | { id?: string; label: string; transport: string; command?: string; args?: string[] | string; url?: string; headerTemplates?: { name: string; value: string }[]; fields?: McpField[]; source?: string }, values?: Record<string, string>) => Promise<{ ok: boolean; id?: string; error?: string }>;
        uninstall: (id: string) => Promise<{ ok: boolean }>;
      };
      claudeAuth: {
        status: () => Promise<{ ok: boolean; loggedIn: boolean; email?: string | null; method?: string | null; plan?: string | null; error?: string }>;
        login: (opts?: { console?: boolean }) => Promise<{ ok: boolean; code?: number; error?: string }>;
        submitCode: (code: string) => Promise<{ ok: boolean; error?: string }>;
        cancel: () => Promise<{ ok: boolean }>;
        onLog: (handler: (payload: { line: string }) => void) => () => void;
      };
      update: {
        check: () => Promise<any>;
        download: () => Promise<any>;
        install: () => Promise<{ ok: boolean }>;
        onEvent: (handler: (channel: string, payload: any) => void) => () => void;
      };
      projects: {
        list: () => Promise<Project[]>;
        get: (id: string) => Promise<Project | null>;
        create: (input: any) => Promise<Project>;
        import: (path: string) => Promise<Project>;
        patch: (id: string, patch: Partial<Project>) => Promise<Project>;
        delete: (id: string) => Promise<boolean>;
        exportConfig: (id: string) => Promise<string | null>;
        onChanged: (handler: () => void) => () => void;
      };
      skills?: {
        list: () => Promise<{ skills: SkillSummary[] }>;
        get: (id: string) => Promise<Skill | null>;
        save: (def: { id?: string; name: string; description: string; body: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
        delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      };
      starter: {
        get: () => Promise<{ project: Project; bat: string; flow: { type: 'action' | 'voice'; label: string }[]; wakePhrase: string; wakeEnabled: boolean }>;
        saveBat: (content: string) => Promise<{ ok: boolean; flow?: { type: 'action' | 'voice'; label: string }[]; error?: string }>;
        setWake: (opts: { phrase?: string; enabled?: boolean }) => Promise<{ ok: boolean; wakePhrase: string; wakeEnabled: boolean }>;
        run: () => Promise<{ ok: boolean; startVoice?: boolean; error?: string }>;
        onOpenVoice: (handler: () => void) => () => void;
      };
      claude: {
        send: (projectId: string, message: string) => Promise<{ ok: boolean }>;
        stop: (projectId: string) => Promise<boolean>;
        loadHistory: (projectId: string) => Promise<ChatMessage[]>;
        usage: (opts?: { scope?: 'all' | 'project'; projectId?: string }) => Promise<UsageReport>;
        version: () => Promise<string>;
        logout: () => Promise<{ code: number; output: string }>;
        listAgents: (projectId?: string) => Promise<AgentDef[]>;
        listMemories: () => Promise<MemoryDef[]>;
        dispatch: (targetId: string, prompt: string, opts?: { timeoutMs?: number }) => Promise<DispatchResult>;
        compact: (projectId: string, opts?: { focus?: string }) => Promise<{ ok: boolean; summary?: string; error?: string }>;
        onEvent: (handler: (evt: ClaudeEvent) => void) => () => void;
      };
      claudeMd: {
        read: (projectId: string) => Promise<ClaudeMdFile>;
        write: (projectId: string, content: string) => Promise<ClaudeMdFile>;
        ensure: (projectId: string) => Promise<ClaudeMdFile>;
      };
      dialog: {
        pickFolder: () => Promise<string | null>;
        pickFile: (filters?: any[]) => Promise<string | null>;
      };
      shell: {
        openFolder: (p: string) => Promise<string>;
        openExternal: (url: string) => Promise<void>;
      };
      browser: {
        onOpen: (handler: (payload: { url?: string }) => void) => () => void;
      };
      cloud: {
        account: () => Promise<CloudAccount | null>;
        login: (email: string, password: string) => Promise<{ ok: boolean; account?: CloudAccount; error?: string; message?: string }>;
        validate: () => Promise<{ ok: boolean; status?: string; account?: CloudAccount }>;
        logout: () => Promise<{ ok: boolean }>;
        checkUpdate: () => Promise<{ ok: boolean; update_available?: boolean; latest?: string; url?: string; notes?: string; mandatory?: boolean }>;
        sync: () => Promise<{ ok: boolean; error?: string; blocked?: string | null }>;
        syncState: () => Promise<{ loggedIn: boolean; states: Record<string, 'synced' | 'unsynced'> }>;
        syncProject: (id: string) => Promise<{ ok: boolean; error?: string; blocked?: string | null }>;
        openPanel: () => Promise<{ ok: boolean }>;
        getSyncInterval: () => Promise<{ sec: number }>;
        setSyncInterval: (sec: number) => Promise<{ ok: boolean; sec: number }>;
        aiStatus: () => Promise<{ ok: boolean; enabled: boolean; price_in_per_mtok?: number; price_out_per_mtok?: number; included_usd?: number; cap_usd?: number; realtime_voice_enabled?: boolean; deepgram_available?: boolean }>;
        listSessions: () => Promise<{ ok: boolean; sessions: ClaudeSession[] }>;
        importSession: (s: { sessionId: string; cwd: string | null; name: string }) => Promise<{ ok: boolean; project?: Project; error?: string }>;
        cloudList: () => Promise<{ ok: boolean; sessions: CloudSession[]; error?: string }>;
        cloudStart: (projectId: string, autoSetup?: boolean) => Promise<{ ok: boolean; device_id?: string; host_name?: string; preview_url?: string; sandbox_id?: string; error?: string }>;
        cloudStop: (projectId: string) => Promise<{ ok: boolean; error?: string }>;
        cloudPause: (projectId: string) => Promise<{ ok: boolean; error?: string }>;
        cloudResume: (projectId: string) => Promise<{ ok: boolean; device_id?: string; preview_url?: string; error?: string }>;
        openCloud: (deviceId: string, name?: string) => Promise<{ ok: boolean; error?: string }>;
        devices: () => Promise<{ ok: boolean; devices: Array<{ device_id: string; device_name: string | null; last_seen: string; online: boolean }> }>;
        deviceDelete?: (deviceId: string) => Promise<{ ok: boolean; error?: string }>;
      };
      remote: {
        hostState: () => Promise<RemoteHostState>;
        hostEnable: () => Promise<{ ok: boolean; error?: string }>;
        hostDisable: () => Promise<{ ok: boolean }>;
        pairCreate: () => Promise<{ ok: boolean; code?: string; ttl?: number; error?: string }>;
        onHostState: (handler: (s: RemoteHostState) => void) => () => void;
        connect: (code: string) => Promise<{ ok: boolean; hostName?: string; error?: string }>;
        reconnect: () => Promise<{ ok: boolean; hostName?: string; error?: string }>;
        discover?: () => Promise<{ ok: boolean; error?: string }>;
        getDiscovery?: () => Promise<{ enabled: boolean }>;
        setDiscovery?: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
        hosts?: () => Promise<{ ok: boolean; hosts?: Array<{ deviceId: string; name: string; os: string }> }>;
        disconnect: () => Promise<{ ok: boolean }>;
        clientState: () => Promise<RemoteClientState>;
        refreshProjects: () => Promise<Project[]>;
        onClientState: (handler: (s: RemoteClientState) => void) => () => void;
      };
      tasks: {
        list: () => Promise<{ ok: boolean; tasks?: KanbanTask[]; error?: string }>;
        create: (t: Partial<KanbanTask>) => Promise<{ ok: boolean; id?: string; error?: string }>;
        update: (id: string, patch: Partial<KanbanTask>) => Promise<{ ok: boolean; error?: string }>;
        delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
        reorder: (moves: Array<{ id: string; status: TaskStatus; position: number }>) => Promise<{ ok: boolean; error?: string }>;
        settingsGet: () => Promise<{ ok: boolean; settings?: TaskSettings; error?: string }>;
        settingsSet: (s: Partial<TaskSettings>) => Promise<{ ok: boolean; error?: string }>;
        newId: () => Promise<string>;
        onChanged: (handler: (payload: { kind: string; taskId?: string; task?: KanbanTask }) => void) => () => void;
      };
      ssh: {
        available: () => Promise<{ ok: boolean }>;
        test: (ssh: Omit<SshConfig, 'remotePath'> & { remotePath?: string }, secret: SshSecret) => Promise<{ ok: boolean; error?: string }>;
        listDir: (ssh: Omit<SshConfig, 'remotePath'> & { remotePath?: string }, secret: SshSecret, path?: string) => Promise<{ ok: boolean; path?: string; entries?: SshDirEntry[]; error?: string }>;
        listKeys: () => Promise<{ keys: string[] }>;
        createProject: (name: string, ssh: SshConfig, secret: SshSecret) => Promise<Project>;
        pull: (projectId: string) => Promise<{ ok: boolean; files?: number; error?: string }>;
        status: (projectId: string) => Promise<{ connected: boolean; isSsh: boolean; hasCreds?: boolean }>;
        saveCreds: (projectId: string, secret: SshSecret) => Promise<{ ok: boolean; error?: string }>;
      };
    };
  }
}
