'use strict';
// ─── Orquestrador do Maestrus on Cloud (backend E2B) ────────────────────────
// Sobe um sandbox (Firecracker microVM, isolado) por projeto cloud rodando o
// runner headless, conectado no relay como "host". O desktop/PWA conecta nesse
// host pelo relay — IGUAL conecta na sua máquina. O runtime vive no sandbox:
// PC desligado não importa.
//
// PROVADO AO VIVO: sandbox → runner → relay status online → cliente fez
// projects.list/ping com sucesso através do relay.
//
// A E2B key fica no servidor (settings.e2b_api_key) — nunca no código.
// Uso: const { startCloudSession } = require('./orchestrator');

const { Sandbox } = require('e2b');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Arquivos enviados pro sandbox (em /home/user, gravável — /app e /workspace
// são root no template base). O runner usa require('../relay/link') relativo.
const FILES = {
  '/home/user/app/relay/link.js': 'relay/link.js',
  '/home/user/app/relay/protocol.js': 'relay/protocol.js',
  '/home/user/app/cloud-runner/runner.js': 'cloud-runner/runner.js',
  '/home/user/app/cloud-runner/package.json': 'cloud-runner/package.json',
};

const PREVIEW_PORT = 3000; // porta padrão exposta pro preview de produção

// Sobe uma sessão cloud. Retorna { sandboxId, deviceId, previewUrl }.
// opts:
//   apiKey                       E2B api key (do settings do backend)
//   project: { id, name, model }
//   relay:   { url, token, deviceId }    (api.php?action=relay_token role=host)
//   anthropic: { baseUrl, token, apiKey } auth do Claude (Maestrus AI ou BYO)
//   repoUrl                      repo a clonar em /home/user/workspace (opcional)
//   codeTarGz (Buffer/base64)    OU código local empacotado (migração de pasta local)
//   sessionJsonl (string)        histórico da sessão local a CONTINUAR na nuvem
//   memoryJson (string)          memória RAG local a levar junto
//   refreshUrl, licenseKey       pra o runner renovar o relay_token
//   previewPort                  porta do app pro preview público (default 3000)
//   timeoutMs                    vida do sandbox (default 1h; Fase 3 = snapshot)
async function startCloudSession(opts) {
  const { apiKey, project, relay, anthropic = {}, repoUrl, codeTarGz, sessionJsonl, memoryJson, timeoutMs = 60 * 60 * 1000 } = opts;
  const previewPort = opts.previewPort || PREVIEW_PORT;
  if (!apiKey) throw new Error('E2B apiKey ausente');
  if (!relay || !relay.url || !relay.token || !relay.deviceId) throw new Error('relay {url,token,deviceId} obrigatório');

  const sbx = await Sandbox.create({ apiKey, timeoutMs });
  try {
    for (const [dest, rel] of Object.entries(FILES)) await sbx.files.write(dest, src(rel));
    await sbx.commands.run('cd /home/user/app/cloud-runner && npm install ws', { timeoutMs: 180000 });
    await sbx.commands.run('npm install -g @anthropic-ai/claude-code', { timeoutMs: 300000 });

    // ─── Migração de RUNTIME/CODE pra nuvem ───────────────────────────────
    await sbx.commands.run('mkdir -p /home/user/workspace');
    if (codeTarGz) {
      // código da pasta local empacotado → extrai no workspace
      await sbx.files.write('/home/user/_code.tar.gz', Buffer.isBuffer(codeTarGz) ? codeTarGz : Buffer.from(codeTarGz, 'base64'));
      await sbx.commands.run('tar -xzf /home/user/_code.tar.gz -C /home/user/workspace && rm -f /home/user/_code.tar.gz', { timeoutMs: 120000 });
    } else if (repoUrl) {
      // Clone TOLERANTE: se falhar (repo privado/inacessível → exit 128), não
      // aborta a sessão; sobe com workspace vazio e o agente lida (ou o usuário
      // manda o código). Antes isso matava o "Ativar na nuvem" com exit 128.
      try {
        await sbx.commands.run(`rm -rf /home/user/workspace && git clone --depth 1 ${repoUrl} /home/user/workspace`, { timeoutMs: 300000 });
      } catch (e) {
        console.error('[orchestrator] git clone falhou (repo privado/inacessível?), seguindo com workspace vazio:', (e && e.message || '').slice(0, 200));
        await sbx.commands.run('mkdir -p /home/user/workspace').catch(() => {});
      }
    }

    // ─── Migração de SESSION (continua de onde parou) + MEMORY ────────────
    let resumeSessionId = '';
    if (sessionJsonl && project.sessionId) {
      // o claude lê a sessão de ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl
      const enc = '-home-user-workspace';
      await sbx.commands.run(`mkdir -p /home/user/.claude/projects/${enc}`);
      await sbx.files.write(`/home/user/.claude/projects/${enc}/${project.sessionId}.jsonl`, sessionJsonl);
      resumeSessionId = project.sessionId;
    }
    if (memoryJson) {
      await sbx.commands.run('mkdir -p /home/user/.maestrus');
      await sbx.files.write('/home/user/.maestrus/memory.json', memoryJson);
    }

    // ─── Skills globais + MCP do usuário (do DB, montados pelo backend) ──────
    await injectUserConfig(sbx, opts);

    const envs = {
      RELAY_URL: relay.url, RELAY_TOKEN: relay.token, DEVICE_ID: relay.deviceId,
      PROJECT_ID: project.id, PROJECT_NAME: project.name || project.id,
      WORKDIR: '/home/user/workspace', MODEL: project.model || '',
      PREVIEW_PORT: String(previewPort),
      HOME: '/home/user',
    };
    if (resumeSessionId) envs.RESUME_SESSION_ID = resumeSessionId;
    // Auto-setup: o agente entende o código, instala e sobe o app na porta de
    // preview — sozinho, no boot. (só quando o projeto vira cloud, não sempre)
    if (opts.autoSetup) envs.SETUP_PROMPT = setupPrompt(previewPort);
    if (anthropic.baseUrl) envs.ANTHROPIC_BASE_URL = anthropic.baseUrl;
    if (anthropic.token) envs.ANTHROPIC_AUTH_TOKEN = anthropic.token;
    if (anthropic.apiKey) envs.ANTHROPIC_API_KEY = anthropic.apiKey;
    if (opts.refreshUrl && opts.licenseKey) { envs.REFRESH_URL = opts.refreshUrl; envs.LICENSE_KEY = opts.licenseKey; }

    sbx.commands.run('node /home/user/app/cloud-runner/runner.js', { background: true, envs }).catch(() => {});

    // URL pública do preview de produção (o agente sobe o app nessa porta).
    const previewUrl = 'https://' + sbx.getHost(previewPort);
    return { sandboxId: sbx.sandboxId, deviceId: relay.deviceId, previewUrl, previewPort };
  } catch (e) {
    try { await sbx.kill(); } catch {}
    throw e;
  }
}

// Injeta no sandbox as Skills globais (~/.claude/skills/<slug>/SKILL.md) e os
// servidores MCP do usuário (workspace/.mcp.json). Ambos chegam JÁ PRONTOS do
// backend (api.php gather): skills sem segredo, mcpServers com auth já
// descriptografada. Tolerante: nunca derruba o boot da sessão.
async function injectUserConfig(sbx, opts) {
  try {
    const skills = Array.isArray(opts && opts.skills) ? opts.skills : [];
    if (skills.length) {
      await sbx.commands.run('mkdir -p /home/user/.claude/skills').catch(() => {});
      for (const sk of skills) {
        const slug = String(sk.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
        if (!slug) continue;
        await sbx.commands.run(`mkdir -p /home/user/.claude/skills/${slug}`).catch(() => {});
        const desc = String(sk.description || '').replace(/\r?\n/g, ' ').replace(/"/g, "'");
        const md = `---\nname: ${sk.name}\ndescription: ${desc}\n---\n\n${sk.body || ''}\n`;
        await sbx.files.write(`/home/user/.claude/skills/${slug}/SKILL.md`, md).catch(() => {});
      }
    }
    const mcpServers = (opts && opts.mcpServers && typeof opts.mcpServers === 'object') ? opts.mcpServers : null;
    if (mcpServers && Object.keys(mcpServers).length) {
      await sbx.files.write('/home/user/workspace/.mcp.json', JSON.stringify({ mcpServers }, null, 2)).catch(() => {});
    }
  } catch (e) { console.error('[orchestrator] injectUserConfig', e && e.message); }
}

// Prompt de setup auto-injetado quando um projeto vira cloud: o agente entende
// o código, instala, sobe o app na porta de preview e confirma a URL.
function setupPrompt(previewPort) {
  return [
    'Você está rodando num ambiente de nuvem (sandbox Linux limpo) com o código deste projeto em /home/user/workspace.',
    'Faça o seguinte, de forma autônoma:',
    '1) Analise o projeto (linguagem, framework, package manager) lendo os arquivos.',
    '2) Instale as dependências (npm/pnpm/yarn/pip/etc.).',
    `3) Suba o app de forma que ele escute em 0.0.0.0:${previewPort} (ajuste host/porta se preciso) pra ficar acessível no preview público.`,
    '4) Me diga em 1 linha o que rodou e confirme que está no ar na porta de preview.',
    'Se for um projeto sem servidor web, só instale e rode os testes/build e me diga o estado.',
  ].join('\n');
}

async function getPreviewUrl(apiKey, sandboxId, port = PREVIEW_PORT) {
  const sbx = await Sandbox.connect(sandboxId, { apiKey });
  return 'https://' + sbx.getHost(port);
}

async function stopCloudSession(apiKey, sandboxId) {
  try { await Sandbox.kill(sandboxId, { apiKey }); return { ok: true }; }
  catch (e) { return { ok: false, error: e && e.message }; }
}

// ─── Reaper de custo: mata sandboxes E2B ÓRFÃOS (rodando mas NÃO rastreados no
// banco) — pega duplicatas e instâncias esquecidas ligadas à toa. Carência de
// 3min protege sandboxes recém-criados (start/resume em andamento). validIds =
// sandbox_ids que o banco considera vivos (running/paused).
async function reapOrphans(apiKey, validIds) {
  const valid = new Set((validIds || []).filter(Boolean));
  const GRACE_MS = 3 * 60 * 1000;
  let running = [];
  try { running = await Sandbox.list({ apiKey }); }
  catch (e) { return { ok: false, error: 'list_failed: ' + (e && e.message) }; }
  const killed = []; const alive = [];
  for (const s of (running || [])) {
    const id = s.sandboxId || s.sandbox_id || s.id;
    if (!id) continue;
    if (valid.has(id)) { alive.push(id); continue; }
    const started = s.startedAt ? new Date(s.startedAt).getTime() : (s.startInfo && s.startInfo.startedAt ? new Date(s.startInfo.startedAt).getTime() : 0);
    if (started && (Date.now() - started) < GRACE_MS) { alive.push(id); continue; } // recém-criado: não mata
    try { await Sandbox.kill(id, { apiKey }); killed.push(id); } catch {}
  }
  return { ok: true, killed, alive };
}

// Snapshot: congela o sandbox (scale-to-zero, só storage). Runtime fica intacto.
async function pauseCloudSession(apiKey, sandboxId) {
  try { const s = await Sandbox.connect(sandboxId, { apiKey }); await (s.betaPause ? s.betaPause() : s.pause()); return { ok: true }; }
  catch (e) { return { ok: false, error: e && e.message }; }
}
// Restore: resume o sandbox pausado e REINICIA o runner do zero. Confiar que o
// processo pausado (runner + claude) volta intacto é frágil — o resume-from-
// snapshot deixa o claude/stdin em estado quebrado e o chat trava. Então aqui
// matamos qualquer runner/claude stale e subimos um runner novo com token/env
// frescos. O workspace e as deps instaladas continuam no snapshot.
async function resumeCloudSession(opts, _legacyPort) {
  // compat: assinatura antiga resumeCloudSession(apiKey, sandboxId, previewPort)
  if (typeof opts === 'string') opts = { apiKey: opts, sandboxId: _legacyPort };
  const { apiKey, sandboxId, relay, anthropic = {}, project = {}, refreshUrl, licenseKey, repoUrl } = opts || {};
  const previewPort = opts.previewPort || PREVIEW_PORT;
  // 1) Tenta reconectar E confirmar que o sandbox responde. Sandboxes E2B são
  //    efêmeros: podem ter sido deletados/expirados (o status no banco fica
  //    obsoleto). connect() pode "funcionar" mas o VM estar morto, então
  //    validamos com um echo curto.
  let s = null;
  try {
    s = await Sandbox.connect(sandboxId, { apiKey });
    await s.commands.run('echo ok', { timeoutMs: 10000 });
  } catch (e) {
    s = null; // morto/inacessível → resume-or-fresh abaixo
  }

  // 2a) Sandbox VIVO → reinicia o runner do zero (token/env frescos).
  if (s) {
    try { await s.commands.run('pkill -9 -f cloud-runner/runner.js 2>/dev/null; pkill -9 -f "claude" 2>/dev/null; true', { timeoutMs: 15000 }); } catch {}
    // RE-SOBE os arquivos do runner — pega fixes (ex: stdin) sem precisar
    // recriar o sandbox. Sandboxes antigos ficavam com o runner.js velho porque
    // o resume só reiniciava o node, sem re-enviar os arquivos.
    try { for (const [dest, rel] of Object.entries(FILES)) await s.files.write(dest, src(rel)); } catch (e) { console.error('[orchestrator] re-upload runner', e && e.message); }
    // reaplica skills/MCP atuais (o usuário pode ter mudado desde o último start)
    await injectUserConfig(s, opts);
    if (relay && relay.url && relay.token && relay.deviceId) {
      const envs = {
        RELAY_URL: relay.url, RELAY_TOKEN: relay.token, DEVICE_ID: relay.deviceId,
        PROJECT_ID: project.id || '', PROJECT_NAME: project.name || project.id || '',
        WORKDIR: '/home/user/workspace', MODEL: project.model || '',
        PREVIEW_PORT: String(previewPort), HOME: '/home/user',
      };
      if (anthropic.baseUrl) envs.ANTHROPIC_BASE_URL = anthropic.baseUrl;
      if (anthropic.token) envs.ANTHROPIC_AUTH_TOKEN = anthropic.token;
      if (anthropic.apiKey) envs.ANTHROPIC_API_KEY = anthropic.apiKey;
      if (refreshUrl && licenseKey) { envs.REFRESH_URL = refreshUrl; envs.LICENSE_KEY = licenseKey; }
      s.commands.run('node /home/user/app/cloud-runner/runner.js', { background: true, envs }).catch(() => {});
    }
    return { ok: true, fresh: false, sandboxId, previewUrl: 'https://' + s.getHost(previewPort) };
  }

  // 2b) Sandbox MORTO → sobe um NOVO automaticamente (resume-or-fresh). Precisa
  //     do relay+anthropic (vêm do api.php). Re-clona o repo se for o caso.
  if (!relay || !relay.url || !relay.token || !relay.deviceId) return { ok: false, error: 'sandbox_gone' };
  try {
    const fresh = await startCloudSession({ apiKey, project, relay, anthropic, repoUrl: repoUrl || undefined, autoSetup: !!repoUrl, refreshUrl, licenseKey, previewPort, skills: opts.skills, mcpServers: opts.mcpServers });
    return { ok: true, fresh: true, sandboxId: fresh.sandboxId, previewUrl: fresh.previewUrl };
  } catch (e) { return { ok: false, error: 'fresh_start_failed: ' + (e && e.message) }; }
}

module.exports = { startCloudSession, stopCloudSession, pauseCloudSession, resumeCloudSession, getPreviewUrl, setupPrompt, reapOrphans, PREVIEW_PORT };
