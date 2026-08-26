# Maestrus on Cloud — Runner (Fase 1)

Runtime 100% na nuvem: cada projeto cloud vive num **sandbox** (container/microVM)
onde o Claude roda de verdade. O sandbox se liga no **relay** como "host", então
o desktop/PWA conecta nele **igual** conecta na sua máquina — reusando todo o
transporte (`relay/link.js`, `remote-client.js`). Beats Omnara porque o runtime
é **persistente e coerente** (não um container limpo a cada migração).

## Por que isso (vs. os 3 modos atuais)
- **Free** — local, 1 máquina.
- **Pro $12** — sua máquina vira servidor (relay).
- **Cloud $30–40** — runtime na nuvem, persistente, PC off, snapshot/restore. ← este.
- **+ JARVIS** em todos (controle de PC + voz) — que a Omnara não tem.

## Arquitetura (o runner reusa ~80% do que já existe)
```
PWA/Desktop ──relay (existente)──▶ Sandbox cloud
                                    ├─ Claude CLI (o agente)
                                    ├─ cloud-runner/runner.js  ← host headless
                                    │    (replica os eventos do claude-pty)
                                    └─ /workspace = repo do projeto (persistente)
Backend (orquestrador) = cria/snapshota/restaura o sandbox + emite relay_token + bill
```
`runner.js` é a versão headless do `electron/remote-host.js`: mesmo protocolo RPC
(`projects.list`, `claude.send`, `claude.stop`, `claude.loadHistory`), mesmos
eventos (`assistant-text`, `tool-use`, `tool-result`, `delta`, `done`…).

## Backend de sandbox — plugável (abstração)
- `local-docker` — **grátis**, roda num host Docker (VPS dedicado de ~$5/mês, ou
  o seu pra protótipo). Sem isolamento forte → só você/beta confiável.
- `e2b` / `fly-sprites` — Firecracker/microVM (isolamento forte, snapshot/restore,
  scale-to-zero) pra escala pública. Mesma orquestração; só o "spawn" muda.

## Status / Fases
- **Fase 1 (feito):** `runner.js` headless + `Dockerfile` da imagem-base.
- **Fase 2:** orquestrador no backend (`api.php` action `cloud_session_start`):
  `docker run` (ou E2B/Fly API) a imagem, clona o repo, emite `relay_token`,
  devolve o `host_device_id` pro app conectar (mesmo fluxo do `remote:connect`).
  + gate no plano Cloud + UI "criar projeto na nuvem".
- **Fase 3:** snapshot/restore no idle (scale-to-zero), metragem de compute +
  tokens (ai-proxy já existe), egress/segurança, persistência do volume.

## Testar localmente (Fase 1)
Precisa de um host com Docker + um `relay_token` de host válido (via
`api.php?action=relay_token&role=host`) + auth do Claude (Maestrus AI ou key).

```bash
# 1) build da imagem (a partir da raiz do repo claui)
docker build -f cloud-runner/Dockerfile -t maestrus-runner .

# 2) sobe um sandbox de teste (repo em ./meu-projeto)
docker run --rm \
  -e RELAY_URL="wss://<relay>" \
  -e RELAY_TOKEN="<relay_token host>" \
  -e DEVICE_ID="cloud-demo-1" \
  -e PROJECT_ID="cloud-demo" \
  -e PROJECT_NAME="Demo Cloud" \
  -e ANTHROPIC_BASE_URL="https://maestrus.cloud/ai-proxy.php" \
  -e ANTHROPIC_AUTH_TOKEN="<license_key>" \
  -v "$PWD/meu-projeto:/workspace" \
  maestrus-runner

# 3) no app: conecte como cliente nesse host (device cloud-demo-1) e converse.
```
O projeto "Demo Cloud" aparece e o chat roteia pro sandbox. PC off não importa —
o runtime está no container.
