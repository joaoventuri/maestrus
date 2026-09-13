// Preview VISUAL da tela Contas LLM num navegador: componente real + CSS real,
// window.maestrus simulado. Existe porque UI publicada sem NUNCA ter sido vista
// quebrou três vezes seguidas — agora toda tela nova passa por aqui primeiro.
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './lib/i18n';
import LLMAccountsScreen from './components/LLMAccountsScreen';
import './styles/maestrus.css';

const profiles = [
  { id: 'default', name: 'Principal', email: 'joaonventuri@gmail.com', teamBound: false },
  { id: 'p2', name: 'joaoventuri2020', email: 'joaoventuri2020@gmail.com', teamBound: false },
  { id: 'p3', name: 'Conta 3', email: 'joao.patsdorf@ebpos.com.br', teamBound: false },
  { id: 'p4', name: 'Conta 4', email: 'cirillo.sales@ebpos.com.br', teamBound: true },
];
let active = 'p2';
const usage = {
  ok: true, limits: [
    { kind: 'session', label: 'Sessão atual (janela de 5h)', percent: 34, severity: 'normal', resetsAt: new Date(Date.now() + 2.2 * 3600e3).toISOString(), active: true },
    { kind: 'weekly_all', label: 'Semana — todos os modelos', percent: 62, severity: 'normal', resetsAt: new Date(Date.now() + 3 * 86400e3).toISOString(), active: false },
    { kind: 'weekly_scoped', label: 'Semana — Fable 5.1', percent: 88, severity: 'warning', resetsAt: new Date(Date.now() + 3 * 86400e3).toISOString(), active: false },
  ],
};
(window as any).maestrus = {
  platform: 'darwin',
  claudeProfiles: {
    list: async () => ({ ok: true, active, profiles }),
    setActive: async (id: string) => { active = id; return { ok: true, active: id }; },
    listFor: async () => ({ ok: true, active, profiles }),
    setActiveFor: async (_s: any, id: string) => { active = id; return { ok: true, active: id }; },
    statusFor: async () => ({ ok: true }),
    status: async (id: string) => ({ ok: true, loggedIn: id !== 'p3', email: profiles.find(p => p.id === id)?.email, plan: 'max' }),
    create: async () => ({ ok: true, id: 'novo' }),
    remove: async () => ({ ok: true }),
    loginStart: async () => ({ ok: true }),
    loginState: async () => ({ active: false }),
  },
  claude: {
    usage: async ({ profileId }: any) => profileId === 'p3' ? { ok: false, error: 'no_credentials' } : usage,
    onEvent: () => () => {},
  },
  invite: {
    grants: async () => ({ ok: true, grants: [
      { id: 'g1', p: ['mail-server'], w: true, aiBound: true, hostName: 'MacBook' },
      { id: 'g2', p: ['api', 'site'], w: false, aiBound: false },
    ] }),
    aiAdmin: async (op: string) => op === 'status' ? { ok: true, bound: true, loggedIn: true, email: 'tecnologia@ebpos.com.br' } : { ok: true, profiles },
  },
  projects: { list: async () => ([{ id: 'mail-server', name: 'mail-server' }, { id: 'api', name: 'API interna' }, { id: 'site', name: 'Site' }]) },
  app: { getCloudSettings: async () => ({ settings: {} }) },
};
createRoot(document.getElementById('root')!).render(<I18nProvider><LLMAccountsScreen /></I18nProvider>);
