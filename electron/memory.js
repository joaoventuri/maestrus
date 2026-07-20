'use strict';
// Memória de longo prazo do Maestrus — RAG semântico LOCAL (custo zero).
//
// Inspirado no JARVIS, mas sem OpenAI: os embeddings rodam 100% locais via
// @xenova/transformers (all-MiniLM-L6-v2, ~25MB, baixado e cacheado na 1ª vez,
// WASM). Depois de cada turno relevante guardamos { texto, categoria, vetor };
// em novos prompts, embedamos a query e injetamos as top-K memórias mais
// parecidas (cosseno) no system prompt. Sincroniza no GCS (cross-device).
//
// Degradação graciosa: se o modelo não carregar (rede/ambiente), caímos num
// scoring por sobreposição de palavras — a memória continua funcionando, só
// menos esperta. NUNCA quebra o fluxo do chat.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MEM_DIR = path.join(os.homedir(), '.maestrus', 'memory');
const MEM_FILE = path.join(MEM_DIR, 'memory.json');
const MODEL_CACHE = path.join(os.homedir(), '.maestrus', 'models');
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const MAX_MEMORIES = 2000;        // teto — poda as mais antigas/menos úteis
const DEDUP_THRESHOLD = 0.93;     // não guarda quase-duplicatas

let _extractor = null;
let _extractorTried = false;
let _cache = null;

function ensureDir() { try { fs.mkdirSync(MEM_DIR, { recursive: true }); } catch {} }

// ─── Embedder local (lazy) ───────────────────────────────────────────────────
async function getExtractor() {
  if (_extractor) return _extractor;
  if (_extractorTried) return null; // já falhou antes — não tenta de novo
  _extractorTried = true;
  try {
    const tf = await import('@xenova/transformers');
    tf.env.allowRemoteModels = true;          // baixa na 1ª vez
    tf.env.cacheDir = MODEL_CACHE;            // cacheia em ~/.maestrus/models
    _extractor = await tf.pipeline('feature-extraction', MODEL_NAME);
    console.log('[maestrus memory] embedder local pronto (all-MiniLM-L6-v2)');
    return _extractor;
  } catch (e) {
    console.warn('[maestrus memory] embedder indisponível, usando fallback por palavras:', e && e.message);
    return null;
  }
}

async function embed(text) {
  const ext = await getExtractor();
  if (!ext) return null;
  try {
    const out = await ext(String(text).slice(0, 2000), { pooling: 'mean', normalize: true });
    return Array.from(out.data); // 384 floats normalizados
  } catch { return null; }
}

// Vetores normalizados → cosseno = produto escalar.
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// Fallback sem embedding: sobreposição de tokens (Jaccard simplificado).
function tokenize(t) { return new Set(String(t).toLowerCase().match(/[a-zà-ú0-9_]{3,}/gi) || []); }
function tokenOverlap(qTokens, text) {
  const tt = tokenize(text);
  if (tt.size === 0) return 0;
  let inter = 0;
  for (const w of qTokens) if (tt.has(w)) inter++;
  return inter / Math.sqrt(qTokens.size * tt.size);
}

// ─── Storage ─────────────────────────────────────────────────────────────────
function load() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); } catch { _cache = []; }
  if (!Array.isArray(_cache)) _cache = [];
  return _cache;
}
function save() {
  ensureDir();
  try { fs.writeFileSync(MEM_FILE, JSON.stringify(_cache || [])); } catch {}
}

const CATS = [
  [/prefer|gosto|sempre|nunca|estilo|formato|tom|idioma|prefiro/i, 'preference'],
  [/decid|escolh|optei|vamos com|confirmo|aprovado|go with/i, 'decision'],
  [/projeto|deploy|site|app|saas|planilha|pdf|apresenta|feature|módulo|module/i, 'project'],
  [/aprendi|descobri|importante|anotar|salvar|memoriz|lembr/i, 'fact'],
  [/como fazer|tutorial|passo|configur|instalar|setup/i, 'skill'],
];
function categorize(text) {
  for (const [re, cat] of CATS) if (re.test(text)) return cat;
  return 'conversation';
}

