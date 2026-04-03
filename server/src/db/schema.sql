-- ============================================
-- ÁTRIO OFFICE — Schema do Banco de Dados
-- Escritório Contábil Virtual com Agentes IA
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Status enums
CREATE TYPE agent_status AS ENUM ('online', 'busy', 'offline');
CREATE TYPE member_type AS ENUM ('ai', 'human');
CREATE TYPE member_status AS ENUM ('available', 'busy', 'offline');
CREATE TYPE client_status AS ENUM ('active', 'onboarding', 'inactive');
CREATE TYPE regime_tributario AS ENUM ('simples', 'presumido', 'real', 'mei', 'isento');
CREATE TYPE channel_type AS ENUM ('dashboard', 'whatsapp', 'email');
CREATE TYPE conversation_status AS ENUM ('active', 'closed', 'archived');
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system', 'tool');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE task_status AS ENUM ('pending', 'in_progress', 'done', 'blocked', 'cancelled');

-- ============================================
-- 1. AGENTS — Definição dos agentes IA
-- ============================================
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    role VARCHAR(100) NOT NULL,
    department VARCHAR(100) NOT NULL,
    system_prompt TEXT NOT NULL,
    tools JSONB DEFAULT '[]',
    personality TEXT,
    status agent_status DEFAULT 'online',
    config JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 2. TEAM_MEMBERS — Unifica IA + Humanos
-- ============================================
CREATE TABLE team_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    type member_type NOT NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    role VARCHAR(100),
    department VARCHAR(100),
    status member_status DEFAULT 'available',
    contact JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 3. CLIENTS — Carteira de clientes
-- ============================================
CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    cnpj VARCHAR(18) UNIQUE,
    regime regime_tributario DEFAULT 'simples',
    phone VARCHAR(20),
    email VARCHAR(255),
    status client_status DEFAULT 'active',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 4. CONVERSATIONS — Conversas com agentes
-- ============================================
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    client_id UUID REFERENCES clients(id),
    user_id UUID REFERENCES team_members(id),
    channel channel_type DEFAULT 'dashboard',
    status conversation_status DEFAULT 'active',
    title VARCHAR(255),
    started_at TIMESTAMP DEFAULT NOW(),
    closed_at TIMESTAMP
);

-- ============================================
-- 5. MESSAGES — Mensagens das conversas
-- ============================================
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role message_role NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 6. TASKS — Tarefas delegadas/executadas
-- ============================================
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    assigned_to UUID REFERENCES team_members(id),
    delegated_by UUID REFERENCES team_members(id),
    client_id UUID REFERENCES clients(id),
    parent_task_id UUID REFERENCES tasks(id),
    priority task_priority DEFAULT 'medium',
    status task_status DEFAULT 'pending',
    due_date TIMESTAMP,
    result JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- ============================================
-- ÍNDICES
-- ============================================
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_status ON tasks(status, priority);
CREATE INDEX idx_tasks_client ON tasks(client_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_conversations_agent ON conversations(agent_id, status);
CREATE INDEX idx_conversations_client ON conversations(client_id);
CREATE INDEX idx_clients_cnpj ON clients(cnpj);
CREATE INDEX idx_team_members_type ON team_members(type, status);

-- ============================================
-- TRIGGERS — updated_at automático
-- ============================================
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_agents_updated BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER tr_team_updated BEFORE UPDATE ON team_members FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER tr_clients_updated BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER tr_tasks_updated BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_timestamp();
