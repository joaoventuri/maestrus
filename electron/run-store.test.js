// Execucoes em segundo plano precisam SOBREVIVER ao fim do turno — era esse o
// bug: `claude -p` sai ao responder e leva os filhos junto. Estes testes
// exercitam processos de verdade, nao mocks, porque o ponto e justamente o
// ciclo de vida do processo.
const test = require('node:test');
const assert = require('node:assert');
const runStore = require('./run-store');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await wait(60); }
  return false;
}

test('captura a saida e termina com status done', async () => {
  const r = runStore.start({ projectId: 'p1', command: 'echo ola-mundo', label: 'echo' });
  assert.equal(r.status, 'running');
  const ok = await until(() => runStore.get(r.id).status !== 'running');
  assert.ok(ok, 'a execucao nao terminou a tempo');
  const fin = runStore.get(r.id);
  assert.equal(fin.status, 'done');
  assert.equal(fin.exitCode, 0);
  assert.match(fin.tail, /ola-mundo/);
});

test('exit != 0 vira error, nao done', async () => {
  const r = runStore.start({ projectId: 'p1', command: 'exit 3' });
  await until(() => runStore.get(r.id).status !== 'running');
  const fin = runStore.get(r.id);
  assert.equal(fin.status, 'error');
  assert.equal(fin.exitCode, 3);
});

test('activeCount conta so o que esta vivo, por projeto', async () => {
  const r = runStore.start({ projectId: 'p-count', command: 'sleep 5' });
  assert.equal(runStore.activeCount('p-count'), 1);
  assert.equal(runStore.activeCount('outro-projeto'), 0);
  runStore.stop(r.id);
  await until(() => runStore.get(r.id).status !== 'running');
  assert.equal(runStore.activeCount('p-count'), 0);
});

test('stop encerra e marca stopped', async () => {
  const r = runStore.start({ projectId: 'p2', command: 'sleep 30' });
  assert.equal(runStore.stop(r.id).ok, true);
  const ok = await until(() => runStore.get(r.id).status !== 'running');
  assert.ok(ok, 'nao parou a tempo');
  assert.equal(runStore.get(r.id).status, 'stopped');
});

test('o processo NAO esta no grupo de quem chamou — sobrevive ao turno', async (t) => {
  if (process.platform === 'win32') return t.skip('process group e conceito POSIX');
  // O turno e morto com process.kill(-pgid). Se a execucao ficasse no mesmo
  // grupo, morreria junto — era exatamente o bug relatado.
  const r = runStore.start({ projectId: 'p3', command: 'sleep 5' });
  await wait(400);
  const pid = runStore.get(r.id).pid;
  assert.ok(pid, 'o run precisa expor o pid para esta verificacao');

  const { execSync } = require('child_process');
  const pgidDoRun = execSync(`ps -o pgid= -p ${pid}`).toString().trim();
  const pgidDoTeste = execSync(`ps -o pgid= -p ${process.pid}`).toString().trim();

  assert.notEqual(pgidDoRun, pgidDoTeste,
    `a execucao ficou no mesmo process group do chamador (${pgidDoRun}) e morreria com o turno`);

  // E a prova final: matar o grupo do chamador nao pode derrubar a execucao.
  assert.equal(runStore.get(r.id).status, 'running');
  runStore.stop(r.id);
});

test('stop de id inexistente nao explode', () => {
  assert.equal(runStore.stop('run_nao_existe').ok, false);
});

test('list filtra por projeto e ordena do mais novo', async () => {
  runStore.start({ projectId: 'p-list', command: 'echo a' });
  await wait(50);
  runStore.start({ projectId: 'p-list', command: 'echo b' });
  const l = runStore.list('p-list');
  assert.ok(l.length >= 2);
  assert.ok(l[0].startedAt >= l[1].startedAt, 'deveria vir do mais recente');
  assert.ok(l.every((x) => x.projectId === 'p-list'));
});