// ─── API pública ─────────────────────────────────────────────────────────────

// Guarda um par (pergunta do user → resposta) como memória. Embeda; se já houver
// algo quase idêntico, atualiza o timestamp em vez de duplicar. Best-effort.
async function remember(projectId, userMsg, assistantReply) {
  try {
    const text = `${String(userMsg || '').trim()}\n→ ${String(assistantReply || '').trim()}`.slice(0, 2000);
    if (text.replace(/\s/g, '').length < 12) return; // muito curto, ignora
    const mem = load();
    const vec = await embed(text);
    // Dedup por similaridade (só quando há vetor).
    if (vec) {
      for (const m of mem) {
        if (m.vec && m.vec.length === vec.length && dot(m.vec, vec) > DEDUP_THRESHOLD) {
          m.ts = Date.now();
          save();
          return;
        }
      }
    }
    mem.push({
      id: crypto.randomUUID(),
      projectId: projectId || null,
      text,
      category: categorize(text),
      vec: vec || null,
      ts: Date.now(),
    });
    // Poda: mantém os MAX_MEMORIES mais recentes.
    if (mem.length > MAX_MEMORIES) {
      mem.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      _cache = mem.slice(0, MAX_MEMORIES);
    }
    save();
  } catch (e) { /* memória nunca quebra o fluxo */ }
}

// Recupera as top-K memórias relevantes pra uma query. Usa cosseno se houver
// embedder; senão sobreposição de palavras. Retorna [{text, category, score}].
async function recall(query, k = 4) {
  try {
    const mem = load();
    if (mem.length === 0) return [];
    const qvec = await embed(query);
    let scored;
    if (qvec) {
      scored = mem.map((m) => ({ m, score: m.vec ? dot(m.vec, qvec) : 0 }));
    } else {
      const qTokens = tokenize(query);
      scored = mem.map((m) => ({ m, score: tokenOverlap(qTokens, m.text) }));
    }
    scored.sort((a, b) => b.score - a.score);
    const MIN = qvec ? 0.30 : 0.12; // limiar pra não injetar lixo irrelevante
    return scored.filter((s) => s.score >= MIN).slice(0, k).map((s) => ({
      text: s.m.text, category: s.m.category, score: s.score,
    }));
  } catch { return []; }
}

// Monta um bloco de texto pra anexar no system prompt com as memórias relevantes.
async function recallBlock(query, k = 4) {
  const hits = await recall(query, k);
  if (hits.length === 0) return '';
  const lines = hits.map((h) => `- (${h.category}) ${h.text.replace(/\n/g, ' ').slice(0, 300)}`);
  return ' [MAESTRUS LONG-TERM MEMORY] Relevant facts/preferences/decisions remembered from past sessions (use them, but if something contradicts the current conversation, trust the conversation and ask):\n' + lines.join('\n');
}

// ─── Sync GCS (cross-device) ─────────────────────────────────────────────────
// Serializa pra um buffer (pra cloud-sync subir) e funde o que vem da nuvem
// (união por id, mantém o vetor de quem tiver). Idempotente.
function serialize() { return Buffer.from(JSON.stringify(load())); }
function mergeFromCloud(buf) {
  try {
    const incoming = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(incoming)) return false;
    const mem = load();
    const byId = new Map(mem.map((m) => [m.id, m]));
    let changed = false;
    for (const m of incoming) {
      if (!m || !m.id) continue;
      const cur = byId.get(m.id);
      if (!cur) { byId.set(m.id, m); changed = true; }
      else if ((m.ts || 0) > (cur.ts || 0)) { byId.set(m.id, m); changed = true; }
    }
    if (changed) {
      _cache = [...byId.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, MAX_MEMORIES);
      save();
    }
    return changed;
  } catch { return false; }
}

module.exports = { remember, recall, recallBlock, serialize, mergeFromCloud, MEM_FILE };
