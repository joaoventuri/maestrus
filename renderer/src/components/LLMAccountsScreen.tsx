import { Bot, Gauge } from 'lucide-react';
import ClaudeAccounts from './ClaudeAccounts';
import { useT } from '../lib/i18n';

/**
 * Contas LLM — o cockpit das contas que pagam os turnos.
 *
 * UMA lista (a mesma máquina de contas usada no resto do app — e-mail, plano,
 * troca, criar/remover) com o uso OFICIAL expansível por conta: sessão de 5h,
 * semana e semana por modelo, direto da mesma fonte do /usage do Claude Code.
 * A primeira versão desta tela duplicava a lista com um leitor próprio de
 * credenciais — duas verdades na mesma tela, as duas discordando. Nunca mais.
 */
export default function LLMAccountsScreen() {
  const { t } = useT();
  return (
    <div className="cloud-screen remote-web-screen">
      <div className="cloud-grid" />
      <div className="remote-stack remote-web">
        <div className="remote-web-head">
          <h1><Bot size={22} style={{ verticalAlign: '-3px', marginRight: 8 }} />{t('llm.title')}</h1>
          <p>{t('llm.sub')}</p>
        </div>
        <div className="cloud-card remote-card span-2">
          <div className="remote-head">
            <Gauge size={24} />
            <div>
              <div className="remote-title">{t('llm.claudeTitle')}</div>
              <div className="remote-sub">{t('llm.claudeSub')}</div>
            </div>
          </div>
          <ClaudeAccounts withUsage />
        </div>
      </div>
    </div>
  );
}
