# Maestrus — Estudo Competitivo, Pricing, Lançamento e Open Source

**Data:** 2026-07-15 · **Autor:** análise técnica + pesquisa de mercado (jul/2026)
**Para:** decisão do owner (João) · **Companion:** `BUSINESS-PRICING.md` (custo de infra)

> Este documento responde 4 perguntas: (1) o Maestrus é inovador ou tem
> concorrente? (2) quanto cobrar? (3) estamos prontos pra lançar? (4) a
> estratégia open source é inteligente ou entrega o ouro de graça?

---

## 1. O Maestrus é inovador? (resposta honesta)

**Não é 100% inédito em nenhuma peça isolada — é inédito na COMBINAÇÃO.**
Sendo brutalmente sincero: em jul/2026 o mercado de "IA que programa" explodiu
e várias peças do Maestrus já existem soltas por aí. O que **ninguém** juntou
num produto só é a combinação que descrevo em §3. Vamos por partes.

### 1.1 O que já é commodity (não é diferencial)
- **"Claude Code no celular"** virou grátis. A própria **Anthropic** lançou o
  *Remote Control* (fev/2026) — espelha sua sessão local no app/web, incluído
  no Max ($100–200) e chegando ao Pro ($20). O **Happy Coder** faz o mesmo,
  open source e de graça. Vender só "acesse o Claude do celular" está **morto**.

### 1.2 O que existe mas fragmentado (concorrentes parciais)
| Produto | O que faz | Preço | Limitação vs Maestrus |
|---|---|---|---|
| **Omnara** | Claude/Codex mobile + web, agentes paralelos, sessões cloud, voz | Free + **$9/mo** | Sem multi-projeto orquestrado; sem container próprio 24/7; sem multi-conta |
| **Happy Coder** | Remote control Claude/Codex pelo celular (QR) | **Grátis** (OSS) | Só remote control; sem cloud, sem orquestração, sem voz integrada |
| **Anthropic Remote Control** | Espelha a sessão local no mobile/web | Incluído Max/Pro | 1 sessão espelhada, **não** multi-projeto; morre se seu PC desliga |
| **Cursor 3.0 (Agents/Cloud)** | Agentes background em VM, trigger mobile | $20–200 | IDE-cêntrico; não orquestra "seus N projetos" de um chat |
| **Devin** | Agente autônomo cloud, metrado (ACU) | $20–500 | Caro, você paga a inferência; sem BYO-assinatura |
| **Vibe Kanban** | Orquestração kanban de agentes, local | Grátis (OSS) | **Empresa fechou abr/2026**; local-only; sem cloud/mobile/voz |
| **Conductor** | N agentes paralelos em worktrees | Grátis | **macOS-only**; sem mobile, sem cloud |
| **Terragon** | Orquestração cloud VM | **Morto** | — |

### 1.3 Veredito
O Maestrus **não** vai ganhar dizendo "programe com IA pelo celular" (commodity)
nem "rode agentes em paralelo" (Vibe/Conductor fazem, de graça). Ele ganha na
**tese do maestro**: uma pessoa conduzindo *muitos projetos ao mesmo tempo*, de
*qualquer dispositivo*, com a IA rodando *24/7 numa instância própria na nuvem* —
mesmo com o computador desligado — usando a *própria assinatura* (Claude e, em
breve, ChatGPT). **Essa fotografia inteira não existe empacotada em lugar nenhum.**

---

## 2. O fosso (moat) real do Maestrus

Ordenado do mais defensável pro menos:

1. **Multi-conta do Claude com switch ao vivo** — trocar de assinatura no meio da
   MESMA conversa quando um plano estoura o limite. **Ninguém tem isso.** É a
   feature que resolve a dor #1 de quem usa Claude pesado (limite semanal).
2. **Container pessoal 24/7 na nuvem** — não é "espelho da sua sessão" (Anthropic),
   é um Maestrus completo e independente rodando sozinho. O trabalho continua com
   seu PC desligado. Cursor/Devin fazem em VM, mas metrando a inferência (caro).
3. **Orquestração multi-projeto ("o maestro")** — despachar tarefas pra N codebases
   diferentes de uma conversa. Vibe/Conductor orquestram *agentes*, não *projetos
   distintos com contexto próprio*.
4. **BYO dupla-assinatura + custo de IA zero** — o cliente traz Claude (e logo
   ChatGPT/Codex). Nosso custo de inferência = $0. Devin/Cursor pagam a inferência
   e repassam; nós vendemos o palco, não a orquestra.
