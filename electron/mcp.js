const { spawn } = require('child_process');

function findClaudeBin() {
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}

function buildEnv() {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    const sys = 'C:\\Windows\\System32';
    const currentPath = env.PATH || env.Path || '';
    if (!currentPath.toLowerCase().startsWith(sys.toLowerCase())) {
      env.PATH = `${sys};C:\\Windows;C:\\Windows\\System32\\Wbem;${currentPath}`;
    }
  }
  return env;
}

function runClaude(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(findClaudeBin(), args, {
      shell: process.platform === 'win32',
      env: buildEnv(),
      cwd: opts.cwd,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `claude exit ${code}`));
    });
    proc.on('error', reject);
  });
}

function parseMcpList(stdout) {
  const lines = stdout.split(/\r?\n/);
  const servers = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Pula linhas de cabeçalho/status do CLI ("Checking MCP server health…").
    if (!/:\s/.test(trimmed)) continue;
    // Formato: "<nome com espaços>: <comando-ou-url> [- <status>]".
    // O nome vai até o primeiro ": " (dois-pontos + espaço); URLs usam "://"
    // (sem espaço) então não confundem o split.
    const m = trimmed.match(/^(.+?):\s+(\S.*?)(?:\s+-\s+(.+))?$/);
    if (m) {
      const [, name, command, status] = m;
      servers.push({
        name: name.trim(),
        command: command.trim(),
        status: (status || '').trim() || 'unknown',
        raw: trimmed,
      });
    }
  }
  return servers;
}

async function list() {
  try {
    const { stdout } = await runClaude(['mcp', 'list']);
    return { ok: true, servers: parseMcpList(stdout), raw: stdout };
  } catch (e) {
    return { ok: false, error: e.message, servers: [] };
  }
}

async function get(name) {
  try {
    const { stdout } = await runClaude(['mcp', 'get', name]);
    return { ok: true, raw: stdout };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function add({ name, command, scope, transport, env }) {
  const args = ['mcp', 'add'];
  if (scope) args.push('--scope', scope);
  if (transport) args.push('--transport', transport);
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      args.push('--env', `${k}=${v}`);
    }
  }
  args.push(name);
  if (command) {
    const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    for (const p of parts) args.push(p.replace(/^"|"$/g, ''));
  }
  try {
    const { stdout } = await runClaude(args);
    return { ok: true, raw: stdout };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function remove(name, scope) {
  const args = ['mcp', 'remove'];
  if (scope) args.push('--scope', scope);
  args.push(name);
  try {
    const { stdout } = await runClaude(args);
    return { ok: true, raw: stdout };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { list, get, add, remove };
