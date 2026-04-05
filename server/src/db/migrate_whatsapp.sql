-- ============================================
-- MIGRAÇÃO: Persistência de conversas WhatsApp
-- Permite restaurar estado após restart do servidor
-- ============================================

-- Tabela específica para estado das conversas WhatsApp da Luna
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(30) NOT NULL,
    chat_id VARCHAR(80) NOT NULL,
    client_name VARCHAR(255),
    real_phone VARCHAR(30),
    display_phone VARCHAR(30),

    -- Estado da conversa
    escalation_level INTEGER DEFAULT -1,
    human_replied BOOLEAN DEFAULT FALSE,
    human_replied_at TIMESTAMP,
    resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP,
    greeted BOOLEAN DEFAULT FALSE,
    outside_hours BOOLEAN DEFAULT FALSE,

    -- Análise Luna
    analysis JSONB,

    -- Classificação da demanda (L2)
    classification VARCHAR(50), -- fiscal, financeiro, societario, atendimento, geral
    priority VARCHAR(20) DEFAULT 'medium', -- low, medium, high, urgent
    assigned_to VARCHAR(100), -- nome do atendente sugerido

    -- Timestamps
    started_at TIMESTAMP DEFAULT NOW(),
    last_message_at TIMESTAMP DEFAULT NOW(),
    closed_at TIMESTAMP,

    -- Constraint: um phone ativo por vez
    CONSTRAINT uq_whatsapp_active_phone UNIQUE (phone) -- será removido se precisar histórico
);

-- Mensagens do WhatsApp (separada de messages do dashboard)
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
    sender VARCHAR(20) NOT NULL, -- 'client', 'team', 'luna'
    body TEXT NOT NULL,
    metadata JSONB DEFAULT '{}', -- sentimento, urgência, etc
    created_at TIMESTAMP DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_wa_conv_phone ON whatsapp_conversations(phone);
CREATE INDEX IF NOT EXISTS idx_wa_conv_resolved ON whatsapp_conversations(resolved, started_at);
CREATE INDEX IF NOT EXISTS idx_wa_conv_classification ON whatsapp_conversations(classification);
CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON whatsapp_messages(conversation_id, created_at);

-- Métricas de agentes (R2 - preparação)
CREATE TABLE IF NOT EXISTS agent_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL, -- 'greeting_sent', 'escalation', 'analysis', 'task_created', etc
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_agent ON agent_metrics(agent_name, created_at);
CREATE INDEX IF NOT EXISTS idx_metrics_type ON agent_metrics(event_type, created_at);
