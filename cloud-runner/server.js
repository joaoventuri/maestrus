'use strict';
// ─── Serviço orquestrador do Maestrus on Cloud ──────────────────────────────
// HTTP fino que o backend PHP chama (rede interna do Docker). Tem a E2B key
// (env, do settings) e fala com o E2B. Mantém o segredo fora do PHP e isola a
// dependência Node (SDK do E2B) num processo só.
//
// Endpoints (POST, header x-orch-secret):
//   /start   { project, relay, anthropic, repoUrl|codeTarGz, sessionJsonl,
//              memoryJson, autoSetup, previewPort } → { sandboxId, deviceId, previewUrl }
//   /stop    { sandboxId } → { ok }
//   /preview { sandboxId, port } → { ok, previewUrl }
//   /health  → { ok }

const http = require('http');
const { startCloudSession, stopCloudSession, getPreviewUrl, pauseCloudSession, resumeCloudSession, reapOrphans } = require('./orchestrator');
const daytona = require('./daytona');
const local = require('./local');

const PORT = Number(process.env.PORT || 8790);
const SECRET = process.env.ORCH_SECRET || '';
const E2B_API_KEY = process.env.E2B_API_KEY || '';
const BACKEND_URL = process.env.BACKEND_URL || 'https://maestrus.cloud/api.php';

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (d) => { b += d; if (b.length > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/health') return json(res, 200, { ok: true, e2b: !!E2B_API_KEY });
  if (SECRET && req.headers['x-orch-secret'] !== SECRET) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return json(res, 404, { ok: false });
  const body = await readBody(req);
  // Provedor escolhido no admin (sandbox_provider). 'daytona' usa o driver novo;
  // qualquer outro = E2B (compat). A chave vem do backend (body.apiKey) com
  // fallback pro env E2B_API_KEY (compat com deploy antigo).
  const provider = (body.provider || 'e2b').toLowerCase();
  const isDtn = provider === 'daytona';
  const isLocal = provider === 'local';
  // 'local' usa o socket Docker do host (sem apiKey). e2b/daytona precisam de chave.
  const apiKey = body.apiKey || (isDtn || isLocal ? '' : E2B_API_KEY);
  if (!isLocal && !apiKey) return json(res, 503, { ok: false, error: isDtn ? 'no_daytona_key' : 'no_e2b_key' });
  const opts = { ...body, apiKey };
  try {
    if (url === '/start') {
      const r = isLocal ? await local.startLocal(opts) : isDtn ? await daytona.startDaytona(opts) : await startCloudSession({ ...body, apiKey });
      return json(res, 200, { ok: true, ...r });
    }
    if (url === '/stop') {
      const r = isLocal ? await local.stopLocal(opts) : isDtn ? await daytona.stopDaytona(opts) : await stopCloudSession(apiKey, body.sandboxId);
      return json(res, 200, r);
    }
    if (url === '/pause') {
      const r = isLocal ? await local.pauseLocal(opts) : isDtn ? await daytona.pauseDaytona(opts) : await pauseCloudSession(apiKey, body.sandboxId);
      return json(res, 200, r);
    }
    if (url === '/resume') {
      const r = isLocal ? await local.resumeLocal(opts) : isDtn ? await daytona.resumeDaytona(opts) : await resumeCloudSession({ ...body, apiKey });
      return json(res, 200, r);
    }
    if (url === '/preview') {
      const u = isLocal ? await local.getPreviewLocal(opts) : isDtn ? await daytona.getPreviewDaytona(opts) : await getPreviewUrl(apiKey, body.sandboxId, body.port);
      return json(res, 200, { ok: true, previewUrl: u });
    }
    if (url === '/delete') {
      // Exclusão definitiva. Local: remove container + volume. e2b/daytona: mata
      // o sandbox (libera compute; storage é efêmero lá mesmo).
      const r = isLocal ? await local.deleteLocal(opts)
              : isDtn ? await daytona.stopDaytona(opts)
              : await stopCloudSession(apiKey, body.sandboxId);
      return json(res, 200, r);
    }
    if (url === '/status') {
      // Estado REAL (ground truth). Hoje só o provider local sabe inspecionar de
      // graça; e2b/daytona devolvem vazio → o backend cai no heartbeat.
      const r = isLocal ? await local.statusLocal(opts) : { ok: true, statuses: {} };
      return json(res, 200, r);
    }
    if (url === '/reap') { const r = await reapOrphans(apiKey, body.validIds || []); return json(res, 200, r); }
    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) { console.error('[orchestrator]', url, e && e.message); return json(res, 500, { ok: false, error: e && e.message }); }
});

server.listen(PORT, () => console.log(`[orchestrator] Maestrus Cloud orchestrator on :${PORT} (e2b=${!!E2B_API_KEY})`));

// NOTA: o reaper periódico (Sandbox.list/kill a cada 5min) foi REMOVIDO — esse
// padrão de varredura provavelmente disparou o ban do E2B. Controle de custo
// agora é por AÇÃO + presença real: auto-suspend (5min idle, no runner) +
// timeout nativo do E2B (1h) + lock anti-duplicidade. O endpoint /reap segue
// existindo p/ uso manual pontual, mas não roda em loop.
