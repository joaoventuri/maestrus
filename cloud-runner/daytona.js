'use strict';
// ─── Driver Daytona do Maestrus on Cloud ────────────────────────────────────
// Mesma ideia do orchestrator.js (E2B), mas usando o SDK @daytonaio/sdk. O
// image padrão da Daytona já traz node + git + claude CLI, então não precisa
// instalar o claude. Sandbox = container (start ~90ms); auto-stop nativo +
// nosso auto-suspend cuidam do custo (sem reaper).
//
// HOME do sandbox = /home/daytona. App em /home/daytona/app, código em
// /home/daytona/workspace. O runner é path-agnostic (usa HOME/WORKDIR do env).

const fs = require('fs');
const path = require('path');
const { Daytona } = require('@daytonaio/sdk');

const ROOT = path.resolve(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PREVIEW_PORT = 3000;
const HOME = '/home/daytona';
const APP = `${HOME}/app`;
const WORKDIR = `${HOME}/workspace`;

const FILES = {
  [`${APP}/relay/link.js`]: 'relay/link.js',
  [`${APP}/relay/protocol.js`]: 'relay/protocol.js',
  [`${APP}/cloud-runner/runner.js`]: 'cloud-runner/runner.js',
  [`${APP}/cloud-runner/package.json`]: 'cloud-runner/package.json',
};

function client(opts) {
  return new Daytona({ apiKey: opts.apiKey, apiUrl: opts.apiUrl || 'https://app.daytona.io/api' });
}
// Promise com teto de tempo — evita travar em chamadas lentas da API (ex.: get/
// start de um sandbox já deletado, que pendurava o resume por minutos).
function withTimeout(p, ms) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms)),
  ]);
}
async function exec(sbx, cmd) { try { return await sbx.process.executeCommand(`bash -lc ${shq(cmd)}`); } catch (e) { return { exitCode: 1, result: String(e && e.message || e) }; } }
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
async function writeFile(sbx, dest, content) {
  await exec(sbx, `mkdir -p ${path.posix.dirname(dest)}`);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  await sbx.fs.uploadFile(buf, dest);
}
const b64 = (s) => Buffer.from(String(s == null ? '' : s)).toString('base64');

// Monta o start.sh: exporta envs (via base64 pra zero problema de aspas) e sobe
// o runner. Roda em background com nohup (executeCommand retorna na hora).
function buildStartScript(envs) {
  const lines = ['#!/bin/bash'];
  for (const [k, v] of Object.entries(envs)) {
    if (v == null || v === '') continue;
    lines.push(`export ${k}="$(printf %s '${b64(v)}' | base64 -d)"`);
  }
  lines.push(`cd ${APP}/cloud-runner`);
  lines.push('exec node runner.js');
  return lines.join('\n') + '\n';
}

