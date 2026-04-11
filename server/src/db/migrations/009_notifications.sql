-- Migration 009: Notifications table (Blueprint v2 - Fase 1)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  severity VARCHAR(20) DEFAULT 'info',
  read BOOLEAN DEFAULT FALSE,
  agent_id UUID REFERENCES agents(id),
  task_id UUID REFERENCES tasks(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
