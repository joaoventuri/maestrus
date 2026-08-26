# Maestrus Remoto — host ↔ client via relay na cloud

> Objetivo: rodar um Maestrus como **host** (expõe o Claude CLI local + projetos).
> Outros Maestrus (desktop ou **mobile/Capacitor**) conectam como **client**
> através de um **relay na cloud**, dirigem o CLI do host, veem projetos e
> conversas ao vivo, com **badge de servidor** por conversa remota. O mobile não
> usa CLI nem API local — ele "empresta" o plano de assinatura do host.

## 1. Princípio central: abstrair o transporte

Hoje o renderer fala com a máquina local só por um ponto: `window.maestrus.*`
(contextBridge sobre IPC, em `electron/preload.js`), com `*.onEvent` pro
streaming. Se transformarmos isso numa **interface de transporte** com duas
implementações:

- `LocalTransport` → IPC do Electron (hoje).
- `RemoteTransport` → WebSocket pro relay, que repassa pro host.

…o **mesmo renderer** roda local ou remoto sem reescrita. `renderer/src/lib/
browser-fallback.ts` (stub atual pra fora do Electron) vira a base do
`RemoteTransport`. Mobile = renderer + RemoteTransport (sempre remoto).

```
[ Mobile/Desktop client ] --wss--> [ RELAY (VPS) ] <--wss-- [ Host Maestrus ]
        renderer + RemoteTransport      roteia          remote-host.js
                                      por conta+host     spawna claude CLI
```

## 2. Componentes

### 2.1 Relay (NOVO — serviço Node no VPS)
PHP de shared hosting **não segura WebSocket persistente**. Relay próprio:
- Node + `ws`, atrás do nginx em `wss://maestrus.cloud/relay` (ou subdomínio),
  gerenciado por systemd/pm2.
- Dois papéis conectam (host e client), autenticados por **relay_token**
  (curto, assinado, emitido pelo backend a partir da licença).
- Mantém **presença** por conta: hosts online (nome, SO, lista de projetos).
- Roteia frames entre um client e o host escolhido **dentro da mesma conta e
  pareados**. **Não persiste conteúdo** (privacidade) — só presença/roteamento.
- Rate-limit + tamanho-máx de frame.

### 2.2 Backend PHP (maestrus.cloud/maestrus)
- `action=relay_token`: dado license válido, devolve JWT curto p/ conectar no
  relay (mesmo padrão do `sso` já existente em `app/api.php`).
- Pareamento:
  - `action=pair_create` (host logado + "permitir controle remoto" ON) → gera
    **código one-time** (8 chars, TTL 5 min) → tabela `remote_pairings`.
  - `action=pair_redeem` (client) → valida código → cria vínculo persistente
    (client_device ↔ host), revogável.
- DB novas:
  - `remote_hosts(id, user_id, host_name, os, enabled, last_seen, created_at)`
  - `remote_pairings(id, host_id, client_device_id, code_hash, ttl, redeemed_at, revoked_at)`
- Auto-migração idempotente (`ALTER ... IF NOT EXISTS`), padrão já usado.

### 2.3 Host (Electron main) — NOVO `electron/remote-host.js`
- Toggle nas Settings: **"Run as host (allow remote control)"** (OFF por padrão).
- Ligado: abre WS **de saída** pro relay, autentica (relay_token), registra
  (nome, SO, lista de projetos).
- Recebe RPC do client e reusa os handlers IPC existentes (`projects.list`,
  `claude.send`, `claude.loadHistory`, `claude.stop`, `claudeMd.read`, …).
- Faz fan-out dos eventos `claude.onEvent` (de `claude-pty.js`) de volta pro
  relay, tagueados por `projectId` → client renderiza idêntico.
- Segurança (ver §4): clamp de `permission-mode`, seleção de projetos expostos,
  log de auditoria, botão "desconectar todos os clients".

### 2.4 Client (renderer + main) — transporte + UI
- `renderer/src/lib/transport.ts`: interface única; `LocalTransport` e
  `RemoteTransport`. `window.maestrus` passa a delegar pro transporte ativo.
- Conexão: client lista hosts **online** da conta e escolhe um. Projetos e
  histórico passam a vir do host.