async function injectUserConfig(sbx, opts) {
  try {
    const skills = Array.isArray(opts && opts.skills) ? opts.skills : [];
    if (skills.length) {
      await exec(sbx, `mkdir -p ${HOME}/.claude/skills`);
      for (const sk of skills) {
        const slug = String(sk.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
        if (!slug) continue;
        const desc = String(sk.description || '').replace(/\r?\n/g, ' ').replace(/"/g, "'");
        const md = `---\nname: ${sk.name}\ndescription: ${desc}\n---\n\n${sk.body || ''}\n`;
        await writeFile(sbx, `${HOME}/.claude/skills/${slug}/SKILL.md`, md).catch(() => {});
      }
    }
    const mcp = (opts && opts.mcpServers && typeof opts.mcpServers === 'object') ? opts.mcpServers : null;
    if (mcp && Object.keys(mcp).length) await writeFile(sbx, `${WORKDIR}/.mcp.json`, JSON.stringify({ mcpServers: mcp }, null, 2)).catch(() => {});
  } catch (e) { console.error('[daytona] injectUserConfig', e && e.message); }
}

function setupPrompt(port) {
  return [
    'Você está rodando num ambiente de nuvem (sandbox Linux limpo) com o código deste projeto em ' + WORKDIR + '.',
    'Faça de forma autônoma: 1) analise o projeto; 2) instale dependências; 3) suba o app escutando em 0.0.0.0:' + port + ' (pro preview público); 4) confirme em 1 linha o que rodou.',
    'Se não for um app web, só instale e rode testes/build e me diga o estado.',
  ].join('\n');
}

function runnerEnvs(opts, { resumeSessionId } = {}) {
  const { relay = {}, anthropic = {}, project = {} } = opts;
  const envs = {
    RELAY_URL: relay.url, RELAY_TOKEN: relay.token, DEVICE_ID: relay.deviceId,
    PROJECT_ID: project.id, PROJECT_NAME: project.name || project.id,
    WORKDIR, HOME, MODEL: project.model || '', PREVIEW_PORT: String(opts.previewPort || PREVIEW_PORT),
  };
  if (resumeSessionId) envs.RESUME_SESSION_ID = resumeSessionId;
  if (opts.autoSetup) envs.SETUP_PROMPT = setupPrompt(opts.previewPort || PREVIEW_PORT);
  if (anthropic.baseUrl) envs.ANTHROPIC_BASE_URL = anthropic.baseUrl;
  if (anthropic.token) envs.ANTHROPIC_AUTH_TOKEN = anthropic.token;
  if (anthropic.apiKey) envs.ANTHROPIC_API_KEY = anthropic.apiKey;
  if (opts.refreshUrl && opts.licenseKey) { envs.REFRESH_URL = opts.refreshUrl; envs.LICENSE_KEY = opts.licenseKey; }
  return envs;
}

async function bootRunner(sbx, opts, resumeSessionId) {
  await writeFile(sbx, `${APP}/start.sh`, buildStartScript(runnerEnvs(opts, { resumeSessionId })));
  await exec(sbx, `nohup bash ${APP}/start.sh > /tmp/runner.log 2>&1 & echo started`);
}

async function startDaytona(opts) {
  const { relay, project = {}, repoUrl, codeTarGz, sessionJsonl, memoryJson } = opts;
  if (!relay || !relay.url || !relay.token || !relay.deviceId) throw new Error('relay {url,token,deviceId} obrigatório');
  const d = client(opts);
  // networkBlockAll:false → restaura saída geral. Por padrão a Daytona bloqueia
  // egress (só registries), o que impedia o runner de alcançar o relay
  // (wss://maestrus.cloud) → "relay status: error" eterno. Com saída liberada o
  // runner conecta no relay e o agente acessa a internet (igual E2B).
  const sbx = await d.create({ language: 'typescript', networkBlockAll: false });
  try {
    // 1) arquivos do runner + instala o pacote `ws` (o WebSocket NATIVO do node
    // falha no handshake com o relay; o pacote `ws` conecta — é o que o runner
    // prefere). É rápido (~3-5s).
    for (const [dest, rel] of Object.entries(FILES)) await writeFile(sbx, dest, src(rel));
    await exec(sbx, `cd ${APP}/cloud-runner && npm install ws --no-audit --no-fund --loglevel=error`);
    // 2) código
    await exec(sbx, `mkdir -p ${WORKDIR}`);
    if (codeTarGz) {
      await writeFile(sbx, `${HOME}/_code.tar.gz`, Buffer.isBuffer(codeTarGz) ? codeTarGz : Buffer.from(codeTarGz, 'base64'));
      await exec(sbx, `tar -xzf ${HOME}/_code.tar.gz -C ${WORKDIR} && rm -f ${HOME}/_code.tar.gz`);
    } else if (repoUrl) {
      const r = await exec(sbx, `rm -rf ${WORKDIR} && git clone --depth 1 ${shq(repoUrl)} ${WORKDIR}`);
      if (r.exitCode !== 0) await exec(sbx, `mkdir -p ${WORKDIR}`); // clone tolerante
    }
    // 3) sessão + memória
    let resumeSessionId = '';
    if (sessionJsonl && project.sessionId) {
      const enc = WORKDIR.replace(/[^a-zA-Z0-9]/g, '-');
      await exec(sbx, `mkdir -p ${HOME}/.claude/projects/${enc}`);
      await writeFile(sbx, `${HOME}/.claude/projects/${enc}/${project.sessionId}.jsonl`, sessionJsonl);
      resumeSessionId = project.sessionId;
    }
    if (memoryJson) { await exec(sbx, `mkdir -p ${HOME}/.maestrus`); await writeFile(sbx, `${HOME}/.maestrus/memory.json`, memoryJson); }
    // 4) skills + MCP do usuário
    await injectUserConfig(sbx, opts);
    // 5) sobe o runner
    await bootRunner(sbx, opts, resumeSessionId);
    let previewUrl = null;
    try { previewUrl = (await sbx.getPreviewLink(opts.previewPort || PREVIEW_PORT)).url; } catch (e) { console.error('[daytona] previewLink', e && e.message); }
    return { sandboxId: sbx.id, deviceId: relay.deviceId, previewUrl, previewPort: opts.previewPort || PREVIEW_PORT };
  } catch (e) {
    // NÃO deleta o sandbox no erro — o runner pode já ter conectado; deletar
    // matava um runner que estava de pé (e dava "count 0"). O auto-suspend/auto-
    // stop nativo da Daytona limpa o que ficar ocioso.
    console.error('[daytona] startDaytona', e && e.message);
    return { sandboxId: sbx.id, deviceId: relay.deviceId, previewUrl: null, previewPort: opts.previewPort || PREVIEW_PORT, warn: String(e && e.message || e) };
  }
}

async function resumeDaytona(opts) {
  const { sandboxId, relay = {}, project = {}, repoUrl } = opts;
  const d = client(opts);
  let sbx = null;
  // Valida o sandbox existente com TIMEOUTS CURTOS. Sem isso, um sandbox_id
  // antigo/deletado (comum, ainda mais pós-migração de provedor) travava no
  // d.get + start(120) por até 2min → cloud_resume pendurava e nada subia.
  if (sandboxId) {
    try {
      sbx = await withTimeout(d.get(sandboxId), 12000);
      await withTimeout(sbx.start(25), 28000).catch(() => {});
      const ok = await withTimeout(exec(sbx, 'echo ok'), 10000);
      if (!ok || ok.exitCode !== 0) sbx = null;
    } catch (e) { console.error('[daytona] resume validate (vai fresh):', e && e.message); sbx = null; }
  }

  if (sbx) {
    await exec(sbx, "pkill -9 -f cloud-runner/runner.js 2>/dev/null; pkill -9 -f claude 2>/dev/null; true");
    // re-sobe arquivos do runner (pega fixes) + garante o pacote ws (sandboxes
    // antigos podem não ter) + reaplica skills/MCP
    try { for (const [dest, rel] of Object.entries(FILES)) await writeFile(sbx, dest, src(rel)); } catch {}
    await exec(sbx, `cd ${APP}/cloud-runner && (node -e "require('ws')" 2>/dev/null || npm install ws --no-audit --no-fund --loglevel=error)`);
    await injectUserConfig(sbx, opts);
    if (relay && relay.url && relay.token && relay.deviceId) await bootRunner(sbx, opts, '');
    let previewUrl = null; try { previewUrl = (await sbx.getPreviewLink(opts.previewPort || PREVIEW_PORT)).url; } catch {}
    return { ok: true, fresh: false, sandboxId, previewUrl };
  }
  // morto/sumiu → fresh
  if (!relay || !relay.url || !relay.token || !relay.deviceId) return { ok: false, error: 'sandbox_gone' };
  try {
    const fresh = await startDaytona({ ...opts, repoUrl: repoUrl || undefined, autoSetup: !!repoUrl });
    return { ok: true, fresh: true, sandboxId: fresh.sandboxId, previewUrl: fresh.previewUrl };
  } catch (e) { return { ok: false, error: 'fresh_start_failed: ' + (e && e.message) }; }
}

async function stopDaytona(opts) {
  try { const d = client(opts); const sbx = await d.get(opts.sandboxId); await sbx.delete(0); return { ok: true }; }
  catch (e) { return { ok: false, error: e && e.message }; }
}
async function pauseDaytona(opts) {
  try { const d = client(opts); const sbx = await d.get(opts.sandboxId); await sbx.stop(); try { await sbx.archive(); } catch {} return { ok: true }; }
  catch (e) { return { ok: false, error: e && e.message }; }
}
async function getPreviewDaytona(opts) {
  const d = client(opts); const sbx = await d.get(opts.sandboxId);
  return (await sbx.getPreviewLink(opts.port || PREVIEW_PORT)).url;
}

module.exports = { startDaytona, resumeDaytona, stopDaytona, pauseDaytona, getPreviewDaytona, PREVIEW_PORT };
