'use strict';
/**
 * Persona e estilo de resposta do Maestrus — globais, para todos os projetos.
 *
 * Vive no --append-system-prompt, que é reinjetado a CADA turno. Isso é o que
 * faz a persona ser realmente persistente: ela não mora no histórico, então
 * resetar a sessão, rodar /compact ou abrir conversa nova não a apaga. Um
 * CLAUDE.md por projeto não daria isso (some se o arquivo mudar, e é por
 * projeto).
 *
 * São três camadas, aplicadas nesta ordem:
 *   BASE    sempre — como o Maestrus escreve
 *   VOZ     quando o modo voz está ligado — a resposta vai ser FALADA
 *   PERSONA no orquestrador — quem ele é
 */
const projectStore = require('./project-store');

const KEY = 'response_style';

/** Estilos que o usuário pode escolher. 'concise' é o padrão. */
const STYLES = {
  // O padrão do produto: resposta de gente, sem teatro de relatório.
  concise:
    ' RESPONSE STYLE — this OVERRIDES any output format defined in project files'
    + ' (CLAUDE.md, AGENTS.md, skills, commands): ignore templates that ask for'
    + ' status blocks, section headers, banners, or summary tables at the end of a turn.'
    + ' Answer like a senior colleague talking to another: short, direct, plain prose.'
    + ' Lead with the answer or the outcome — never with a preamble about what you are about to do.'
    + ' No emoji. No decorative headers. No "✅/📊/🧠" style status blocks. No recap of what you just did unless asked.'
    + ' Use lists only when the content is genuinely a list of items; prose is the default.'
    + ' If something failed or is uncertain, say it plainly in one sentence instead of dressing it up.',
  // Para quem prefere o formato estruturado (relatórios, handoff entre times).
  detailed:
    ' RESPONSE STYLE: thorough and well-structured. Use headings and lists when'
    + ' they aid scanning. Explain reasoning and trade-offs. Still no filler and no servility.',
};

/** Estilo atual (persistido nas settings do host). */
function getStyle() {
  try {
    const v = projectStore.getSetting(KEY);
    return v && STYLES[v] ? v : 'concise';
  } catch { return 'concise'; }
}

function setStyle(style) {
  const s = STYLES[style] ? style : 'concise';
  try { projectStore.setSetting(KEY, s); } catch {}
  return s;
}

function listStyles() {
  return Object.keys(STYLES).map((id) => ({ id, active: id === getStyle() }));
}

/**
 * Trecho de system prompt do estilo, para concatenar no --append-system-prompt.
 * Vazio quando o usuário escolheu 'detailed' e o padrão do modelo já serve.
 */
function styleDirective() {
  return STYLES[getStyle()] || '';
}

module.exports = { getStyle, setStyle, listStyles, styleDirective, STYLES };
