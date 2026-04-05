-- ============================================
-- FIX: Remove duplicate tools from agents
-- Campelo, Sneijder, Luna had consultar_cliente/listar_clientes appended twice
-- This script rebuilds tools arrays without duplicates
-- ============================================

-- Helper: For each agent, rebuild tools keeping only unique names (first occurrence wins)
UPDATE agents SET tools = (
  SELECT jsonb_agg(tool)
  FROM (
    SELECT DISTINCT ON (tool->>'name') tool
    FROM jsonb_array_elements(tools) AS tool
    ORDER BY tool->>'name', ctid
  ) unique_tools
)
WHERE name IN ('Campelo', 'Sneijder', 'Luna')
  AND tools IS NOT NULL
  AND jsonb_array_length(tools) > 0;

-- Verify: Show tool counts after fix
SELECT name, jsonb_array_length(tools) as tool_count,
  (SELECT string_agg(t->>'name', ', ') FROM jsonb_array_elements(tools) t) as tool_names
FROM agents
WHERE name IN ('Campelo', 'Sneijder', 'Luna', 'Rodrigo');
