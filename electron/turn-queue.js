'use strict';
/**
 * Fila de prompts POR CONVERSA, vivendo no host.
 *
 * Antes a fila era um useRef no navegador (ProjectChat): sair da conversa
 * apagava tudo, o host nunca soube que ela existia, e cada dispositivo tinha a
 * sua. Agora a fila é estado do host, persistido em disco:
 *
 *   • sobrevive a trocar de conversa, fechar o app e reiniciar a máquina
 *   • é a MESMA em todos os dispositivos (enfileira no desktop, vê no celular)
 *   • o host despacha o próximo sozinho quando o turno termina
 *
 * Não confundir com task-queue.js: aquele é o Kanban 24/7 (tarefas autônomas
 * entre projetos). Este é a fila do turno de UMA conversa — o que você digita
 * enquanto a IA ainda está respondendo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let _dir = null;
function storeDir() {
  if (_dir) return _dir;
  try {
    const { app } = require('electron');
    if (app && app.getPath) _dir = app.getPath('userData');
  } catch {}
  if (!_dir) _dir = path.join(os.homedir(), '.maestrus');
  try { fs.mkdirSync(_dir, { recursive: true }); } catch {}
  return _dir;
}
function storePath() { return path.join(storeDir(), 'turn-queue.json'); }

// projectId → [{ id, text, attachments, at }]
let queues = new Map();
let loaded = false;
let onChange = null;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) if (Array.isArray(v) && v.length) queues.set(k, v);
  } catch { /* primeira execução, ou arquivo corrompido: começa vazio */ }
}

function persist() {
  const obj = {};
  for (const [k, v] of queues) if (v && v.length) obj[k] = v;
  try {
    fs.writeFileSync(storePath(), JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[maestrus][queue] persist falhou:', e && e.message);
  }
}

function emitChange(projectId) {
  persist();
  try { onChange && onChange(projectId, list(projectId)); } catch {}
}

/** Quem recebe as mudanças (main.js liga no fan-out de eventos). */
function setOnChange(fn) { onChange = fn; }

function list(projectId) {
  load();
  return (queues.get(projectId) || []).map((it) => ({ ...it }));
}

function count(projectId) { load(); return (queues.get(projectId) || []).length; }

function enqueue(projectId, item) {
  load();
  const text = String((item && item.text) || '').trim();
  if (!projectId || !text) return null;
  const entry = {
    id: 'q_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(36),
    text,
    attachments: Array.isArray(item.attachments) ? item.attachments : undefined,
    at: Date.now(),
  };
  const arr = queues.get(projectId) || [];
  arr.push(entry);
  queues.set(projectId, arr);
  emitChange(projectId);
  return entry;
}

function remove(projectId, itemId) {
  load();
  const arr = queues.get(projectId);
  if (!arr) return false;
  const i = arr.findIndex((x) => x.id === itemId);
  if (i < 0) return false;
  arr.splice(i, 1);
  if (arr.length) queues.set(projectId, arr); else queues.delete(projectId);
  emitChange(projectId);
  return true;
}

/** Reordena pela lista de ids; ids desconhecidos são ignorados e o resto mantém a ordem. */
function reorder(projectId, ids) {
  load();
  const arr = queues.get(projectId);
  if (!arr || !Array.isArray(ids)) return false;
  const byId = new Map(arr.map((x) => [x.id, x]));
  const next = [];
  for (const id of ids) { const it = byId.get(id); if (it) { next.push(it); byId.delete(id); } }
  for (const it of arr) if (byId.has(it.id)) next.push(it);
  queues.set(projectId, next);
  emitChange(projectId);
  return true;
}

function clear(projectId) {
  load();
  if (!queues.has(projectId)) return false;
  queues.delete(projectId);
  emitChange(projectId);
  return true;
}

/**
 * Tira o próximo item pra despachar. Prompts curtos e seguidos são FUNDIDOS
 * num só turno: três mensagens de uma linha escritas em sequência quase sempre
 * são o mesmo pedido, e mandar uma a uma gasta um turno (e contexto) por linha.
 * Só funde o que não tem anexo e o que foi escrito com pouco intervalo.
 */
const MERGE_WINDOW_MS = 90 * 1000;
const MERGE_MAX_CHARS = 1200;

function shift(projectId, { merge = true } = {}) {
  load();
  const arr = queues.get(projectId);
  if (!arr || !arr.length) return null;

  const first = arr.shift();
  const parts = [first.text];
  let attachments = first.attachments;

  if (merge && !first.attachments) {
    while (arr.length) {
      const nxt = arr[0];
      const soon = Math.abs((nxt.at || 0) - (first.at || 0)) <= MERGE_WINDOW_MS;
      const fits = parts.join('\n').length + nxt.text.length <= MERGE_MAX_CHARS;
      // Comando slash é sempre um turno próprio: fundir mudaria o significado.
      const plain = !nxt.attachments && !nxt.text.startsWith('/') && !first.text.startsWith('/');
      if (!soon || !fits || !plain) break;
      parts.push(arr.shift().text);
    }
  }

  if (arr.length) queues.set(projectId, arr); else queues.delete(projectId);
  emitChange(projectId);
  return { text: parts.join('\n'), attachments, merged: parts.length };
}

module.exports = { setOnChange, list, count, enqueue, remove, reorder, clear, shift };
