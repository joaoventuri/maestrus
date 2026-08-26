# Maestrus — Estudo de Negócio: Pricing na era do container por usuário

**Data:** 2026-07-12 · **Status:** proposta para decisão do owner
**Contexto:** com o cloud-first no ar (1 container por usuário, `u{id}.maestrus.cloud`),
a estrutura de custo mudou: cada usuário cloud ativo agora tem um custo fixo mensal
(container + storage), não mais custo marginal ~zero. O pricing precisa refletir isso —
e a oportunidade é enorme, porque o custo é baixíssimo perto do valor entregue.

---

## 1. O insight central: BYO-assinatura = margem de software puro

O Maestrus tem uma vantagem estrutural sobre TODO concorrente de "AI coding cloud"
(Devin, Replit Agent, Cursor background agents):

> **O cliente traz a própria assinatura de IA.** O Claude Code roda com o plano
> Claude do usuário (OAuth). Com o Codex CLI (ver §4), roda com o plano ChatGPT dele.
> **Nosso custo de IA = $0.** Vendemos a orquestração, o 24/7 e a conveniência.

Concorrentes pagam a inferência (a parte cara). Nós vendemos o *palco*, o cliente traz
a *orquestra*. Isso permite preço agressivo com margem de 90%+.

O **Cloud AI** (proxy metered) vira o caminho de conveniência para quem não tem
assinatura — cobrado com markup, nunca incluído em quantidade que gere prejuízo.

---

## 2. Custo unitário real por usuário cloud (hoje)

| Item | Cálculo | Custo/user/mês |
|---|---|---|
| Container 4GB (VPS 16GB/8vCPU ~$30, ~10-12 containers ativos com overcommit de RAM/CPU — idle é quase grátis) | $30 ÷ 10 conservador | **~$3.00** |
| Com auto-suspend (containers idle >7d pausados, ~40/host) | $30 ÷ 40 | **~$0.75** |
| Storage GCS 10GB | 10 × $0.02 | $0.20 |
| Bandwidth + relay | rateado | ~$0.10 |
| **Total (conservador, sem auto-suspend)** | | **~$3.30** |
| **Total (com auto-suspend implementado)** | | **~$1.05** |

⚠️ O número de $105/mês para 100 users do DESIGN.md §5 assume auto-suspend.
**Auto-suspend é o item de infra mais importante da Fase 5** — muda a margem de 78% para 93%.

---

## 3. Proposta de planos (recomendação)

Ancoragem de mercado: Cursor $20, ChatGPT Plus $20, Claude Pro $20, Replit Core $25,
Devin $20+ (usage). O usuário-alvo já paga $20-40/mês em IA. O Maestrus se posiciona
como **a camada que multiplica o valor do que ele já paga** — não mais um gasto de IA.

| Plano | Preço | O que inclui | Custo/user | Margem |
|---|---|---|---|---|
| **Free (Local)** | $0 | Desktop completo, engines CLI locais, projetos ilimitados. Sem cloud, sem sync. | ~$0 | — (funil) |
| **Cloud** | **$19/mês** (ou $190/ano) | Container 4GB 24/7 · sync 10GB · web/mobile de qualquer lugar · voice · **BYO Claude/ChatGPT** · $5 de Cloud AI de cortesia | ~$1.30 | **~93%** |
| **Cloud Pro** | **$39/mês** (ou $390/ano) | Container 8GB prioridade · sync 50GB · $15 de Cloud AI · voice realtime (OpenAI) · suporte prioritário | ~$2.60 + AI | **~85%** |
| **Team** (Fase 6) | $99/mês (5 seats) | Workspaces compartilhados, billing central | — | — |

**Cloud AI avulso:** créditos prepagos $5–$100 (já existe), custo Anthropic × 1.35–1.5.
Nunca "unlimited". O incluído no plano é cortesia de onboarding, não o produto.

Racional dos números:
- **$19** fica abaixo da âncora psicológica dos $20 das assinaturas de IA — "menos que
  o seu ChatGPT". Com custo ~$1.30, cada usuário Cloud rende ~$17.70/mês líquido de infra.
- **Anual com 2 meses grátis** melhora caixa e retenção (padrão SaaS).
- O plano atual "Pro $20 com $20 de AI incluído" tem margem potencialmente NEGATIVA
  (se o user consome os $20, o custo Anthropic é ~$14-15 + container $1.30 + Stripe →
  sobra ~$3). **Recomendo migrar o incluído de $20 → $5 no Cloud e $15 no Cloud Pro.**
- Trial 30 dias do Cloud (já implementado) → cartão pré-autorizado no dia 0,
  e-mail no dia 25, downgrade automático (container pausado, dados 90 dias).

