# ÁTRIO OFFICE — Escritório Contábil Virtual com Agentes IA

## Visão geral

Átrio Office é o sistema operacional do Átrio Contabilidade — um escritório contábil digital onde agentes de IA e colaboradores humanos trabalham juntos. O sistema consiste em um dashboard web onde o CEO (Caio) visualiza, conversa e gerencia toda a operação através de agentes autônomos.

**Criador:** Caio Monteiro — contador (CRC PE-029471/O-2), fundador do Átrio Contabilidade.
**Co-fundador/operador:** Deyvison.

## Agentes IA (5 agentes)

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
- **Canal:** Evolution API (WhatsApp) — já rodando na infra.

### Sofia — Analista societário (Societário)
- **Função:** Contratos sociais, alterações, consolidações, Junta Comercial, estrutura societária.
- **Cor:** #7F77DD (Purple) | **Letra:** So
- **Tools:** gerar_contrato, alteracao_contratual, consultar_jucep, consultar_cnpj, simular_estrutura, checklist_abertura
- **Personalidade:** Estratégica, visão de longo prazo. Sempre considera proteção patrimonial.

## Colaboradores humanos

- **Deyvison** — Coordenador operacional (humano)
- **Diego** — Assistente contábil (humano)

## Fluxo padrão de uma demanda

1. Cliente envia mensagem (WhatsApp/email)
2. **Luna** recebe, classifica (fiscal/financeiro/societário/geral), extrai intenção
3. Luna envia para **Rodrigo** via task queue com classificação e prioridade
4. **Rodrigo** avalia: complexidade, urgência, disponibilidade → delega
5. Rodrigo cria **task** e atribui ao agente/humano adequado
6. Agente executa e reporta resultado na task
7. **Luna** formata e envia resposta ao cliente

## Stack técnica

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React + Vite (SPA dashboard) |
| Backend | Node.js + Express (API REST + WebSocket) |
| Banco | PostgreSQL (já rodando na VPS) |
| IA | Claude API (claude-sonnet-4-20250514) |
| WhatsApp | Evolution API (já rodando) |
| NFS-e | Nuvem Fiscal / Focus NFe (API) |
| Orquestração | n8n + task queue interna (Node.js) |
| Deploy | Docker + Traefik (mesmo padrão Bira/FleetOS) |

## Infraestrutura

- **VPS principal:** 89.167.63.141 (PostgreSQL, Evolution API, n8n, Redis)
- **Deploy:** Docker containers com Traefik reverse proxy
- **Domínio previsto:** atrio-office.vcatech.online (ou similar via Traefik)
- **Portas:** server 3010, WebSocket 3011, frontend 5173 (dev)

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
├── client/                    # React + Vite
│   ├── src/
│   │   ├── components/        # AgentCard, ChatPanel, TaskBoard, etc.
│   │   ├── hooks/             # useAgent, useWebSocket
│   │   ├── pages/             # Office, Agent, Tasks
│   │   └── App.jsx
│   └── package.json
├── server/                    # Node.js + Express
│   ├── src/
│   │   ├── agents/            # System prompts + tools por agente
│   │   ├── services/          # claude.js, taskQueue.js, whatsapp.js, nfse.js
│   │   ├── routes/            # agents, chat, tasks, clients
│   │   ├── db/                # schema.sql, seed.sql, pool.js
│   │   ├── websocket.js
│   │   └── index.js
│   └── package.json
├── docker-compose.yml
├── .env.example
├── CLAUDE.md                  # Este arquivo
└── README.md
```

## Estado atual

### Já criado:
- [x] Definição completa dos 5 agentes (nomes, roles, system prompts, tools, personalidades)
- [x] Schema do banco (schema.sql) com 6 tabelas, índices e triggers
- [x] Seed data (seed.sql) com agentes + humanos
- [x] Server Express básico (index.js) com rotas de agents, chat, tasks, clients, stats
- [x] Claude API wrapper (claude.js) com suporte a tool use loop
- [x] Pool PostgreSQL (pool.js)
- [x] .env.example com todas as variáveis
- [x] Protótipo visual do dashboard (React JSX)

### Próximos passos (Fase 2-3):
- [ ] Setup completo do frontend React + Vite com Tailwind
- [ ] Componentizar o dashboard (AgentCard, ChatPanel, TaskBoard, SectorView)
- [ ] Conectar frontend ao backend (fetch API, WebSocket para chat real-time)
- [ ] Chat funcional com Claude API (mensagens reais, não mock)
- [ ] Implementar tool execution no backend (calcular_fator_r, alertas_prazos, etc.)
- [ ] WebSocket broadcast para atualizações em tempo real
- [ ] Docker compose para deploy

### Fase 4+ (futuro):
- [ ] Integração WhatsApp via Evolution API (Luna)
- [ ] Integração email
- [ ] Integração Nuvem Fiscal (NFS-e)
- [ ] Orquestração inter-agentes real (Rodrigo delegando)
- [ ] Portal do cliente
- [ ] Multi-tenant para SaaS

## Convenções de código

- **ES Modules** (import/export, "type": "module" no package.json)
- **Nomes de variáveis/funções:** camelCase em JS, snake_case no banco
- **Agentes:** cada agente é um arquivo em `server/src/agents/` exportando { systemPrompt, tools }
- **Rotas:** prefixo `/api/` para todas as rotas
- **Erros:** sempre retornar `{ error: "mensagem" }` com status HTTP adequado
- **IDs:** UUID v4 para todas as entidades

## Regras importantes

1. O sistema atende qualquer tipo de cliente (não apenas médicos PJ)
2. Rodrigo NUNCA executa — apenas coordena e delega
3. Luna é sempre o primeiro contato com o cliente
4. Toda comunicação inter-agente é via task queue (fica registrada no banco)
5. Se algo trava 2x ou é urgente, Rodrigo escala para Caio
6. Colaboradores humanos recebem tasks da mesma forma que agentes IA
7. Theme: dark mode com identidade visual Átrio (#C4956A + #08080A)
