# ÁTRIO OFFICE — Escritório Contábil Virtual com Agentes IA

## Visão geral

Átrio Office é o sistema operacional do Átrio Contabilidade — um escritório contábil digital onde agentes de IA e colaboradores humanos trabalham juntos. O sistema consiste em um dashboard web onde o CEO (Caio) visualiza, conversa e gerencia toda a operação através de agentes autônomos.

**Criador:** Caio Monteiro — contador (CRC PE-029471/O-2), fundador do Átrio Contabilidade.
**Co-fundador/operador:** Deyvison.

## Agentes IA (8 agentes)

### Rodrigo — Diretor de operações (Diretoria)
- **Função:** Orquestrador. NUNCA executa — coordena. Toda demanda passa por ele.
- **Cor:** #C4956A (Warm Gold) | **Letra:** R
- **Tools:** delegar_tarefa, status_equipe, fila_prioridades, relatorio_diario, escalar_para_caio, rotear_demanda, agenda_prazos
- **Personalidade:** Líder sereno, visão macro. Decide se tarefa vai para IA ou humano baseado em complexidade, urgência e disponibilidade.
- **Gerencia:** Todos os agentes IA + humanos (Deyvison, Diego)

### Campelo — Analista fiscal (Setor Fiscal)
- **Função:** Impostos, NFS-e, Fator R, obrigações acessórias, simulação de regimes.
- **Cor:** #378ADD (Blue) | **Letra:** C
- **Tools:** emitir_nfse, calcular_impostos, calcular_fator_r, gerar_guia_das, simular_regime, alertas_prazos, consultar_cnpj
- **Personalidade:** Preciso, metódico. O cara dos números. Nunca deixa prazo passar.
- **NFS-e:** Usa Nuvem Fiscal / Focus NFe como engine de emissão via API.

### Sneijder — Analista financeiro (Setor Financeiro)
- **Função:** Conciliação bancária, fluxo de caixa, contas a pagar/receber, DRE, alertas.
- **Cor:** #639922 (Green) | **Letra:** S
- **Tools:** conciliar_extrato, fluxo_caixa, contas_pagar, contas_receber, alertas_cobranca, relatorio_dre
- **Personalidade:** Organizado, vigilante com o caixa. Enxerga padrões nos números.

### Luna — Gestora de atendimento (Atendimento)
- **Função:** Porta de entrada. Recebe mensagens (WhatsApp/email), classifica, coleta documentos, faz onboarding, encaminha para Rodrigo.
- **Cor:** #BA7517 (Amber) | **Letra:** L
- **Tools:** whatsapp_enviar, whatsapp_receber, email_enviar, coletar_documento, onboarding_cliente, rotear_para_rodrigo
- **Personalidade:** Simpática, acolhedora. Traduz contabilês para o cliente.
- **Canal:** whatsapp-web.js (sessão local via Puppeteer)

### Sofia — Analista societário (Societário)
- **Função:** Contratos sociais, alterações, consolidações, Junta Comercial, estrutura societária.
- **Cor:** #7F77DD (Purple) | **Letra:** So
- **Tools:** gerar_contrato, alteracao_contratual, consultar_jucep, consultar_cnpj, simular_estrutura, checklist_abertura
- **Personalidade:** Estratégica, visão de longo prazo. Sempre considera proteção patrimonial.

### Valência — Gestor Comercial (Setor Comercial)
- **Função:** Funil de vendas, propostas, contratos de serviço, análise de churn, upsell.
- **Cor:** #E05A33 (Coral) | **Letra:** V
- **Tools:** funil_vendas, gerar_proposta, gerar_contrato_servico, analise_churn, relatorio_comercial, oportunidade_upsell, consultar_vendas_gesthub
- **Personalidade:** Consultivo, orientado a dados, vende valor e não preço.
- **Integrações:** Gesthub (vendas/leads), Omie (faturamento), Maia (leads qualificados)

