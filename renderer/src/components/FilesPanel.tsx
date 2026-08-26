import { useEffect, useState, useMemo } from 'react';
import { X, FileText, Download, Loader2, Search, FolderClosed, RefreshCw } from 'lucide-react';
import { useT } from '../lib/i18n';

type Entry = { rel: string; dir?: boolean; size?: number; mime?: string };

// Painel de Arquivos por projeto (Fase C — arquivos universais). Lista a árvore
// do workspace ONDE O PROJETO VIVE (local, host remoto ou container) e permite
// baixar/preview qualquer arquivo — resolve "o arquivo ficou no host e o client
// não acessa". Usa window.maestrus.files.tree/pull/saveAs (roteia sozinho).
export default function FilesPanel({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { t } = useT();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [busyRel, setBusyRel] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ rel: string; kind: 'text' | 'image'; body: string } | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r: any = await (window as any).maestrus?.files?.tree?.(projectId);
      if (r && r.ok) setEntries((r.files || []).filter((e: Entry) => !e.dir));
      else setErr((r && r.error) || 'erro');
    } catch (e: any) { setErr(e?.message || 'erro'); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (open) { setPreview(null); load(); } /* eslint-disable-next-line */ }, [open, projectId]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = entries || [];
    return (s ? list.filter((e) => e.rel.toLowerCase().includes(s)) : list).slice(0, 1500);
  }, [entries, q]);

  async function pull(rel: string): Promise<{ ok: boolean; dataB64?: string; mime?: string; error?: string } | null> {
    setBusyRel(rel);
    try { return await (window as any).maestrus?.files?.pull?.(projectId, rel); }
    catch (e: any) { return { ok: false, error: e?.message }; }
    finally { setBusyRel(null); }
  }
  async function download(rel: string) {
    const r = await pull(rel);
    if (r && r.ok && r.dataB64) await (window as any).maestrus?.files?.saveAs?.(rel.split('/').pop(), r.dataB64);
  }
  async function openPreview(e: Entry) {
    const mime = e.mime || '';
    const isImg = mime.startsWith('image/');
    const isText = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';
    if (!isImg && !isText) return download(e.rel);
    const r = await pull(e.rel);
    if (!r || !r.ok || !r.dataB64) return;
    if (isImg) setPreview({ rel: e.rel, kind: 'image', body: `data:${mime};base64,${r.dataB64}` });
    else { try { setPreview({ rel: e.rel, kind: 'text', body: decodeURIComponent(escape(atob(r.dataB64))) }); } catch { setPreview({ rel: e.rel, kind: 'text', body: atob(r.dataB64) }); } }
  }

  if (!open) return null;
  return (
    <aside className="files-dock">
      <header className="files-dock-head">
        <span className="files-dock-title"><FolderClosed size={14} /> {t('files.title') || 'Arquivos'}</span>
        <button className="files-dock-refresh" title={t('nav.refresh') || 'Atualizar'} onClick={load}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
        <button className="files-dock-close" onClick={onClose} title={t('common.close') || 'Fechar'}><X size={15} /></button>
      </header>
      <div className="files-dock-search">
        <Search size={13} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('files.search') || 'Filtrar arquivos…'} />
      </div>
      {preview ? (
        <div className="files-preview">
          <div className="files-preview-bar">
            <span className="files-preview-name">{preview.rel}</span>
            <button onClick={() => download(preview.rel)} title={t('files.download') || 'Baixar'}><Download size={14} /></button>
            <button onClick={() => setPreview(null)} title={t('common.close') || 'Fechar'}><X size={14} /></button>
          </div>
          {preview.kind === 'image'
            ? <div className="files-preview-img"><img src={preview.body} alt={preview.rel} /></div>
            : <pre className="files-preview-text">{preview.body}</pre>}
        </div>
      ) : (
        <div className="files-dock-list">
          {loading && !entries ? <div className="files-dock-empty"><Loader2 size={16} className="spin" /></div>
            : err ? <div className="files-dock-empty err">{err}</div>
            : filtered.length === 0 ? <div className="files-dock-empty">{t('files.empty') || 'Nenhum arquivo'}</div>
            : filtered.map((e) => (
              <div key={e.rel} className="files-row" onClick={() => openPreview(e)} title={e.rel}>
                <FileText size={13} className="files-row-icon" />
                <span className="files-row-name">{e.rel}</span>
                {typeof e.size === 'number' && <span className="files-row-size">{fmtSize(e.size)}</span>}
                <button className="files-row-dl" onClick={(ev) => { ev.stopPropagation(); download(e.rel); }} title={t('files.download') || 'Baixar'}>
                  {busyRel === e.rel ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
                </button>
              </div>
            ))}
        </div>
      )}
    </aside>
  );
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
