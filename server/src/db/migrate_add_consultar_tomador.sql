-- Add consultar_tomador tool to Campelo
-- Searches tomadores in NFS-e System (not Gesthub)

UPDATE agents SET tools = tools || '[{
  "name": "consultar_tomador",
  "description": "Busca tomador (quem recebe a nota fiscal) no sistema NFS-e por CPF/CNPJ ou nome. Use para verificar se o tomador já está cadastrado antes de emitir uma NFS-e.",
  "input_schema": {
    "type": "object",
    "properties": {
      "cpf_cnpj": { "type": "string", "description": "CPF ou CNPJ do tomador (busca exata)" },
      "nome": { "type": "string", "description": "Nome ou razão social do tomador (busca parcial)" }
    }
  }
}]'::jsonb
WHERE name = 'Campelo'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(tools) AS t WHERE t->>'name' = 'consultar_tomador'
  );

-- Verify
SELECT name, jsonb_array_length(tools) as tool_count,
  (SELECT string_agg(t->>'name', ', ') FROM jsonb_array_elements(tools) t) as tool_names
FROM agents WHERE name = 'Campelo';
