# Maestrus user container — 1 imagem, N tenants (cada container = 1 user).
# Ver DESIGN.md #2.2 na raiz do repo.

FROM node:22-slim AS base

# Instala git (necessário pro Claude CLI clonar repos) + tools comuns.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl openssh-client bash coreutils \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI oficial (npm). Roda no user do container.
RUN npm install -g @anthropic-ai/claude-code@latest \
    && claude --version

WORKDIR /app

# Copia manifest primeiro pra beneficiar cache do docker.
COPY maestrus-server/package.json ./package.json
RUN npm install --production --no-audit --no-fund

# Copia o backend Electron (reusado headless via electron-compat) + relay.
COPY electron ./electron
COPY relay ./relay
COPY maestrus-server ./

# Self-host: os estáticos do web app e do PWA são servidos pelo PRÓPRIO
# servidor (uma porta só). webroot = web app (/), approot = PWA (/app).
# Buildados antes no CI (npm run build:web / build:mobile). Se ausentes, o
# servidor apenas não serve estáticos (modo cloud não precisa).
COPY dist-web ./webroot
COPY dist-mobile ./approot
# No PWA o entrypoint é mobile.html; o servidor faz fallback pra index.html,
# então garante que exista.
RUN [ -f ./approot/mobile.html ] && cp -f ./approot/mobile.html ./approot/index.html || true
RUN [ -f ./webroot/web.html ] && cp -f ./webroot/web.html ./webroot/index.html || true

# /data é o volume persistente (montado via -v no docker run). Cria e dá posse
# ao user node (uid 1000) — sem VOLUME declaration, que descartaria o chown e
# deixaria o dir root-owned (node não conseguiria gravar credenciais/sessões).
RUN mkdir -p /data && chown -R node:node /data

# Env padrão — sobreescreve com -e no docker run.
# HOME=/data é CRÍTICO: o Claude CLI grava credenciais em ~/.claude, e ~ precisa
# apontar pro volume persistente (/data), senão o login some ao reiniciar o
# container (antes ia pra /home/node, fora do volume).
ENV MAESTRUS_DATA_DIR=/data \
    MAESTRUS_PORT=8090 \
    MAESTRUS_LOG=info \
    HOME=/data \
    NODE_ENV=production

EXPOSE 8090

# /data precisa ser gravável pelo user node (uid 1000). Cria e dá posse ANTES do
# VOLUME/USER — o volume nomeado herda essa ownership quando criado do zero.
RUN mkdir -p /data && chown -R node:node /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:8090/health || exit 1

USER node

CMD ["node", "index.js"]
