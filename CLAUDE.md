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
- **Canal:** Evolution API (WhatsApp) — já rodando na infra.

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
| Comercial | — | Caio |
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

- **VPS principal:** 89.167.63.141 (PostgreSQL, Gesthub, serviços)
- **Deploy:** Docker containers com Caddy reverse proxy
- **Portas:** server 3010, frontend 5173 (dev)

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
- [x] Chat funcional com Minimax M2.5 (tool use loop)
- [x] WhatsApp operacional (whatsapp-web.js) — Luna ativa
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
- [ ] Escritório virtual 2D com avatares animados (PixiJS)
- [ ] Scheduler proativo — Campelo alerta prazos fiscais por cliente
- [ ] Integração Cliente 360 do Gesthub no contexto da Luna
- [ ] Comunicação proativa (lembretes, coleta de documentos)
- [ ] Dashboard de gestão CEO (NPS, SLA, produtividade)
- [ ] Portal do cliente

## Convenções de código

- **ES Modules** (import/export, "type": "module" no package.json)
- **Nomes de variáveis/funções:** camelCase em JS, snake_case no banco
- **Tools:** cada agente tem um arquivo em `server/src/tools/` com suas tools registradas
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