### Caminho para o primeiro milhão
- 500 users Cloud ($19) + 100 Cloud Pro ($39) = **$13.4k MRR ≈ $160k ARR**, infra ~$1k/mês.
- Milestone $1M ARR ≈ 3.500 users Cloud + 700 Pro. Com funil Free→Cloud de 5-8%
  isso pede ~60-80k instalações Free. O Free local (custo zero) existe exatamente
  pra alimentar esse funil — distribuição agressiva (Product Hunt, HN, YouTube dev BR/EN/ES).

---

## 4. Codex CLI (OpenAI) como segunda engine — SIM, e é barato de fazer

*(Nota: o produto chama-se **Codex CLI** — "Cortex" não existe na OpenAI.)*

Confirmado na documentação oficial da OpenAI (jul/2026):
- **Login com conta ChatGPT** (OAuth via browser) — mesmo modelo do `claude auth login`.
  Usa os limites do plano ChatGPT do usuário (Plus/Pro/Business), **sem API key**.
- **Modo headless:** `codex exec --json "tarefa"` → stream de eventos **JSONL** no
  stdout (comandos executados, arquivos alterados, mensagens do agente) — equivalente
  direto do `claude -p --output-format stream-json`.
- Suporta resume de sessão, sandbox de execução e MCP.

**Encaixe na arquitetura:** o `claude-pty.js` já abstrai spawn + parse de stream JSON.
Um `codex-pty.js` (ou modo no mesmo módulo) mapeando os eventos JSONL do Codex para o
mesmo shape interno cobre desktop, container e remote de uma vez. O OAuth bridge do
container (paste-code) já existe para o Claude — replicar o padrão para `codex login`.

| Item | Esforço estimado |
|---|---|
| Adapter spawn/stream (`codex exec --json` → eventos internos) | 2-4 dias |
| Auth inline no chat (reusa padrão ClaudeCliConnect) | 1-2 dias |
| Bundle do binário no instalador (`vendor/runtime/codex/`) | 1 dia |
| OAuth bridge no container (reusa claude-auth) | 1-2 dias |
| Picker de engine por projeto (UI já tem conceito de engine) | 1 dia |

**Impacto de negócio:** dobra o mercado endereçável (usuários ChatGPT >> usuários
Claude), zero custo de inferência, e cria o pitch único: *"um maestro, todas as
orquestras — Claude e ChatGPT trabalhando nos seus projetos, juntos"*. Nenhum
concorrente orquestra as duas assinaturas do usuário numa interface só.

**Alinhado à diretriz atual:** nada via API key — só CLI com assinatura do usuário
+ Cloud AI gerenciado como fallback.

---

## 5. Regras de proteção de margem (implementar na Fase 5)

1. **Auto-suspend** de container após 7 dias sem atividade (start automático no
   próximo acesso, <20s). Maior alavanca de custo.
2. **Cloud AI**: hard-stop no saldo (nunca negativo), markup mínimo 1.35×, incluído
   mensal não acumula.
3. **Fair use de container**: 1 container por conta; limite de CPU burst; sem mineração
   (monitorar CPU sustentada >90% por horas).
4. **Storage**: overage por GB-mês (já existe `cron_overage.php`) — manter.
5. **Stripe**: cobrar anual à vista com desconto; dunning automático (retry + e-mail).

## 5.5 · ATUALIZAÇÃO 2026-07-15 — Estudo competitivo REAL (pesquisa de mercado)

**Veredito honesto: o Maestrus NÃO é "algo que ninguém nunca fez".** O espaço
de "controlar/orquestrar o Claude Code" está quente e tem players fortes —
inclusive a própria Anthropic. O que o Maestrus tem de único é a COMBINAÇÃO,
não cada peça isolada.

### O mapa (julho/2026)

| Player | O que faz | Preço | Ameaça |
|---|---|---|---|
| **Claude Code web/mobile (Anthropic)** | Sessões cloud em VM gerenciada, teleport, remote-control de sessão local pelo celular. Cowork mobile (jul/2026) roda com o laptop fechado (Max $100) | Incluído no Pro/Max | **ALTA** — absorve o caso "acessar de qualquer lugar" |
| **Happy** (happy.engineering) | Remote control open source do Claude Code/Codex: iOS/Android/web, voz, criptografia E2E | **Grátis, OSS** | ALTA no layer "celular controla o CLI" — commoditizou esse pedaço |
| **Omnara** | Command center: rodar/monitorar/guiar sessões de qualquer device; 20k+ users | Free core + ~$9/mês | MÉDIA |
| **Conductor** | Orquestra agentes paralelos num repo (worktrees), desktop Mac. Series A de $22M | — | MÉDIA — valida o mercado de orquestração |
| **Devin / Factory / Cursor BG agents** | Agentes full-service que cobram por uso (ACUs/créditos) | $20–200/mês + uso | BAIXA direta (outro modelo: eles PAGAM a inferência) |

