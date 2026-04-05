-- ============================================
-- MIGRATE: Adicionar tools consultar_cliente e listar_clientes
-- aos agentes Campelo, Sneijder e Luna
-- ============================================

-- CAMPELO — Adiciona consultar_cliente e listar_clientes
UPDATE agents SET tools = tools || '[
    {
        "name": "consultar_cliente",
        "description": "Busca cliente na base do Gesthub por nome, CNPJ ou telefone. Retorna regime tributário, honorário, Fator R, endereço e dados completos.",
        "input_schema": {
            "type": "object",
            "properties": {
                "busca": { "type": "string", "description": "Nome, CNPJ ou telefone do cliente para buscar" }
            },
            "required": ["busca"]
        }
    },
    {
        "name": "listar_clientes",
        "description": "Lista todos os clientes ativos do escritório com regime, honorário e cidade (resumo).",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    }
]'::jsonb WHERE name = 'Campelo';

-- SNEIJDER — Adiciona consultar_cliente e listar_clientes
UPDATE agents SET tools = tools || '[
    {
        "name": "consultar_cliente",
        "description": "Busca cliente na base do Gesthub por nome, CNPJ ou telefone. Retorna regime tributário, honorário, dados financeiros e contato.",
        "input_schema": {
            "type": "object",
            "properties": {
                "busca": { "type": "string", "description": "Nome, CNPJ ou telefone do cliente para buscar" }
            },
            "required": ["busca"]
        }
    },
    {
        "name": "listar_clientes",
        "description": "Lista todos os clientes ativos do escritório com regime, honorário e cidade (resumo).",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    }
]'::jsonb WHERE name = 'Sneijder';

-- LUNA — Adiciona consultar_cliente
UPDATE agents SET tools = tools || '[
    {
        "name": "consultar_cliente",
        "description": "Busca cliente na base do Gesthub por nome, CNPJ ou telefone. Retorna dados cadastrais, contato e status.",
        "input_schema": {
            "type": "object",
            "properties": {
                "busca": { "type": "string", "description": "Nome, CNPJ ou telefone do cliente para buscar" }
            },
            "required": ["busca"]
        }
    }
]'::jsonb WHERE name = 'Luna';