5. **Voz (Jarvis) realtime** — conduzir por voz, resposta falada. Omnara tem voz;
   os outros não.
6. **Um app, todas as telas** — desktop (Win/Mac), PWA, web e host remoto, mesma
   conta, projetos locais + remotos + cloud somando na sidebar.

Nenhum concorrente tem 1+2+3 juntos. Esse é o pitch.

---

## 3. Frase de posicionamento (pra LP)

> **Maestrus é o maestro dos seus agentes de IA.** Conduza todos os seus projetos
> — de qualquer lugar, por texto ou voz — com uma instância sua rodando 24/7 na
> nuvem, usando a assinatura de Claude (e ChatGPT) que você já paga. Não é o
> Claude no celular. É a sala de controle de tudo que você constrói.

---

## 4. Precificação recomendada (final)

Contexto de âncoras de mercado (jul/2026): Anthropic dá remote control de graça,
Omnara cobra $9, Cursor $20–200, Devin $20–500. O Maestrus **não pode** cobrar
por "acesso mobile" (é grátis no mercado). Cobra pelo que os outros **não dão**:
orquestração multi-projeto + container 24/7 + multi-conta + voz.

| Plano | Preço | Para quem | Inclui |
|---|---|---|---|
| **Free (Self-host / Local)** | **$0** | Dev que roda tudo na própria máquina | Desktop Win/Mac/Linux · PWA · orquestração multi-projeto local · BYO Claude · **sem cloud, sem sync gerenciado** |
| **Solo Cloud** | **$12/mo** ($120/ano) | Freelancer/indie que quer 24/7 | Container 4GB 24/7 · web+mobile de qualquer lugar · voz · multi-conta Claude · $5 Cloud AI cortesia |
| **Pro Cloud** | **$29/mo** ($290/ano) | Quem vive nisso / múltiplos projetos | Container 8GB prioritário · orquestração ilimitada · $15 Cloud AI · voz realtime · suporte |
| **Team** | **$79/mo** (até 5 seats) | Squads | Workspaces compartilhados · billing central · (Fase 6) |
| **Cloud AI avulso** | **$5–$100** prepago | Todos | Créditos de IA gerenciada (markup 1.35–1.5×), nunca expira |

**Mudanças vs planos atuais no banco** (`pro=$20/10GB/$10-AI`, `plus=$9`, `team=$40`,
`cloud=$30` inativo):
- O **Solo Cloud a $12** substitui a lacuna entre Free e Pro — abaixo do Omnara ($9)
  não dá pela conta do container, mas $12 com container 24/7 é imbatível vs "$9 sem
  container próprio". **$12 é o número mágico**: barato o suficiente pra conversão
  por impulso, alto o suficiente pra pagar a infra (~$1.30/user) com margem ~90%.
- **Pro a $29** (não $20): quem tem multi-projeto e quer 24/7 paga com folga; o
  incluído de IA sobe pra $15 mas o container maior justifica. O $20 atual tem
  margem apertada quando o user consome o AI incluído.
- **Anual = 2 meses grátis** (padrão SaaS, melhora caixa e retenção).
- Mantém **trial de 30 dias** do Solo Cloud (já implementado).

### Por que não cobrar mais?
Porque o teto psicológico é o preço da própria assinatura de IA. Quem paga $20 de
Claude não paga $50 de "orquestrador". O Maestrus tem que ser sentido como "custa
menos que meu Claude e multiplica ele", não "mais uma assinatura cara".

### Caminho pro primeiro milhão (ARR)
- 800 Solo ($12) + 300 Pro ($29) + 30 Team ($79) ≈ **$20.8k MRR ≈ $250k ARR**.
- $1M ARR ≈ 3.500 Solo + 1.200 Pro + 100 Team. Com funil Free→pago de 4–6%, pede
  ~70–90k instalações do Free. **É por isso que o Free/open source existe**: é o
  motor de distribuição (ver §6).

---

## 5. Estamos prontos pra lançar? (veredito honesto)

**Resposta curta: pronto pra um LANÇAMENTO BETA PÚBLICO / early access — NÃO pra um
"1.0 estável pago" ainda.** Faltam 3 travas de confiança antes de cobrar de
estranhos. Detalhamento:

