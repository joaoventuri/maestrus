import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { ChatMessage, ClaudeEvent, ModelChoice, PermissionMode, Project, ThinkingMode } from '../types';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import QuickReplies from './QuickReplies';
import { computeQuickReplies } from '../lib/quick-replies';
import MetaPanel from './MetaPanel';
import ClaudeMdEditor from './ClaudeMdEditor';
import ClaudeCliConnect from './ClaudeCliConnect';
import SshStatusPill from './SshStatusPill';
import { Volume2, VolumeX, Cpu, Cloud, Mic, CloudCog, Loader2, RefreshCw, X as XIcon } from 'lucide-react';
import { handleSlash, makeSystemMessage } from '../lib/slash-handler';
import { getContextWindow, getEffectiveContextWindow } from '../lib/model-info';
import { useT } from '../lib/i18n';
import { playDone, isMuted, setMuted } from '../lib/sound';
import { getSnapshot as getActivity, markRead } from '../lib/activity-store';
import { ttsSpeak, ttsCancel, ttsSupported, getSttEngine, sttSupported, unlockAudio, extractSentences, resetSentenceSplitter, resolveSttEngineFromConfig } from '../lib/voice';
// JarvisMode importa Three.js (~500KB) — lazy load só quando o usuário
// abre o modo voz. Mantém o main bundle enxuto.
const JarvisMode = lazy(() => import('./JarvisMode'));
import type { VoiceState } from './JarvisMode';
import { RealtimeSession } from '../lib/realtime-voice';
import { KeyRound, ArrowRight } from 'lucide-react';

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
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  // Fila de mensagens: prompts enviados enquanto a IA responde aguardam aqui
  // e são despachados automaticamente quando o turno termina.
  const msgQueueRef = useRef<{ text: string; att?: Attachment[] }[]>([]);
  // Status da instância cloud subindo (cold start do sandbox) → banner "iniciando".
  const [cloudStarting, setCloudStarting] = useState(false);
  const [editingMd, setEditingMd] = useState(false);
  const [contextUsed, setContextUsed] = useState(0);
  const [muted, setMutedState] = useState(isMuted());
  const [engineAvail, setEngineAvail] = useState<{ claude: boolean; cloud: boolean }>({ claude: true, cloud: false });
  // Mensagem pendente aguardando conexão do Claude CLI (login OAuth inline).
  const [cliConnect, setCliConnect] = useState<{ text: string; att?: Attachment[] } | null>(null);
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
  useEffect(() => { vmodeRef.current = vmode; }, [vmode]);
  useEffect(() => { busyVRef.current = busy; }, [busy]);
  // Inicializador: abre o modo voz ao montar (após rodar o launcher). Pequeno
  // delay pra o aiStatus resolver e abrir em Cloud (realtime) se disponível.
  useEffect(() => {
    if (!openVoiceOnMount) return;
    const id = setTimeout(() => { try { openJarvis(); } catch {} onVoiceOpened?.(); }, 900);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { try { sttRef.current.stop(); ttsCancel(); } catch {} }, []);

  function resetTtsState() {
    ttsQueueRef.current = []; ttsAccumRef.current = '';
    ttsDoneRef.current = false; ttsPlayingRef.current = false;
    resetSentenceSplitter();
  }
  function playTtsQueue() {
    if (ttsPlayingRef.current || !ttsQueueRef.current.length || !vmodeRef.current) return;
    const sentence = ttsQueueRef.current.shift()!;
    ttsPlayingRef.current = true; speakingRef.current = true; setVstate('speaking');
    setVcaption(sentence);
    ttsSpeak(sentence, lang as any, () => {
      ttsPlayingRef.current = false;
      if (!vmodeRef.current) { speakingRef.current = false; return; }
      if (ttsQueueRef.current.length > 0) { playTtsQueue(); return; }
      if (ttsDoneRef.current) { speakingRef.current = false; setVstate('idle'); setVcaption(''); setTimeout(startVoiceListen, 200); }
    });
  }
  function flushTtsAccum(force = false) {
    const { sentences, remaining } = extractSentences(ttsAccumRef.current);
    sentences.forEach((s) => ttsQueueRef.current.push(s));
    ttsAccumRef.current = remaining;
    if (force && remaining.trim()) { ttsQueueRef.current.push(remaining.trim()); ttsAccumRef.current = ''; }
  }

  function startVoiceListen() {
    if (!vmodeRef.current || busyVRef.current || speakingRef.current) return;
    setVstate('listening'); setVcaption('');
    sttRef.current.start(lang as any, {
      onInterim: (txt: string) => { setVcaption(txt); },
      onFinal: (txt: string) => { setVstate('idle'); setVcaption(txt); send(txt); },
      onEnd: () => { if (vmodeRef.current && !busyVRef.current && !speakingRef.current) setTimeout(startVoiceListen, 350); },
      onError: () => { if (vmodeRef.current && !busyVRef.current && !speakingRef.current) setTimeout(startVoiceListen, 900); },
    });
  }
  async function openJarvis() {
    if (vmode) return;
    // Verifica se o usuário tem chave OpenAI configurada: se sim, usa Realtime;
    // se não, mostra modal de upsell.
    try {
      const k: any = await (window as any).maestrus?.openaiKey?.has?.();
      if (k && k.has) {
        await openRealtimeJarvis();
        return;
      }
    } catch {}
    setShowOaiUpsell(true);
  }
  async function openRealtimeJarvis() {
    setVmode(true); vmodeRef.current = true;
    setUsingRealtime(true);
    unlockAudio(); resetTtsState(); setRecentTools([]);
    setVstate('listening'); setVcaption('');
    const session = new RealtimeSession({
      projectId: project.id,
      lang: (((window as any).maestrus?.lang) || 'pt') as any,
      onStatus: (s) => {
        if (s.status === 'connected') setVstate('listening');
        else if (s.status === 'error') { setVcaption(s.message || 'error'); }
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
      setVmode(false); vmodeRef.current = false; setUsingRealtime(false);
      return;
    }
    realtimeRef.current = session;
  }
  function closeJarvis() {
    setVmode(false); vmodeRef.current = false;
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
  useEffect(() => {
    (async () => {
      try {
        const [s, key] = await Promise.all([
          window.maestrus.claudeAuth.status(),
          (window as any).maestrus?.anthropicKey?.has?.().catch(() => ({ has: false })),
        ]);
        const isWeb = !!(window as any).maestrus?.isWeb;
        const projCloud = !!(project as any).cloud || project.source === 'cloud';
        const projRemoteMachine = !!project.remoteHostId && !projCloud;
        let claudeAvail: boolean;
        if (projCloud) claudeAvail = true;                  // container tem o CLI (OAuth próprio)
        else if (projRemoteMachine) claudeAvail = true;     // CLI da máquina do host
        else if (isWeb) claudeAvail = false;                // web sem máquina = sem CLI
        else claudeAvail = !!(s && s.loggedIn);             // desktop local
        setEngineAvail({ claude: claudeAvail, cloud: !!(key && key.has) });
      } catch { /* mantém default */ }
    })();
  }, [project.id]);

  const engine: 'claude' | 'cloud' = (project.engine as any) || 'claude';
  async function setEngine(e: 'claude' | 'cloud') {
    if (e === engine) return;
    // Não troca pra um engine indisponível. Projeto cloud roda no sandbox via
    // Maestrus AI — o Claude CLI local não dirige ele. Mensagem clara em vez de erro.
    if (e === 'claude' && !engineAvail.claude) {
      const projCloud = !!(project as any).cloud || project.source === 'cloud';
      pushSystem(projCloud ? t('engine.cloudLocked') : t('engine.needClaude'));
      return;
    }
    if (e === 'cloud' && !engineAvail.cloud) { pushSystem(t('engine.needCloud')); return; }
    await patchProject({ engine: e });
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
    (async () => {
      const history = await window.maestrus.claude.loadHistory(project.id);
      if (!interactedRef.current) setMessages(history);
    })();
  }, [project.id]);

  useEffect(() => {
    const off = window.maestrus.claude.onEvent((evt: ClaudeEvent) => {
      if (evt.projectId !== project.id) return;

      if (evt.type === 'user') {
        // dedupe: se acabamos de adicionar essa mesma msg otimisticamente
        // (cloud/remote), não duplica o balão.
        if (pendingUserRef.current && evt.text === pendingUserRef.current) { pendingUserRef.current = null; return; }
        setMessages((m) => [...m, { role: 'user', text: evt.text, timestamp: evt.timestamp }]);
        return;
      }
      if (evt.type === 'delta' && evt.text) {
        if (vmodeRef.current) {
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
        return;
      }
      if (evt.type === 'done') {
        setMessages((m) => m.map((msg) => (msg.pending ? { ...msg, pending: false } : msg)));
        setBusy(false);
        busyRef.current = false;
        setRecentTools([]); // limpa constelação ao fim do turno
        // Drena a fila de mensagens pendentes — envia o próximo prompt automaticamente.
        const next = msgQueueRef.current.shift();
        if (next) {
          // Marca a primeira mensagem enfileirada como "dequeued" (volta ao estilo normal).
          setMessages((m) => {
            const idx = m.map((x, i) => ({ x, i })).reverse().find(({ x }) => x.queued && x.text === next.text)?.i ?? -1;
            if (idx < 0) return m;
            const copy = [...m];
            copy[idx] = { ...copy[idx], queued: false };
            return copy;
          });
          setTimeout(() => send(next.text, next.att, { fromQueue: true }), 120);
        }
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
    setMessages(history);
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
    const res = await window.maestrus.projects.patch(project.id, patch).catch(() => null);
    // projeto cloud (stub) não está no store local → patch pode voltar null.
    // Nunca seta null (era o crash "reading 'lock'"); aplica o patch localmente.
    const next = (res && (res as any).id) ? res : { ...project, ...patch };
    setProject(next);
    projectRef.current = next;
    onProjectUpdate(next);
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
  async function resolveAttachments(attachments?: Attachment[]): Promise<Attachment[] | undefined> {
    if (!attachments || attachments.length === 0) return attachments;
    const up = (window as any).maestrus?.files?.uploadToHost;
    if (!up) return attachments;
    const resolved: Attachment[] = [];
    for (const a of attachments) {
      try {
        const r = await up(project.id, a);
        if (r && r.ok && r.path) { resolved.push({ name: a.name, path: r.path }); continue; }
        if (a.path) { resolved.push(a); continue; }
        pushSystem((t('chat.attachFail') || 'Falha ao enviar o anexo') + ` ${a.name}${r?.error ? ` (${r.error})` : ''}`);
      } catch {
        if (a.path) resolved.push(a);
        else pushSystem((t('chat.attachFail') || 'Falha ao enviar o anexo') + ` ${a.name}`);
      }
    }
    return resolved;
  }

  async function send(text: string, attachments?: Attachment[], opts?: { skipEngineGuard?: boolean; fromQueue?: boolean }) {
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) return;

    if (trimmed.startsWith('/')) {
      setMessages((m) => [...m, { role: 'user', text: trimmed, timestamp: Date.now() }]);
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
          msgQueueRef.current.push({ text: trimmed, att: attachments });
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
      // Prompt normal enquanto IA responde → enfileira visualmente.
      msgQueueRef.current.push({ text: trimmed, att: attachments });
      setMessages((m) => [...m, { role: 'user', text: trimmed, queued: true, timestamp: Date.now() }]);
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
      setMessages((m) => [...m, { role: 'user', text: trimmed, timestamp: Date.now() }]);
      pushSystem(t('engine.needCloud'));
      return;
    }

    // ── Loop mode: Claude planeja e enfileira tarefas no Kanban, não executa ──
    if (isMaestrus && loopMode) {
      interactedRef.current = true;
      setMessages((m) => [...m, { role: 'user', text: trimmed, timestamp: Date.now() }]);
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
    setMessages((m) => [...m, { role: 'user', text: trimmed, timestamp: Date.now() }]);
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

  async function stop() {
    await window.maestrus.claude.stop(project.id);
    setBusy(false);
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
  useEffect(() => { setContextUsed(0); lastUsageRef.current = null; }, [project.model]);

  if (editingMd) {
    return <ClaudeMdEditor project={project} onClose={() => setEditingMd(false)} />;
  }

  // Denominador FIEL ao Claude Code: descontamos a reserva de output (~8K) do
  // contextWindow (resetado acima quando o modelo muda).
  const contextTotal = getEffectiveContextWindow(project.model);

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-title">
          <span className="chat-name">{project.name}</span>
          <span className="chat-source" data-source={project.source}>{project.source}</span>
          {project.ssh && <SshStatusPill projectId={project.id} host={project.ssh.host} busy={busy} />}
        </div>
        <div className="engine-switch" title={t('engine.tooltip')}>
          <button
            className={`engine-seg ${engine === 'claude' ? 'active' : ''} ${!engineAvail.claude ? 'off' : ''}`}
            onClick={() => setEngine('claude')}
            title={engineAvail.claude ? 'Claude CLI' : t('engine.needClaude')}
          >
            <Cpu size={12} /> Claude CLI
          </button>
          <button
            className={`engine-seg ${engine === 'cloud' ? 'active' : ''} ${!engineAvail.cloud ? 'off' : ''}`}
            onClick={() => setEngine('cloud')}
            title={engineAvail.cloud ? 'Claude API (sua chave Anthropic)' : t('engine.needCloud')}
          >
            <Cloud size={12} /> Claude API
          </button>
        </div>
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
        }}
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
      <MessageInput
        onSend={send}
        onStop={stop}
        busy={busy || lockHeldElsewhere}
        onOpenJarvis={openJarvis}
        jarvisAvailable={voiceOk && !(window as any).maestrus?.isWeb}
      />

      {cliConnect && (
        <ClaudeCliConnect
          cloudAvailable={engineAvail.cloud}
          onCancel={() => setCliConnect(null)}
          onSwitchCloud={async () => {
            const pending = cliConnect;
            setCliConnect(null);
            await setEngine('cloud');
            if (pending) setTimeout(() => send(pending.text, pending.att, { skipEngineGuard: true }), 50);
          }}
          onConnected={() => {
            const pending = cliConnect;
            setCliConnect(null);
            setEngineAvail((a) => ({ ...a, claude: true }));
            if (pending) setTimeout(() => send(pending.text, pending.att, { skipEngineGuard: true }), 50);
          }}
        />
      )}
    </div>
  );
}
