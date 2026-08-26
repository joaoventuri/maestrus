// Cliente das APIs ?action=tasks do maestrus-cloud. Wrapper fino sobre fetch
// — autentica via license_key da conta logada, retorna sempre { ok, ... }.

const { API_BASE } = require('./config');
const cloud = require('./cloud');

async function call(op, body = {}, opts = {}) {
  const acc = cloud.getAccount();
  if (!acc) return { ok: false, error: 'not_logged_in' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 12000);
  try {
    const url = `${API_BASE}?action=tasks&op=${encodeURIComponent(op)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, license_key: acc.licenseKey }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: 'http_error', status: res.status };
    return await res.json().catch(() => ({ ok: false, error: 'bad_json' }));
  } catch (e) {
    return { ok: false, error: 'network', message: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function newId() {
  // "t_" + 13 hex chars (54 bits aleatorios, suficientes pro escopo de 1 user)
  return 't_' + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 7);
}

module.exports = {
  newId,
  list:         ()          => call('list'),
  create:       (t)         => call('create', t),
  update:       (id, patch) => call('update', { id, ...patch }),
  remove:       (id)        => call('delete', { id }),
  reorder:      (moves)     => call('reorder', { moves }),
  claim:        (projectId) => call('claim',   { project_id: projectId }),
  settingsGet:  ()          => call('settings_get'),
  settingsSet:  (s)         => call('settings_set', s),
};
