// HTTP local pra MCP server stdio bin chamar de volta no Maestrus em runtime.
// Sobe em 127.0.0.1:<porta-aleatória>, expõe /projects e /dispatch protegidos
// por bearer token efêmero. Url+token são injetados via env no `claude` spawnado
// pra projeto maestrus.

const http = require('http');
const crypto = require('crypto');
const computerControl = require('./computer-control');
const taskStore = require('./task-store');
const taskQueue = require('./task-queue');

let _info = null; // { port, token, url }
let _server = null;
let _store = null;
let _dispatchFn = null;
let _browser = null;
let _getProjects = null;   // async () => [projetos despacháveis] (local+cloud+remote)
let _getProject = null;    // async (idOrName) => projeto | null
let _maestrusId = 'maestrus';

function jsonResponse(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > 5 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error('invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function start({ projectStore, dispatchFn, browser, getProjects, getProject } = {}) {
  if (_server) return _info;
  if (!projectStore || !dispatchFn) {
    throw new Error('orchestrate-server.start needs { projectStore, dispatchFn }');
  }
  _store = projectStore;
  _dispatchFn = dispatchFn;
  _browser = browser || null;
  _maestrusId = projectStore.MAESTRUS_ID || 'maestrus';
  // getProjects/getProject permitem despachar pra projetos CLOUD/REMOTE além dos
  // locais. Sem eles, cai no projectStore (compat).
  _getProjects = getProjects || (async () => _store.list());
  _getProject = getProject || (async (idOrName) => _store.get(idOrName) || _store.list().find((p) => p.name.toLowerCase() === String(idOrName).toLowerCase()));

  const token = crypto.randomBytes(24).toString('hex');

  _server = http.createServer(async (req, res) => {
    try {
      // CORS bobinho: só localhost ouve, mas adicionando pra evitar problemas
      // de pré-flight caso alguém chame via fetch().
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const auth = req.headers['authorization'] || '';
      const expected = `Bearer ${token}`;
      if (auth !== expected) {
        return jsonResponse(res, 401, { error: 'unauthorized' });
      }

      const url = new URL(req.url, `http://localhost:${_info.port}`);

      if (req.method === 'GET' && url.pathname === '/projects') {
        const all = (await _getProjects()) || [];
        const projects = all
          .filter((p) => p && p.id !== _maestrusId)
          .map((p) => ({
            id: p.id,
            name: p.name,
            model: p.model || 'sonnet',
            source: p.source,
            cloud: !!p.cloud || p.source === 'cloud',
            codeDir: p.codeDir || null,
            sessionId: p.sessionId || null,
          }));
        return jsonResponse(res, 200, { projects });
      }

      if (req.method === 'POST' && url.pathname === '/dispatch') {
        const body = await readBody(req);
        const targetId = body.project_id || body.targetId;
        const prompt = body.prompt;
        const timeoutMs = Number(body.timeout_ms || body.timeoutMs) || undefined;
        // wait=true → síncrono (espera a resposta, p/ encadear). Default = async
        // (fire-and-forget): dispara e volta na hora; a resposta aparece no chat
        // do próprio projeto-alvo. É o que deixa o maestro não travar.
        const wait = body.wait === true || body.wait === 'true';
        if (!targetId || !prompt) {
          return jsonResponse(res, 400, { error: 'missing project_id or prompt' });
        }
        const target = await _getProject(targetId);
        if (!target) {
          return jsonResponse(res, 404, { error: `project not found: ${targetId}` });
        }
        if (target.id === _maestrusId) {
          return jsonResponse(res, 400, { error: 'cannot dispatch to maestrus from maestrus' });
        }
        try {
          const result = await _dispatchFn(target, prompt, { timeoutMs, wait });
          return jsonResponse(res, 200, {
            ok: true,
            project_id: target.id,
            project_name: target.name,
            dispatched: result.dispatched || false,
            async: result.async || false,
            text: result.text ?? null,
            cost: result.cost ?? null,
            session_id: result.sessionId ?? null,
            usage: result.usage ?? null,
          });
        } catch (e) {
          return jsonResponse(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
        }
      }

      // Enfileira uma tarefa no Kanban do projeto-alvo (async, não-bloqueante).
      // O task-queue (worker) executa em segundo plano e guarda a resposta no
      // result_note — colhida depois via /results. É o que deixa o Maestrus
      // delegar trabalho sem travar.
      if (req.method === 'POST' && url.pathname === '/enqueue') {
        const body = await readBody(req);
        const targetId = body.project_id || body.targetId;
        const prompt = (body.prompt || '').trim();
        if (!targetId || !prompt) {
          return jsonResponse(res, 400, { ok: false, error: 'missing project_id or prompt' });
        }
        const target = await _getProject(targetId);
        if (!target) return jsonResponse(res, 404, { ok: false, error: `project not found: ${targetId}` });
        if (target.id === _maestrusId) {
          return jsonResponse(res, 400, { ok: false, error: 'cannot enqueue to maestrus' });
        }
        const title = (body.title || '').trim() || prompt.replace(/\s+/g, ' ').slice(0, 80);
        const id = taskStore.newId();
        // status 'ready' → o worker do Kanban pega no próximo tick.
        const r = await taskStore.create({ id, project_id: target.id, title, description: prompt, status: 'ready' });
        if (!r || !r.ok) {
          return jsonResponse(res, 502, { ok: false, error: (r && r.error) || 'enqueue_failed' });
        }
        // Goal loop: registra no worker (estado in-process) — itera até cumprir.
        const maxIter = Number(body.max_iterations || body.loop_max) || 1;
        let loopMax = 1;
        if (maxIter > 1) { try { loopMax = taskQueue.registerLoop(id, maxIter); } catch {} }
        return jsonResponse(res, 200, { ok: true, task_id: id, project_id: target.id, project_name: target.name, loop: loopMax > 1 ? loopMax : undefined });
      }

      // Colhe os resultados das tarefas enfileiradas (concluídas/falhas com o
      // texto), e lista as ainda pendentes. Não bloqueia.
      if (req.method === 'POST' && url.pathname === '/results') {
        const body = await readBody(req);
        const ids = Array.isArray(body.task_ids) && body.task_ids.length ? body.task_ids : null;
        const r = await taskStore.list();
        if (!r || !r.ok) return jsonResponse(res, 502, { ok: false, error: (r && r.error) || 'list_failed' });
        let tasks = r.tasks || [];
        if (ids) tasks = tasks.filter((t) => ids.includes(t.id));
        const results = tasks
          .filter((t) => t.status === 'done' || t.status === 'failed')
          .map((t) => ({ task_id: t.id, project_id: t.project_id, title: t.title, status: t.status, result: t.result_note || '', finished_at: t.finished_at || null }));
        const pending = tasks
          .filter((t) => t.status === 'ready' || t.status === 'doing' || t.status === 'backlog')
          .map((t) => ({ task_id: t.id, project_id: t.project_id, title: t.title, status: t.status }));
        return jsonResponse(res, 200, { ok: true, results, pending });
      }

      // Controle do navegador embutido (MCP browser_*).
      if (req.method === 'POST' && url.pathname === '/browser') {
        if (!_browser) return jsonResponse(res, 503, { ok: false, error: 'browser indisponível' });
        const body = await readBody(req);
        const op = body.op;
        if (!op) return jsonResponse(res, 400, { ok: false, error: 'missing op' });
        try {
          const result = await _browser.run(op, body);
          return jsonResponse(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : { result }) });
        } catch (e) {
          return jsonResponse(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
        }
      }

      // Controle do computador (MCP computer_*): screenshot/click/type/key.
      if (req.method === 'POST' && url.pathname === '/computer') {
        const body = await readBody(req);
        const op = body.op;
        if (!op) return jsonResponse(res, 400, { ok: false, error: 'missing op' });
        try {
          const result = await computerControl.run(op, body);
          return jsonResponse(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : { result }) });
        } catch (e) {
          return jsonResponse(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
        }
      }

      jsonResponse(res, 404, { error: 'not found' });
    } catch (e) {
      jsonResponse(res, 500, { error: e && e.message ? e.message : String(e) });
    }
  });

  return new Promise((resolve, reject) => {
    _server.on('error', reject);
    _server.listen(0, '127.0.0.1', () => {
      const port = _server.address().port;
      _info = { port, token, url: `http://127.0.0.1:${port}` };
      console.log(`[maestrus orchestrate] HTTP server on ${_info.url}`);
      resolve(_info);
    });
  });
}

function info() { return _info; }

function stop() {
  if (_server) {
    try { _server.close(); } catch {}
    _server = null;
    _info = null;
  }
}

module.exports = { start, stop, info };