### Maia — Estrategista de Marketing (Setor Marketing)
- **Função:** Campanhas, conteúdo educativo, segmentação, nutrição de leads, posicionamento, programa de indicação.
- **Cor:** #D946A8 (Rosa) | **Letra:** M
- **Tools:** campanha_whatsapp, gerar_conteudo, segmentar_clientes, calendario_marketing, programa_indicacao, nutrir_lead, relatorio_marketing
- **Personalidade:** Criativa, estratégica, comunicativa. Transforma contabilidade em conteúdo que engaja.
- **Integrações:** Luna (execução WhatsApp), Campelo (conteúdo fiscal), Valência (conversão de leads)

### Dara — Secretária executiva (Diretoria)
- **Função:** Agenda, atas, follow-ups, organização interna, suporte administrativo ao CEO.
- **Cor:** #8B6F5A (Bronze) | **Letra:** D
- **Tools:** agendar_reuniao, gerar_ata, follow_up, organizar_pauta, lembrete_interno, consultar_agenda, resumo_dia
- **Personalidade:** Discreta, eficiente, proativa. Mantém tudo organizado nos bastidores.

## Colaboradores humanos (7)

- **Caio** — CEO / Comercial / Marketing (diretoria)
- **Deyvison** — Legalização / Contabilidade / Fiscal (fiscal)
- **Diego** — Contabilidade / Fiscal (fiscal)
- **Diogo** — Financeiro (financeiro)
- **Karla** — Contabilidade / Fiscal (fiscal)
- **Quésia** — Sucesso do Cliente / Atendimento (atendimento)
- **Rafaela** — Folha de Pagamento (pessoal)

## Roteamento de demandas

| Tipo | Agente IA (executa) | Humano (revisa) |
|------|-------------------|-----------------|
| Fiscal | Campelo | Deyvison / Diego / Karla |
| Financeiro | Sneijder | Diogo |
| Societário | Sofia | Deyvison |
| Comercial | Valência | Caio |
| Atendimento | Luna | Quésia |
| Pessoal/Folha | — | Rafaela |

## Fluxo padrão de uma demanda

1. Cliente envia mensagem (WhatsApp)
2. **Luna** envia greeting com nome do cliente (30s delay)
3. **Luna** classifica com todas as mensagens do cliente (60s delay)
4. UMA notificação no grupo WhatsApp Luna_Atendimento
5. Task criada → agente IA executa + humano revisa/aprova
6. Humano responde ao cliente (Luna não responde conclusão)
7. Escalation automática se ninguém responder (10min → 30min → 1h → 2h → 6h → 12h → 24h)

## Stack técnica

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React + Vite (SPA dashboard) |
| Backend | Node.js + Express (API REST + WebSocket) |
| Banco | PostgreSQL (já rodando na VPS) |
| IA | Minimax M2.5 (OpenAI-compatible SDK) |
| WhatsApp | whatsapp-web.js (sessão local) |
| Notificações | Telegram Bot API |
| Gestão | Gesthub (sistema próprio) |
| Financeiro | Omie API |
| NFS-e | Nuvem Fiscal / Focus NFe (API) |
| Deploy | Docker + Caddy reverse proxy |

## Infraestrutura

- **VPS Hostinger:** 31.97.175.200 (PostgreSQL, Gesthub, Átrio Office, NFS-e System)
- **Deploy:** Docker Compose (`/opt/atrio/`) com Caddy reverse proxy
- **Repo no VPS:** `/opt/atrio/atrio-office/` (git pull + docker compose up -d --build)
- **CI/CD:** GitHub Actions com appleboy/ssh-action (atualmente quebrado — SSH bloqueado pelo firewall Hostinger)
- **Portas:** server 3010, frontend 5173 (dev)
- **VPS expira:** 2026-04-16 (renovar!)

## Banco de dados — 6 tabelas

1. **agents** — Definição dos agentes IA (name, role, system_prompt, tools, status, config)
2. **team_members** — Unifica IA + humanos (type: 'ai'|'human', agent_id FK)
3. **clients** — Carteira de clientes (cnpj, regime, contato, status)
4. **conversations** — Conversas com agentes (agent_id, client_id, channel, status)
5. **messages** — Mensagens das conversas (conversation_id, role, content, metadata)
6. **tasks** — Tarefas delegadas (assigned_to, delegated_by, priority, status, result)

Schema completo em: `server/src/db/schema.sql`
Seed (agentes + humanos) em: `server/src/db/seed.sql`

## Identidade visual

