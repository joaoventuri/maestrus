import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { ChatMessage, ClaudeEvent, ModelChoice, PermissionMode, Project, ThinkingMode } from '../types';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import QuickReplies from './QuickReplies';
import QueuePanel from './QueuePanel';
import AccountPicker from './AccountPicker';
import { computeQuickReplies } from '../lib/quick-replies';
import MetaPanel from './MetaPanel';
import ClaudeMdEditor from './ClaudeMdEditor';
import ClaudeCliConnect from './ClaudeCliConnect';
import CodexCliConnect from './CodexCliConnect';
import SshStatusPill from './SshStatusPill';
import { Volume2, VolumeX, Cpu, Cloud, Mic, CloudCog, Loader2, RefreshCw, X as XIcon, FolderClosed } from 'lucide-react';
import { handleSlash, makeSystemMessage } from '../lib/slash-handler';
import { getContextWindow, getEffectiveContextWindow } from '../lib/model-info';
import { useT } from '../lib/i18n';
import { playDone, isMuted, setMuted } from '../lib/sound';
import { getSnapshot as getActivity, markRead } from '../lib/activity-store';
import { ttsSpeak, ttsCancel, ttsSupported, getSttEngine, sttSupported, unlockAudio, extractSentences, resetSentenceSplitter, resolveSttEngineFromConfig, speakableText } from '../lib/voice';
// JarvisMode importa Three.js (~500KB) — lazy load só quando o usuário
// abre o modo voz. Mantém o main bundle enxuto.
const JarvisMode = lazy(() => import('./JarvisMode'));
import type { VoiceState } from './JarvisMode';
import { RealtimeSession } from '../lib/realtime-voice';
import { KeyRound, ArrowRight, AlertTriangle } from 'lucide-react';
import FilesPanel from './FilesPanel';
import ConnectionStatus from './ConnectionStatus';
import EnginePicker, { EngineId } from './EnginePicker';
import { defaultModelForEngine } from '../lib/model-info';

// Cache de histórico por projeto (sobrevive à troca de aba/projeto na sessão).
// Reabrir uma conversa mostra o cache NA HORA e atualiza em segundo plano —
// fim do "demora demais pra carregar a conversa" no modo remoto.
const histCache = new Map<string, any[]>();

interface Props {
  project: Project;
  onProjectUpdate: (p: Project) => void;
  onOpenMcp?: () => void;
  onOpenSettings?: () => void;
  onOpenLink?: (url: string) => void;
  // Inicializador: abre o modo voz automaticamente ao montar (após o launcher).
  openVoiceOnMount?: boolean;
  onVoiceOpened?: () => void;
}

interface Attachment { path?: string; name: string; dataB64?: string }

// Monta o meta-prompt do Loop Mode: instrui o Claude a decompor o objetivo
// em tarefas e enfileirar via claui_enqueue_task, sem executar diretamente.
function buildLoopPrompt(goal: string, projects: Project[]): string {
  const list = projects
    .filter((p) => p.id !== 'maestrus' && p.id !== 'starter')
    .map((p) => `  • ${p.name}  (id: "${p.id}"${p.model ? ` · model: ${p.model}` : ''})`)
    .join('\n');
  return `[MODO LOOP — ORQUESTRADOR MAESTRUS]
Você está no modo de planejamento e orquestração assíncrona. NÃO execute código, NÃO escreva arquivos, NÃO use /ask ou /parallel.

Objetivo do usuário:
${goal}

Projetos disponíveis para orquestrar:
${list || '  (nenhum projeto configurado — oriente o usuário a criar um)'}

Como proceder:
1. Analise o objetivo e o decomponha em subtarefas independentes e executáveis.
2. Para cada subtarefa, chame claui_enqueue_task:
   • title: título curto e descritivo (max 100 chars)
   • prompt: instrução detalhada e autossuficiente — o agente não tem contexto externo
   • project_id: ID do projeto mais adequado para aquela tarefa
   • max_iterations: 1 para tarefas simples; 3-8 quando precisar de múltiplas tentativas
     (ex: "implemente e faça os testes passarem" → 5; "escreva documentação" → 1)
3. Enfileire em ordem lógica (dependências primeiro quando possível).
4. Ao terminar, responda com um plano claro:
   • Quantas tarefas foram criadas e em quais projetos
   • O que cada tarefa vai fazer e por que escolheu aquele projeto
   • Que os resultados aparecerão neste chat conforme cada tarefa concluir

Regras absolutas:
— NUNCA escreva código diretamente
— NUNCA use /ask nem /parallel — apenas claui_enqueue_task
— Se o objetivo estiver ambíguo, peça clareza antes de enfileirar
— Se não houver projetos configurados, informe e sugira criar um

Comece analisando o objetivo e criando o plano de execução.`;
}

