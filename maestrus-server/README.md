# maestrus-server

Headless Node.js server que roda o **Maestrus completo** dentro de um container Docker — sem Electron, sem UI, expondo tudo por WebSocket + REST pra clientes conectarem (desktop, PWA, web app).

Cada cliente cloud Pro tem **um container deste** rodando 24h, endereço `{userId}.maestrus.cloud`.

Ver `DESIGN.md` na raiz do repo pra arquitetura completa.

## Stack interna

- Node 22 (mesmo runtime do Electron main.js atual)
- Módulos reutilizados do `electron/`:
  - `project-store`, `claude-pty`, `remote-host` (registra como host no relay central),
    `openai-key`, `openai-realtime`, `realtime-tools`, `task-store`, `task-queue`,
    `memory`, `orchestrate-server`
- Módulos NÃO usados (dependem de Electron): `main.js`, `preload.js`, `browser-*`, `computer-control`, `runtime.js`, `install.js`
- Novos módulos aqui:
  - `index.js` — entrypoint HTTP + WebSocket bridge
  - `event-bus.js` — adapter que substitui `mainWindow.webContents.send(...)` por broadcast WebSocket
  - `health.js` — endpoint `/health` + `/metrics`

## Rodar local (dev)

```bash
cd maestrus-server
npm install
NODE_ENV=development \
  MAESTRUS_USER_ID=dev-local \
  MAESTRUS_LICENSE_KEY=<uma license válida> \
  MAESTRUS_RELAY_URL=wss://maestrus.cloud/relay \
  MAESTRUS_DATA_DIR=./data \
  npm run start
```

Depois abre desktop → adiciona como remote host manualmente com deviceId `dev-local`.

## Rodar no Docker

```bash
docker compose up
```

## Variáveis de ambiente

| Var | Descrição |
|---|---|
| `MAESTRUS_USER_ID` | ID único do user (subdomínio + deviceId no relay) |
| `MAESTRUS_LICENSE_KEY` | License key do user (autoriza no relay + cloud) |
| `MAESTRUS_RELAY_URL` | wss://maestrus.cloud/relay |
| `MAESTRUS_DATA_DIR` | dir persistente `/data/{userId}/` |
| `MAESTRUS_PORT` | porta HTTP local (default 8090) |
| `MAESTRUS_ANTHROPIC_KEY` | opcional — chave Anthropic BYOK |
| `MAESTRUS_OPENAI_KEY` | opcional — chave OpenAI BYOK (voice) |

Todas as configs (kanban, MCP servers, skills, projetos) ficam em `MAESTRUS_DATA_DIR`, portável entre containers.
