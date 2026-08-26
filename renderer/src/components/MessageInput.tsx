import { useState, useRef, KeyboardEvent, useEffect, DragEvent, ClipboardEvent } from 'react';
import { ArrowUp, Square, Paperclip, X, AudioLines } from 'lucide-react';
import { filterCommands, SlashCommand } from '../lib/slash-commands';
import { useT } from '../lib/i18n';
import AudioNoteButton from './AudioNoteButton';
import type { AudioNoteResult } from '../lib/audio-note';
import ModelPicker from './ModelPicker';
import ThinkingPicker from './ThinkingPicker';
import PermissionPicker from './PermissionPicker';
import { ModelChoice, PermissionMode, ThinkingMode } from '../types';

interface Attachment {
  path?: string;    // path local (desktop)
  name: string;
  dataB64?: string; // conteúdo (web/PWA — o arquivo não existe no host)
}

interface Props {
  onSend: (text: string, attachments?: Attachment[]) => void;
  onStop: () => void;
  busy: boolean;
  /** Parar já foi pedido, mas o turno ainda não morreu — botão travado no lugar. */
  stopping?: boolean;
  /** Há um turno LOCAL pra parar. False quando o lock está em outra máquina:
   *  aí o stop não teria processo pra matar e o botão só enganaria. */
  canStop?: boolean;
  /** Nota de voz gravada no chat (áudio + transcrição). */
  onAudioNote?: (r: AudioNoteResult) => void;
  onOpenJarvis?: () => void;
  jarvisAvailable?: boolean;
  // Pickers no rodapé do input (estilo Claude Code): modelo + modo de pensamento
  // à direita, permissão à esquerda. Mantêm 100% das opções (Opus/Sonnet/… /1M,
  // thinking levels, permission modes).
  engine?: string;
  model?: ModelChoice;
  onModel?: (m: ModelChoice) => void;
  thinking?: ThinkingMode;
  onThinking?: (t: ThinkingMode) => void;
  permission?: PermissionMode;
  onPermission?: (p: PermissionMode) => void;
  /** Id da conversa. Guarda o RASCUNHO (texto + anexos) por conversa, pra trocar
   *  de projeto e voltar sem perder o que estava escrevendo. */
  draftKey?: string;
}

// Rascunho por conversa, no localStorage. Anexos grandes (colados/arrastados)
// ficam de fora do que é gravado — só o que cabe com folga — pra nunca estourar
// a cota do navegador e quebrar OUTRA coisa. Texto sempre é salvo.
const DRAFT_PREFIX = 'maestrus-draft:';
const DRAFT_MAX_BYTES = 512 * 1024;
function loadDraft(key?: string): { text: string; attachments: Attachment[] } {
  if (!key) return { text: '', attachments: [] };
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return { text: '', attachments: [] };
    const d = JSON.parse(raw);
    return { text: String(d.text || ''), attachments: Array.isArray(d.attachments) ? d.attachments : [] };
  } catch { return { text: '', attachments: [] }; }
}
function saveDraft(key: string | undefined, text: string, attachments: Attachment[]): void {
  if (!key) return;
  try {
    if (!text.trim() && !attachments.length) { localStorage.removeItem(DRAFT_PREFIX + key); return; }
    // Anexo por PATH (desktop) é leve; conteúdo em base64 pode ser enorme.
    let budget = DRAFT_MAX_BYTES;
    const keep = attachments.filter((a) => {
      const size = a.dataB64 ? a.dataB64.length : 0;
      if (size > budget) return false;
      budget -= size;
      return true;
    });
    localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ text, attachments: keep }));
  } catch { /* cota cheia: rascunho é conveniência, nunca quebra o envio */ }
}