### ✅ O que já está sólido (pode mostrar sem vergonha)
- Desktop Win/Mac, PWA, web app — os três funcionando, mesma conta.
- Orquestração multi-projeto (o maestro) — funcional.
- Engine Claude (BYO) + Cloud AI proxy metrado — funcional.
- Container cloud 24/7 por usuário — **provisiona e conecta** (self-heal do status
  corrigido hoje; DNS wildcard + Caddy + relay validados em produção).
- Multi-conta Claude com switch — implementado e testado.
- Anexos client→host, /usage real, /compact linha contínua — entregues.
- Voz (Jarvis), kanban 24/7, MCP, browser embutido — funcionais.
- Onboarding cloud (cadastro → container → OAuth Claude → app) — funcional.

### 🟡 Travas ANTES de cobrar (bloqueadores de "pronto pra vender")
1. **Estabilidade do container 24/7** — o refresh de token do relay dentro do
   container falha após horas (`relay token falhou: undefined` nos logs). O
   container reconecta no restart, mas pra 24/7 real isso precisa ser à prova de
   falha (reconnect com backoff + token novo). **Bloqueador**: é o coração da
   promessa "roda com seu PC desligado".
2. **Fase 5 — Billing Stripe fim-a-fim** — webhook existe, planos existem, mas o
   fluxo trial→cobrança→downgrade automático não está fechado. Sem isso você não
   cobra de verdade nem protege a margem. **Bloqueador pra pago.**
3. **Auto-suspend de container inativo** — sem isso, cada trial abandonado queima
   recurso 24/7 (a margem de 90% vira 78%). **Bloqueador de custo** antes de abrir
   trial ao público em escala.

