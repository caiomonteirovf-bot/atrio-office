-- Migration 010: Phase 2 tables (Cron Jobs, Token Usage)

-- Token usage / IA costs tracking
CREATE TABLE IF NOT EXISTS token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  conversation_id UUID REFERENCES conversations(id),
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  model VARCHAR(100),
  cost_usd DECIMAL(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(created_at);

-- Cron jobs registry
CREATE TABLE IF NOT EXISTS cron_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  schedule VARCHAR(50) NOT NULL,
  handler VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active',
  last_run TIMESTAMPTZ,
  next_run TIMESTAMPTZ,
  last_result VARCHAR(20),
  last_error TEXT,
  run_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cron run history
CREATE TABLE IF NOT EXISTS cron_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_job_id UUID REFERENCES cron_jobs(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  duration_ms INTEGER,
  output TEXT,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(cron_job_id, started_at DESC);

-- Seed default cron jobs based on existing schedulers
INSERT INTO cron_jobs (name, description, schedule, handler, status) VALUES
  ('Omie Sync', 'Sincronizar dados financeiros com Omie API', '0 */4 * * *', 'omie_sync', 'active'),
  ('Gesthub Sync', 'Sincronizar clientes e dados do Gesthub', '0 */6 * * *', 'gesthub_sync', 'active'),
  ('Relatório Diário', 'Gerar e enviar relatório diário da equipe', '0 18 * * 1-5', 'relatorio_diario', 'active'),
  ('Health Check', 'Verificar saúde de todos os serviços', '*/5 * * * *', 'health_check', 'active'),
  ('Backup Database', 'Backup automático do PostgreSQL', '0 3 * * *', 'backup_db', 'paused'),
  ('Limpeza Logs', 'Limpar logs e mensagens antigas (>90 dias)', '0 4 * * 0', 'limpeza_logs', 'active')
ON CONFLICT DO NOTHING;
