# Atrio Office

Escritorio contabil virtual do Atrio Contabilidade. Sistema onde agentes IA e colaboradores humanos trabalham juntos para atender clientes, processar demandas fiscais, financeiras e societarias.

## Arquitetura

```
Cliente (WhatsApp) → Luna (IA) → Classifica → Agente IA executa → Humano revisa → Cliente
```

### Agentes IA (8)

| Agente | Setor | Funcao | Tools |
|--------|-------|--------|-------|
| **Rodrigo** | Diretoria | Orquestrador — coordena, nunca executa | 7 |
| **Campelo** | Fiscal | Impostos, NFS-e, Fator R, obrigacoes | 7 |
| **Sneijder** | Financeiro | Conciliacao, fluxo de caixa, DRE, cobranca | 6 |
| **Luna** | Atendimento | WhatsApp, classificacao, onboarding | 6 |
| **Sofia** | Societario | Contratos, alteracoes, Junta Comercial | 5 |
| **Valencia** | Comercial | Funil de vendas, propostas, contratos | 7 |
| **Maia** | Marketing | Campanhas, conteudo, segmentacao, leads | 7 |

**Total:** 31 tools registradas

### Equipe Humana (7)

| Nome | Funcao | Setor |
|------|--------|-------|
| Caio | CEO / Comercial / Marketing | Diretoria |
| Deyvison | Legalizacao / Contabilidade / Fiscal | Fiscal |
| Diego | Contabilidade / Fiscal | Fiscal |
| Diogo | Financeiro | Financeiro |
| Karla | Contabilidade / Fiscal | Fiscal |
| Quesia | Sucesso do Cliente / Atendimento | Atendimento |
| Rafaela | Folha de Pagamento | Pessoal |

### Roteamento de Demandas

```
fiscal      → Campelo (IA)  + Deyvison/Diego/Karla (revisa)
financeiro  → Sneijder (IA) + Diogo (revisa)
societario  → Sofia (IA)    + Deyvison (revisa)
comercial   → Caio (direto)
atendimento → Luna (IA)     + Quesia (revisa)
pessoal     → Rafaela (direto)
```

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 19 + Vite 8 + Tailwind CSS 4 |
| Backend | Node.js 22 + Express |
| Banco | PostgreSQL 17 |
| IA | Minimax M2.5 (OpenAI-compatible) |
| WhatsApp | whatsapp-web.js (sessao local) |
| Notificacoes | Telegram Bot API |
| NFS-e | Nuvem Fiscal / Focus NFe |
| Gestao | Gesthub (sistema proprio) |
| Financeiro | Omie API |
| Deploy | Docker + Caddy reverse proxy |

## Estrutura

```
atrio-office/
├── client/                      # React + Vite
│   ├── src/
│   │   ├── components/          # 10 componentes
│   │   │   ├── TopBar.jsx       # Navegacao + filtro de agentes
│   │   │   ├── AgentCard.jsx    # Card de status do agente
│   │   │   ├── ChatPanel.jsx    # Chat com agentes
│   │   │   ├── TaskBoard.jsx    # Quadro de tarefas
│   │   │   ├── ActivityFeed.jsx # Feed de atividades em tempo real
│   │   │   ├── StatsBar.jsx     # Metricas do dashboard
│   │   │   ├── WhatsAppStatus.jsx # Status + QR Code
│   │   │   ├── AttendanceQueue.jsx # Fila de atendimento Luna
│   │   │   ├── Header.jsx       # Cabecalho
│   │   │   └── Sidebar.jsx      # Barra lateral
│   │   ├── hooks/               # Custom hooks
│   │   │   ├── useAgents.js     # Estado dos agentes
│   │   │   ├── useChat.js       # Conversas com agentes
│   │   │   └── useWebSocket.js  # WebSocket real-time
│   │   ├── pages/
│   │   │   └── Office.jsx       # Dashboard principal
│   │   ├── portal/              # Portal do cliente
│   │   │   ├── PortalLogin.jsx
│   │   │   └── PortalDashboard.jsx
│   │   ├── office/              # Escritorio virtual 2D (futuro)
│   │   │   ├── VirtualOffice.jsx
│   │   │   ├── HUD.jsx
│   │   │   └── OfficeMap.js
│   │   ├── lib/api.js           # API client
│   │   ├── App.jsx
│   │   └── main.jsx
│   └── package.json
├── server/                      # Node.js + Express
│   ├── src/
│   │   ├── services/            # Integracoes
│   │   │   ├── claude.js        # Minimax API wrapper
│   │   │   ├── orchestrator.js  # Motor de execucao de tasks
│   │   │   ├── whatsapp.js      # WhatsApp (Luna) — fluxo completo
│   │   │   ├── luna-analyzer.js # Sentimento, classificacao, NPS
│   │   │   ├── gesthub.js       # Gesthub API client
│   │   │   ├── omie.js          # Omie API client
│   │   │   ├── receita.js       # Consulta CNPJ (Receita Federal)
│   │   │   ├── telegram.js      # Telegram Bot notificacoes
│   │   │   ├── scheduler.js     # Tarefas automaticas
│   │   │   └── daily-report.js  # Relatorio diario
│   │   ├── tools/               # 31 tools dos agentes
│   │   │   ├── registry.js      # Registro central + dispatcher
│   │   │   ├── rodrigo.js       # 7 tools — diretoria
│   │   │   ├── campelo.js       # 7 tools — fiscal
│   │   │   ├── sneijder.js      # 6 tools — financeiro
│   │   │   ├── luna.js          # 6 tools — atendimento
│   │   │   ├── sofia.js         # 5 tools — societario
│   │   │   └── shared.js        # Funcoes compartilhadas
│   │   ├── db/
│   │   │   ├── pool.js          # Conexao PostgreSQL
│   │   │   ├── schema.sql       # 6 tabelas + enums + indices
│   │   │   ├── seed.sql         # Agentes IA + equipe humana
│   │   │   ├── migrate_tools_schema.sql
│   │   │   └── migrate_whatsapp.sql
│   │   └── index.js             # Express + WebSocket + rotas
│   └── package.json
├── Dockerfile                   # Multi-stage build
├── docker-compose.yml           # PostgreSQL + server
├── Caddyfile                    # Reverse proxy
├── deploy.sh                    # Script de deploy VPS
├── CLAUDE.md                    # Documentacao tecnica completa
└── README.md                    # Este arquivo
```

