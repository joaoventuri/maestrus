const fs = require('fs');
const path = require('path');

const DEFAULT_TEMPLATE = (name) => `# CLAUDE.md

Instruções específicas deste projeto para o Claude Code. Este arquivo é lido automaticamente no início de cada sessão e funciona como memória do projeto.

## Sobre ${name}

(Descreva brevemente o que este projeto faz)

## Stack

- (linguagens, frameworks, ferramentas)

## Convenções

- (estilo de código, naming, padrões a seguir)

## Comandos úteis

\`\`\`bash
# rodar localmente
# rodar testes
# build
\`\`\`

## O que evitar

- (anti-patterns, decisões já tomadas que não devem ser revertidas)
`;

function pathFor(project) {
  if (!project.codeDir) return null;
  return path.join(project.codeDir, 'CLAUDE.md');
}

function read(project) {
  const p = pathFor(project);
  if (!p) return { exists: false, path: null, content: '' };
  if (!fs.existsSync(p)) return { exists: false, path: p, content: '' };
  return { exists: true, path: p, content: fs.readFileSync(p, 'utf8') };
}

function write(project, content) {
  const p = pathFor(project);
  if (!p) throw new Error('Projeto sem codeDir definido');
  fs.writeFileSync(p, content, 'utf8');
  return { exists: true, path: p, content };
}

function ensure(project) {
  const cur = read(project);
  if (cur.exists) return cur;
  return write(project, DEFAULT_TEMPLATE(project.name));
}

module.exports = { read, write, ensure, pathFor };