- **Marca:** Átrio Contabilidade
- **Warm Gold:** #C4956A
- **Void (fundo):** #08080A
- **Tema:** Dark mode, premium, profissional
- **Font:** DM Sans (ou system-ui fallback)

## Estrutura do projeto

```
atrio-office/
├── client/                      # React 19 + Vite 8 + Tailwind 4
│   ├── src/
│   │   ├── components/          # 10 componentes (AgentCard, ChatPanel, TaskBoard, etc.)
│   │   ├── hooks/               # useAgents, useChat, useWebSocket
│   │   ├── pages/Office.jsx     # Dashboard principal
│   │   ├── portal/              # Portal do cliente (login + dashboard)
│   │   ├── office/              # Escritório virtual 2D (PixiJS)
│   │   ├── lib/api.js           # API client
│   │   └── App.jsx
│   └── package.json
├── server/                      # Node.js 22 + Express
│   ├── src/
│   │   ├── services/            # 10 serviços (whatsapp, omie, gesthub, telegram, etc.)
│   │   ├── tools/               # 31 tools (registry + por agente)
│   │   ├── db/                  # schema.sql, seed.sql, pool.js, migrations
│   │   └── index.js             # Express + WebSocket + rotas
│   └── package.json
├── Dockerfile                   # Multi-stage build
├── docker-compose.yml           # PostgreSQL + server
├── Caddyfile                    # Reverse proxy
├── deploy.sh                    # Deploy VPS
├── CLAUDE.md                    # Este arquivo
└── README.md
```

## Estado atual

### Funcionando:
- [x] 8 agentes IA com system prompts, tools e personalidades
- [x] 7 colaboradores humanos no banco (seed.sql)
- [x] 31 tools registradas e funcionais
- [x] Schema do banco com 9 tabelas (6 core + 3 WhatsApp/métricas)
- [x] Server Express com rotas, WebSocket, orchestrator
- [x] Frontend React + Vite + Tailwind com 10 componentes
- [x] Chat funcional com Minimax M2.5 (tool use loop + fallback <FunctionCall> XML)
- [x] Chat privado (1:1 com agente) + Chat da equipe (@menções, todos os agentes com tools)
- [x] WhatsApp operacional (whatsapp-web.js) — Luna ativa, com controles de desconectar/reconectar no dashboard
- [x] Fluxo completo: greeting → classificação → roteamento → escalation
- [x] Coleta de dados NFS-e via WhatsApp
- [x] Integração Omie (inadimplência, contas a pagar/receber)
- [x] Integração Gesthub (clientes, bootstrap)
- [x] Integração Telegram (alertas equipe)
- [x] Scheduler automático (verificações Omie + Gesthub)
- [x] Relatório diário automático
- [x] Docker + Caddy para deploy
- [x] Persistência de conversas WhatsApp no banco

### Próximos passos:
- [ ] Emissão NFS-e via Nuvem Fiscal (payload DPS validado, falta credenciais prod)
- [ ] Scheduler proativo — Campelo alerta prazos fiscais por cliente
- [ ] Integração Omie API (dados reais de faturamento/inadimplência)
- [ ] Integração Cliente 360 do Gesthub no contexto da Luna
- [ ] Comunicação proativa (lembretes, coleta de documentos via WhatsApp)
- [ ] Gesthub como master — sync bidirecional via API externa (PUT + enriquecer-cnpj)
- [ ] Fila de atendimento no dashboard (SLA, classificação, atribuição)
- [ ] Dashboard de gestão CEO (NPS, SLA, produtividade)
- [ ] Escritório virtual 2D com avatares animados (PixiJS)
- [ ] Portal do cliente
- [ ] Corrigir CI/CD (SSH bloqueado — considerar webhook-based deploy ou self-hosted runner)

## Convenções de código

- **ES Modules** (import/export, "type": "module" no package.json)
- **Nomes de variáveis/funções:** camelCase em JS, snake_case no banco
- **Tools:** cada agente tem um arquivo em `server/src/tools/` com suas tools registradas
- **Rotas:** prefixo `/api/` para todas as rotas
- **Erros:** sempre retornar `{ error: "mensagem" }` com status HTTP adequado
- **IDs:** UUID v4 para todas as entidades