## Banco de Dados

6 tabelas principais:

- **agents** — Definicao dos agentes IA (name, role, system_prompt, tools, config)
- **team_members** — Unifica IA + humanos (type: ai/human, agent_id FK)
- **clients** — Carteira de clientes (cnpj, regime, contato)
- **conversations** — Conversas com agentes (agent_id, channel, status)
- **messages** — Mensagens das conversas (role, content, metadata)
- **tasks** — Tarefas delegadas (assigned_to, priority, status, result)

Tabelas adicionais para WhatsApp:
- **whatsapp_conversations** — Conversas ativas com persistencia
- **whatsapp_messages** — Historico de mensagens WhatsApp
- **agent_metrics** — Metricas de performance dos agentes

## Fluxo WhatsApp (Luna)

```
1. Cliente envia mensagem
2. [30s] Luna envia greeting com nome do cliente
3. [60s] Luna classifica (fiscal/financeiro/societario/comercial/atendimento/pessoal)
4. [60s] UMA notificacao no grupo Luna_Atendimento
5. [60s] Task criada → Agente IA executa + humano revisa
6. [10min] Escalation nivel 0 — mensagem ao cliente
7. [30min] Escalation nivel 1
8. [1h] Escalation nivel 2 (hora-aware: transbordo fora do horario)
9. [2h] Escalation nivel 3
10. [6h+] Escalation niveis 4-6 (so equipe, sem msg ao cliente)
```

Fluxo especial NFS-e:
```
1. Detecta "nota fiscal" → pula greeting
2. Luna coleta: nome, CPF/CNPJ, valor, descricao
3. Dados completos → cria task fiscal → Campelo executa
```

## Setup Local

```bash
# 1. Banco de dados
psql -U postgres -c 'CREATE DATABASE atrio_office;'
psql -U postgres -d atrio_office -f server/src/db/schema.sql
psql -U postgres -d atrio_office -f server/src/db/seed.sql

# 2. Backend
cd server
cp ../.env.example .env  # preencher variaveis
npm install
npm run dev              # porta 3010

# 3. Frontend
cd client
npm install
npm run dev              # porta 5173
```

## Variaveis de Ambiente

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/atrio_office
MINIMAX_API_KEY=...
MINIMAX_MODEL=MiniMax-M1
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
OMIE_APP_KEY=...
OMIE_APP_SECRET=...
GESTHUB_BASE_URL=...
PORT=3010
```

## Deploy

```bash
# VPS com Docker
./deploy.sh
# ou
docker compose up -d
```

Infraestrutura: Docker containers + Caddy reverse proxy na VPS `89.167.63.141`.

## Identidade Visual

- **Marca:** Atrio Contabilidade
- **Warm Gold:** #C4956A
- **Void (fundo):** #08080A
- **Tema:** Dark mode, premium, profissional

---

Desenvolvido por **Caio Monteiro** — CRC PE-029471/O-2 | Atrio Contabilidade
