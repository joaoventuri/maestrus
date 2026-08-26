# MAESTRUS — Documento Comercial (fonte para Landing Page)

> **Instrução para a IA que vai criar a LP:** este documento é a fonte canônica
> do produto. Tom: enterprise, confiante, direto — sem hype vazio. Identidade
> visual: fundo quase-preto, **laranja neon #ff8a3d** como única cor de marca,
> tipografia Space Grotesk (corpo) e Syne (wordmark), logo = silhueta do
> maestro regendo. SEM emojis na UI. Idiomas da LP: PT, EN, ES.

---

## 1. O posicionamento (headline material)

**Maestrus é o maestro dos seus agentes de IA.**
Um só lugar pra reger o Claude Code (e em breve o Codex) em **todos os seus
projetos, em todas as suas máquinas, de qualquer dispositivo** — desktop,
navegador, celular e voz.

- *"Um maestro. Todas as suas orquestras."*
- *"Seus projetos trabalhando — mesmo com o notebook fechado."*
- *"Você já paga pela melhor IA do mundo. O Maestrus faz ela trabalhar em tudo que você tem."*

### O problema que resolve
Quem usa IA de código hoje vive preso a UMA janela de terminal, UM projeto,
UMA máquina. Pra usar em outro projeto: abre outro terminal. Em outra máquina:
começa do zero. No celular: impossível. O Maestrus transforma isso numa
**mesa de comando**: cada projeto vira um "sistema" regido do mesmo lugar,
com despacho paralelo, fila de tarefas 24/7 e acesso de qualquer lugar.

### A vantagem econômica (argumento matador)
O Maestrus **usa a assinatura de IA que o cliente já tem** (Claude Pro/Max via
login oficial — sem API key, sem custo extra de tokens). Concorrentes cobram
por tokens ou ACUs em cima; o Maestrus multiplica o valor do que a pessoa já
paga. E pra quem não tem assinatura, existe o **Maestrus AI** (crédito medido,
pré-pago, sem surpresa).

---

## 2. O que o Maestrus FAZ hoje (tudo real, em produção)

### 2.1 Orquestração multi-projeto (o coração)
- Cada projeto do usuário vira um **sistema**: pasta local, repositório GitHub,
  servidor via SSH ou projeto novo do zero.
- De **um único chat**, comanda qualquer projeto: `/ask <projeto> <tarefa>`
  despacha pra outro projeto e a resposta volta como contexto;
  `/parallel p1,p2,p3 <tarefa>` executa em vários ao mesmo tempo;
  `/task <projeto> <tarefa>` enfileira no Kanban.
- **Kanban 24/7**: fila de tarefas que o agente executa uma a uma, com estado
  visível (a fazer → executando → concluída) — funciona mesmo sem ninguém
  olhando, inclusive no container na nuvem.
- **Modo Loop**: o Maestrus planeja um objetivo grande, quebra em tarefas e
  alimenta o Kanban sozinho.

### 2.2 Qualquer dispositivo, um só cérebro (modelo servidor)
- Uma máquina (ou o container na nuvem) é o **host**; todos os outros
  dispositivos — desktop, navegador, PWA no celular — conectam nele via relay
  próprio com pareamento por código e token rotativo.
- A conversa é UMA: começa no desktop, continua no celular, retoma no web.
  Histórico, contexto e sessão vivem no host.
- **Anexos de qualquer lugar**: manda um arquivo do celular e ele materializa
  no host — o agente lê de verdade.
- Notificações push quando o agente termina.

### 2.3 Maestrus na nuvem (container 24/7 por usuário)
- Um clique e o usuário ganha um **Maestrus completo rodando 24h na nuvem**,
  no endereço próprio `u{id}.maestrus.cloud` com TLS automático.
- Onboarding de 3 passos: cria conta → instância provisionada em segundos →
  conecta o Claude (OAuth oficial) → usando. **Sem instalar nada.**
- O web/PWA conecta automático no container — pro usuário, é como se fosse
  local. Projetos, Kanban e agente rodando com o computador dele desligado.
- Migração: projetos locais sobem pro container (código + sessão + memória) e
  continuam exatamente de onde pararam.

### 2.4 Voz — modo Jarvis
- Conversa por **voz em tempo real** com o projeto atual: fala, o agente
  executa, responde falando. Orbe de maestro indica ouvindo/pensando/falando.
- No desktop: Whisper local (privacidade, sem custo). No celular: nativo.
- Voz realtime premium (OpenAI) com BYOK — a chave fica criptografada na conta.
- Trilíngue: a voz fala o idioma da interface (PT/EN/ES).

### 2.5 Controle do computador e do navegador
- Navegador embutido controlável pelo agente (navegar, ler, clicar, preencher).
- **Controle do computador** (Windows/macOS): abre apps, lê o conteúdo de
  janelas, clica por NOME de elemento (UI Automation real, não coordenada
  cega), digita, tira screenshot. "Abre o WhatsApp Web e responde o cliente"
  é um comando válido.

### 2.6 Multi-conta de IA (exclusivo)
- Cadastre **várias assinaturas do Claude** e troque com um switch — na
  mesma conversa, sem perder nada. Estourou o limite semanal da conta 1?
  Troca pra conta 2 e segue. Funciona até remotamente (troca a conta do
  host pelo celular).
- `/usage` mostra o consumo **oficial e em tempo real** da conta (sessão 5h,
  semana, por modelo — o dado da Anthropic, não estimativa).

### 2.7 Qualidade de vida que vira argumento
- **Zero-fricção**: instalador traz Node, Git e Claude embutidos — instala e
  usa, sem terminal, sem pré-requisito.
