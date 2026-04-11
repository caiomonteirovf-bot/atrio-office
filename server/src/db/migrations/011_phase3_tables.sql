-- Migration 011: Phase 3 — Agent Memory + Calendar Events

-- Agent memory/context storage
CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  category VARCHAR(50) DEFAULT 'general',
  title VARCHAR(200),
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  pinned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id, category);

-- Calendar events (prazos fiscais, reuniões, tasks agendadas)
CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL DEFAULT 'task',
  category VARCHAR(50),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  all_day BOOLEAN DEFAULT FALSE,
  color VARCHAR(20),
  agent_id UUID REFERENCES agents(id),
  task_id UUID REFERENCES tasks(id),
  client_id UUID REFERENCES clients(id),
  recurrence VARCHAR(50),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_time ON calendar_events(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_calendar_events_type ON calendar_events(type);

-- Seed some fiscal deadlines for 2026
INSERT INTO calendar_events (title, description, type, category, start_time, all_day, color) VALUES
  ('DAS - Simples Nacional', 'Vencimento guia DAS competência anterior', 'prazo_fiscal', 'fiscal', '2026-04-20T23:59:00Z', true, '#378ADD'),
  ('DARF - IRPJ/CSLL', 'Vencimento DARF trimestral', 'prazo_fiscal', 'fiscal', '2026-04-30T23:59:00Z', true, '#378ADD'),
  ('GFIP/SEFIP', 'Entrega GFIP competência anterior', 'prazo_fiscal', 'pessoal', '2026-04-07T23:59:00Z', true, '#D946A8'),
  ('IRPF - Prazo Final', 'Último dia para transmissão IRPF 2026', 'prazo_fiscal', 'fiscal', '2026-05-31T23:59:00Z', true, '#f87171'),
  ('EFD-Contribuições', 'Entrega EFD PIS/COFINS', 'prazo_fiscal', 'fiscal', '2026-04-15T23:59:00Z', true, '#378ADD'),
  ('eSocial - Folha', 'Fechamento folha eSocial', 'prazo_fiscal', 'pessoal', '2026-04-15T23:59:00Z', true, '#D946A8'),
  ('DEFIS', 'Declaração de Informações Socioeconômicas', 'prazo_fiscal', 'fiscal', '2026-03-31T23:59:00Z', true, '#378ADD'),
  ('DIRF', 'Declaração IR Retido na Fonte', 'prazo_fiscal', 'fiscal', '2026-02-28T23:59:00Z', true, '#378ADD')
ON CONFLICT DO NOTHING;