## Particularidades técnicas do Minimax M2.5

- Às vezes gera `<FunctionCall>` XML como texto em vez de usar o mecanismo formal `tool_calls` da API OpenAI
- `chatWithAgent()` em `claude.js` tem fallback: parseia XML, executa tools, alimenta resultado de volta ao LLM
- Respostas incluem blocos `<think>` que são removidos por `extractText()`
- O `tools` no banco é JSONB array com `input_schema` — duplicatas causam rejeição da API

## Regras importantes

1. O sistema atende qualquer tipo de cliente (não apenas médicos PJ)
2. Rodrigo NUNCA executa — apenas coordena e delega
3. Luna é sempre o primeiro contato com o cliente
4. Luna NUNCA notifica cliente sobre resultado — sempre avisa EQUIPE (grupo WhatsApp/Telegram)
5. Escalation ao cliente SÓ em horário comercial; fora = só equipe interna
6. Tasks SEMPRE para agentes IA, nunca direto para humanos
7. Toda comunicação inter-agente é via task queue (fica registrada no banco)
8. Se algo trava 2x ou é urgente, Rodrigo escala para Caio
9. Colaboradores humanos recebem tasks da mesma forma que agentes IA
10. Theme: dark mode com identidade visual Átrio (#C4956A + #08080A)

---

## BLUEPRINT v2 — Evolução do Frontend (Abril 2026)

Referência: tenacitOS (Mission Control do OpenClaw) — repo clonado em `../tenacitOS/` como referência de código.
O tenacitOS é um dashboard de gestão de agentes IA com 18 módulos frontend (Next.js 16 + React 19 + Tailwind v4).
Diretriz: **absorver features e patterns de UX do tenacitOS, reescrever na linguagem visual do Átrio**.

### DNA Visual — O QUE NÃO MUDA

Estes elementos são a assinatura da marca. NUNCA substituir por equivalentes do tenacitOS:

| Elemento | Átrio (MANTER) | tenacitOS (NÃO USAR) |
|----------|----------------|----------------------|
| Accent | `#C4956A` Warm Gold | `#FF3B30` Red |
| Background | `#08080A` Void | `#0C0C0C` Pure Black |
| Surface | `#0f1117` / `#131620` (dark slate) | `#1A1A1A` / `#242424` (flat gray) |
| Cards | Glassmorphism (blur 12px + gradientes alpha + noise texture) | Flat surfaces (cor sólida) |
| Borders | Alpha-based `rgba(255,255,255,0.06)` | Fixed `#2A2A2A` |
| Fontes body | Plus Jakarta Sans | Inter |
| Fontes heading | Outfit | Sora |
| Fontes mono | Space Grotesk | JetBrains Mono |
| Animações | Gold-tinted (shimmer, glow-breathe, vista-sweep, pulse-glow) | Transitions simples 150ms |
| Navegação | TopBar horizontal 52px com links textuais + gold underline | Dock lateral 68px com ícones |
| Tema | Dark (padrão) + Light toggle | Dark only |

### Design System — Tokens CSS

```css
/* Cores principais */
--ao-gold: #C4956A;
--ao-gold-dim: #C4956A66;
--ao-void: #08080A;
--ao-surface: #0f1117;
--ao-card: #131620;
--ao-card-hover: #161a24;

/* Texto (alpha-based para transparência natural) */
--ao-text-primary: rgba(255, 255, 255, 0.85);
--ao-text-secondary: rgba(255, 255, 255, 0.6);
--ao-text-muted: rgba(255, 255, 255, 0.5);
--ao-text-dim: rgba(255, 255, 255, 0.35);

/* Borders */
--ao-border: rgba(255, 255, 255, 0.06);
--ao-border-hover: rgba(255, 255, 255, 0.10);

/* Glass card pattern (USAR em todas as cards) */
.glass-card {
  background: linear-gradient(135deg, rgba(19,22,32,0.8) 0%, rgba(19,22,32,0.6) 100%);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 12px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Status colors dos agentes */
--working: #fbbf24 (amber);
--blocked: #f87171 (red);
--pending: #60a5fa (blue);
--success: #22c55e (green);
--standby: rgba(255,255,255,0.35);
```

### Features a Absorver do tenacitOS

#### Fase 1 — Instrumentação do TopBar (~3-4 dias)
Sem mudança no layout. Apenas adições na shell existente.

1. **Busca Global (⌘K)** — Barra de busca no TopBar (centro-direita)
   - Modal overlay com busca em conversas, tasks, clientes, agentes
   - Atalho de teclado ⌘K / Ctrl+K
   - Resultados categorizados com ícones por tipo
   - Ref: `tenacitOS/src/components/GlobalSearch.tsx`

2. **Central de Notificações** — Sino no TopBar com badge
   - Dropdown 420px com cards de notificação
   - Tipos: task_complete, escalation, prazo_fiscal, erro_servico
   - Marca como lido, limpar lidos
   - Requer: nova tabela `notifications` no banco + endpoint `/api/notifications`
   - Ref: `tenacitOS/src/components/NotificationDropdown.tsx`

3. **StatusBar (Health)** — Barra fixa no footer 32px
   - Status de: WhatsApp, Omie API, Gesthub, Telegram, PostgreSQL
   - Dots verde/vermelho + uptime + contagem de agentes online
   - Polling a cada 30s no `/api/health`
   - Dot pulsa com `glow-breathe` gold quando serviço cai
   - Ref: `tenacitOS/src/components/TenacitOS/StatusBar.tsx`

#### Fase 2 — Visibilidade Operacional (~4-5 dias)
Novos componentes dentro do layout existente.

4. **Activity Heatmap** — Embaixo do ActivityFeed
   - Grid 52 semanas × 7 dias (estilo GitHub contributions)
   - Escala de cor: gold-pale → gold saturado (NÃO vermelho como tenacitOS)
   - Tooltip com contagem de atividades por dia
   - Ref: `tenacitOS/src/components/ActivityHeatmap.tsx`

5. **Cron Manager Visual** — Nova página acessível via TopBar
   - Cards para cada scheduler (Omie sync, Gesthub sync, relatório diário, health check)
   - Cada card: nome, schedule (monospace), status, última run, próxima run
   - Botões: play/pause, run now, ver histórico inline
   - Timeline semanal com blocos coloridos
   - Requer: endpoints `/api/crons` (GET, PUT, POST /trigger)
   - Ref: `tenacitOS/src/components/CronJobCard.tsx`, `CronWeeklyTimeline.tsx`

6. **Analytics / Custos IA** — Nova página acessível via TopBar
   - KPI cards: custo hoje, custo mês, projetado, orçamento
   - Chart.js: trend line diário (gold), breakdown por agente (bar)
   - Requer: nova tabela `token_usage` (agent_id, tokens_in, tokens_out, cost, timestamp)
   - Ref: `tenacitOS/src/app/(dashboard)/costs/page.tsx`

#### Fase 3 — Gestão Avançada (~5-7 dias)
Novas páginas e funcionalidades de gestão.

7. **Histórico de Sessões** — Todas as conversas com filtros
   - Filtro por tipo (chat, task, cron), agente, cliente, data
   - Token usage por sessão
   - Ref: `tenacitOS/src/app/(dashboard)/sessions/page.tsx`

8. **Calendário Semanal** — Prazos fiscais + tasks agendadas
   - Grade 7 dias × horário (6h-22h)
   - Cards coloridos por tipo (fiscal, financeiro, societário)
   - Ref: `tenacitOS/src/components/WeeklyCalendar.tsx`

9. **Memory Browser** — Contexto/memória dos agentes
   - Navegar e editar o que cada agente "sabe"
   - Markdown editor/preview
   - Ref: `tenacitOS/src/app/(dashboard)/memory/page.tsx`

#### Fase 4 — Avaliar (Pós Fase 3)

10. **Migração Next.js** — Só se o projeto crescer além de 5-6 páginas
    - Sai React+Vite, entra Next.js com App Router
    - SSR, API routes integradas, middleware de auth nativo
    - Muda deploy: PM2 ou container Node (não mais static build)
    - Decisão: avaliar após implementar fases 1-3

### O QUE NÃO ABSORVER do tenacitOS

- **Sidebar Dock lateral** — TopBar horizontal é assinatura Átrio
- **Red accent (#FF3B30)** — Comunica urgência/dev tool, não premium
- **Flat surfaces sem blur** — Glassmorphism é diferencial visual
- **Inter / Sora / JetBrains Mono** — Manter fontes premium Átrio
- **SQLite** — Já temos PostgreSQL
- **Terminal embutido** — Feature de dev, não de CEO/contador
- **Git Dashboard** — Irrelevante para contexto contábil
- **Skills Manager** — Tools já gerenciados pelo backend
- **Office 3D (Three.js)** — Já temos 2D canvas. 3D é fase futura de branding
- **Pixel art themes** (Habbo, Stardew, Zelda) — Desnecessário

### Referência de código do tenacitOS

Repo local: `../tenacitOS/` (clonado de github.com/caiomonteirovf-bot/tenacitOS)

Componentes-chave para consulta:
```
tenacitOS/src/components/
├── GlobalSearch.tsx          → Busca ⌘K
├── NotificationDropdown.tsx  → Sino + dropdown
├── ActivityHeatmap.tsx       → Heatmap GitHub-style
├── CronJobCard.tsx           → Card de cron job
├── CronWeeklyTimeline.tsx    → Timeline semanal
├── WeeklyCalendar.tsx        → Calendário 7 dias
├── StatsCard.tsx             → KPI cards
├── ActivityFeed.tsx          → Feed de atividades
├── IntegrationStatus.tsx     → Status de integrações
├── SystemInfo.tsx            → Info do sistema
├── TenacitOS/
│   ├── Dock.tsx              → Sidebar (NÃO USAR layout, só ref de UX)
│   ├── TopBar.tsx            → TopBar (ref de busca + notificações)
│   └── StatusBar.tsx         → StatusBar footer (ABSORVER)
└── Office3D/                 → 3D office (fase futura)

tenacitOS/src/app/(dashboard)/
├── page.tsx                  → Dashboard home
├── costs/page.tsx            → Analytics de custos
├── cron/page.tsx             → Cron manager
├── activity/page.tsx         → Activity log + heatmap
├── sessions/page.tsx         → Histórico de sessões
├── memory/page.tsx           → Memory browser
└── calendar/page.tsx         → Calendário semanal
```

### Novas tabelas necessárias (PostgreSQL)

```sql
-- Notificações (Fase 1)
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL, -- task_complete, escalation, prazo_fiscal, erro_servico
  title TEXT NOT NULL,
  message TEXT,
  severity VARCHAR(20) DEFAULT 'info', -- info, warning, error, success
  read BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Token usage / custos IA (Fase 2)
CREATE TABLE token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  conversation_id UUID REFERENCES conversations(id),
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  model VARCHAR(100),
  cost_usd DECIMAL(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cron jobs registry (Fase 2)
CREATE TABLE cron_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  schedule VARCHAR(50) NOT NULL, -- cron expression
  status VARCHAR(20) DEFAULT 'active', -- active, paused, failed
  last_run TIMESTAMPTZ,
  next_run TIMESTAMPTZ,
  last_result VARCHAR(20), -- success, error
  last_error TEXT,
  run_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cron run history (Fase 2)
CREATE TABLE cron_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_job_id UUID REFERENCES cron_jobs(id),
  status VARCHAR(20) NOT NULL, -- success, error
  duration_ms INTEGER,
  output TEXT,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
```

### Novos endpoints necessários

```
# Fase 1
GET    /api/notifications         → Lista notificações (filtro: unread)
PATCH  /api/notifications/:id     → Marca como lida
DELETE /api/notifications/read    → Limpa lidas
GET    /api/health                → Health de todos os serviços (já existe, expandir)

# Fase 2
GET    /api/crons                 → Lista cron jobs com status
PUT    /api/crons/:id             → Toggle pause/active
POST   /api/crons/:id/trigger     → Executa cron manualmente
GET    /api/crons/:id/runs        → Histórico de runs
GET    /api/analytics/costs       → Custos por período/agente
GET    /api/analytics/activity    → Activity stats + heatmap data

# Fase 3
GET    /api/sessions              → Histórico de sessões com filtros
GET    /api/calendar              → Tasks + prazos por semana
GET    /api/agents/:id/memory     → Memória/contexto do agente
PUT    /api/agents/:id/memory     → Editar memória
```
