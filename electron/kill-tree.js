/**
 * Matar um turno da IA de verdade — a árvore inteira, não só o processo de cima.
 *
 * O CLI (`claude` ou `codex`) é só a raiz: durante um turno ele spawna
 * sub-agents, ferramentas Bash e servidores MCP, todos processos filhos. Um
 * `proc.kill()` manda SIGTERM só pro PID da raiz — os descendentes ficam órfãos
 * e seguem rodando, gastando token e escrevendo no .jsonl da sessão depois do
 * usuário ter mandado parar.
 *
 * POSIX: quem spawna com `detached: true` vira líder de um process group novo
 * (pgid == pid), e `process.kill(-pgid)` entrega o sinal ao grupo inteiro.
 * Windows: não há process group utilizável aqui, então `taskkill /T` percorre a
 * árvore. É também o único jeito que funciona quando o bin é um `.cmd` e o
 * `proc.pid` é o do `cmd.exe`, não o do CLI.
 */
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

/** Opções de spawn que tornam o processo matável em árvore. Use no spawn do CLI. */
const SPAWN_OPTS = { detached: !IS_WIN, windowsHide: true };

function signal(proc, sig) {
  if (IS_WIN) { proc.kill(sig); return; }
  // O sinal vai pro grupo (pid negativo). Se o processo já morreu, o grupo não
  // existe mais e o ESRCH é esperado — cai no kill direto por garantia.
  try { process.kill(-proc.pid, sig); }
  catch { try { proc.kill(sig); } catch {} }
}

/**
 * Derruba `proc` e todos os seus descendentes. Pede saída limpa primeiro e
 * escala pra SIGKILL se a árvore ainda estiver de pé depois de `graceMs` — um
 * CLI no meio de uma chamada de rede costuma ignorar o SIGTERM.
 * Retorna false se não havia processo vivo pra matar.
 */
function killTree(proc, graceMs = 1500) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return false;

  if (IS_WIN) {
    // /T pega a árvore, /F força. Se o taskkill não estiver disponível, o kill
    // direto abaixo ainda derruba ao menos a raiz.
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
        .on('error', () => { try { proc.kill(); } catch {} });
    } catch { try { proc.kill(); } catch {} }
    return true;
  }

  signal(proc, 'SIGTERM');
  const hard = setTimeout(() => signal(proc, 'SIGKILL'), graceMs);
  // Não segura o event loop do Electron por causa de um timer de 1.5s.
  if (hard.unref) hard.unref();
  proc.once('close', () => clearTimeout(hard));
  return true;
}

module.exports = { killTree, SPAWN_OPTS };
