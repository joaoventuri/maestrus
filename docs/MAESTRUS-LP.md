# MAESTRUS — Documentação Comercial Completa para Landing Page de Alta Conversão

**Versão:** 2026-07-18 · **Este é O documento** para a IA que vai construir a LP.
Substitui versões anteriores. Tudo aqui **existe e funciona hoje** — exceto o que
estiver marcado `[EM BREVE]`. Não inventar recursos além destes; não omitir nenhum.

**Identidade:** neon laranja **#ff8a3d** sobre quase-preto · fonte **Space Grotesk**
(corpo) e **Syne** (wordmark) · logo = silhueta do maestro regendo · tom enterprise,
confiante, zero emoji · trilíngue **PT/EN/ES**.

---

## 1. HERO

> ## O maestro dos seus agentes de IA.
> Todos os seus projetos, conduzidos por texto ou voz, de qualquer dispositivo —
> com uma instância **sua** rodando 24/7 na nuvem, conectada à **sua conta do Claude**.
>
> **Crie a conta. Conecte seu Claude. Comece a conduzir.** Em menos de um minuto.

Sub: *Não é "o Claude no celular". É a sala de controle de tudo que você constrói —
que continua trabalhando quando você fecha o notebook.*

CTAs: **[ Começar grátis na nuvem ]** · **[ Baixar o desktop ]**

### A promessa central (o gancho emocional)
Todo mundo que usa remote control "espelhado" conhece a dor (o Reddit está cheio
de relatos): **o computador desligou → a sessão morreu → religou → sessão NOVA,
o trabalho do dia virou órfão.** O Maestrus nasceu dessa raiva. Aqui a sessão é
**persistente por design**: mora em disco, num container seu que nunca desliga —
ou na sua própria máquina como host, retomando a MESMA conversa ao religar.
**Você nunca mais perde o fio.**

---

## 2. O FLUXO MÁGICO (foco da LP — Maestrus Cloud)

3 passos ilustrados, sem terminal, sem configuração:

1. **Crie sua conta** em maestrus.cloud — em segundos sua instância pessoal
   (`voce.maestrus.cloud`) é provisionada: um Maestrus completo, isolado, só seu.
2. **Conecte seu Claude** — um clique abre a autorização da Anthropic; você aprova
   e cola o código. **A conta é SEMPRE a sua conta do Claude** (Pro ou Max): seus
   limites, sua privacidade, sua relação com a Anthropic. O Maestrus nunca fica no
   meio da sua inferência.
3. **Conduza** — adicione projetos (GitHub, do zero) e despache tarefas de qualquer
   tela: navegador, celular (PWA instalável) ou desktop. Feche tudo e vá viver — o
   container segue trabalhando.

> Selo de confiança: *Sua assinatura, seus tokens, seus arquivos. O Maestrus vende
> o palco — a orquestra é sua.*

---

## 3. OS PODERES (features — todos reais, todos hoje)

### 3.1 O Maestro — orquestração multi-projeto
Cada codebase (pasta local, repo GitHub, servidor SSH ou projeto novo) vira um
"sistema" regido pelo Maestrus. De **um** chat: *"sobe o endpoint no backend,
ajusta o front e atualiza o app"* — três projetos, três agentes, em paralelo, cada
um com o contexto e as regras do próprio projeto. Comandos `/team`, `/ask projeto
prompt`, `/parallel p1,p2 prompt` para despachar entre projetos.

### 3.2 Instância 24/7 na nuvem (Maestrus Cloud)
Um container dedicado por usuário — não um "espelho" da sua sessão local, uma
máquina independente com endereço próprio e TLS. Auto-provisionada no cadastro,
auto-religa quando você volta (se hibernou por inatividade), monitorada na tela
"Maestrus Cloud" do app (status, uptime, memória, projetos). **É isso que mata a
dor do PC desligado.**

### 3.3 Remote control persistente — pela SUA máquina também
Prefere seu hardware? Deixe seu desktop/Mac mini como **host**: ele registra na sua
conta e você o comanda de qualquer dispositivo via relay seguro (conexões de saída,
nenhuma porta aberta). A sessão mora em disco: o host reiniciou? **Retoma a MESMA
conversa.** Anexou um arquivo pelo celular? **Ele sobe fisicamente pro host.**

### 3.4 Claude Powers — o ecossistema Claude, gerenciado numa tela
Central única (desktop e web) para tudo que o Claude sabe usar:
- **Skills** — ensine a IA a trabalhar do SEU jeito; salvas na conta, valem em
  todos os dispositivos e no container. Criar/editar/excluir com editor elegante.
- **Agents (subagentes)** — especialistas que o Claude convoca em paralelo
  (revisor, documentador, caçador de bugs), cada um com seu prompt.
- **Comandos (slash)** — seus prompts recorrentes viram `/atalhos` em qualquer chat.
- **MCPs** — instale conectores no host com busca na MCP Registry oficial +
  curadoria de populares; conectores da conta Claude gerenciados no site oficial.
