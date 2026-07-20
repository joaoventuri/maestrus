// Indicador de atividade por projeto: 3 bolinhas pulsando (respondendo) ou um
// ponto cheio (terminou, não lido). Usado na sidebar do desktop e na lista do
// PWA. Lê o status do activity-store global.
import { Activity } from '../lib/activity-store';

export function WorkingDots() {
  return (
    <span className="act-dots" aria-label="respondendo">
      <i /><i /><i />
    </span>
  );
}

export default function ActivityIndicator({ activity }: { activity: Activity | null }) {
  if (!activity) return null;
  if (activity.status === 'working') return <WorkingDots />;
  if (activity.status === 'unread') return <span className="act-unread" aria-label="resposta nova" />;
  return null;
}
