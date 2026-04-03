# ============================================
# PROMPT INICIAL — Cole no Claude Code
# ============================================
# Após abrir o projeto com `claude` no terminal,
# cole o texto abaixo como primeira mensagem:
# ============================================

Leia o CLAUDE.md na raiz do projeto para entender o contexto completo. Este é o Átrio Office — um escritório contábil virtual com 5 agentes IA (Rodrigo, Campelo, Sneijder, Luna, Sofia) e colaboradores humanos.

O projeto já tem:
- Schema do banco (server/src/db/schema.sql)
- Seed com os agentes (server/src/db/seed.sql)
- Server Express básico (server/src/index.js) 
- Claude API wrapper (server/src/services/claude.js)
- Pool PostgreSQL (server/src/db/pool.js)

Preciso que você execute agora, nesta ordem:

1. **Setup do backend:**
   - `cd server && npm install`
   - Criar arquivo `.env` baseado no `.env.example` (use placeholder para ANTHROPIC_API_KEY, eu preencho depois)
   - Criar o banco `atrio_office` no PostgreSQL local
   - Rodar schema.sql e seed.sql
   - Testar se o server sobe com `npm run dev`

2. **Setup do frontend:**
   - `cd client && npm create vite@latest . -- --template react`
   - Instalar Tailwind CSS
   - Criar a estrutura de componentes baseada no CLAUDE.md
   - Portar o dashboard protótipo (que já existe como conceito) para componentes React reais
   - Conectar ao backend (proxy para localhost:3010)

3. **Conectar chat real:**
   - O endpoint POST /api/chat/:agentId já existe no server
   - O ChatPanel do frontend deve chamar esse endpoint
   - Usar WebSocket para streaming (ou polling simples no MVP)
   - As respostas devem vir da Claude API real, usando o system prompt do agente

Comece pelo passo 1. Ao encontrar erros, corrija e siga. Me avise quando o server estiver rodando.
