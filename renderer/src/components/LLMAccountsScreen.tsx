import { useEffect, useState } from 'react';
import { Bot, Gauge, Users, UserRound, Loader2 } from 'lucide-react';
import ClaudeAccounts from './ClaudeAccounts';
import { useT } from '../lib/i18n';

/**
 * Contas LLM — o cockpit das contas que pagam os turnos.
 *
 * Card 1: SUAS contas (lista única — e-mail, plano, troca, criar/remover) com
 * o uso oficial expansível por conta. Card 2: as contas DO TIME — cada acesso
 * compartilhado e qual conta do Claude ele gasta, com atalho pra configurar.
 * (A resposta de "como seto a conta que vai pro compartilhamento" tem que
 * estar NESTA tela, não escondida atrás de um ícone em outra.)
 */
export default function LLMAccountsScreen({ onOpenSharing }: { onOpenSharing?: () => void }) {
  const { t } = useT();
  const inviteApi = (window as any).maestrus?.invite;
  const [grants, setGrants] = useState<any[] | null>(null);
  const [aiEmails, setAiEmails] = useState<Record<string, string>>({});
  const [projNames, setProjNames] = useState<Record<string, string>>({});

  useEffect(() => {
    (window as any).maestrus?.projects?.list?.().then((ps: any[]) => {
      const m: Record<string, string> = {};
      for (const p of ps || []) { m[p.id] = p.name; const short = String(p.id).split(':').pop(); if (short) m[short] = p.name; }
      setProjNames(m);
    }).catch(() => {});
    inviteApi?.grants?.().then(async (r: any) => {
      const gs = r?.grants || [];
      setGrants(gs);
      // e-mail da conta de cada acesso (best-effort, em paralelo)
      const pairs = await Promise.all(gs.filter((g: any) => g.aiBound).map(async (g: any) => {
        const st = await inviteApi?.aiAdmin?.('status', g.id, g.hostId).catch(() => null);
        const emails = (st?.accounts || []).map((a: any) => a.email).filter(Boolean);
        return [g.id, emails.length ? emails.join(' + ') : (st?.email || '')] as const;
      }));
      setAiEmails(Object.fromEntries(pairs.filter(([, e]) => e)));
    }).catch(() => setGrants([]));
  }, []);

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
          <ClaudeAccounts withUsage bare />
        </div>

        <div className="cloud-card remote-card span-2">
          <div className="remote-head">
            <Users size={24} />
            <div>
              <div className="remote-title">{t('llm.teamTitle')}</div>
              <div className="remote-sub">{t('llm.teamSub')}</div>
            </div>
          </div>
          {grants === null ? (
            <div className="page-sub"><Loader2 size={13} className="spin" /></div>
          ) : grants.length === 0 ? (
            <p className="cloud-hint">{t('llm.teamEmpty')}</p>
          ) : (
            <div className="llm-team-list">
              {grants.map((g: any) => (
                <div key={g.id} className="llm-team-row">
                  <UserRound size={14} />
                  <span className="llm-team-projects">
                    {g.email ? <strong>{g.email} · </strong> : null}
                    {(g.p || []).slice(0, 3).map((pid: string) => projNames[pid] || pid.slice(0, 8)).join(', ')}
                    {(g.p || []).length > 3 ? ` +${g.p.length - 3}` : ''}
                  </span>
                  <span className={`llm-team-ai ${g.aiBound ? 'own' : ''}`}>
                    {g.aiBound ? (aiEmails[g.id] || t('team.aiOwn')) : t('llm.teamUsesYours')}
                  </span>
                </div>
              ))}
            </div>
          )}
          <button className="cloud-logout" style={{ width: 'auto' }} onClick={onOpenSharing}>
            {t('llm.teamManage')}
          </button>
        </div>
      </div>
    </div>
  );
}