export default function MessageInput({ onSend, onStop, busy, stopping, canStop = true, onAudioNote, onOpenJarvis, jarvisAvailable, engine, model, onModel, thinking, onThinking, permission, onPermission, draftKey }: Props) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInRef = useRef<HTMLInputElement>(null);

  // Troquei de conversa: recupera o rascumo daquela (ou limpa, se não houver).
  useEffect(() => {
    const d = loadDraft(draftKey);
    setText(d.text);
    setAttachments(d.attachments);
    setShowSlash(false);
  }, [draftKey]);

  // Salva enquanto digita/anexa (debounce curto — não escreve a cada tecla).
  useEffect(() => {
    if (!draftKey) return;
    const id = setTimeout(() => saveDraft(draftKey, text, attachments), 300);
    return () => clearTimeout(id);
  }, [draftKey, text, attachments]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setText('');
    setAttachments([]);
    setShowSlash(false);
    saveDraft(draftKey, '', []);   // enviou → some o rascunho
  }

  const slashList: SlashCommand[] = showSlash ? filterCommands(text).slice(0, 8) : [];

  function applySlash(cmd: SlashCommand) {
    setText(cmd.name + ' ');
    setShowSlash(false);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (showSlash && slashList.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, slashList.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applySlash(slashList[slashIdx]);
        return;
      }
      if (e.key === 'Escape') {
        setShowSlash(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  useEffect(() => {
    const trimmed = text.trimStart();
    const starts = trimmed.startsWith('/');
    const hasSpace = trimmed.includes(' ');
    setShowSlash(starts && !hasSpace);
    setSlashIdx(0);
  }, [text]);

  useEffect(() => {
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 200) + 'px';
    }
  }, [text]);

  async function attachFile() {
    // Desktop: diálogo nativo devolve o path. Web: pickFile é null → input file.
    const p = await window.maestrus.dialog?.pickFile?.();
    if (p) { addAttachment(p); return; }
    fileInRef.current?.click();
  }

  function addAttachment(filePath: string) {
    const name = filePath.split(/[\\/]/).pop() || filePath;
    setAttachments((a) => a.some((x) => x.path === filePath) ? a : [...a, { path: filePath, name }]);
  }

  async function addBlobAttachment(f: File) {
    if (f.size > 20 * 1024 * 1024) { alert(t('chat.attachTooBig') || 'Arquivo grande demais (máx. 20 MB).'); return; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    setAttachments((a) => a.some((x) => x.name === f.name && x.dataB64) ? a : [...a, { name: f.name, dataB64: b64 }]);
  }

  function removeAttachment(idx: number) {
    setAttachments((a) => a.filter((_, i) => i !== idx));
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragging) setDragging(true);
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setDragging(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      const p = (f as any).path;
      if (p) addAttachment(p);       // desktop: path real
      else addBlobAttachment(f);     // web: sobe o conteúdo
    }
  }

  // Ctrl/Cmd+V de imagem ou arquivo no campo de texto (desktop E web). Itens de
  // arquivo do clipboard não têm path (vêm da área de transferência, não do
  // disco) → sobem como conteúdo (dataB64). Só intercepta quando há arquivo;
  // paste de texto puro segue normal.
  async function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items ? Array.from(e.clipboardData.items) : [];
    const fileItems = items.filter((it) => it.kind === 'file');
    if (fileItems.length === 0) return; // texto normal
    e.preventDefault();
    for (const it of fileItems) {
      const f = it.getAsFile();
      if (!f) continue;
      const p = (f as any).path;
      if (p) { addAttachment(p); continue; }
      // imagem colada costuma vir sem nome → sintetiza pela extensão do MIME
      let file = f;
      if (!f.name) {
        const ext = (f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        file = new File([f], `colado-${Date.now().toString(36)}.${ext}`, { type: f.type });
      }
      await addBlobAttachment(file);
    }
  }

  return (
    <div
      className={`input-wrap ${dragging ? 'dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="drop-overlay">
          {t('chat.dropFiles', { at: '@path' })}
        </div>
      )}
      {showSlash && slashList.length > 0 && (
        <div className="slash-menu">
          {slashList.map((c, i) => (
            <button
              key={c.name}
              className={`slash-item ${i === slashIdx ? 'active' : ''}`}
              onClick={() => applySlash(c)}
              onMouseEnter={() => setSlashIdx(i)}
            >
              <span className="slash-name">{c.name}</span>
              <span className="slash-desc">{c.desc}</span>
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a, i) => (
            <span key={(a.path || a.name) + i} className="attachment-chip" title={a.path || a.name}>
              <Paperclip size={11} /> {a.name}
              <button onClick={() => removeAttachment(i)} title={t('common.remove')}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={fileInRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { const fl = e.target.files; if (fl) Array.from(fl).forEach(addBlobAttachment); e.target.value = ''; }}
      />

      {/* Caixa estilo Claude Code: textarea grande em cima, barra de ações
          embaixo — esquerda (anexo/voz/game/permissão) e direita (modelo +
          modo de pensamento + enviar). */}
      <div className="input-box">
        <textarea
          ref={taRef}
          className="input-textarea"
          placeholder={busy ? t('chat.queuePlaceholder') : t('chat.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={1}
        />
        <div className="input-toolbar">
          <div className="input-toolbar-left">
            <button className="tb-btn" onClick={attachFile} title={t('chat.attach')}>
              <Paperclip size={15} />
            </button>
            {jarvisAvailable && onOpenJarvis && (
              <button className="tb-btn" onClick={onOpenJarvis} title={t('voice.start')} aria-label={t('voice.start')}>
                <AudioLines size={15} />
              </button>
            )}
            {onPermission && (
              <div className="tb-picker perm">
                <PermissionPicker value={permission || 'bypassPermissions'} onChange={onPermission} />
              </div>
            )}
          </div>
          <div className="input-toolbar-right">
            {onModel && (
              <div className="tb-picker">
                <ModelPicker value={model || 'sonnet'} onChange={onModel} engine={engine} />
              </div>
            )}
            {onThinking && (
              <div className="tb-picker">
                <ThinkingPicker value={thinking || 'medium'} onChange={onThinking} />
              </div>
            )}
            {canStop && (busy || stopping) && (
              <button
                className={`btn-stop ${stopping ? 'stopping' : ''}`}
                onClick={onStop}
                disabled={stopping}
                title={stopping ? t('chat.stopping') : t('chat.stop')}
              >
                <Square size={13} fill="currentColor" />
              </button>
            )}
            {onAudioNote && !text.trim() && attachments.length === 0 && (
              <AudioNoteButton onSend={onAudioNote} disabled={false} />
            )}
            <button
              className={`btn-send ${busy && (text.trim() || attachments.length > 0) ? 'queued' : ''}`}
              onClick={submit}
              disabled={!text.trim() && attachments.length === 0}
              title={busy ? t('chat.queueSend') : t('chat.send')}
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
