'use strict';
// ─── Driver LOCAL (Docker no próprio server) ────────────────────────────────
// Cada projeto cloud = 1 container Docker no host, numa REDE ISOLADA da matriz
// (DB/relay/backend). Egress liberado (rede do host) → o runner alcança o relay.
// Sem provedor terceiro, sem ban, sem tier. Imagem base enxuta (node+git+claude
// + runner já dentro) → start ~1s. Volume por projeto persiste código/sessão
// entre pause/resume. Limites de RAM/CPU por container (leve).
//
// O orquestrador fala com o Docker do host via /var/run/docker.sock (montado).

const Docker = require('dockerode');
const tar = require('tar-stream');           // vem com o dockerode (tar-fs)
const zlib = require('zlib');
const { Readable } = require('stream');
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const IMAGE = process.env.SANDBOX_IMAGE || 'maestrus-sandbox:base';
const NETWORK = process.env.SANDBOX_NETWORK || 'maestrus-sandboxes';
const PUBLIC_HOST = process.env.SANDBOX_PUBLIC_HOST || 'maestrus.cloud';
const MEM = Math.round(Number(process.env.SANDBOX_MEM_MB || 768) * 1024 * 1024);
const NANO_CPUS = Math.round(Number(process.env.SANDBOX_CPUS || 0.75) * 1e9);
const PREVIEW_PORT = 3000;
const HOME = '/home/user';
const WORKDIR = '/home/user/workspace';

const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
const cname = (pid) => 'maestrus-sb-' + safe(pid);
const cvol = (pid) => 'maestrus-vol-' + safe(pid);

function setupPrompt() {
  return [
    'Você está num sandbox Linux com o código deste projeto em ' + WORKDIR + '.',
    'Faça autônomo: instale deps e suba o app escutando em 0.0.0.0:' + PREVIEW_PORT + ' (pro preview); confirme em 1 linha.',
    'Se não for app web, instale e rode testes/build e diga o estado.',
  ].join('\n');
}

function envArr(opts, withSetup) {
  const { relay = {}, anthropic = {}, project = {} } = opts;
  const e = {
    RELAY_URL: relay.url, RELAY_TOKEN: relay.token, DEVICE_ID: relay.deviceId,
    PROJECT_ID: project.id, PROJECT_NAME: project.name || project.id,
    WORKDIR, HOME, MODEL: project.model || '', PREVIEW_PORT: String(PREVIEW_PORT),
    // O container roda como root; o claude recusa --dangerously-skip-permissions
    // (= bypassPermissions) como root, exceto com IS_SANDBOX=1 (escape oficial
    // p/ ambientes isolados — e este É um sandbox isolado, descartável).
    IS_SANDBOX: '1',
  };
  if (project.sessionId) e.RESUME_SESSION_ID = project.sessionId;
  if (opts.orchestrator) e.MAESTRUS_IS_ORCHESTRATOR = '1'; // maestro: ganha o MCP de dispatch
  if (withSetup && opts.autoSetup) e.SETUP_PROMPT = setupPrompt();
  if (anthropic.baseUrl) e.ANTHROPIC_BASE_URL = anthropic.baseUrl;
  if (anthropic.token) e.ANTHROPIC_AUTH_TOKEN = anthropic.token;
  if (anthropic.apiKey) e.ANTHROPIC_API_KEY = anthropic.apiKey;
  if (opts.refreshUrl && opts.licenseKey) { e.REFRESH_URL = opts.refreshUrl; e.LICENSE_KEY = opts.licenseKey; }
  if (opts.repoUrl) e.REPO_URL = opts.repoUrl;
  if (Array.isArray(opts.skills) && opts.skills.length) e.SKILLS_JSON = JSON.stringify(opts.skills);
  if (opts.mcpServers && Object.keys(opts.mcpServers).length) e.MCP_JSON = JSON.stringify({ mcpServers: opts.mcpServers });
  return Object.entries(e).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`);
}

// ─── Injeção de CÓDIGO + SESSÃO + MEMÓRIA (paridade com E2B/Daytona) ─────────
// Constrói UM tar (rooted em /home/user) e injeta via putArchive ANTES de o
// container iniciar — sem corrida com o runner/setup. Conteúdo:
//   workspace/<código da pasta local>   (de codeTarGz, .tar.gz já pronto)
//   .claude/projects/-home-user-workspace/<sessionId>.jsonl  (continua a sessão)
//   .maestrus/memory.json               (memória RAG)
function buildInjectTar({ codeTarGz, sessionJsonl, sessionId, memoryJson }) {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks = [];
    pack.on('data', (c) => chunks.push(c));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
    const extras = () => {
      try {
        if (sessionJsonl && sessionId) pack.entry({ name: `.claude/projects/-home-user-workspace/${sessionId}.jsonl` }, sessionJsonl);
        if (memoryJson) pack.entry({ name: '.maestrus/memory.json' }, memoryJson);
      } catch (e) { return reject(e); }
      pack.finalize();
    };
    if (codeTarGz) {
      const buf = Buffer.isBuffer(codeTarGz) ? codeTarGz : Buffer.from(codeTarGz, 'base64');
      const extract = tar.extract();
      extract.on('entry', (header, stream, next) => {
        const rel = header.name.replace(/^\.?\/*/, '');
        if (!rel || rel === './') { stream.resume(); return next(); }
        const out = pack.entry({ name: 'workspace/' + rel, type: header.type, mode: header.mode, mtime: header.mtime, size: header.size, linkname: header.linkname }, next);
        stream.pipe(out);
      });
      extract.on('finish', extras);
      extract.on('error', reject);
      Readable.from(buf).pipe(zlib.createGunzip()).pipe(extract);
    } else {
      pack.entry({ name: 'workspace/', type: 'directory' });
      extras();
    }
  });
}

async function removeByName(name) { try { await docker.getContainer(name).remove({ force: true }); } catch {} }
function previewFrom(info) {
  try { const p = info.NetworkSettings.Ports['3000/tcp']; if (p && p[0] && p[0].HostPort) return `http://${PUBLIC_HOST}:${p[0].HostPort}`; } catch {}
  return null;
}

