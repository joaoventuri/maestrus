import { useEffect, useRef, useState } from 'react';
import { Mic, Trash2, Send, Loader2 } from 'lucide-react';
import { AudioNoteRecorder, AudioNoteResult, fmtDuration } from '../lib/audio-note';
import { useT } from '../lib/i18n';

/**
 * Nota de voz do chat.
 *
 * Clique no mic começa a gravar e a gravação FICA de pé até você decidir: o
 * botão de enviar manda, a lixeira descarta, Enter manda, Esc descarta.
 *
 * A versão anterior era press-and-hold e travava: o botão do mic desmontava ao
 * entrar em gravação, então o `pointerup` nunca chegava no elemento que tinha
 * capturado o ponteiro — a gravação não encerrava e os botões da barra ficavam
 * sem efeito. Segurar continua funcionando (solta = envia), mas agora é atalho,
 * não o único caminho.
 */
export default function AudioNoteButton({ onSend, disabled }: {
  onSend: (r: AudioNoteResult) => void;
  disabled?: boolean;
}) {
  const { t, lang } = useT();
  const recRef = useRef<AudioNoteRecorder | null>(null);
  const holdRef = useRef(false);      // veio de "segurar" e ainda não soltou
  const startedAtRef = useRef(0);
  const finishingRef = useRef(false); // evita enviar duas vezes (Enter + clique)

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [text, setText] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 200);
    return () => clearInterval(id);
  }, [recording]);

  // Enter envia, Esc descarta — enquanto estiver gravando, em qualquer foco.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(true); }
    };
    // capture: chega antes do textarea do chat, que também trata Enter.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  useEffect(() => () => { try { recRef.current?.cancel(); } catch {} }, []);

  async function begin() {
    if (disabled || recording || busy || recRef.current) return;
    setErr(''); setText(''); setElapsed(0);
    finishingRef.current = false;

    let apiKey = '';
    try {
      const m: any = (window as any).maestrus;
      const r = m?.openaiKey?.get ? await m.openaiKey.get() : null;
      apiKey = (r && r.key) || '';
    } catch {}

    const rec = new AudioNoteRecorder({ onText: setText, onLevel: setLevel, onError: setErr });
    try {
      // Sem chave o áudio é gravado do mesmo jeito — só não há transcrição.
      await rec.start({ apiKey, lang });
      recRef.current = rec;
      startedAtRef.current = Date.now();
      setRecording(true);
    } catch (e: any) {
      try { rec.cancel(); } catch {}
      setErr(e?.message || t('audio.micDenied') || 'Não consegui acessar o microfone');
    }
  }

  async function finish(cancel: boolean) {
    const rec = recRef.current;
    if (!rec || finishingRef.current) return;
    finishingRef.current = true;
    recRef.current = null;
    holdRef.current = false;

    if (cancel) {
      try { rec.cancel(); } catch {}
      setRecording(false); setText(''); setLevel(0); setElapsed(0);
      finishingRef.current = false;
      return;
    }

    setBusy(true);
    try {
      const res = await rec.stop();
      if (res.durationMs > 400 && (res.text || res.blob)) onSend(res);
    } catch (e: any) {
      setErr(e?.message || 'falha ao finalizar');
    } finally {
      setBusy(false); setRecording(false); setLevel(0); setText(''); setElapsed(0);
      finishingRef.current = false;
    }
  }

  if (!recording && !busy) {
    return (
      <button
        className="an-btn"
        disabled={disabled}
        title={t('audio.record') || 'Gravar áudio'}
        aria-label={t('audio.record') || 'Gravar áudio'}
        onPointerDown={() => { holdRef.current = true; begin(); }}
        // Soltar rápido = clique: a gravação continua e você usa os botões.
        // Segurou de verdade (>600ms) = atalho de mensageiro, solta e envia.
        onPointerUp={() => {
          const held = Date.now() - startedAtRef.current;
          if (holdRef.current && recRef.current && held > 600) finish(false);
          holdRef.current = false;
        }}
      >
        <Mic size={17} />
      </button>
    );
  }

  return (
    <div className="an-live">
      <button
        className="an-cancel"
        onClick={() => finish(true)}
        disabled={busy}
        title={t('audio.cancel') || 'Descartar'}
        aria-label={t('audio.cancel') || 'Descartar'}
      >
        <Trash2 size={15} />
      </button>

      <span className="an-dot" />
      <span className="an-time">{fmtDuration(elapsed)}</span>

      <div className="an-wave" aria-hidden="true">
        {Array.from({ length: 16 }).map((_, i) => (
          <span key={i} style={{ height: `${18 + Math.min(80, level * 100) * (0.35 + Math.abs(Math.sin(i * 1.1 + elapsed / 160)) * 0.65)}%` }} />
        ))}
      </div>

      <div className="an-text">
        {busy && !text ? <Loader2 size={13} className="spin" /> : null}
        <span>{text || (busy ? t('audio.transcribing') || 'transcrevendo…' : t('audio.listening') || 'ouvindo…')}</span>
      </div>

      {err && <span className="an-err">{err}</span>}

      <button
        className="an-send"
        onClick={() => finish(false)}
        disabled={busy}
        title={t('audio.send') || 'Enviar'}
        aria-label={t('audio.send') || 'Enviar'}
      >
        {busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
      </button>
    </div>
  );
}