- **Regras globais** — o CLAUDE.md que vale para todos os projetos (cada projeto
  ainda tem o seu, editável no chat).
- **Contas** — múltiplas assinaturas do Claude com switch (ver 3.5).
*Mensagem da LP: "nada de 'no Claude puro tem, aqui não'. Aqui tem — organizado."*

### 3.5 Multi-conta do Claude — troque sem perder a conversa **(exclusivo)**
Cadastre mais de uma assinatura do Claude e alterne com um switch — **a conversa
continua exatamente de onde parou**, porque o histórico é compartilhado entre as
contas. Estourou o limite semanal do Max no meio do trabalho? Troca pra conta 2 e
segue. Funciona remotamente: dá pra trocar a conta do host **pelo celular**. E o
`/usage` mostra a cota **oficial e em tempo real** de cada conta (sessão de 5h,
semana, por modelo) — o mesmo dado da Anthropic, não estimativa.

### 3.6 Duas engines: Claude CLI × Claude API
Switch no topo de cada chat:
- **Claude CLI** — sua assinatura (OAuth), com skills/MCP/agents completos.
- **Claude API** — sua própria API key da Anthropic (`sk-ant-…`) para quem prefere
  pagar por uso. Criptografada com sua licença no cliente, o servidor nunca vê a
  chave, e ela vale em todos os seus dispositivos e no container.
Em ambas: **a inferência é 100% sua**. O Maestrus não revende tokens.

### 3.7 Modo Jarvis — conduza por voz
Conversa realtime de mãos livres: fale, a IA executa, a resposta volta falada, com
o orbe do maestro indicando ouvindo/pensando/falando e botão de pausa que
interrompe na hora. No celular usa a voz nativa; no desktop, Whisper local. Com sua
chave da OpenAI (**BYOK**, mesma proteção criptografada), destrava a voz realtime
full-duplex (gpt-4o-realtime) com acesso às ferramentas do Maestrus. Wake word no
desktop pra chamar o maestro sem tocar no teclado.

### 3.8 Kanban 24/7 — a fila que trabalha por você
Quadro de tarefas por projeto: empilhe 10 cards à noite, o Maestrus executa em
sequência — na sua máquina host ou no container — e os resultados aparecem no chat
de cada projeto. Acompanhe do celular. *"Acorde com o backlog feito."*

### 3.9 Compartilhamento de workspace
Convide outra pessoa (pelo e-mail da conta Maestrus) para projetos seus, com
permissões — ela conversa com os SEUS projetos, no SEU host, sem acesso à sua
máquina além do que você liberou. Ideal pra dupla dev+cliente ou dev+dev.

### 3.10 Um app, todas as telas
**Desktop** Windows e Mac com tudo embutido (Node, Git e Claude CLI no instalador —
zero setup, funciona offline no primeiro boot) e updates automáticos leves (patch
de ~5 MB, sem reinstalar). **Web app** desktop-like no navegador. **PWA** que
instala no celular. Mesma conta, mesmos projetos: locais + remotos + nuvem somando
na mesma sidebar. Interface trilíngue (PT/EN/ES), tema claro/escuro, campo de
prompt e histórico com tipografia de leitura confortável.

### 3.11 Poderes de máquina (desktop)
O agente enxerga e opera o computador quando você pede: navegador embutido
(pesquisa, screenshots, interação), controle de janelas e UI por acessibilidade,
abrir apps e arquivos. No macOS e Windows. Perfeito pra "pesquisa no site X e
aplica no projeto".

### 3.12 `[EM BREVE]` (pode aparecer como roadmap na LP — rotulado)
- **Codex CLI (OpenAI)** como terceira engine — sua conta ChatGPT junto do Claude.
- **Self-host open source** (`maestrus-selfhost`): suba seu próprio servidor com
  docker-compose em qualquer VPS, grátis, licença BSL. Os mesmos apps conectam na
  SUA URL.
- **Team**: workspaces multi-seat com billing central.

---

## 4. PLANOS (pricing da LP — ativos em produção)

*A inferência nunca está embutida: você usa sua assinatura ou sua API key. Por
isso os preços são honestos — você paga o palco, não tokens re-vendidos.*

