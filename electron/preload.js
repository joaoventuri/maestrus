const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__maestrus_electron', true);

contextBridge.exposeInMainWorld('maestrus', {
  platform: process.platform,
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onMaximizeChange: (handler) => {
      const fn = (_e, isMax) => handler(isMax);
      ipcRenderer.on('win:maximized', fn);
      return () => ipcRenderer.removeListener('win:maximized', fn);
    },
  },
  requirements: {
    check: () => ipcRenderer.invoke('requirements:check'),
    install: (id) => ipcRenderer.invoke('requirements:install', { id }),
    onInstallLog: (handler) => {
      const fn = (_e, payload) => handler(payload);
      ipcRenderer.on('requirements:install:log', fn);
      return () => ipcRenderer.removeListener('requirements:install:log', fn);
    },
  },
  app: {
    notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
    config: () => ipcRenderer.invoke('app:config'),
    showWindow: () => ipcRenderer.invoke('app:showWindow'),
    getGraphicsCompat: () => ipcRenderer.invoke('app:getGraphicsCompat'),
    setGraphicsCompat: (enabled) => ipcRenderer.invoke('app:setGraphicsCompat', { enabled }),
    getHostAlways: () => ipcRenderer.invoke('app:getHostAlways'),
    setHostAlways: (on) => ipcRenderer.invoke('app:setHostAlways', on),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    listBrowserBackends: () => ipcRenderer.invoke('app:listBrowserBackends'),
    setBrowserBackend: (id) => ipcRenderer.invoke('app:setBrowserBackend', { id }),
    getCloudSettings: () => ipcRenderer.invoke('app:getCloudSettings'),
    setCloudSetting: (key, value) => ipcRenderer.invoke('app:setCloudSetting', { key, value }),
    getMode: () => ipcRenderer.invoke('app:getMode'),
    setMode: (mode, host) => ipcRenderer.invoke('app:setMode', { mode, host }),
    entitlement: () => ipcRenderer.invoke('app:entitlement'),
  },
  claudeAuth: {
    status: () => ipcRenderer.invoke('claude:authStatus'),
    login: (opts) => ipcRenderer.invoke('claude:authLogin', opts || {}),
    submitCode: (code) => ipcRenderer.invoke('claude:authSubmitCode', { code }),
    cancel: () => ipcRenderer.invoke('claude:authCancel'),
    onLog: (handler) => {
      const fn = (_e, payload) => handler(payload);
      ipcRenderer.on('claude:auth:log', fn);
      return () => ipcRenderer.removeListener('claude:auth:log', fn);
    },
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onEvent: (handler) => {
      const channels = ['update:available', 'update:none', 'update:error', 'update:progress', 'update:downloaded'];
      const subs = channels.map((ch) => {
        const fn = (_e, payload) => handler(ch, payload);
        ipcRenderer.on(ch, fn);
        return () => ipcRenderer.removeListener(ch, fn);
      });
      return () => subs.forEach((u) => u());
    },
    // ASAR patch updates: substitui só o app.asar (preserva permissões do OS).
    asarCheck: () => ipcRenderer.invoke('asarUpdate:check'),
    asarDownload: () => ipcRenderer.invoke('asarUpdate:download'),
    asarApply: () => ipcRenderer.invoke('asarUpdate:apply'),
    onAsarEvent: (handler) => {
      const channels = ['asar-update:available', 'asar-update:progress', 'asar-update:downloaded', 'asar-update:error'];
      const subs = channels.map((ch) => {
        const fn = (_e, payload) => handler(ch, payload);
        ipcRenderer.on(ch, fn);
        return () => ipcRenderer.removeListener(ch, fn);
      });
      return () => subs.forEach((u) => u());
    },
  },
  files: {
    // Sobe um anexo pro host do projeto (remote/shared). Local = no-op.
    uploadToHost: (projectId, att) => ipcRenderer.invoke('files:uploadToHost', { projectId, path: att && att.path, name: att && att.name, dataB64: att && att.dataB64 }),
  },
  claudeProfiles: {
    list: () => ipcRenderer.invoke('claudeProfiles:list'),
    create: (name) => ipcRenderer.invoke('claudeProfiles:create', { name }),
    remove: (id) => ipcRenderer.invoke('claudeProfiles:remove', { id }),
    setActive: (id) => ipcRenderer.invoke('claudeProfiles:setActive', { id }),
    status: (id) => ipcRenderer.invoke('claudeProfiles:status', { id }),
    loginStart: (id) => ipcRenderer.invoke('claudeProfiles:loginStart', { id }),
    loginState: () => ipcRenderer.invoke('claudeProfiles:loginState'),
    loginCode: (code) => ipcRenderer.invoke('claudeProfiles:loginCode', { code }),
    loginCancel: () => ipcRenderer.invoke('claudeProfiles:loginCancel'),
  },
  openaiKey: {
    has: () => ipcRenderer.invoke('openaiKey:has'),
    set: (key) => ipcRenderer.invoke('openaiKey:set', { key }),
    delete: () => ipcRenderer.invoke('openaiKey:delete'),
    refresh: () => ipcRenderer.invoke('openaiKey:refresh'),
  },
  anthropicKey: {
    has: () => ipcRenderer.invoke('anthropicKey:has'),
    set: (key) => ipcRenderer.invoke('anthropicKey:set', { key }),
    delete: () => ipcRenderer.invoke('anthropicKey:delete'),
    refresh: () => ipcRenderer.invoke('anthropicKey:refresh'),
  },
  realtime: {
    start: (opts) => ipcRenderer.invoke('realtime:start', opts),
    stop: () => ipcRenderer.invoke('realtime:stop'),
    status: () => ipcRenderer.invoke('realtime:status'),
    appendAudio: (b64) => ipcRenderer.invoke('realtime:appendAudio', b64),
    commitAudio: () => ipcRenderer.invoke('realtime:commitAudio'),
    cancelResponse: () => ipcRenderer.invoke('realtime:cancelResponse'),
    sendText: (text) => ipcRenderer.invoke('realtime:sendText', text),
    setProject: (pid) => ipcRenderer.invoke('realtime:setProject', pid),
    onEvent: (handler) => {
      const channels = ['realtime:status', 'realtime:event', 'realtime:audio', 'realtime:transcript'];
      const subs = channels.map((ch) => {
        const fn = (_e, payload) => handler(ch, payload);
        ipcRenderer.on(ch, fn);
        return () => ipcRenderer.removeListener(ch, fn);
      });
      return () => subs.forEach((u) => u());
    },
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    get: (id) => ipcRenderer.invoke('projects:get', id),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    import: (path) => ipcRenderer.invoke('projects:import', path),
    patch: (id, patch) => ipcRenderer.invoke('projects:patch', { id, patch }),
    delete: (id) => ipcRenderer.invoke('projects:delete', id),
    exportConfig: (id) => ipcRenderer.invoke('projects:exportConfig', id),
    // Disparado pelo sync engine quando o manifesto (lock/sessionId/etc) muda
    // por mexida em outra máquina. UI re-lista projetos pra refletir lock vivo.
    onChanged: (handler) => {
      const fn = () => handler();
      ipcRenderer.on('projects:changed', fn);
      return () => ipcRenderer.removeListener('projects:changed', fn);
    },
  },
  starter: {
    get: () => ipcRenderer.invoke('starter:get'),
    saveBat: (content) => ipcRenderer.invoke('starter:saveBat', content),
    setWake: (opts) => ipcRenderer.invoke('starter:setWake', opts),
    run: () => ipcRenderer.invoke('starter:run'),
    // main pede pro renderer abrir o modo voz (após o bat com marcador).
    onOpenVoice: (handler) => {
      const fn = () => handler();
      ipcRenderer.on('starter:openVoice', fn);
      return () => ipcRenderer.removeListener('starter:openVoice', fn);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    get: (name) => ipcRenderer.invoke('mcp:get', name),
    add: (input) => ipcRenderer.invoke('mcp:add', input),
    remove: (name, scope) => ipcRenderer.invoke('mcp:remove', { name, scope }),
    // Biblioteca de conectores (curado + busca na registry + remoto), vault cifrado.
    catalog: () => ipcRenderer.invoke('mcplib:catalog'),
    search: (query, cursor) => ipcRenderer.invoke('mcplib:search', { query, cursor }),
    setAuth: (id, values) => ipcRenderer.invoke('mcplib:setAuth', { id, values }),
    enable: (id) => ipcRenderer.invoke('mcplib:enable', { id }),
    disable: (id) => ipcRenderer.invoke('mcplib:disable', { id }),
    removeAuth: (id) => ipcRenderer.invoke('mcplib:removeAuth', { id }),
    install: (descriptor, values) => ipcRenderer.invoke('mcplib:install', { descriptor, values }),
    uninstall: (id) => ipcRenderer.invoke('mcplib:uninstall', { id }),
  },
  claudePowers: {
    agentsList: () => ipcRenderer.invoke('claudePowers:agentsList'),
    agentsGet: (id) => ipcRenderer.invoke('claudePowers:agentsGet', { id }),
    agentsSave: (def) => ipcRenderer.invoke('claudePowers:agentsSave', def),
    agentsDelete: (id) => ipcRenderer.invoke('claudePowers:agentsDelete', { id }),
    commandsList: () => ipcRenderer.invoke('claudePowers:commandsList'),
    commandsGet: (id) => ipcRenderer.invoke('claudePowers:commandsGet', { id }),
    commandsSave: (def) => ipcRenderer.invoke('claudePowers:commandsSave', def),
    commandsDelete: (id) => ipcRenderer.invoke('claudePowers:commandsDelete', { id }),
    globalMdGet: () => ipcRenderer.invoke('claudePowers:globalMdGet'),
    globalMdSet: (content) => ipcRenderer.invoke('claudePowers:globalMdSet', { content }),
    mcpList: () => ipcRenderer.invoke('claudePowers:mcpList'),
    mcpRemove: (name) => ipcRenderer.invoke('claudePowers:mcpRemove', { name }),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (id) => ipcRenderer.invoke('skills:get', { id }),
    save: (def) => ipcRenderer.invoke('skills:save', def),
    delete: (id) => ipcRenderer.invoke('skills:delete', { id }),
  },
  claudeMd: {
    read: (projectId) => ipcRenderer.invoke('claudeMd:read', projectId),
    write: (projectId, content) => ipcRenderer.invoke('claudeMd:write', { projectId, content }),
    ensure: (projectId) => ipcRenderer.invoke('claudeMd:ensure', projectId),
  },
  claude: {
    send: (projectId, message) => ipcRenderer.invoke('claude:send', { projectId, message }),
    stop: (projectId) => ipcRenderer.invoke('claude:stop', projectId),
    loadHistory: (projectId) => ipcRenderer.invoke('claude:loadHistory', projectId),
    usage: (opts) => ipcRenderer.invoke('claude:usage', opts || {}),
    version: () => ipcRenderer.invoke('claude:version'),
    logout: () => ipcRenderer.invoke('claude:logout'),
    listAgents: (projectId) => ipcRenderer.invoke('claude:listAgents', projectId),
    listMemories: () => ipcRenderer.invoke('claude:listMemories'),
    dispatch: (targetId, prompt, opts) => ipcRenderer.invoke('claude:dispatch', { targetId, prompt, timeoutMs: opts?.timeoutMs }),
    compact: (projectId, opts) => ipcRenderer.invoke('claude:compact', { projectId, focus: opts?.focus }),
    compactRestore: (projectId) => ipcRenderer.invoke('claude:compactRestore', { projectId }),
    onEvent: (handler) => {
      const sub = (_e, payload) => handler(payload);
      ipcRenderer.on('claude:event', sub);
      return () => ipcRenderer.removeListener('claude:event', sub);
    },
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', filters),
  },
  shell: {
    openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  browser: {
    // o main pede pra abrir o painel do navegador embutido (ex.: MCP browser_navigate)
    onOpen: (handler) => {
      const fn = (_e, payload) => handler(payload || {});
      ipcRenderer.on('browser:open', fn);
      return () => ipcRenderer.removeListener('browser:open', fn);
    },
  },
  cloud: {
    account: () => ipcRenderer.invoke('cloud:account'),
    login: (email, password) => ipcRenderer.invoke('cloud:login', { email, password }),
    validate: () => ipcRenderer.invoke('cloud:validate'),
    logout: () => ipcRenderer.invoke('cloud:logout'),
    checkUpdate: () => ipcRenderer.invoke('cloud:checkUpdate'),
    sync: () => ipcRenderer.invoke('cloud:sync'),
    syncState: () => ipcRenderer.invoke('cloud:syncState'),
    syncProject: (id) => ipcRenderer.invoke('cloud:syncProject', id),
    openPanel: () => ipcRenderer.invoke('cloud:openPanel'),
    getSyncInterval: () => ipcRenderer.invoke('cloud:getSyncInterval'),
    setSyncInterval: (sec) => ipcRenderer.invoke('cloud:setSyncInterval', sec),
    aiStatus: () => ipcRenderer.invoke('cloud:aiStatus'),
    listSessions: () => ipcRenderer.invoke('claude:listSessions'),
    importSession: (s) => ipcRenderer.invoke('claude:importSession', s),
    // Maestrus on Cloud (runtime na nuvem por projeto)
    cloudList: () => ipcRenderer.invoke('cloud:cloudList'),
    cloudStart: (projectId, autoSetup) => ipcRenderer.invoke('cloud:cloudStart', { projectId, autoSetup }),
    cloudStop: (projectId) => ipcRenderer.invoke('cloud:cloudStop', { projectId }),
    cloudPause: (projectId) => ipcRenderer.invoke('cloud:cloudPause', { projectId }),
    cloudResume: (projectId) => ipcRenderer.invoke('cloud:cloudResume', { projectId }),
    openCloud: (deviceId, name) => ipcRenderer.invoke('cloud:openCloud', { deviceId, name }),
    devices: () => ipcRenderer.invoke('cloud:devices'),
    deviceDelete: (deviceId) => ipcRenderer.invoke('cloud:deviceDelete', deviceId),
    containerStatus: () => ipcRenderer.invoke('cloud:containerStatus'),
    containerProvision: () => ipcRenderer.invoke('cloud:containerProvision'),
    containerConnect: () => ipcRenderer.invoke('cloud:containerConnect'),
  },
  tasks: {
    list:        ()          => ipcRenderer.invoke('tasks:list'),
    create:      (t)         => ipcRenderer.invoke('tasks:create', t),
    update:      (id, patch) => ipcRenderer.invoke('tasks:update', { id, patch }),
    delete:      (id)        => ipcRenderer.invoke('tasks:delete', id),
    reorder:     (moves)     => ipcRenderer.invoke('tasks:reorder', moves),
    settingsGet: ()          => ipcRenderer.invoke('tasks:settingsGet'),
    settingsSet: (s)         => ipcRenderer.invoke('tasks:settingsSet', s),
    newId:       ()          => ipcRenderer.invoke('tasks:newId'),
    onChanged:   (handler)   => {
      const fn = (_e, payload) => handler(payload);
      ipcRenderer.on('tasks:changed', fn);
      return () => ipcRenderer.removeListener('tasks:changed', fn);
    },
  },
  // Self-host: conectar o desktop num servidor Maestrus próprio (URL + secret).
  selfhost: {
    connect: (url, secret) => ipcRenderer.invoke('selfhost:connect', { url, secret }),
    info: () => ipcRenderer.invoke('selfhost:info'),
    reconnect: () => ipcRenderer.invoke('selfhost:reconnect'),
    forget: () => ipcRenderer.invoke('selfhost:forget'),
  },
  remote: {
    hostState: () => ipcRenderer.invoke('remote:hostState'),
    hostEnable: () => ipcRenderer.invoke('remote:hostEnable'),
    hostDisable: () => ipcRenderer.invoke('remote:hostDisable'),
    pairCreate: () => ipcRenderer.invoke('remote:pairCreate'),
    onHostState: (handler) => {
      const fn = (_e, s) => handler(s);
      ipcRenderer.on('remote:hostState', fn);
      return () => ipcRenderer.removeListener('remote:hostState', fn);
    },
    connect: (code) => ipcRenderer.invoke('remote:connect', code),
    reconnect: () => ipcRenderer.invoke('remote:reconnect'),
    discover: () => ipcRenderer.invoke('remote:discover'),
    getDiscovery: () => ipcRenderer.invoke('remote:getDiscovery'),
    setDiscovery: (enabled) => ipcRenderer.invoke('remote:setDiscovery', enabled),
    hosts: () => ipcRenderer.invoke('remote:hosts'),
    disconnect: () => ipcRenderer.invoke('remote:disconnect'),
    clientState: () => ipcRenderer.invoke('remote:clientState'),
    refreshProjects: () => ipcRenderer.invoke('remote:refreshProjects'),
    onClientState: (handler) => {
      const fn = (_e, s) => handler(s);
      ipcRenderer.on('remote:clientState', fn);
      return () => ipcRenderer.removeListener('remote:clientState', fn);
    },
  },
  ssh: {
    available: () => ipcRenderer.invoke('ssh:available'),
    test: (ssh, secret) => ipcRenderer.invoke('ssh:test', { ssh, secret }),
    listDir: (ssh, secret, path) => ipcRenderer.invoke('ssh:listDir', { ssh, secret, path }),
    listKeys: () => ipcRenderer.invoke('ssh:listKeys'),
    createProject: (name, ssh, secret) => ipcRenderer.invoke('ssh:createProject', { name, ssh, secret }),
    pull: (projectId) => ipcRenderer.invoke('ssh:pull', projectId),
    status: (projectId) => ipcRenderer.invoke('ssh:status', projectId),
    saveCreds: (projectId, secret) => ipcRenderer.invoke('ssh:saveCreds', { projectId, secret }),
  },
});