### Onde o Maestrus é genuinamente diferente (o pitch honesto)
1. **Multi-PROJETO, multi-MÁQUINA de um chat só** — Conductor paraleliza 1 repo;
   Happy/Omnara espelham sessões; Anthropic é 1 tarefa/VM. Ninguém "rege" N
   codebases + servidores SSH + máquinas como sistemas de uma orquestra, com
   /ask, /parallel e Kanban 24/7.
2. **Container SEU, persistente, com endereço próprio** — a VM da Anthropic é
   efêmera por tarefa; o container Maestrus é a "máquina dev na nuvem" do
   usuário, viva 24/7, com todos os projetos e memória.
3. **Voz Jarvis + controle de computador/navegador** — nenhum player do mapa faz.
4. **Multi-conta Claude com switch** + uso oficial em tempo real — ninguém tem.
5. **PT/EN/ES + instalador zero-fricção** — nicho BR/LATAM mal atendido.

### Consequências pro preço
- O layer "controlar do celular" NÃO é vendável sozinho (Happy é grátis/OSS).
  O que se vende: **o compute 24/7 (container) + a conveniência gerenciada**.
- $19 Cloud / $39 Cloud Pro (seção 3) continuam certos: abaixo do Omnara+VPS
  DIY somados, na âncora psicológica "menos que o ChatGPT", margem ~93%.
- Sinal de risco: a Anthropic empacotando cloud sessions no Max derruba o
  valor percebido — reforça a urgência de LANÇAR AGORA e dominar o nicho
  multi-projeto/BR antes.

## 5.6 · Decisão Open Source (recomendação)

**SIM — open-core, e é a jogada certa.** O concorrente gratuito (Happy) já
existe e é OSS: manter o self-host fechado não protege nada; abrir compra
distribuição, confiança e comunidade. O que se monetiza é o **gerenciado**
(o playbook GitLab/Supabase/Coolify).

**Repo público `maestrus-selfhost`** (licença **FSL/BSL 1.1** — livre pra
self-host e uso interno, PROIBIDO oferecer como SaaS concorrente; vira
Apache 2.0 após 2 anos):
- `maestrus-server` (headless) + `relay` + **PWA client** buildado
- `docker-compose.yml` de 1 comando (Linux/Windows/qualquer nuvem): sobe
  server + relay + PWA servido — o usuário aponta o desktop/PWA pra URL dele
- Desktop Mac/Windows ganham campo **"URL do meu servidor"** (self-host)
- Docs PT/EN de instalação

**Continua fechado (o negócio):** control plane do maestrus.cloud
(provisionamento 1-clique, subdomínio TLS, billing, Maestrus AI proxy,
multi-device pairing gerenciado, updates automáticos, suporte). Marca
"Maestrus" registrada como trademark.

**Por que NÃO está "dando tudo de graça":** quem self-hospeda ia usar o Happy
grátis mesmo; agora usa o SEU, vira comunidade, estrela no GitHub, e quando
cansar de manter VPS/TLS/update vira cliente Cloud. O funil Free→Cloud passa
a ter dois braços (desktop local + self-host).

## 5.7 · Pronto pra lançar? (checklist honesto — 2026-07-15)

**PRONTO para lançamento em beta pública com trial 30d: SIM.**
**PRONTO para cobrar assinatura Cloud: AINDA NÃO — falta a Fase 5 (Stripe).**

| Item | Status |
|---|---|
| Produto core (desktop, web, PWA, container, voz, orquestração) | ✅ em produção |
| Onboarding signup→container→OAuth→uso | ✅ (falta 1 teste OAuth de ponta a ponta com código real) |
| Provisioning self-heal + crons (overage, trial) | ✅ |
| Updates automáticos (asar + instalador) | ✅ |
| **Stripe dos planos Cloud $19/$39** (trial→cobrança, dunning) | ❌ Fase 5 — ~1-2 semanas |
| Auto-suspend por inatividade (proteção de margem) | ⚠️ só trial-expirado; idle falta |
| Páginas legais (Termos, Privacidade) na landing | ❌ rápido, obrigatório pré-cobrança |
| Landing page comercial (docs/COMERCIAL-LP.md pronto como fonte) | ❌ em produção por outra IA |
| Repo maestrus-selfhost (open-core) | ❌ ~1 semana |

**Sequência recomendada:** (1) lançar beta pública JÁ com trial 30d e LP nova
→ (2) Stripe + legal na semana seguinte → (3) virar a chave da cobrança pros
trials novos → (4) repo open source como onda de marketing (Product Hunt/HN).

## 6. Decisões que este estudo pede ao owner

1. ✅/❌ Migrar Pro $20/$20-AI → **Cloud $19/$5-AI** + **Cloud Pro $39/$15-AI**
   (grandfathering: quem já paga mantém 6 meses).
2. ✅/❌ Priorizar **auto-suspend** antes de abrir o trial ao público.
3. ✅/❌ Codex CLI como engine 2 (estimativa ~1-2 semanas).
4. ✅/❌ Anual com 2 meses grátis desde o lançamento.