| | **Free** | **Solo Cloud** | **Pro Cloud** | **Team** `[EM BREVE]` |
|---|---|---|---|---|
| Preço | **$0** | **$12/mês** | **$29/mês** | $79/mês (5 seats) |
| Anual (2 meses grátis) | — | $120/ano | $290/ano | $790/ano |
| Instância 24/7 na nuvem | — | ✓ 4 GB | ✓ 8 GB prioritária | ✓ |
| Storage de projetos | — | 10 GB | 50 GB | 100 GB |
| Desktop + Web + PWA | ✓ | ✓ | ✓ | ✓ |
| Orquestração multi-projeto | ✓ | ✓ | ✓ ilimitada | ✓ |
| Sua conta Claude (CLI) e sua API key | ✓ | ✓ | ✓ | ✓ |
| Multi-conta com switch | ✓ | ✓ | ✓ | ✓ |
| Claude Powers (skills/agents/comandos/MCP) | ✓ | ✓ | ✓ | ✓ |
| Host na própria máquina + acesso remoto | ✓ | ✓ | ✓ | ✓ |
| Jarvis (voz) · realtime com BYOK OpenAI | ✓ | ✓ | ✓ | ✓ |
| Kanban 24/7 | ✓ (host próprio) | ✓ na nuvem | ✓ | ✓ |
| Compartilhar workspace | — | ✓ | ✓ | ✓ |
| **Trial** | — | **30 dias grátis no cadastro** | — | — |

Free = 100% na sua máquina, sem nuvem — pra sempre. Solo = o pulo pro 24/7.

---

## 5. COMPARATIVO (seção "por que Maestrus")

| | Remote control espelhado (grátis por aí) | Cloud de IA metrado | **Maestrus** |
|---|---|---|---|
| PC desligou | sessão morre, ID se perde | n/a | **continua 24/7, mesma sessão** |
| Vários projetos de um chat | não | não | **sim — o maestro** |
| Limite do plano estourou | trava | paga mais tokens | **troca de conta, mesma conversa** |
| Quem paga a inferência | você (ok) | você, com markup | **você, direto na Anthropic, sem markup** |
| Skills/agents/comandos/MCP gerenciáveis | terminal | limitado | **tela Claude Powers** |
| Voz | não | raro | **Jarvis realtime** |

---

## 6. SEGURANÇA & CONFIANÇA (bloco da LP)

- **Sua conta é sempre a sua conta do Claude.** OAuth oficial da Anthropic; o
  Maestrus não intercepta sua inferência nem revende tokens.
- **Chaves BYOK (Anthropic/OpenAI) criptografadas no SEU dispositivo** (AES-256-GCM
  derivada da sua licença) — o servidor guarda só o blob cifrado.
- **Container isolado por usuário**, subdomínio próprio, TLS automático.
- **Nenhuma porta aberta na sua máquina** — host conecta pra fora, via relay.
- **Seus arquivos ficam com você** (modo local) ou no SEU container (nuvem).
- Termos e privacidade publicados; conta com trial sem pegadinha.

---

## 7. FAQ (seeds)

1. **Preciso pagar tokens de novo?** Não. Sua assinatura Claude (ou sua API key)
   fala direto com a Anthropic. O Maestrus cobra pela orquestração e pelo 24/7.
2. **E se meu PC desligar?** No modo nuvem, nada muda — o container é independente.
   No modo host, ao religar a MESMA sessão continua (histórico em disco).
3. **Estourei o limite do meu plano Claude.** Cadastre outra conta e troque com um
   switch — sem perder a conversa. O /usage mostra a cota real de cada uma.
4. **Funciona no celular?** Sim: navegador ou PWA instalável. Voz inclusive.
5. **Sou obrigado a usar a nuvem?** Não. O Free roda 100% local, pra sempre.
   `[EM BREVE]` self-host open source pra rodar o servidor na SUA VPS.
6. **Meus arquivos vão pra onde?** Local: ficam na sua máquina. Nuvem: no seu
   container isolado. Nunca num pote compartilhado.
7. **Que IA ele usa?** A sua: Claude (assinatura ou API key). `[EM BREVE]` ChatGPT
   via Codex CLI.

---

## 8. ESTRUTURA DA PÁGINA (ordem sugerida)

1. Hero (§1) + mockup desktop+celular · 2. A dor (sessão que morre — narrativa §1)
3. O fluxo mágico em 3 passos (§2) · 4. Features em cards (§3, ordem: Maestro →
24/7 → Multi-conta → Claude Powers → Jarvis → Kanban → Remote host → Todas as
telas → Compartilhamento → Poderes de máquina) · 5. Comparativo (§5) · 6. Pricing
(§4) com destaque no Solo $12 + trial 30d · 7. Segurança (§6) · 8. FAQ (§7) ·
9. CTA final: *"Sua orquestra está esperando. Crie a conta, conecte seu Claude,
levante a batuta."* · 10. Footer trilíngue.

### Headlines auxiliares (ads/section titles)
- "Fechou o notebook. O trabalho continuou."
- "Um maestro. Todos os seus projetos."
- "Estourou o limite? Troca de conta. A conversa nem percebe."
- "Sua conta do Claude. Nossos superpoderes."
- "Do celular, por voz, com o PC desligado."

### O que NÃO dizer
- Não prometer `[EM BREVE]` como existente (Codex, self-host, Team).
- Não dizer "ilimitado" sobre IA — a cota é a do plano Claude do usuário.
- Não vender "Claude no celular" como diferencial (commodity) — vender a
  PERSISTÊNCIA, a ORQUESTRAÇÃO e o CONTROLE.
