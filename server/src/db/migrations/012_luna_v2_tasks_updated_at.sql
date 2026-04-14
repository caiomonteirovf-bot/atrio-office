-- Adiciona coluna updated_at em luna_v2.tasks
-- Motivo: trigger tasks_updated_at referencia NEW.updated_at mas a coluna nao existia,
-- causando erro 500 no endpoint POST /api/luna/tasks. Aplicado em 2026-04-14.

ALTER TABLE luna_v2.tasks
  ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP;
