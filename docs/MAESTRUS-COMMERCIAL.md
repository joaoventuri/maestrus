# Maestrus — Dossiê Comercial Completo (fonte para a Landing Page)

**Data:** 2026-07-15 · **Uso:** este documento é a fonte de verdade para outra
IA construir a LP. Contém posicionamento, todas as capacidades reais (o que faz,
como faz, como usa, o quanto ajuda), personas, objeções, provas, copy pronta e
estrutura de página. **Regra de ouro: nada aqui é vaporware — só o que existe e
funciona hoje.** Itens em roadmap estão marcados como `[ROADMAP]`.

Identidade visual: **neon laranja (#ff8a3d)** sobre quase-preto · **Space Grotesk**
(corpo) · **Syne** (wordmark) · logo = silhueta do maestro. Tom: enterprise,
confiante, sem emoji na UI, direto. Trilíngue: **PT / EN / ES**.

---

## 0. A frase (hero)

> ## O maestro dos seus agentes de IA.
> Conduza todos os seus projetos — de qualquer lugar, por texto ou voz — com uma
> instância sua rodando **24 horas por dia** na nuvem, usando a assinatura de
> Claude que você **já paga**.
>
> **Não é o Claude no celular. É a sala de controle de tudo que você constrói.**

Sub-headline:
> Um app. Todos os seus repositórios. Desktop, navegador e celular na mesma conta.
> Comece de graça, 100% na sua máquina — suba pra nuvem quando quiser.

CTAs: **[ Baixar grátis ]** · **[ Ativar meu Maestrus na nuvem ]**

---

## 1. O problema (a dor que a LP abre)

Quem usa IA pra programar hoje vive 4 dores:

1. **A IA mora no seu terminal.** Fechou o notebook, acabou. Saiu de casa, parou.
2. **Um projeto por vez.** Você pula entre pastas, janelas, terminais. Não existe
   uma "sala de controle" dos seus vários projetos.
3. **O limite da assinatura estoura** no pior momento — e você não tem pra onde ir
   sem perder o fio da conversa.
4. **Cloud de IA é caro** porque você paga a inferência duas vezes: a assinatura +
   o serviço que revende os tokens.

### A dor de origem (história real — usar como narrativa na LP)
O remote control "espelhado" tem uma falha que os usuários relatam aos montes no
Reddit: **se o computador desliga ou dorme, a sessão morre**. Você religa, e não é
só reconectar — **gera uma sessão NOVA, o ID antigo se perde**, e a conversa em que
você passou o dia trabalhando fica órfã. O Maestrus nasceu exatamente dessa raiva:
> "Eu só queria que o trabalho continuasse de onde parou. Sempre."

Por isso a instância 24/7 não é um "espelho" do seu PC — é uma máquina sua na
nuvem que **nunca desliga e nunca perde a sessão**. E se você usa o modo host
(seu PC como servidor), o Maestrus **retoma a MESMA sessão** ao religar — o
histórico mora em disco, não na memória de um processo.

O Maestrus resolve os quatro. Um maestro conduz a orquestra inteira; você conduz
todos os seus projetos.

---

## 2. As capacidades (o coração da LP — o que faz, como, o quanto ajuda)

Cada bloco abaixo vira uma **seção/feature-card** na LP. Ordem = prioridade de
destaque.

### 2.1 O Maestro — orquestre vários projetos de uma conversa
- **O que é:** cada projeto (pasta local, repo GitHub, servidor SSH, ou novo do
  zero) vira um "sistema" que o Maestrus conduz. De um único chat você despacha
  tarefas para projetos diferentes, em paralelo — como um maestro dando a entrada
  pra cada naipe da orquestra.
- **Como funciona:** o Maestrus roda o Claude Code de verdade em cada projeto, com
  o contexto e as regras (CLAUDE.md) daquele projeto, e traz o resultado de volta
  pro seu painel.
- **O quanto ajuda:** pare de fazer malabarismo com janelas. "Cria o endpoint no
  backend, ajusta o componente no front e atualiza o app mobile" — três projetos,
  uma frase.

### 2.2 Instância 24/7 na nuvem — trabalha com seu PC desligado
- **O que é:** um Maestrus completo, só seu, rodando num container dedicado na
  nuvem (`seu-id.maestrus.cloud`). Não é um espelho da sua sessão — é uma máquina
  independente que continua trabalhando quando você fecha o notebook.
- **Como funciona:** um clique provisiona seu container; ele registra na sua conta
  e aparece em todos os seus dispositivos. Você acessa pelo navegador ou celular e
  é como se os projetos fossem locais — o container é o "local" invisível.
- **O quanto ajuda:** dá a tarefa no almoço pelo celular, o container executa
  sozinho, você revisa à noite pronto. O trabalho não depende mais de você estar
  com a máquina ligada.
- **Diferença vs. concorrentes:** o remote control da Anthropic e o Happy espelham
  sua sessão *local* — se seu PC dorme, para. O Maestrus roda numa instância
  *própria* que nunca dorme.

### 2.3 Multi-conta do Claude — troque de assinatura sem perder a conversa
- **O que é:** cadastre mais de uma conta Claude no mesmo Maestrus e alterne com um
  switch. A conversa continua **exatamente** de onde parou.
- **Como funciona:** cada conta é um perfil isolado de credenciais; o histórico é
  compartilhado entre elas. Trocou de conta → o próximo turno usa a nova
  assinatura, no mesmo chat.
- **O quanto ajuda:** estourou o limite semanal do seu plano Max no meio de um
  trabalho? Troca pra conta 2 e segue sem perder nada. E pelo celular, longe da
  máquina host. **Nenhum concorrente tem isso.**

### 2.4 Sua assinatura, seu custo de IA — BYO Claude (e ChatGPT `[ROADMAP]`)
- **O que é:** o Maestrus usa a assinatura de Claude que você **já paga** (login
  OAuth, sem API key). Você não paga tokens duas vezes.
- **Como funciona:** login inline no chat — abre o navegador, você aprova, cola o
  código, pronto. `[ROADMAP]` mesma coisa com a conta ChatGPT via Codex CLI.
- **O quanto ajuda:** o cloud de IA dos concorrentes cobra a inferência com markup.
  No Maestrus, seu custo de IA é o da sua própria assinatura — o Maestrus cobra só
  a orquestração e o 24/7.

### 2.5 Voz — o modo Jarvis
- **O que é:** fale com o Maestrus e ouça a resposta. Um modo de conversa realtime
  com um orbe indicador ("pensando", "falando"), botão de pausa que interrompe.
- **Como funciona:** no celular usa o reconhecimento de voz nativo; no desktop usa
  Whisper local. A resposta é falada no idioma da interface.
- **O quanto ajuda:** conduza seus projetos dirigindo, caminhando, cozinhando.
  Mãos livres, olhos livres.

### 2.6 Um app, todas as telas
- **O que é:** desktop (Windows e Mac), app no celular (PWA) e navegador — a mesma
  conta, os mesmos projetos. Projetos locais, remotos e na nuvem somam na sidebar.
- **Como funciona:** instala sem configurar nada (Node, Git e Claude já vêm
  embutidos no instalador). No celular, acessa pelo navegador ou instala como app.
- **O quanto ajuda:** começa no desktop, continua no ônibus pelo celular, revisa no
  navegador do trabalho. Sem fricção, sem reconfigurar.

### 2.7 Kanban 24/7 — fila de tarefas que roda sozinha
- **O que é:** um quadro onde você enfileira tarefas por projeto; o Maestrus executa
  em background e devolve o resultado no chat.
- **O quanto ajuda:** empilhe 10 tarefas à noite, acorde com elas feitas.

### 2.8 Máquina remota — controle outro computador seu
- **O que é:** deixe um computador seu (ex: um Mac mini ligado em casa) como "host"
  e controle-o de qualquer outro dispositivo, via um relay seguro.
- **Como funciona:** o host se registra na sua conta; os outros dispositivos
  conectam nele. Anexos enviados do celular sobem fisicamente pro host.
- **O quanto ajuda:** seu desktop potente fica em casa fazendo o trabalho pesado;
  você comanda do celular na rua.

### 2.9 Extras que já funcionam
- **Anexos** que sobem pro host certo (mesmo controlando de longe).
- **`/usage` com o dado REAL da sua conta Claude** (cota da sessão, semana, por
  modelo) — não estimativa.
- **`/compact`** que resume o contexto **sem apagar** a conversa da tela (linha
  contínua).
- **MCP + navegador embutido** em qualquer projeto (o agente navega a web).
- **Editor de CLAUDE.md** por projeto, dentro do app.
- **Trilíngue** (PT/EN/ES) em toda a interface.

---

## 3. Como funciona por baixo (seção "For the technical" da LP)

Fluxo em 3 passos pra LP ilustrar:

1. **Instale ou ative.** Baixe o desktop (Win/Mac) — já vem tudo embutido — ou
   ative sua instância na nuvem com um clique. Nada de configurar Node, Git ou
   terminal.
2. **Conecte sua conta Claude.** Login inline: aprova no navegador, cola o código.
   Sua assinatura, seu custo.
3. **Conduza.** Adicione seus projetos e comece a despachar tarefas — por texto ou
   voz, de qualquer dispositivo. O que roda na nuvem continua com seu PC desligado.

Arquitetura (pra um bloco "arquitetura" ou FAQ técnico):
- **Seus arquivos ficam com você.** No modo local, nada sai da sua máquina. No
  modo nuvem, ficam no *seu* container isolado.
- **Sem abrir portas.** As conexões são de saída (o dispositivo conecta no relay),
  não expõem seu computador à internet.
- **Zero-config.** O instalador traz Node, Git e o Claude embutidos.

---

## 4. Personas (pra LP falar com cada uma)

1. **O indie/freelancer** — toca 3–5 projetos de clientes. Dor: pular entre eles.
   Ganho: a sala de controle + 24/7 pra entregar mais rápido.
2. **O dev que usa Claude pesado** — estoura limite de plano. Dor: parar no meio.
   Ganho: multi-conta com switch + cota real no `/usage`.
3. **O nômade/mobile-first** — quer trabalhar do celular. Dor: IA presa no terminal.
   Ganho: PWA + voz + container 24/7.
4. **A pequena squad `[ROADMAP Team]`** — quer compartilhar. Ganho: workspaces.

---

## 5. Planos e preços (pra seção de pricing da LP)

**STATUS: preços JÁ ATIVOS em produção** (tabela `plans`; checkout/Stripe
dinâmico). Team está com compra desativada até workspaces existirem.

| | **Free** | **Solo Cloud** | **Pro Cloud** | **Team** `[ROADMAP]` |
|---|---|---|---|---|
| Preço | **$0** | **$12/mês** | **$29/mês** | **$79/mês** |
| Anual | — | $120 (2 meses grátis) | $290 | $790 |
| Onde roda | Sua máquina | Container 4GB 24/7 | Container 8GB 24/7 | Multi-seat |
| Orquestração multi-projeto | ✓ | ✓ | ✓ ilimitada | ✓ |
| Desktop + PWA + Web | ✓ | ✓ | ✓ | ✓ |
| Sua assinatura Claude (BYO) | ✓ | ✓ | ✓ | ✓ |
| Instância 24/7 na nuvem | — | ✓ | ✓ prioritária | ✓ |
| Multi-conta Claude | ✓ (local) | ✓ | ✓ | ✓ |
| Voz (Jarvis) | ✓ | ✓ | ✓ realtime | ✓ |
| Maestrus AI incluído | — | $5 cortesia | $15 | sob medida |
| Workspaces compartilhados | — | — | — | ✓ `[ROADMAP]` |

- **Maestrus AI avulso:** créditos de $5 a $100, nunca expiram. Pra quem não tem
  assinatura própria ou quer um extra sob demanda.
- **Trial:** 30 dias de Solo Cloud grátis no cadastro.
- **Self-host / Open Source `[ROADMAP]`:** suba seu próprio Maestrus numa VPS com
  docker-compose — client + relay + servidor, de graça (licença BSL).

---

## 6. Objeções e respostas (pra FAQ da LP)

- **"Já não tem isso de graça?"** — O "Claude no celular" sim (até a Anthropic dá).
  O que o Maestrus faz e ninguém junta: conduzir *vários projetos* de uma conversa,
  com uma instância *sua* 24/7, e trocar de conta Claude sem perder o fio.
- **"Meus arquivos vão pra onde?"** — No local, ficam na sua máquina. Na nuvem,
  no seu container isolado. Nunca num pote compartilhado.
- **"Preciso pagar tokens de novo?"** — Não. Usa a assinatura de Claude que você
  já tem. O Maestrus cobra a orquestração e o 24/7, não a inferência.
- **"E se meu limite de plano acabar?"** — Cadastre outra conta e troque com um
  switch, sem perder a conversa.
- **"Funciona no meu celular?"** — Sim, pelo navegador ou instalando como app.
- **"Sou obrigado a usar a nuvem?"** — Não. O Free roda 100% na sua máquina.

---

## 7. Prova social e números (preencher conforme surgirem)

- `[preencher]` depoimentos do beta.
- Contexto de mercado pra credibilidade: o Claude Code atingiu **$2.5 bi** de
  run-rate anualizado (fev/2026) — a categoria está explodindo; o Maestrus é a
  camada de orquestração em cima dela.
- Selo: **"Beta / Early Access"** enquanto não fecha o 1.0 (ver veredito de
  lançamento em `COMPETITIVE-PRICING.md`).

---

## 8. Estrutura sugerida da página (pra IA que vai montar a LP)

1. **Hero** — headline §0 + sub + 2 CTAs + mockup do app (desktop + celular lado a lado).
2. **A dor** (§1) — 4 bullets curtos, visual "antes".
3. **A virada** — "Conheça o maestro" + animação da orquestração multi-projeto.
4. **Features** (§2) — cards, na ordem: Maestro → 24/7 na nuvem → Multi-conta →
   BYO assinatura → Voz → Todas as telas → Kanban → Máquina remota.
5. **Como funciona** (§3) — 3 passos ilustrados + selo de segurança.
6. **Comparativo** — tabela Maestrus vs "Claude no celular" vs "cloud de IA caro"
   (destacar: multi-projeto, 24/7 próprio, multi-conta, custo de IA zero).
7. **Pricing** (§5).
8. **FAQ** (§6).
9. **Prova social** (§7).
10. **CTA final** — "Comece de graça na sua máquina. Suba pra nuvem quando quiser."
11. **Footer** — links, open source `[ROADMAP]`, trilíngue.

### Palavras-chave de copy (tom)
maestro · conduzir · sala de controle · 24 horas · de qualquer lugar · a sua
assinatura · sem perder o fio · uma frase, vários projetos · com o PC desligado.

### O que EVITAR na copy
- Não prometa o que é `[ROADMAP]` como se existisse (Codex/ChatGPT, Team, self-host).
- Não diga "único no mundo" sem qualificar — diga "a combinação que ninguém junta".
- Não venda "Claude no celular" como se fosse o diferencial (é commodity).

---

## 9. Diferenciais em uma linha (pra headlines/ads)

- "Não é o Claude no celular. É o maestro de todos os seus projetos."
- "Sua IA trabalhando 24/7 — mesmo com o computador desligado."
- "Estourou o limite? Troca de conta sem perder a conversa."
- "Sua assinatura. Seus projetos. Qualquer tela."
- "Um maestro. Todas as suas orquestras."