async function startLocal(opts, withSetup = true) {
  const { project = {}, relay = {} } = opts;
  const name = cname(project.id);
  await removeByName(name); // idempotente
  const c = await docker.createContainer({
    Image: IMAGE, name,
    Env: envArr(opts, withSetup),
    ExposedPorts: { '3000/tcp': {} },
    Labels: { 'maestrus.sandbox': '1', 'maestrus.project': String(project.id || '') },
    HostConfig: {
      Memory: MEM, NanoCpus: NANO_CPUS, PidsLimit: 512,
      NetworkMode: NETWORK,
      Binds: [`${cvol(project.id)}:/home/user`],
      PortBindings: { '3000/tcp': [{ HostPort: '' }] }, // porta aleatória no host
      RestartPolicy: { Name: 'no' },
      SecurityOpt: ['no-new-privileges'],
    },
  });
  // Injeta código/sessão/memória ANTES do start (no volume, sem corrida com o
  // runner). Só no start fresh — no resume o volume já tem tudo.
  if (opts.codeTarGz || (opts.sessionJsonl && project.sessionId) || opts.memoryJson) {
    try {
      const buf = await buildInjectTar({ codeTarGz: opts.codeTarGz, sessionJsonl: opts.sessionJsonl, sessionId: project.sessionId, memoryJson: opts.memoryJson });
      await c.putArchive(buf, { path: HOME });
    } catch (e) { console.error('[local] putArchive (code/session)', e && e.message); }
  }
  await c.start();
  let previewUrl = null; try { previewUrl = previewFrom(await c.inspect()); } catch {}
  return { sandboxId: c.id, deviceId: relay.deviceId, previewUrl, previewPort: PREVIEW_PORT };
}

async function resumeLocal(opts) {
  const { project = {} } = opts;
  const name = cname(project.id);
  try {
    const c = docker.getContainer(name); const info = await c.inspect();
    if (info.State && info.State.Running) return { ok: true, fresh: false, sandboxId: info.Id, previewUrl: previewFrom(info) };
  } catch {}
  // parado/inexistente → recria fresh (o VOLUME persiste código + sessão). Token
  // fresco no env (sem token velho). Não re-roda o setup no resume.
  try { const r = await startLocal(opts, false); return { ok: true, fresh: true, sandboxId: r.sandboxId, previewUrl: r.previewUrl }; }
  catch (e) { return { ok: false, error: 'fresh_start_failed: ' + (e && e.message) }; }
}

// Estado REAL dos containers (ground truth) — 1 listContainers (barato, socket
// local) e mapeia por nome. O backend usa isso pra status fiel, sem depender só
// do heartbeat (que tem janela de 90s). Aceita {projectIds:[...]} ou {project}.
async function statusLocal(opts) {
  const ids = Array.isArray(opts.projectIds) ? opts.projectIds
            : (opts.project && opts.project.id ? [opts.project.id] : []);
  const out = {};
  try {
    const list = await docker.listContainers({ all: true, filters: { label: ['maestrus.sandbox=1'] } });
    const state = new Map();
    for (const c of list) for (const n of (c.Names || [])) state.set(n.replace(/^\//, ''), c.State);
    for (const pid of ids) { const st = state.get(cname(pid)); out[pid] = st === 'running' ? 'running' : 'stopped'; }
  } catch (e) { /* erro de socket → deixa vazio (backend cai no heartbeat) */ }
  return { ok: true, statuses: out };
}

async function stopLocal(opts) {
  const id = opts.sandboxId || cname(opts.project && opts.project.id);
  try { await docker.getContainer(id).stop({ t: 5 }); return { ok: true }; }
  catch (e) { return { ok: false, error: e && e.message }; }
}
async function pauseLocal(opts) { return stopLocal(opts); } // stop = scale-to-zero (CPU 0; volume fica)
// Exclusão DEFINITIVA: remove o container E o volume (código+sessão somem). Só no
// delete explícito — pause/stop preservam o volume.
async function deleteLocal(opts) {
  const pid = (opts.project && opts.project.id) || opts.projectId;
  try { await docker.getContainer(cname(pid)).remove({ force: true }); } catch {}
  try { await docker.getVolume(cvol(pid)).remove({ force: true }); } catch {}
  return { ok: true };
}
async function getPreviewLocal(opts) {
  const id = opts.sandboxId || cname(opts.project && opts.project.id);
  return previewFrom(await docker.getContainer(id).inspect());
}

module.exports = { startLocal, resumeLocal, stopLocal, pauseLocal, deleteLocal, getPreviewLocal, statusLocal, PREVIEW_PORT };