- **Badge de servidor** por conversa quando o transporte é remoto (mostra o
  nome do host).
- Settings: **"Enable Client to Connect"** → cola o código do host → pareia.
- Switch de engine vira 3 vias: **Claude CLI local** · **Host remoto** · **Cloud AI**.
  No host remoto, a execução roda no CLI do host (custo zero p/ você).

### 2.5 Mobile (Capacitor)
- Embrulha a build web do renderer (Vite) num app Android/iOS — **sem reescrever
  a UI**.
- Sem Electron → usa **só** o `RemoteTransport` (ou Cloud AI). Detecta ambiente
  (`window.__maestrus_electron` ausente) e força remoto.
- Login com a conta cloud (email/senha ou SSO) → relay_token → conecta no host.
- CSS responsivo (sidebar/chat) pra telas pequenas.

## 3. Protocolo (frames no relay)
Envelope: `{ v, type, from, to, reqId, channel, payload }`
- `register-host`, `host-list`, `presence`
- `rpc-request` / `rpc-response` (mapeiam 1:1 os handlers IPC)
- `event` (streaming dos `claude.onEvent`, por `projectId`)
- `error`
Deltas são JSON pequeno → WS aguenta de sobra. reqId casa request↔response.

## 4. Segurança (CRÍTICO — é execução remota de código)
Um client remoto dirigindo o Claude Code do host **executa código na máquina do
host** (edita arquivos, roda bash) e gasta o plano dele. Logo:
- Host **opt-in** (toggle OFF por padrão).
- Pareamento: código one-time, TTL curto, vínculo persistente **revogável**.
- Toda conexão no relay autenticada por **relay_token** escopo-de-conta (curto,
  renovável). Relay só conecta client↔host **pareados da mesma conta**.
- Host **clampa** sessões remotas: teto de `permission-mode` (padrão = perguntar),
  e lista de projetos expostos (allowlist).
- **Log de auditoria** no host: quem conectou, o que mandou.
- Relay **não persiste** conteúdo. TLS em tudo. Rate-limit.
- Revisão de segurança dedicada **antes** de habilitar em produção.

## 5. Fases
- **Fase 0 — Transporte (desktop, sem relay):** extrai `transport.ts`, prova
  desktop→desktop **na LAN** (WS direto no `orchestrate-server`, hoje só HTTP
  local). De-risca protocolo + badges com **zero infra**.
- **Fase 1 — Relay:** serviço Node no VPS + nginx + systemd; `relay_token`; host
  registra; client conecta pelo relay (substitui o LAN direto). Funciona sob NAT.
- **Fase 2 — Pareamento & segurança:** toggle do host, códigos, vínculos,
  clamps de permissão, auditoria, revogação.
- **Fase 3 — Mobile (Capacitor):** embrulhar renderer, auth mobile, layout
  responsivo, transporte só-remoto, builds de loja.
- **Fase 4 — Inteligência:** multi-host picker, host anuncia projetos, status
  offline, "rodar em qual máquina" por projeto, fila quando host offline.

## 6. Riscos / esforço
- Relay = nova superfície de ops (Node no VPS).
- Refactor de transporte toca a camada de dados do renderer (mecânico, amplo).
- CSS responsivo no mobile.
- Segurança exige revisão antes de produção (terminal remoto de fato).

## 7. Arquivos (novos/alterados) — referência rápida
- NOVO `relay/` (serviço Node) — fora do app, deploy no VPS.
- NOVO `electron/remote-host.js` — modo host.
- NOVO `renderer/src/lib/transport.ts` — Local/Remote transport.
- ALTERA `electron/preload.js` / `main.js` — delega pro transporte; toggle host.
- ALTERA `renderer/src/lib/browser-fallback.ts` → base do RemoteTransport.
- ALTERA `renderer/src/components/*` — badge de servidor, host picker, settings.
- NOVO `app/api.php` casos `relay_token`, `pair_create`, `pair_redeem`.
- NOVO `migrationN.sql` — `remote_hosts`, `remote_pairings`.
- NOVO `capacitor.config.ts` + wrapper mobile.
