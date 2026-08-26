# Imagem-base do sandbox do Maestrus on Cloud.
# Node + Git + Claude CLI + o runner headless. O orquestrador sobe um container
# destes por projeto cloud, passando RELAY_URL/RELAY_TOKEN/PROJECT_* via env e
# montando o repo em /workspace.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (o agente).
RUN npm install -g @anthropic-ai/claude-code

# Runner + o relay compartilhado (mesmo link.js do desktop).
WORKDIR /app
COPY relay/ ./relay/
COPY cloud-runner/package.json ./cloud-runner/package.json
RUN cd cloud-runner && npm install --omit=dev
COPY cloud-runner/runner.js ./cloud-runner/runner.js

# Onde o repo do projeto é clonado/montado.
RUN mkdir -p /workspace
ENV WORKDIR=/workspace
WORKDIR /workspace

# bypassPermissions é o padrão do Maestrus; o runner não pausa por aprovação.
CMD ["node", "/app/cloud-runner/runner.js"]
