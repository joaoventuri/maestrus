import { useState, useRef, KeyboardEvent, useEffect, DragEvent } from 'react';
import { ArrowUp, Square, Paperclip, X, Speech } from 'lucide-react';
import { filterCommands, SlashCommand } from '../lib/slash-commands';
import { useT } from '../lib/i18n';

interface Attachment {
  path?: string;    // path local (desktop)
  name: string;
  dataB64?: string; // conteúdo (web/PWA — o arquivo não existe no host)
}

interface Props {
  onSend: (text: string, attachments?: Attachment[]) => void;
  onStop: () => void;
  busy: boolean;
  onOpenJarvis?: () => void;
  jarvisAvailable?: boolean;
}

export default function MessageInput({ onSend, onStop, busy, onOpenJarvis, jarvisAvailable }: Props) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInRef = useRef<HTMLInputElement>(null);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setText('');
    setAttachments([]);
    setShowSlash(false);
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

      <div className="input-bar">
        <button
          className="btn-attach"
          onClick={attachFile}
          title={t('chat.attach')}
        >
          <Paperclip size={15} />
        </button>
        <textarea
          ref={taRef}
          className="input-textarea"
          placeholder={busy ? t('chat.queuePlaceholder') : t('chat.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={1}
        />
        {/* Botão Maestrus pro modo Jarvis: aparece quando o input está vazio
            (e a IA não está respondendo). Some assim que o usuário começa a
            digitar, dando lugar pro envio normal. */}
        {jarvisAvailable && onOpenJarvis && !text.trim() && attachments.length === 0 && !busy && (
          <button
            className="btn-jarvis"
            onClick={onOpenJarvis}
            title={t('voice.start')}
            aria-label={t('voice.start')}
          >
            <Speech size={16} />
          </button>
        )}
        {busy && (
          <button className="btn-stop" onClick={onStop} title={t('chat.stop')}>
            <Square size={13} fill="currentColor" />
          </button>
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
  );
}