### 🟢 Pode lançar já, em BETA (early access), se:
- Posicionar como **"beta / early access"** (baixa expectativa de SLA).
- Abrir só o **Free (self-host)** amplamente + **Solo Cloud por convite/lista de
  espera** (limita quantos containers sobem enquanto as travas #1–#3 fecham).
- Grátis pra os primeiros N usuários cloud em troca de feedback.

### Recomendação de sequência
1. **Semana 1–2:** fechar trava #1 (estabilidade do container). É a mais crítica.
2. **Semana 2–3:** Fase 5 (Stripe) + auto-suspend.
3. **Então:** lançamento público pago. Antes disso, **beta por convite** já pode
   rodar pra gerar prova social e os primeiros depoimentos pra LP.

**Veredito:** lance o **Free (open source) + beta cloud por convite AGORA** pra
começar a distribuição e coletar prova social; **abra o pago em ~3 semanas** com as
3 travas fechadas. Lançar o pago hoje, com o container instável, queimaria a
primeira impressão — e a primeira impressão de um SaaS você só tem uma vez.

---

## 6. Open source: viável e inteligente? (a decisão que você pediu)

**Sim, é inteligente — se for OPEN-CORE, não "tudo aberto".** A intuição de abrir
"uma parte" está certíssima; o segredo é **onde** cortar a linha. Deixa eu te
mostrar por que não é "dar o ouro de graça".

### 6.1 O ponto-chave que muda tudo
O que você pensou em abrir (desktop Win/Mac/Linux + container Docker self-host +
PWA + conectar na sua própria URL cloud) **já é grátis no mercado**: o **Happy
Coder** dá remote control open source de graça, o **Vibe Kanban** dá orquestração
open source de graça. Então **você não está entregando uma vantagem exclusiva —
você está igualando o table-stakes** que os concorrentes já zeraram, e ganhando em
troca a coisa mais cara de comprar: **distribuição e confiança**.

O "grande poder" do Maestrus **não é o software client** — é o **serviço
gerenciado**: provisionar o container 24/7 com um clique, billing, Maestrus AI,
sync sem dor de cabeça, multi-conta polido, updates automáticos, suporte. Isso é
o que ninguém consegue clonar de um `git clone`, e é o que as pessoas pagam.

### 6.2 Onde cortar a linha (open-core)

**ABRE (grátis, OSS — vira funil e comunidade):**
- Client desktop (Win/Mac/Linux) + PWA.
- `relay` (o WebSocket relay) e o `maestrus-server` (container headless self-host).
- `docker-compose.yml` oficial: relay + maestrus-server, "suba seu Maestrus numa
  VPS em 5 min".
- Conectar o desktop/PWA numa **URL de cloud própria** do usuário (self-host).
- Orquestração multi-projeto local, engine BYO Claude.

**FECHA (proprietário / pago — o negócio):**
- **Control plane gerenciado**: provisionar container por clique, subdomínio
  automático, DNS/TLS, dashboard "Meu Container".
- **Maestrus AI** (proxy metrado com billing) — a receita de consumo.
- **Billing/Stripe, trials, planos, multi-conta polida com cofre gerenciado.**
- **Sync gerenciado e updates automáticos assinados.**
- Onboarding "zero-config" (o self-host exige mão na massa; o cloud é um clique).

### 6.3 Por que isso é o movimento certo (precedentes que deram bilhões)
É exatamente o modelo de **GitLab, Sentry, Supabase, n8n, PostHog**: o core aberto
vira o padrão da categoria e o canal de aquisição; o gerenciado (hospedar, escalar,
não-ter-dor-de-cabeça) é onde 90% pagam porque **self-host tem custo oculto de
tempo**. Quem instala Docker numa VPS e mantém é minoria; a maioria clica "criar
container" e paga $12.

Bônus estratégico: com Happy/Vibe já commoditizando o client, se você **não** abrir,
fica na posição pior — cobrando por algo que o concorrente dá de graça. Abrindo o
core, você neutraliza o Happy (é tão aberto quanto) e ainda oferece o que ele não
tem (o cloud gerenciado). **Você transforma uma desvantagem em canal.**

### 6.4 Riscos e mitigação
| Risco | Mitigação |
|---|---|
| Alguém sobe um SaaS concorrente com seu código | Licença **BSL 1.1** ou **Elastic License 2.0**: permite self-host, **proíbe revender como serviço**. Vira MIT/Apache após 3–4 anos. |
| "Estou dando o produto de graça" | Não — o produto pago é o *gerenciado*. O OSS é a versão "monte você mesmo", que dá trabalho de propósito. |
| Canibalizar o Free Cloud | O Free já é local/self-host (sem cloud). O OSS só formaliza o que o Free já é. Zero canibalização do pago. |
| Manutenção do OSS custa tempo | Escopo enxuto: só client + relay + server. O control plane (o difícil) fica fechado. |

### 6.5 Veredito open source
**Faça.** Abra `maestrus-selfhost` (client + relay + maestrus-server + docker-compose)
sob **BSL 1.1**. É o motor de distribuição que alimenta o funil do §4, neutraliza
Happy/Vibe, e **não** entrega o negócio — porque o negócio é o serviço gerenciado,
não o binário. O único cuidado real é a licença anti-SaaS-concorrente (BSL/Elastic),
e não abrir o control plane / billing / AI proxy.

---

## 7. Resumo executivo (TL;DR pro owner)

1. **Inovador?** Não nas peças, **sim na combinação**. Fosso real = multi-conta +
   container 24/7 + orquestração multi-projeto. Ninguém junta isso.
2. **Não venda "Claude no celular"** — é grátis (Anthropic/Happy). Venda "o maestro
   dos seus projetos, 24/7, com sua assinatura".
3. **Pricing:** Free (self-host) · **Solo Cloud $12** · **Pro $29** · Team $79 ·
   Cloud AI avulso. Anual = 2 meses grátis. Margem ~90% com auto-suspend.
4. **Pronto pra lançar?** Beta por convite **agora** (Free + cloud limitado). Pago
   em **~3 semanas** após fechar: estabilidade do container 24/7, Stripe fim-a-fim,
   auto-suspend. **Não** cobre de estranhos com o container ainda instável.
5. **Open source:** **Sim, open-core, BSL 1.1.** Abra client+relay+server+compose;
   feche control plane + billing + AI. É canal de distribuição, não entrega do ouro.

---

## Fontes (pesquisa jul/2026)
- Omnara pricing — omnara.com/pricing (Free + $9/mo)
- Happy Coder — happy.engineering (grátis, OSS)
- Anthropic Remote Control — code.claude.com/docs/en/remote-control; VentureBeat (25/02/2026)
- Cursor 3.0 Agents/Cloud — pricing 2026 (Pro+ $60, Ultra $200, Teams $40/seat)
- Devin pricing 2026 — Core $20 + $2.25/ACU, Team $500
- Vibe Kanban — github.com/BloopAI/vibe-kanban (Bloop fechou abr/2026, virou OSS community)
- Conductor — macOS-only, worktrees paralelos
- Claude Code run-rate — $2.5B annualized (fev/2026)