- Atualização rápida (patch de ~5MB) sem reinstalar e sem perder permissões.
- `/compact` compacta o contexto SEM perder a linha do tempo da conversa.
- Memória local do agente entre sessões (RAG), editor de CLAUDE.md por
  projeto, catálogo de MCPs com um clique, importação de sessões existentes
  do Claude Code.
- Interface trilíngue (PT/EN/ES), tema escuro enterprise, sem emoji.

---

## 3. Como funciona (seção "how it works" da LP)

1. **Crie a conta** em maestrus.cloud → sua instância na nuvem nasce em
   segundos (trial 30 dias) OU baixe o desktop (Mac/Windows) e use 100% local.
2. **Conecte seu Claude** — login oficial da Anthropic, dois cliques. Sua
   assinatura, seus limites, sua privacidade. (Sem assinatura? Use créditos
   Maestrus AI.)
3. **Adicione seus sistemas** — pastas, repositórios GitHub, servidores SSH.
4. **Reja** — converse, despache tarefas em paralelo, encha o Kanban, saia.
   Acompanhe do celular. Fale com ele no Jarvis. Receba a notificação de
   "concluído".

---

## 4. Para quem é (personas da LP)

- **O dev com N projetos** (freelas, agência, indie hacker): para de alternar
  janelas; despacha pros projetos como um gestor.
- **O fundador técnico**: o backlog anda de madrugada no container; ele revisa
  de manhã pelo celular.
- **O profissional não-dev com ideias**: cria projetos do zero conversando —
  o Maestrus instala, roda e mostra o preview.
- **Times pequenos** (em breve): workspaces compartilhados.

---

## 5. Planos e preços (copy pronta pra LP)

| | **Local** | **Cloud** | **Cloud Pro** |
|---|---|---|---|
| Preço | **Grátis** | **US$ 19/mês** (ou US$ 190/ano) | **US$ 39/mês** (ou US$ 390/ano) |
| Desktop Mac/Windows completo | ✓ | ✓ | ✓ |
| Projetos ilimitados | ✓ | ✓ | ✓ |
| Sua assinatura Claude (BYO) | ✓ | ✓ | ✓ |
| Voz Jarvis (Whisper local) | ✓ | ✓ | ✓ |
| **Instância na nuvem 24/7** | — | ✓ 2 vCPU · 4 GB | ✓ 4 vCPU · 8 GB prioridade |
| Acesso web + celular (PWA) de qualquer lugar | — | ✓ | ✓ |
| Endereço próprio u/você.maestrus.cloud | — | ✓ | ✓ |
| Sync de arquivos na nuvem | — | 10 GB | 50 GB |
| Maestrus AI incluído/mês | — | US$ 5 | US$ 15 |
| Multi-conta Claude com switch | ✓ | ✓ | ✓ |
| Voz realtime premium (BYOK OpenAI) | ✓ | ✓ | ✓ |
| Suporte | comunidade | e-mail | prioritário |

- **Trial**: 30 dias de Cloud grátis no cadastro — sem instalar nada.
- **Créditos Maestrus AI avulsos**: US$ 5 a US$ 100, pré-pagos, nunca expiram.
- Âncora de copy: *"menos que o seu ChatGPT — e faz TODAS as suas IAs
  renderem mais"*.

---

## 6. Diferenciais vs. mercado (seção comparativa — usar com elegância)

| Capacidade | Maestrus | Claude Code web/mobile (Anthropic) | Happy/Omnara | Conductor | Devin/Factory |
|---|---|---|---|---|---|
| Orquestra VÁRIOS projetos de um chat | **✓** | — (1 sessão/tarefa) | — (espelha sessões) | ✓ (1 repo, worktrees) | — |
| Kanban de tarefas 24/7 | **✓** | — | — | — | parcial |
| Container SEU na nuvem (persistente, endereço próprio) | **✓** | VM efêmera por tarefa | — | — | VM deles |
| Usa a SUA assinatura (custo IA = zero) | **✓** | ✓ | ✓ | ✓ | — (cobra por uso) |
| Voz em tempo real (Jarvis) | **✓** | — | parcial | — | — |
| Controle do computador/navegador | **✓** | — | — | — | — |
| Multi-conta Claude com switch | **✓** | — | — | — | — |
| Servidores via SSH como projeto | **✓** | — | — | — | — |
| PT / EN / ES nativo | **✓** | EN | EN | EN | EN |
| Instala sem terminal (runtime embutido) | **✓** | n/a | npm | ✓ | n/a |

*(Nota interna: NÃO citar concorrentes nominalmente na LP pública — usar
"alternativas" — mas esta tabela orienta a copy dos diferenciais.)*

---

## 7. Confiança e segurança (seção da LP)

- Seu código fica **nas suas máquinas** (ou no SEU container isolado).
- Login do Claude é o OAuth **oficial da Anthropic** — o Maestrus nunca vê sua senha.
- Comunicação entre dispositivos via relay com tokens efêmeros rotativos.
- Credenciais SSH criptografadas (AES-256-GCM) localmente.
- Sem markup escondido: o Maestrus AI mostra custo real e saldo transparente.

---

## 8. FAQ curto (pra LP)

- **Preciso de API key?** Não. Login oficial do Claude (sua assinatura) ou créditos Maestrus AI.
- **Funciona com meu plano Claude Pro/Max?** Sim — é o mesmo Claude Code oficial, regido pelo Maestrus.
- **E se eu não tiver o computador ligado?** O plano Cloud roda seu Maestrus 24/7 na nuvem.
- **Meu código vai pra onde?** Fica na sua máquina ou no seu container isolado. Nunca em servidores compartilhados.
- **Celular?** Web app + PWA instalável, com voz.
- **Windows e Mac?** Sim, instalador completo com tudo embutido. Linux via container/self-host.