export default function ProjectChat({ project: initialProject, onProjectUpdate, onOpenMcp, onOpenSettings, onOpenLink, openVoiceOnMount, onVoiceOpened }: Props) {
  const { t, lang } = useT();
  const [project, setProject] = useState<Project>(initialProject);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // Janela entre o clique em parar e o turno realmente morrer (até 8s no host
  // remoto). Sem isso o botão fica clicável e sem resposta visual.
  const [stopping, setStopping] = useState(false);
  const busyRef = useRef(false);
  // objectURLs das notas de voz — revogados no unmount pra não vazar o blob.
  const audioUrlsRef = useRef<string[]>([]);
  useEffect(() => () => { audioUrlsRef.current.forEach((u) => { try { u && URL.revokeObjectURL(u); } catch {} }); }, []);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const lastEventRef = useRef(0);
  // Arcade (dock lateral) — abre pelo botão ao lado do stop; fecha sozinho quando
  const [filesOpen, setFilesOpen] = useState(false);

  // WATCHDOG do "pensando": se o UI está busy mas nenhum evento chega há um tempo,
  // pergunta ao host/CLI se o turno AINDA roda. Se não roda (perdemos o 'done' —
  // relay caiu, minimizou o app, socket reconectou), destrava. Também revalida
  // ao voltar o foco/visibilidade. Fim do "pensando eterno".
  async function reconcileBusy(reason: string) {
    if (!busyRef.current) return;
    try {
      const r: any = await (window as any).maestrus?.claude?.isBusy?.(project.id);
      if (r && r.known && r.busy === false) {  // só destrava com resposta CONHECIDA do host
        setBusy(false); busyRef.current = false;
        setMessages((m) => m.map((msg) => (msg.pending ? { ...msg, pending: false } : msg)));
        try { setRecentTools([]); } catch {}
        if (vmodeRef.current && !realtimeRef.current) { try { resetTtsState(); } catch {} speakingRef.current = false; setVstate('idle'); setTimeout(startVoiceListen, 400); }
      } else if (r && r.busy) {
        lastEventRef.current = Date.now(); // ainda pensando de verdade
      }
    } catch {}
  }
  // Ao abrir a conversa, busca a fila que já existe no host — ela pode ter sido
  // enfileirada por outro dispositivo ou antes de fechar o app.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const items = await (window as any).maestrus?.claude?.queueList?.(project.id);
        if (alive && Array.isArray(items)) setQueued(items);
      } catch {}
    })();
    return () => { alive = false; };
  }, [project.id]);

  useEffect(() => {
    const iv = setInterval(() => { if (busyRef.current && Date.now() - lastEventRef.current > 12000) reconcileBusy('idle'); }, 5000);
    const onVis = () => { if (!document.hidden) reconcileBusy('visible'); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
  }, [project.id]);
  // Fila de mensagens: prompts enviados enquanto a IA responde aguardam aqui
  // e são despachados automaticamente quando o turno termina.
  // A fila mora no HOST. Aqui só guardamos o espelho pra desenhar.
  const [queued, setQueued] = useState<Array<{ id: string; text: string }>>([]);

  function enqueueOnHost(text: string, attachments?: Attachment[]) {
    try { (window as any).maestrus?.claude?.queueAdd?.(project.id, text, attachments); } catch {}
  }
  // Status da instância cloud subindo (cold start do sandbox) → banner "iniciando".
  const [cloudStarting, setCloudStarting] = useState(false);
  const [editingMd, setEditingMd] = useState(false);
  const [contextUsed, setContextUsed] = useState(0);
  // Aviso de limite de uso da conta Claude (o CLI manda a cada turno). Só
  // aparece quando aperta — não polui a tela no uso normal.
  const [rateLimit, setRateLimit] = useState<{ status: string; resetsAt: number | null } | null>(null);
  // A conta expirou de verdade (detectado no turno, não no auth status — que
  // reporta loggedIn mesmo com o refresh token morto).
  const [authExpired, setAuthExpired] = useState(false);
  useEffect(() => { setAuthExpired(false); }, [project.id]);

  // Modelo REAL detectado da sessão (.jsonl) — mais fiel que project.model
  // (que pode ser 'default'). Define qual janela de contexto usar no %.
  const [detectedModel, setDetectedModel] = useState<string | null>(null);
  const [muted, setMutedState] = useState(isMuted());
  // Voz ancorada à direita (padrão) em vez de tela cheia: dá pra acompanhar a
  // conversa chegando enquanto ele fala. Lembra a escolha.
  const [voiceDock, setVoiceDock] = useState<boolean>(() => {
    try { return localStorage.getItem('maestrus-voice-dock') !== '0'; } catch { return true; }
  });
  const [engineAvail, setEngineAvail] = useState<Record<EngineId, boolean>>({ claude: true, cloud: false, codex: false, 'codex-api': false });
  // Mensagem pendente aguardando conexão do Claude CLI (login OAuth inline).
  const [cliConnect, setCliConnect] = useState<{ text: string; att?: Attachment[] } | null>(null);
  // Idem para o Codex CLI (auto-instala + login ChatGPT inline).
  const [codexConnect, setCodexConnect] = useState<{ text: string; att?: Attachment[] } | null>(null);
  const streamingRef = useRef<{ buffer: string }>({ buffer: '' });
  // Texto do user adicionado otimista (cloud/remote) p/ dedupe do echo do runner.
  const pendingUserRef = useRef<string | null>(null);
  // Marca que o usuário já interagiu → impede o loadHistory do open (que espera
  // o resume do cloud) de sobrescrever o chat em andamento.
  const interactedRef = useRef(false);
  const lastCostRef = useRef<number | null>(null);
  const lastUsageRef = useRef<any>(null);
  const projectRef = useRef<Project>(initialProject);
  // Soft-lock cross-device: pra saber se o lock é desta máquina ou de outra,
  // comparamos com o hostId desta sessão. Se o lock for de outra E ativo (TTL
  // 5 min), o input fica desabilitado com banner.
  const [thisHostId, setThisHostId] = useState<string>('');
  useEffect(() => { window.maestrus.app.config().then((c) => setThisHostId(c.hostId)); }, []);
  // Acompanha o estado do host cloud (relay) → mostra "iniciando instância…".
  useEffect(() => {
    const off = window.maestrus.remote?.onClientState?.((s: any) => setCloudStarting(s?.status === 'starting'));
    return () => { try { off?.(); } catch {} };
  }, []);
  const lock = project?.lock;
  const lockAgeMs = lock ? Date.now() - lock.at : Infinity;
  const lockActive = !!(lock && lockAgeMs < 5 * 60 * 1000);
  const lockHeldElsewhere = lockActive && lock!.hostId !== thisHostId;

  // ── Modo Voz (Jarvis): fala → STT → envia pro projeto → fala a resposta
  // (TTS streaming por sentença). Overlay full-screen com maestro, música
  // clássica e constelação de tools. Mic suspenso enquanto pensa/fala. ────────
  const voiceOk = ttsSupported() && sttSupported();
  const [vmode, setVmode] = useState(false);
  const [showOaiUpsell, setShowOaiUpsell] = useState(false);
  const [usingRealtime, setUsingRealtime] = useState(false);
  const realtimeRef = useRef<RealtimeSession | null>(null);
  const [vstate, setVstate] = useState<VoiceState>('idle');
  const [vcaption, setVcaption] = useState<string>('');
  const [recentTools, setRecentTools] = useState<{ id: string; name: string; ts: number }[]>([]);
  const vmodeRef = useRef(false); const busyVRef = useRef(false); const speakingRef = useRef(false);
  const sttRef = useRef(getSttEngine());
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);
  const ttsDoneRef = useRef(false);
  const ttsAccumRef = useRef('');
  // Frases já fechadas mas ainda curtas: esperam engrossar o bloco antes de virar
  // fala (evita a voz picada de uma requisição de TTS por frase).
  const ttsBlockRef = useRef('');
  useEffect(() => { vmodeRef.current = vmode; }, [vmode]);
  useEffect(() => { busyVRef.current = busy; }, [busy]);
  // Inicializador: abre o modo voz ao montar (após rodar o launcher). Pequeno
  // delay pra o aiStatus resolver e abrir em Cloud (realtime) se disponível.
  // Reage à MUDANÇA da flag, não só à montagem: com deps [] o wake word só
  // funcionava se a conversa fosse montada naquele instante. Já estando no
  // Maestrus, "olá maestrus" trazia a janela e não abria a voz.
  useEffect(() => {
    if (!openVoiceOnMount || vmodeRef.current) return;
    const id = setTimeout(() => { try { openJarvis(); } catch {} onVoiceOpened?.(); }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openVoiceOnMount]);
  useEffect(() => () => { try { sttRef.current.stop(); ttsCancel(); } catch {} }, []);

  function resetTtsState() {
    ttsQueueRef.current = []; ttsAccumRef.current = ''; ttsBlockRef.current = '';
    ttsDoneRef.current = false; ttsPlayingRef.current = false;
    resetSentenceSplitter();
  }
  function playTtsQueue() {
    // No Realtime quem fala é ele: o TTS aqui produzia UMA SEGUNDA VOZ por cima,
    // com outro timbre, lendo a mesma resposta. Este guard é o ponto único que
    // impede isso — todos os caminhos de fala passam por aqui.
    if (realtimeRef.current) return;
    if (ttsPlayingRef.current || !ttsQueueRef.current.length || !vmodeRef.current) return;
    const sentence = ttsQueueRef.current.shift()!;
    ttsPlayingRef.current = true; speakingRef.current = true; setVstate('speaking');
    // Legenda = MESMO texto que vai ser falado (limpo). Antes mostrava o cru,
    // com asterisco e caminho de arquivo, enquanto a voz dizia outra coisa.
    setVcaption(speakableText(sentence));
    // BARGE-IN AUTOMÁTICO DESLIGADO. O detector não tem como separar a voz DELA
    // (que sai pelo alto-falante) da SUA: as duas são voz humana, mesma faixa,
    // sustentada — o cancelamento de eco do sistema não dá conta, então ela se
    // cortava sozinha no meio da frase. Interromper agora é ação explícita: o
    // botão de pausa. Melhor previsível do que "inteligente" e errado.
    ttsSpeak(sentence, lang as any, () => {
      ttsPlayingRef.current = false;
      if (!vmodeRef.current) { speakingRef.current = false; return; }
      if (!speakingRef.current) return;        // você interrompeu: quem manda agora é a captura
      if (ttsQueueRef.current.length > 0) { playTtsQueue(); return; }
      if (ttsDoneRef.current) { speakingRef.current = false; setVstate('listening'); setVcaption(''); setTimeout(() => startVoiceListen(), 200); }
    });
  }
  // Agrupa frases em BLOCOS antes de falar. Falar frase a frase deixava a voz
  // picada (uma requisição de TTS por frase, com pausa entre elas). Agora só
  // manda quando junta um bloco com sentido (~220 chars) ou no fim do turno —
  // fica contínuo e natural, sem perder a rapidez da primeira fala.
  const TTS_BLOCK_CHARS = 220;
  function flushTtsAccum(force = false) {
    const { sentences, remaining } = extractSentences(ttsAccumRef.current);
    ttsAccumRef.current = remaining;
    let block = ttsBlockRef.current;
    for (const s of sentences) {
      block = block ? `${block} ${s}` : s;
      if (block.length >= TTS_BLOCK_CHARS) { ttsQueueRef.current.push(block); block = ''; }
    }
    // A PRIMEIRA fala do turno sai na hora (latência baixa); as seguintes esperam
    // o bloco engrossar, pra soar contínuo em vez de picado.
    const primeiraFala = !ttsQueueRef.current.length && !ttsPlayingRef.current;
    if (block && (force || primeiraFala)) { ttsQueueRef.current.push(block); block = ''; }
    ttsBlockRef.current = block;
    if (force && ttsAccumRef.current.trim()) { ttsQueueRef.current.push(ttsAccumRef.current.trim()); ttsAccumRef.current = ''; }
  }

  // Escuta com BARGE-IN: pode ser chamada ENQUANTO a IA fala. Nesse modo o
  // detector exige voz de verdade (banda 300–3400Hz + duração), então ruído
  // ambiente e o eco da própria IA não cortam a fala dela — só você corta.
  function startVoiceListen(whileSpeaking = false) {
    if (!vmodeRef.current || busyVRef.current) return;
    if (!whileSpeaking && speakingRef.current) return;
    if (!whileSpeaking) {
      // ENCERRA a captura do barge-in antes de abrir a escuta normal. Ela fica
      // ativa enquanto a IA fala e, como o engine ignora um start() com captura
      // em curso, a escuta do turno seguinte nunca começava: o mic pulsava (a
      // captura antiga seguia viva, no modo rígido) mas nada era transcrito —
      // era o "no segundo round fica parado em Ouvindo".
      try { sttRef.current.stop(); } catch {}
      setVstate('listening'); setVcaption('');
    }
    sttRef.current.start(lang as any, {
      // Sua voz CONFIRMADA no meio da fala dela → cala a IA na hora e passa a
      // ouvir você (o que você disser vira o próximo turno).
      onSpeechStart: () => {
        if (!speakingRef.current) return;
        try { ttsCancel(); resetTtsState(); } catch {}
        speakingRef.current = false;
        setVstate('listening');
      },
      onInterim: (txt: string) => { setVcaption(txt); },
      // Fechou a frase → PENSANDO (o agente está trabalhando). O orb só volta a
      // "ouvindo" quando ela termina de falar. Antes ia pra 'idle' e a tela
      // parecia parada/morta enquanto o agente pensava.
      onFinal: (txt: string) => { setVstate('thinking'); setVcaption(txt); send(txt); },
      onEnd: () => {
        if (!vmodeRef.current || busyVRef.current) return;
        if (speakingRef.current) return;   // ela está falando: o mic volta quando terminar
        setTimeout(() => startVoiceListen(), 350);
      },
      // Falha REAL do STT vira legenda visível (antes voltava pra "Ouvindo" mudo).
      onError: (e: string) => {
        if (e === 'no_api_key') { setVcaption(t('byok.voiceNeedsKey') || 'Adicione sua chave OpenAI em Ajustes para usar a voz.'); return; }
        if (e === 'mic') { setVcaption(t('voice.micDenied') || 'Sem acesso ao microfone.'); return; }
        if (e && e !== 'rec') setVcaption(String(e).slice(0, 120));
        if (vmodeRef.current && !busyVRef.current && !speakingRef.current) setTimeout(() => startVoiceListen(), 900);
      },
    }, { speaking: whileSpeaking });
  }
  // Voz turn-based (STT/TTS server-metered, GRÁTIS pro usuário) — base universal
  // desktop+PWA. Antes o desktop só tinha Realtime OU upsell: todo o código
  // turn-based (startVoiceListen/TTS) era MORTO no desktop e a voz grátis ficava
  // inalcançável.
  function openTurnBasedJarvis() {
    setVmode(true); vmodeRef.current = true;
    // Avisa o HOST que estamos em voz: ele injeta a diretriz de fala (respostas
    // curtas, sem markdown) + a persona do Maestrus no system prompt — sem
    // poluir o histórico. Best-effort: se falhar, a voz funciona igual.
    try { patchProject({ voiceMode: true } as any); } catch {}
    setUsingRealtime(false);
    unlockAudio(); resetTtsState(); setRecentTools([]);
    setVstate('listening'); setVcaption('');
    setTimeout(startVoiceListen, 250);
  }
  async function openJarvis() {
    if (vmode) return;
    // A VOZ É O REALTIME: ele é a boca e o ouvido, e o agente do projeto é o
    // cérebro que ele aciona por tool (dispatch_project).
    //
    // O caminho antigo (STT → agente → TTS em chunks) tinha três problemas
    // estruturais: você esperava o raciocínio INTEIRO antes de ouvir qualquer
    // coisa; o texto do agente vem cheio de caminho e número, que soam péssimos
    // falados; e cada chunk de TTS era um request separado, então o tom mudava
    // no meio da frase. O Realtime resolve os três: responde na hora, mantém uma
    // sessão só (tom contínuo) e RESUME o resultado do agente em vez de recitar.
    //
    // O modo por turnos continua disponível como fallback quando o Realtime não
    // sobe (rede, região, conta sem acesso).
    try {
      const k: any = await (window as any).maestrus?.openaiKey?.has?.();
      if (!k || !k.has) { setShowOaiUpsell(true); return; }
    } catch { setShowOaiUpsell(true); return; }
    openRealtimeJarvis();
  }
  async function openRealtimeJarvis() {
    setVmode(true); vmodeRef.current = true;
    setUsingRealtime(true);
    unlockAudio(); resetTtsState(); setRecentTools([]);
    setVstate('listening'); setVcaption('');
    const session = new RealtimeSession({
      projectId: project.id,
      lang: (((window as any).maestrus?.lang) || 'pt') as any,
      onStatus: (s: any) => {
        if (s.status === 'connected') setVstate('listening');
        else if (s.status === 'error') {
          setVcaption(s.message || 'error');
          // Erro FATAL da Realtime (schema/modelo — ex.: a OpenAI virou a API):
          // a sessão nunca vai funcionar. Em vez de deixar a voz morta, desce
          // pro modo turn-based (STT+TTS+CLI), que não depende desse schema.
          if (s.fatal && vmodeRef.current) {
            try { realtimeRef.current?.stop(); } catch {}
            realtimeRef.current = null; setUsingRealtime(false);
            setTimeout(() => { if (vmodeRef.current) openTurnBasedJarvis(); }, 150);
          }
        }
      },
      onUserText: (text, done) => { if (done) setVcaption(text); },
      onAssistantText: (text, done) => {
        setVstate('speaking');
        if (done) setTimeout(() => { if (vmodeRef.current) setVstate('listening'); }, 200);
      },
      onToolCall: (name) => { setRecentTools((rt) => [...rt.slice(-2), { name, status: 'running' as const }]); },
      onToolResult: (name, ok) => { setRecentTools((rt) => rt.map((t) => t.name === name ? { ...t, status: (ok ? 'done' : 'error') as any } : t)); },
      onAudioLevel: () => { /* poderia animar o orb com isso */ },
    });
    const r = await session.start();
    if (!r.ok) {
      // Realtime falhou (rede/chave/limite) → em vez de FECHAR MUDO, cai pra voz
      // grátis turn-based. O usuário continua no modo voz sem perceber a troca.
      setUsingRealtime(false);
      openTurnBasedJarvis();
      return;
    }
    realtimeRef.current = session;
  }
  function closeJarvis() {
    setVmode(false); vmodeRef.current = false;
    try { patchProject({ voiceMode: false } as any); } catch {} // volta ao registro normal (texto)
    // Fechar tem que CALAR na hora, sem exceção: antes o TTS já enfileirado
    // continuava falando depois da tela sumir. Mata os dois caminhos sempre,
    // não só o que estava ativo.
    try { ttsCancel(); } catch {}
    try { resetTtsState(); } catch {}
    ttsQueueRef.current = [];
    ttsAccumRef.current = '';
    ttsPlayingRef.current = false;
    speakingRef.current = false;
    if (realtimeRef.current) {
      try { realtimeRef.current.stop(); } catch {}
      realtimeRef.current = null; setUsingRealtime(false);
    } else {
      try { sttRef.current.stop(); } catch {}
      ttsCancel(); resetTtsState();
      speakingRef.current = false;
    }
    setVstate('idle'); setVcaption('');
  }
  function pauseVoice() {
    if (realtimeRef.current) {
      try { realtimeRef.current.interrupt(); } catch {}
      setVstate('listening');
      return;
    }
    ttsCancel(); resetTtsState();
    speakingRef.current = false;
    try { window.maestrus.claude.stop(project.id); } catch {}
    busyVRef.current = false; setBusy(false); setVstate('idle'); setVcaption('');
    setTimeout(startVoiceListen, 250);
  }

  // Estado efetivo pro Jarvis — "thinking" sempre que a IA está respondendo
  // mas ainda não começou a falar (sem áudio na fila).
  const jarvisState: VoiceState = busy && vstate !== 'speaking' ? 'thinking' : vstate;

  useEffect(() => {
    setProject(initialProject);
    projectRef.current = initialProject;
  }, [initialProject.id]);

  // Disponibilidade de cada engine. Regra:
  //  • "Claude CLI" = assinatura do usuário (OAuth). No WEB/PWA só existe quando
  //    o projeto roda numa MÁQUINA/container conectado (o host usa o CLI de lá).
  //  • "Claude API" (id interno 'cloud') = a API KEY da Anthropic do PRÓPRIO
  //    usuário (BYOK) — configurada em Configurações → Claude API. Sem proxy,
  //    sem billing do Maestrus. Disponível quando a chave existe na conta.
  // Rede de segurança: se o app fechou no meio do modo voz, o projeto ficaria
  // preso no registro falado (respostas curtas no chat de texto). Limpa ao abrir.
  useEffect(() => {
    if ((project as any).voiceMode && !vmodeRef.current) {
      try { patchProject({ voiceMode: false } as any); } catch {}
    }
  }, [project.id]);

  useEffect(() => {
    (async () => {
      try {
        // ONDE ESTE PROJETO RODA decide de quem é o login que importa. O
        // orquestrador "Maestrus" e o Inicializador rodam SEMPRE nesta máquina
        // (o host nem os anuncia), então num client conectado a um host eles
        // precisam do login LOCAL — perguntar ao host daria "ok" pra uma
        // conversa que na verdade roda aqui.
        const rodaLocal = !project.remoteHostId && !(project as any).cloud && project.source !== ('cloud' as any);
        const [s, key, oai] = await Promise.all([
          window.maestrus.claudeAuth.status(rodaLocal ? { local: true } : undefined),
          (window as any).maestrus?.anthropicKey?.has?.().catch(() => ({ has: false })),
          (window as any).maestrus?.openaiKey?.has?.().catch(() => ({ has: false })),
        ]);
        const isWeb = !!(window as any).maestrus?.isWeb;
        const projCloud = !!(project as any).cloud || project.source === 'cloud';
        const projRemoteMachine = !!project.remoteHostId && !projCloud;
        // CLIs (Claude/Codex) precisam de uma MÁQUINA (local/host/container).
        // A auth real do Codex CLI é checada no envio (erro claro se não logado).
        let cliAvail: boolean;
        if (projCloud) cliAvail = true;
        else if (projRemoteMachine) cliAvail = true;
        else if (isWeb) cliAvail = false;
        else cliAvail = true;                                // desktop tem os CLIs instalados
        const claudeCli = cliAvail && (projCloud || projRemoteMachine || isWeb ? true : !!(s && s.loggedIn));
        setEngineAvail({
          claude: claudeCli,
          cloud: !!(key && key.has),
          codex: cliAvail,                                   // Codex CLI (assinatura ChatGPT)
          'codex-api': !!(oai && oai.has),                   // Codex API (chave OpenAI, reusa o cofre)
        });
      } catch { /* mantém default */ }
    })();
  }, [project.id]);

  const engine: EngineId = (project.engine as any) || 'claude';
  async function setEngine(e: EngineId) {
    if (e === engine) return;
    // Não troca pra um engine indisponível — mensagem clara em vez de erro no envio.
    if (!engineAvail[e]) {
      const projCloud = !!(project as any).cloud || project.source === 'cloud';
      const msg = e === 'claude' ? (projCloud ? t('engine.cloudLocked') : t('engine.needClaude'))
        : e === 'cloud' ? t('engine.needCloud')
        : e === 'codex' ? (t('engine.needCodex') || 'Faça login no Codex (Ajustes → Codex CLI).')
        : (t('engine.needCodexApi') || 'Adicione sua chave OpenAI (Ajustes → Codex API).');
      pushSystem(msg);
      return;
    }
    // Ao trocar de provedor, ajusta o modelo pro default do novo provedor
    // (Claude↔OpenAI usam ids diferentes; passar um id do outro provedor falha).
    const patch: any = { engine: e };
    const curModel = project.model;
    const isOpenaiModel = !!curModel && (curModel.startsWith('gpt-') || curModel.includes('codex'));
    const wantOpenai = e === 'codex' || e === 'codex-api';
    if (isOpenaiModel !== wantOpenai) patch.model = defaultModelForEngine(e);
    await patchProject(patch);
  }

  useEffect(() => {
    // No cloud, loadHistory espera o resume (~60s). Se o usuário já mandou uma
    // msg nesse meio tempo, NÃO sobrescreve (era o bug da msg que sumia: o
    // loadHistory do open resolvia tarde e clobberava o chat em andamento).
    interactedRef.current = false;
    // Continuidade: se o store global já sabe que este projeto está respondendo
    // (turno iniciado em outra aba / antes de abrir), mostra o "trabalhando" na
    // hora — sem isso, abria parado e só "acordava" no próximo delta. Marca lido.
    const act = getActivity()[project.id];
    if (act && act.status === 'working') setBusy(true);
    markRead(project.id);
    // 1) Mostra o cache NA HORA (reabrir é instantâneo). 2) Busca o fresco e
    // atualiza. Se não tem cache, mostra "carregando" natural até chegar.
    const cached = histCache.get(project.id);
    if (cached && !interactedRef.current) { setMessages(cached); applyCtxFromHistory(cached); }
    (async () => {
      const history = await window.maestrus.claude.loadHistory(project.id);
      if (Array.isArray(history) && history.length) {
        histCache.set(project.id, history);
        if (!interactedRef.current) { setMessages(history); applyCtxFromHistory(history); }
      } else if (!cached && !interactedRef.current) {
        setMessages(Array.isArray(history) ? history : []); // conversa nova/vazia de verdade
      }
      // fresh vazio COM cache → mantém o cache (não apaga por timeout).
    })();
  }, [project.id]);

  // Lê a ocupação REAL do contexto anexada pelo loadHistory (usage + model do
  // último turno da sessão .jsonl) e mostra o % correto já na abertura — sem
  // esperar um novo prompt e sem resetar pra 0.
  function applyCtxFromHistory(history: any[]) {
    if (!Array.isArray(history)) return;
    let cu: any = null, cm: string | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if ((history[i] as any).ctxUsage) { cu = (history[i] as any).ctxUsage; cm = (history[i] as any).ctxModel || null; break; }
    }
    if (cu) {
      const used = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0);
      setContextUsed(used);
      lastUsageRef.current = cu;
      if (cm) setDetectedModel(cm);
    } else {
      // Conversa vazia/nova (ou pós-compactação sem turno ainda) → contexto zero, honesto.
      setContextUsed(0);
    }
  }

  useEffect(() => {
    const off = window.maestrus.claude.onEvent((evt: ClaudeEvent) => {
      if (evt.projectId !== project.id) return;
      lastEventRef.current = Date.now();

      if (evt.type === 'user') {
        // dedupe: se acabamos de adicionar essa mesma msg otimisticamente
        // (cloud/remote), não duplica o balão.
        if (pendingUserRef.current && evt.text === pendingUserRef.current) { pendingUserRef.current = null; return; }
        setMessages((m) => [...m, { role: 'user', text: evt.text, timestamp: evt.timestamp }]);
        return;
      }
      if (evt.type === 'delta' && evt.text) {
        // realtimeRef: a fala é do Realtime, então nem acumulamos texto pro TTS.
        if (vmodeRef.current && !realtimeRef.current) {
          ttsAccumRef.current += evt.text;
          flushTtsAccum();
          if (ttsQueueRef.current.length > 0) playTtsQueue();
        }
        setMessages((m) => {
          const last = m[m.length - 1];
          if (last && last.role === 'assistant' && last.pending) {
            const next = [...m];
            next[next.length - 1] = { ...last, text: (last.text || '') + evt.text };
            return next;
          }
          return [...m, { role: 'assistant', text: evt.text, pending: true }];
        });
        return;
      }
      if (evt.type === 'assistant-text' && evt.text) {
        setMessages((m) => {
          const last = m[m.length - 1];
          if (last && last.role === 'assistant' && last.pending) {
            const next = [...m];
            next[next.length - 1] = { ...last, text: evt.text!, pending: false };
            return next;
          }
          return [...m, { role: 'assistant', text: evt.text }];
        });
        return;
      }
      if (evt.type === 'thinking' && evt.text) {
        setMessages((m) => [...m, { role: 'thinking', text: evt.text }]);
        return;
      }
      if (evt.type === 'ask-user-question') {
        setMessages((m) => {
          // Mescla na mensagem pendente do streaming (se existir) ou cria nova
          const last = m.length > 0 ? m[m.length - 1] : null;
          if (last && last.role === 'assistant' && last.pending) {
            const next = [...m];
            next[next.length - 1] = { ...last, text: (evt as any).text || last.text, questions: (evt as any).questions, pending: false };
            return next;
          }
          return [...m, { role: 'assistant', text: (evt as any).text, questions: (evt as any).questions }];
        });
        return;
      }
      if (evt.type === 'tool-use') {
        setMessages((m) => [...m, { role: 'tool-use', name: evt.name, input: evt.input, id: evt.id }]);
        // Feed da constelação de tools do Jarvis — mantém só as últimas 12.
        if (vmodeRef.current && evt.name) {
          setRecentTools((prev) => {
            const next = [...prev, { id: evt.id || `${Date.now()}_${prev.length}`, name: evt.name!, ts: Date.now() }];
            return next.length > 12 ? next.slice(-12) : next;
          });
        }
        return;
      }
      if (evt.type === 'tool-result') {
        setMessages((m) => [...m, {
          role: 'tool-result',
          toolUseId: evt.toolUseId,
          text: evt.text,
          isError: evt.isError,
        }]);
        return;
      }
      // Usage mid-turn (cada mensagem do assistant traz `usage` parcial). O
      // Claude Code atualiza o contador AO VIVO assim que a primeira resposta
      // chega; sem isso, o Maestrus só atualiza no `result` (fim do turno) e
      // a porcentagem fica desatualizada durante a conversa.
      if ((evt as any).type === 'rate-limit') {
        const e: any = evt;
        // 'allowed' puro = tudo bem, não mostra nada. Aviso/rejeição aparecem.
        setRateLimit(e.status && e.status !== 'allowed' ? { status: e.status, resetsAt: e.resetsAt || null } : null);
        return;
      }
      if ((evt as any).type === 'usage' && (evt as any).usage) {
        const u = (evt as any).usage;
        lastUsageRef.current = u;
        const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        setContextUsed(used);
        return;
      }
      if (evt.type === 'result' && evt.evt) {
        const r = evt.evt;
        if (typeof r.total_cost_usd === 'number') lastCostRef.current = r.total_cost_usd;
        // IMPORTANTE: r.usage do `result` é CUMULATIVO — soma todas as chamadas
        // internas do turno (cada round-trip de tool-use). NÃO serve pra ocupação
        // da janela de contexto (estourava pra milhões num turno com muitas
        // tools). A ocupação real vem do evento 'usage' por-mensagem (a última
        // chamada do turno = contexto atual). Aqui só guardamos pra custo.
        if (r.usage) lastUsageRef.current = r.usage;
        return;
      }
      if (evt.type === 'system' && evt.text) {
        setMessages((m) => [...m, { role: 'system', text: evt.text }]);
        return;
      }
      if (evt.type === 'error') {
        setMessages((m) => [...m, { role: 'error', text: evt.text }]);
        setBusy(false);
        busyRef.current = false; busyVRef.current = false;
        // Modo voz turn-based: DEVOLVE o mic após erro (rate limit, rede, tool
        // falhou). Antes o handler só zerava busy e o orb morria — o mic nunca
        // voltava e o usuário ficava falando com uma tela morta. (Realtime trata
        // erro na própria sessão, não por aqui.)
        if (vmodeRef.current && !realtimeRef.current) {
          try { resetTtsState(); } catch {}
          speakingRef.current = false; setVstate('idle'); setVcaption('');
          setTimeout(startVoiceListen, 500);
        }
        return;
      }
      // A fila mudou no host (por este device ou por outro): espelha.
      // Sessão da conta morreu: o CLI só descobre ao usar, então este é o
      // único ponto em que dá pra saber de verdade.
      if ((evt as any).type === 'auth-expired') {
        setAuthExpired(true);
        return;
      }
      if ((evt as any).type === 'queue') {
        setQueued(Array.isArray((evt as any).items) ? (evt as any).items : []);
        return;
      }
      if (evt.type === 'done') {
        setMessages((m) => m.map((msg) => (msg.pending ? { ...msg, pending: false } : msg)));
        setBusy(false);
        busyRef.current = false;
        setRecentTools([]); // limpa constelação ao fim do turno
        // Turno cancelado pelo usuário: não continua a fila, não toca floreio e
        // não notifica "a IA terminou" — ela não terminou, foi parada.
        if (evt.cancelled) { setStopping(false); return; }
        // Quem drena a fila é o HOST (electron/turn-queue.js): o próximo turno
        // chega como evento normal, então aqui não há nada a despachar.
        // Modo voz: flush do acumulador e fala por fila de sentenças.
        if (vmodeRef.current) {
          ttsDoneRef.current = true;
          flushTtsAccum(true);
          if (ttsQueueRef.current.length > 0) { playTtsQueue(); }
          else if (!ttsPlayingRef.current) { speakingRef.current = false; setVstate('idle'); setVcaption(''); setTimeout(startVoiceListen, 200); }
        }
        // Som de floreio + notificação nativa quando a IA termina.
        playDone();
        const proj = projectRef.current;
        window.maestrus.app.notify(proj?.name ? `Maestrus · ${proj.name}` : 'Maestrus', t('chat.aiFinished'));
        return;
      }
    });
    return off;
  }, [project.id]);

  function pushSystem(text: string) {
    setMessages((m) => [...m, makeSystemMessage(text)]);
  }
  async function reloadHistory() {
    const history = await window.maestrus.claude.loadHistory(project.id);
    if (Array.isArray(history) && history.length) { histCache.set(project.id, history); setMessages(history); applyCtxFromHistory(history); }
  }
  function pushSystemHtml(html: string) {
    setMessages((m) => [...m, { role: 'system', html, timestamp: Date.now() }]);
  }
  // dispatchSeed: re-injeta resposta orquestrada como turn de user, sem UI duplicada.
  // Chega como mensagem do user pro claude conseguir contextualizar.
  async function dispatchSeed(seed: string) {
    setBusy(true);
    try {
      await window.maestrus.claude.send(project.id, seed);
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'error', text: e.message }]);
      setBusy(false);
    }
  }

  async function patchProject(patch: Partial<Project>) {
    const res: any = await window.maestrus.projects.patch(project.id, patch).catch(() => null);
    // projeto cloud (stub) não está no store local → patch pode voltar null.
    // Nunca seta null (era o crash "reading 'lock'"); aplica o patch localmente.
    const next = (res && res.id) ? res : { ...project, ...patch };
    setProject(next);
    projectRef.current = next;
    onProjectUpdate(next);
    // Trocas de modelo/thinking/permissão precisam chegar no host. Se o host não
    // confirmou (__ok:false ou res null), avisa em vez de fingir sucesso — o
    // próximo turno só usa o novo modelo se o servidor tiver recebido a troca.
    const confirmed = !!(res && res.id && res.__ok !== false);
    if (!confirmed && (patch.model || patch.thinkingMode || patch.permissionMode)) {
      pushSystem(t('model.switchFailed'));
    }
    return next;
  }

  function formatWithAttachments(text: string, attachments?: Attachment[]): string {
    if (!attachments || attachments.length === 0) return text;
    const refs = attachments.filter((a) => a.path).map((a) => `@${a.path}`).join(' ');
    if (!refs) return text;
    return text ? `${refs}\n\n${text}` : refs;
  }

  // Anexos num projeto que roda em HOST remoto (client desktop/web → Mac mini
  // ou container): o path local do client é INACESSÍVEL lá. Sobe o conteúdo
  // pro host e usa o path devolvido. Projeto local = no-op (mantém o path).
  function friendlyUploadErr(code?: string): string {
    const m: Record<string, string> = {
      too_big: 'arquivo grande demais (máx. 50 MB)',
      not_connected: 'sem conexão com a máquina/host — reconecte e tente de novo',
      no_content: 'não consegui ler o arquivo',
      write_failed: 'a máquina não conseguiu salvar o arquivo (permissão de escrita?)',
      file_not_found: 'o arquivo sumiu antes de enviar',
      'acesso-negado': 'sem permissão pra enviar arquivo neste workspace',
      'permissao-negada-viewer': 'você está como somente-leitura neste workspace',
    };
    return code && m[code] ? m[code] : (code || 'erro desconhecido');
  }
  async function resolveAttachments(attachments?: Attachment[]): Promise<Attachment[] | undefined> {
    if (!attachments || attachments.length === 0) return attachments;
    const up = (window as any).maestrus?.files?.uploadToHost;
    if (!up) return attachments;
    const resolved: Attachment[] = [];
    for (const a of attachments) {
      try {
        const r = await up(project.id, a);
        // Prefere o caminho RELATIVO (sem espaço; @ resolve pelo cwd do projeto).
        if (r && r.ok && (r.rel || r.path)) { resolved.push({ name: a.name, path: r.rel || r.path }); continue; }
        // Sem path resolvido: NÃO manda o @ quebrado (era o "arquivo não encontrado").
        pushSystem(`📎 Não consegui anexar "${a.name}": ${friendlyUploadErr(r?.error)}.`);
      } catch (e: any) {
        pushSystem(`📎 Não consegui anexar "${a.name}": ${friendlyUploadErr(e?.message)}.`);
      }
    }
    return resolved;
  }

  async function send(text: string, attachments?: Attachment[], opts?: { skipEngineGuard?: boolean; fromQueue?: boolean; audioUrl?: string; audioDurationMs?: number }) {
    const trimmed = text.trim();
    // Anexa a nota de voz ao balão do usuário (o agente recebe só o texto).
    const audio = opts?.audioUrl ? { audioUrl: opts.audioUrl, audioDurationMs: opts.audioDurationMs } : {};
    if (!trimmed && (!attachments || attachments.length === 0)) return;

    if (trimmed.startsWith('/')) {
      setMessages((m) => [...m, { role: 'user', text: trimmed, ...audio, timestamp: Date.now() }]);
      try {
        const res = await handleSlash(trimmed, {
          project: projectRef.current,
          patchProject,
          pushSystem,
          pushSystemHtml,
          dispatchSeed,
          reloadHistory,
          openMcp: onOpenMcp,
          openSettings: onOpenSettings,
          clearMessages: () => setMessages([]),
          lastCostUsd: lastCostRef.current,
          lastUsage: lastUsageRef.current,
        });
        if (res.handled) return;
        // Slash não local (ex: /ask) — se busy, enfileira e sai.
        if (busyRef.current && !opts?.fromQueue) {
          enqueueOnHost(trimmed, attachments);
          setMessages((m) => {
            // Remove a msg de user que acabamos de inserir e reinsere como queued.
            const copy = [...m];
            copy[copy.length - 1] = { ...copy[copy.length - 1], queued: true };
            return copy;
          });
          return;
        }
      } catch (e: any) {
        pushSystem(`Erro processando comando: ${e.message || e}`);
        return;
      }
    } else if (busyRef.current && !opts?.fromQueue) {
      // Prompt novo enquanto a IA responde → vai pra fila DO HOST, não pra um
      // ref local: sobrevive a trocar de conversa, fechar o app e reiniciar, e
      // aparece igual nos outros dispositivos.
      enqueueOnHost(trimmed, attachments);
      setMessages((m) => [...m, { role: 'user', text: trimmed, queued: true, ...audio, timestamp: Date.now() }]);
      return;
    }

    // Claude CLI escolhido mas sem login: em vez de só avisar, dispara o fluxo
    // de conexão inline (abre o navegador pro OAuth e detecta a conclusão), e
    // reenvia esta mensagem automaticamente ao conectar.
    if (!opts?.skipEngineGuard && engine === 'claude' && !engineAvail.claude) {
      setCliConnect({ text: trimmed, att: attachments });
      return;
    }
    if (!opts?.skipEngineGuard && engine === 'cloud' && !engineAvail.cloud) {
      // Projeto (tipicamente migrado do local pra nuvem) ficou com o engine
      // "Claude API" (BYOK) mas a conta não tem API key. O container roda o
      // Claude CLI PRÓPRIO (OAuth do onboarding) — então em vez de travar com
      // "Claude API indisponível", troca sozinho pro Claude CLI e segue.
      if (engineAvail.claude) {
        try { await patchProject({ engine: 'claude' }); } catch {}
        return void send(text, attachments, { ...(opts || {}), skipEngineGuard: true });
      }
      setMessages((m) => [...m, { role: 'user', text: trimmed, ...audio, timestamp: Date.now() }]);
      pushSystem(t('engine.needCloud'));
      return;
    }
    // Codex CLI sem login → dispara a conexão inline (auto-instala + login
    // ChatGPT, copia-e-cola de fallback) e reenvia ao conectar — igual ao Claude.
    if (!opts?.skipEngineGuard && engine === 'codex' && !engineAvail.codex) {
      setCodexConnect({ text: trimmed, att: attachments });
      return;
    }
    // Codex API sem chave OpenAI → avisa como configurar.
    if (!opts?.skipEngineGuard && engine === 'codex-api' && !engineAvail['codex-api']) {
      setMessages((m) => [...m, { role: 'user', text: trimmed, ...audio, timestamp: Date.now() }]);
      pushSystem(t('engine.needCodexApi') || 'Adicione sua chave OpenAI (Ajustes → Codex API).');
      return;
    }

    // ── Loop mode: Claude planeja e enfileira tarefas no Kanban, não executa ──
    if (isMaestrus && loopMode) {
      interactedRef.current = true;
      setMessages((m) => [...m, { role: 'user', text: trimmed, ...audio, timestamp: Date.now() }]);
      setBusy(true);
      streamingRef.current = { buffer: '' };
      try {
        const allProjects = await window.maestrus.projects.list();
        const loopPrompt = buildLoopPrompt(trimmed, allProjects);
        pendingUserRef.current = loopPrompt;
        await window.maestrus.claude.send(project.id, loopPrompt);
      } catch (e: any) {
        setMessages((m) => [...m, { role: 'error', text: String(e?.message || e) }]);
        setBusy(false);
      }
      return;
    }

    // Mostra a msg do usuário NA HORA — não depende do echo do runner, que some
    // numa reconexão/resume do cloud. O echo é deduplicado via pendingUserRef.
    interactedRef.current = true; // trava o loadHistory tardio do open
    setMessages((m) => [...m, { role: 'user', text: trimmed, ...audio, timestamp: Date.now() }]);
    const finalText = formatWithAttachments(trimmed, await resolveAttachments(attachments));
    pendingUserRef.current = finalText;
    setBusy(true);
    streamingRef.current = { buffer: '' };
    try {
      await window.maestrus.claude.send(project.id, finalText);
    } catch (e: any) {
      const msg = String(e?.message || '');
      // host-starting: o sandbox cloud ainda está esquentando — mensagem amigável
      // em vez de erro cru; o usuário reenvia em instantes.
      setMessages((m) => [...m, { role: 'error', text: msg === 'host-starting' ? t('cloud.starting') : msg }]);
      setBusy(false);
    }
  }

  // Nota de voz: o AGENTE recebe o texto transcrito (é o que ele sabe ler); o
  // áudio vira um objectURL só pro player do balão. Sem chave OpenAI não há
  // transcrição, então o áudio sozinho não teria o que mandar.
  async function sendAudioNote(r: { blob: Blob | null; durationMs: number; text: string }) {
    const text = (r.text || '').trim();
    if (!text) {
      setMessages((m) => [...m, { role: 'error', text: t('audio.noTranscript') || 'Não consegui transcrever o áudio. Confira sua chave OpenAI nas configurações de voz.' }]);
      return;
    }
    const audioUrl = r.blob ? URL.createObjectURL(r.blob) : undefined;
    audioUrlsRef.current.push(audioUrl || '');
    await send(text, undefined, { audioUrl, audioDurationMs: r.durationMs });
  }

  async function stop() {
    // Otimista: no host remoto o RPC leva até 8s, e esperar por ele deixa a tela
    // "pensando" como se o parar não tivesse funcionado.
    setStopping(true);
    setBusy(false);
    busyRef.current = false;
    setRecentTools([]);
    // Sem isso o turno "parado" ressuscita: o done do processo morto drena a
    // fila e dispara o próximo prompt sozinho.
    try { (window as any).maestrus?.claude?.queueClear?.(project.id); } catch {}
    setQueued([]);
    setMessages((m) => m.map((msg) => (msg.pending || msg.queued ? { ...msg, pending: false, queued: false } : msg)));
    try { await window.maestrus.claude.stop(project.id); }
    catch (e) { console.warn('[maestrus] stop falhou:', e); }
    finally { setStopping(false); }
  }

  async function exportConfig() {
    const p = await window.maestrus.projects.exportConfig(project.id);
    if (p) alert(t('chat.exported', { path: p }));
  }

  // Ativa ESTE projeto na nuvem: sobe um sandbox com o código+sessão+memória,
  // instala e roda na nuvem (acesse e converse com o PC desligado).
  const isMaestrus = project.id === 'maestrus';
  const [loopMode, setLoopMode] = useState(false);
  const [cloudActivating, setCloudActivating] = useState(false);
  async function activateCloud() {
    if (!window.confirm(t('cloud.activateConfirm', { name: project.name }))) return;
    setCloudActivating(true);
    try {
      const r = await window.maestrus.cloud.cloudStart?.(project.id, true);
      if (r && r.ok) alert(t('cloud.activatedOk', { name: project.name }) + (r.preview_url ? '\n\n' + t('cloud.preview') + ': ' + r.preview_url : ''));
      else if (r && r.error === 'cloud_required') window.maestrus.cloud.openPanel();
      else alert((r && r.error) || t('remote.errGeneric'));
    } finally { setCloudActivating(false); }
  }

  async function updateModel(model: ModelChoice) {
    await patchProject({ model });
  }
  async function updateThinking(thinkingMode: ThinkingMode) {
    await patchProject({ thinkingMode });
  }
  async function updatePermission(permissionMode: PermissionMode) {
    await patchProject({ permissionMode });
  }

  // Reset do contexto ao trocar de modelo. DEVE ficar ANTES do early-return do
  // editor de CLAUDE.md — senão o nº de hooks muda quando editingMd=true e o
  // React quebra com "rendered fewer hooks than expected" (#300).
  useEffect(() => { setContextUsed(0); lastUsageRef.current = null; setDetectedModel(null); }, [project.model]);

  if (editingMd) {
    return <ClaudeMdEditor project={project} onClose={() => setEditingMd(false)} />;
  }

  // Denominador FIEL ao Claude Code: descontamos a reserva de output (~8K) do
  // contextWindow. Usa o modelo REAL detectado da sessão (mais fiel que
  // project.model, que pode ser 'default'); cai pro do projeto se não houver.
  // AUTO-1M: se o uso REAL já passou da janela assumida (200K), a sessão é de
  // janela grande (1M) — sem isto o anel travava em 100% em conversas 1M
  // (o modelo cru do .jsonl mapeava pra 200K e o uso estourava). Pega a MAIOR
  // janela entre o modelo detectado e o do projeto, e sobe pra 1M se o uso pedir.
  let contextTotal = Math.max(
    getEffectiveContextWindow(detectedModel || project.model),
    getEffectiveContextWindow(project.model),
  );
  if (contextUsed > contextTotal) contextTotal = getEffectiveContextWindow('claude-sonnet-5[1m]');

  return (
    <div
      className={`chat ${filesOpen ? 'files-open' : ''} ${vmode && voiceDock ? 'voice-open' : ''}`}
      style={{ position: 'relative' }}
    >
      <FilesPanel projectId={project.id} open={filesOpen} onClose={() => setFilesOpen(false)} />
      <header className="chat-header">
        <div className="chat-title">
          <span className="chat-name">{project.name}</span>
          <span className="chat-source" data-source={project.source}>{project.source}</span>
          {project.ssh && <SshStatusPill projectId={project.id} host={project.ssh.host} busy={busy} />}
          <ConnectionStatus variant="pill" hostLabel={project.remoteHostName || null} />
        </div>
        <EnginePicker value={engine} onChange={setEngine} avail={engineAvail} />
        {isMaestrus && (
          <button
            className={`loop-mode-toggle ${loopMode ? 'on' : ''}`}
            onClick={() => setLoopMode((v) => !v)}
            title={loopMode ? t('loop.disableTooltip') : t('loop.enableTooltip')}
          >
            <RefreshCw size={12} />
            {loopMode ? t('loop.active') : t('loop.label')}
          </button>
        )}
        {busy && <span className="busy-pill"><span>{t('voice.thinking')}</span></span>}
        {project.source !== 'maestrus' && !project.remoteHostId && (
          <button className="chat-cloud-btn" title={t('cloud.activateTitle')} onClick={activateCloud} disabled={cloudActivating}>
            {cloudActivating ? <Loader2 size={15} className="spin" /> : <CloudCog size={15} />}
          </button>
        )}
        <button
          className={`chat-files-btn ${filesOpen ? 'active' : ''}`}
          title={t('files.title') || 'Arquivos'}
          onClick={() => setFilesOpen((v) => !v)}
        >
          <FolderClosed size={15} />
        </button>
        <button
          className="chat-mute-btn"
          title={muted ? t('chat.unmuteSound') : t('chat.muteSound')}
          onClick={() => { const next = !muted; setMuted(next); setMutedState(next); }}
        >
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <MetaPanel
          project={project}
          contextUsed={contextUsed}
          contextTotal={contextTotal}
          engine={engine}
          onModel={updateModel}
          onThinking={updateThinking}
          onPermission={updatePermission}
          onEditMd={() => setEditingMd(true)}
          onExportConfig={exportConfig}
          onOpenFolder={() => project.codeDir && window.maestrus.shell.openFolder(project.codeDir)}
        />
      </header>

      <MessageList messages={messages} streaming={busy} onOpenLink={onOpenLink} onSend={(txt) => send(txt)} />

      {!busy && (() => {
        const qr = computeQuickReplies(messages);
        return qr ? <QuickReplies data={qr} onSend={(txt) => send(txt)} /> : null;
      })()}

      <Suspense fallback={null}>
      {vmode && <JarvisMode
        open={vmode}
        state={jarvisState}
        caption={vcaption}
        recentTools={recentTools}
        i18n={{
          listening: t('voice.listening'),
          thinking: t('voice.thinking'),
          speaking: t('voice.speaking'),
          ready: t('voice.ready'),
          pause: t('voice.pause'),
          exit: t('voice.exit'),
          musicOn: t('voice.musicOn'),
          musicOff: t('voice.musicOff'),
          dock: t('voice.dock') || 'Painel',
          fullscreen: t('voice.fullscreen') || 'Tela cheia',
        }}
        dock={voiceDock}
        onToggleDock={() => { const n = !voiceDock; setVoiceDock(n); try { localStorage.setItem('maestrus-voice-dock', n ? '1' : '0'); } catch {} }}
        onPause={pauseVoice}
        onClose={closeJarvis}
      />}
      </Suspense>

      {showOaiUpsell && (
        <div className="byok-lock-overlay" onClick={() => setShowOaiUpsell(false)}>
          <div className="byok-lock" onClick={(e) => e.stopPropagation()}>
            <div className="byok-lock-icon"><KeyRound size={24} /></div>
            <h3>{t('byok.voiceLocked') || 'Realtime voice needs an OpenAI key'}</h3>
            <p>{t('byok.voiceLockedDesc') || 'Set your key in Settings to enable the assistant.'}</p>
            <div className="byok-lock-actions">
              <button className="btn-secondary" onClick={() => setShowOaiUpsell(false)}>{t('common.cancel') || 'Cancel'}</button>
              <button className="btn-primary" onClick={() => { setShowOaiUpsell(false); onOpenSettings?.(); }}>
                {t('byok.goToSettings') || 'Open Settings'} <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {authExpired && (
        <div className="rate-limit-banner" role="status">
          <AlertTriangle size={13} />
          <span>{t('auth.expired') || 'A sessão da sua conta Claude expirou. O status do CLI ainda diz conectado, mas o token não renova mais.'}</span>
          <button className="rate-limit-acct" onClick={() => { setCliConnect({ text: '' }); setAuthExpired(false); }}>
            {t('auth.reconnect') || 'Reconectar'}
          </button>
          <button className="rate-limit-close" onClick={() => setAuthExpired(false)} title={t('common.close')}><XIcon size={11} /></button>
        </div>
      )}
      {rateLimit && (
        <div className="rate-limit-banner" role="status">
          <AlertTriangle size={13} />
          <span>
            {rateLimit.status === 'rejected'
              ? (t('rateLimit.reached') || 'Limite de uso atingido nesta conta.')
              : (t('rateLimit.near') || 'Você está perto do limite de uso desta conta.')}
            {rateLimit.resetsAt ? ' ' + (t('rateLimit.resets', { when: new Date(rateLimit.resetsAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }) || `Reseta às ${new Date(rateLimit.resetsAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`) : ''}
          </span>
          {/* Contas DO PROJETO (host que executa o turno), não desta máquina. */}
          <span className="rate-limit-accounts">
            <span className="rate-limit-sep">{t('rateLimit.switchTo') || 'Trocar para'}</span>
            <AccountPicker projectId={project.id} compact onSwitched={() => setRateLimit(null)} />
          </span>
          <button className="rate-limit-close" onClick={() => setRateLimit(null)} title={t('common.close')}><XIcon size={11} /></button>
        </div>
      )}
      {lockHeldElsewhere && (
        <div className="lock-banner" role="status" aria-live="polite">
          <span className="lock-banner-dot" />
          <span className="lock-banner-text">
            {t('chat.lockedOn', { host: lock!.hostName || 'outro dispositivo' })}
          </span>
        </div>
      )}
      {cloudStarting && (
        <div className="cloud-starting-banner" role="status" aria-live="polite">
          <Loader2 size={13} className="spin" />
          <span>{t('cloud.startingInstance')}</span>
        </div>
      )}
      {isMaestrus && loopMode && (
        <div className="loop-banner" role="status">
          <RefreshCw size={11} className="loop-banner-icon" />
          <span>{t('loop.bannerText')}</span>
          <button className="loop-banner-close" onClick={() => setLoopMode(false)} title={t('loop.disableTooltip')}>
            <XIcon size={11} />
          </button>
        </div>
      )}
      <QueuePanel items={queued} projectId={project.id} />
      <MessageInput
        draftKey={project.id}
        onSend={send}
        onStop={stop}
        stopping={stopping}
        onAudioNote={sendAudioNote}
        busy={busy || lockHeldElsewhere}
        // turno em OUTRA máquina: não há processo local pra matar, some o botão
        canStop={busy && !lockHeldElsewhere}
        onOpenJarvis={openJarvis}
        jarvisAvailable={voiceOk && !(window as any).maestrus?.isWeb}
        engine={engine}
        model={project.model || defaultModelForEngine(engine)}
        onModel={updateModel}
        thinking={project.thinkingMode || 'medium'}
        onThinking={updateThinking}
        permission={project.permissionMode || 'bypassPermissions'}
        onPermission={updatePermission}
      />

      {cliConnect && (
        <ClaudeCliConnect
          projectId={project.id}
          local={!project.remoteHostId && !(project as any).cloud}
          cloudAvailable={engineAvail.cloud}
          onCancel={() => setCliConnect(null)}
          onSwitchCloud={async () => {
            const pending = cliConnect;
            setCliConnect(null);
            await setEngine('cloud');
            if (pending && pending.text.trim()) setTimeout(() => send(pending.text, pending.att, { skipEngineGuard: true }), 50);
          }}
          onConnected={() => {
            const pending = cliConnect;
            setCliConnect(null);
            setEngineAvail((a) => ({ ...a, claude: true }));
            if (pending && pending.text.trim()) setTimeout(() => send(pending.text, pending.att, { skipEngineGuard: true }), 50);
          }}
        />
      )}

      {codexConnect && (
        <CodexCliConnect
          onCancel={() => setCodexConnect(null)}
          onConnected={() => {
            const pending = codexConnect;
            setCodexConnect(null);
            setEngineAvail((a) => ({ ...a, codex: true }));
            if (pending) setTimeout(() => send(pending.text, pending.att, { skipEngineGuard: true }), 50);
          }}
        />
      )}
    </div>
  );
}
