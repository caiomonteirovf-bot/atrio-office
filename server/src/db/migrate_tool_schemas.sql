-- ============================================
-- MIGRAÇÃO: Adicionar input_schema às tools dos agentes
-- Para que o Minimax (OpenAI-compatible) saiba quais
-- parâmetros invocar em cada tool call.
-- ============================================
-- Executar: psql -U atrio -d atrio_office -f migrate_tool_schemas.sql
-- ============================================

-- RODRIGO — Diretor de Operações
UPDATE agents SET tools = '[
    {
        "name": "delegar_tarefa",
        "description": "Cria uma task e delega para um membro da equipe",
        "input_schema": {
            "type": "object",
            "properties": {
                "titulo": { "type": "string", "description": "Título da tarefa a ser delegada" },
                "responsavel": { "type": "string", "description": "Nome ou UUID do membro da equipe responsável" },
                "descricao": { "type": "string", "description": "Descrição detalhada da tarefa" },
                "prioridade": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Nível de prioridade (default: medium)" },
                "prazo": { "type": "string", "description": "Data limite no formato YYYY-MM-DD" },
                "cliente_id": { "type": "string", "description": "UUID do cliente relacionado (opcional)" }
            },
            "required": ["titulo", "responsavel"]
        }
    },
    {
        "name": "status_equipe",
        "description": "Consulta status de todos os membros da equipe",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "fila_prioridades",
        "description": "Lista tasks pendentes ordenadas por prioridade",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "relatorio_diario",
        "description": "Gera relatório de produtividade do dia",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "escalar_para_caio",
        "description": "Envia notificação urgente para Caio",
        "input_schema": {
            "type": "object",
            "properties": {
                "motivo": { "type": "string", "description": "Motivo da escalação urgente" },
                "contexto": { "type": "string", "description": "Contexto adicional sobre a situação" }
            },
            "required": ["motivo"]
        }
    },
    {
        "name": "rotear_demanda",
        "description": "Classifica e encaminha uma demanda para o agente/humano certo",
        "input_schema": {
            "type": "object",
            "properties": {
                "descricao": { "type": "string", "description": "Descrição da demanda a ser roteada" },
                "tipo": { "type": "string", "enum": ["fiscal", "financeiro", "atendimento", "societario"], "description": "Tipo da demanda para roteamento" },
                "prioridade": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Nível de prioridade (default: medium)" }
            },
            "required": ["descricao"]
        }
    },
    {
        "name": "agenda_prazos",
        "description": "Consulta prazos de obrigações e deadlines",
        "input_schema": {
            "type": "object",
            "properties": {
                "dias": { "type": "number", "description": "Quantidade de dias à frente para consultar (default: 7)" }
            },
            "required": []
        }
    }
]'::jsonb
WHERE name = 'Rodrigo';

-- CAMPELO — Analista Fiscal
UPDATE agents SET tools = '[
    {
        "name": "emitir_nfse",
        "description": "Emite nota fiscal de serviço eletrônica via API Nuvem Fiscal",
        "input_schema": {
            "type": "object",
            "properties": {
                "prestador_cnpj": { "type": "string", "description": "CNPJ do prestador do serviço" },
                "tomador_cpf_cnpj": { "type": "string", "description": "CPF ou CNPJ do tomador do serviço" },
                "tomador_nome": { "type": "string", "description": "Razão social ou nome do tomador" },
                "valor": { "type": "number", "description": "Valor do serviço em reais" },
                "descricao": { "type": "string", "description": "Descrição do serviço prestado" },
                "codigo_servico": { "type": "string", "description": "Código do serviço municipal (default: 0107)" },
                "aliquota_iss": { "type": "number", "description": "Alíquota do ISS em percentual (default: 5.0)" },
                "task_id": { "type": "string", "description": "ID da task relacionada (opcional)" }
            },
            "required": ["prestador_cnpj", "tomador_cpf_cnpj", "valor", "descricao"]
        }
    },
    {
        "name": "calcular_impostos",
        "description": "Calcula impostos do período para o regime do cliente",
        "input_schema": {
            "type": "object",
            "properties": {
                "regime": { "type": "string", "enum": ["simples", "presumido", "real"], "description": "Regime tributário da empresa" },
                "faturamento_mensal": { "type": "number", "description": "Faturamento bruto mensal em reais" },
                "folha_mensal": { "type": "number", "description": "Valor da folha de pagamento mensal em reais" },
                "atividade": { "type": "string", "description": "Tipo de atividade: comercio ou servico" }
            },
            "required": ["regime", "faturamento_mensal"]
        }
    },
    {
        "name": "calcular_fator_r",
        "description": "Calcula Fator R com folha e receita dos últimos 12 meses",
        "input_schema": {
            "type": "object",
            "properties": {
                "folha_12m": { "type": "number", "description": "Total da folha de pagamento dos últimos 12 meses em reais" },
                "receita_12m": { "type": "number", "description": "Receita bruta total dos últimos 12 meses em reais" }
            },
            "required": ["folha_12m", "receita_12m"]
        }
    },
    {
        "name": "gerar_guia_das",
        "description": "Gera guia DAS do Simples Nacional",
        "input_schema": {
            "type": "object",
            "properties": {
                "receita_bruta_12m": { "type": "number", "description": "Receita bruta acumulada dos últimos 12 meses em reais" },
                "receita_bruta_mensal": { "type": "number", "description": "Receita bruta do mês de apuração em reais" },
                "anexo": { "type": "string", "enum": ["I", "III", "V"], "description": "Anexo do Simples Nacional (I=Comércio, III=Serviços Fator R>=28%, V=Serviços Fator R<28%)" }
            },
            "required": ["receita_bruta_12m", "receita_bruta_mensal", "anexo"]
        }
    },
    {
        "name": "simular_regime",
        "description": "Simula carga tributária comparando Simples x Presumido x Real",
        "input_schema": {
            "type": "object",
            "properties": {
                "faturamento_anual": { "type": "number", "description": "Faturamento bruto anual estimado em reais" },
                "folha_anual": { "type": "number", "description": "Total anual da folha de pagamento em reais" },
                "atividade": { "type": "string", "description": "Tipo de atividade: comercio ou servico" }
            },
            "required": ["faturamento_anual"]
        }
    },
    {
        "name": "alertas_prazos",
        "description": "Lista obrigações acessórias com prazos próximos",
        "input_schema": {
            "type": "object",
            "properties": {
                "mes": { "type": "number", "description": "Mês de referência (1-12). Se não informado, usa o mês atual" }
            },
            "required": []
        }
    },
    {
        "name": "consultar_cnpj",
        "description": "Consulta situação cadastral de CNPJ na Receita Federal e base interna",
        "input_schema": {
            "type": "object",
            "properties": {
                "cnpj": { "type": "string", "description": "Número do CNPJ (com ou sem formatação)" }
            },
            "required": ["cnpj"]
        }
    }
]'::jsonb
WHERE name = 'Campelo';

-- SNEIJDER — Analista Financeiro
UPDATE agents SET tools = '[
    {
        "name": "conciliar_extrato",
        "description": "Concilia extrato bancário com lançamentos contábeis",
        "input_schema": {
            "type": "object",
            "properties": {
                "conta_corrente_id": { "type": "number", "description": "ID da conta corrente no Omie. Se não informado, lista contas disponíveis" }
            },
            "required": []
        }
    },
    {
        "name": "fluxo_caixa",
        "description": "Gera relatório de fluxo de caixa com projeções",
        "input_schema": {
            "type": "object",
            "properties": {
                "meses": { "type": "number", "description": "Quantidade de meses para projeção (default: 3)" }
            },
            "required": []
        }
    },
    {
        "name": "contas_pagar",
        "description": "Lista e gerencia contas a pagar com alertas de vencimento",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "contas_receber",
        "description": "Lista e gerencia contas a receber com alertas de inadimplência",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "alertas_cobranca",
        "description": "Identifica clientes inadimplentes e gera alertas de cobrança",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "relatorio_dre",
        "description": "Gera DRE (Demonstração do Resultado do Exercício) do período",
        "input_schema": {
            "type": "object",
            "properties": {
                "periodo": { "type": "string", "description": "Período do relatório (ex: 2026-01, 2026-Q1, etc.)" }
            },
            "required": []
        }
    }
]'::jsonb
WHERE name = 'Sneijder';

-- LUNA — Gestora de Atendimento
UPDATE agents SET tools = '[
    {
        "name": "whatsapp_enviar",
        "description": "Envia mensagem via WhatsApp para o cliente",
        "input_schema": {
            "type": "object",
            "properties": {
                "telefone": { "type": "string", "description": "Número de telefone do destinatário (com DDD, ex: 5581999999999)" },
                "mensagem": { "type": "string", "description": "Texto da mensagem a ser enviada" }
            },
            "required": ["telefone", "mensagem"]
        }
    },
    {
        "name": "whatsapp_receber",
        "description": "Processa mensagem recebida do WhatsApp",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "email_enviar",
        "description": "Envia email ao cliente (em desenvolvimento)",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "coletar_documento",
        "description": "Solicita e registra recebimento de documento do cliente",
        "input_schema": {
            "type": "object",
            "properties": {
                "cliente": { "type": "string", "description": "Nome ou identificação do cliente" },
                "documento": { "type": "string", "description": "Tipo/nome do documento (ex: Contrato Social, Extrato Bancário)" },
                "status": { "type": "string", "enum": ["solicitado", "recebido", "pendente"], "description": "Status do documento (default: solicitado)" }
            },
            "required": ["cliente", "documento"]
        }
    },
    {
        "name": "onboarding_cliente",
        "description": "Inicia processo de onboarding com checklist completo",
        "input_schema": {
            "type": "object",
            "properties": {
                "nome_cliente": { "type": "string", "description": "Nome ou razão social do cliente" },
                "cnpj": { "type": "string", "description": "CNPJ do cliente (opcional, para buscar dados no Gesthub)" }
            },
            "required": ["nome_cliente"]
        }
    },
    {
        "name": "rotear_para_rodrigo",
        "description": "Encaminha demanda classificada para Rodrigo decidir o roteamento",
        "input_schema": {
            "type": "object",
            "properties": {
                "descricao": { "type": "string", "description": "Descrição da demanda do cliente" },
                "tipo": { "type": "string", "enum": ["fiscal", "financeiro", "societario", "atendimento", "administrativo"], "description": "Classificação da demanda" },
                "prioridade": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Nível de prioridade (default: medium)" },
                "cliente": { "type": "string", "description": "Nome do cliente que originou a demanda" }
            },
            "required": ["descricao", "tipo"]
        }
    }
]'::jsonb
WHERE name = 'Luna';

-- SOFIA — Analista Societário
UPDATE agents SET tools = '[
    {
        "name": "gerar_contrato",
        "description": "Gera modelo de contrato social com cláusulas padrão",
        "input_schema": {
            "type": "object",
            "properties": {
                "tipo_empresa": { "type": "string", "enum": ["MEI", "SLU", "LTDA", "SS"], "description": "Tipo jurídico da empresa" },
                "socios": { "type": "string", "description": "Nomes dos sócios separados por vírgula" },
                "capital_social": { "type": "number", "description": "Valor do capital social em reais" },
                "atividade": { "type": "string", "description": "Descrição da atividade/objeto social" }
            },
            "required": ["tipo_empresa", "socios", "capital_social"]
        }
    },
    {
        "name": "alteracao_contratual",
        "description": "Redige modelo de alteração contratual",
        "input_schema": {
            "type": "object",
            "properties": {
                "tipo_alteracao": { "type": "string", "enum": ["endereco", "atividade", "socios", "capital", "nome"], "description": "Tipo da alteração contratual" },
                "detalhes": { "type": "string", "description": "Detalhes da alteração a ser realizada" }
            },
            "required": ["tipo_alteracao", "detalhes"]
        }
    },
    {
        "name": "consultar_jucep",
        "description": "Consulta processos na Junta Comercial de Pernambuco (em desenvolvimento)",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "consultar_cnpj",
        "description": "Consulta situação cadastral de CNPJ na Receita Federal e base interna",
        "input_schema": {
            "type": "object",
            "properties": {
                "cnpj": { "type": "string", "description": "Número do CNPJ (com ou sem formatação)" }
            },
            "required": ["cnpj"]
        }
    },
    {
        "name": "simular_estrutura",
        "description": "Simula estruturas societárias e suas implicações tributárias e patrimoniais",
        "input_schema": {
            "type": "object",
            "properties": {
                "num_socios": { "type": "number", "description": "Quantidade de sócios" },
                "capital_social": { "type": "number", "description": "Valor do capital social em reais" },
                "atividade": { "type": "string", "description": "Descrição da atividade da empresa" },
                "faturamento_previsto": { "type": "number", "description": "Faturamento anual previsto em reais" }
            },
            "required": ["num_socios", "atividade"]
        }
    },
    {
        "name": "checklist_abertura",
        "description": "Gera checklist completo para abertura de empresa",
        "input_schema": {
            "type": "object",
            "properties": {
                "tipo_empresa": { "type": "string", "enum": ["MEI", "SLU", "LTDA", "SS"], "description": "Tipo jurídico da empresa" },
                "estado": { "type": "string", "description": "UF do estado (default: PE)" },
                "atividade": { "type": "string", "description": "Descrição da atividade principal" }
            },
            "required": ["tipo_empresa"]
        }
    }
]'::jsonb
WHERE name = 'Sofia';

-- VALÊNCIA — Gestor Comercial (tools ainda sem implementação, manter schema vazio)
UPDATE agents SET tools = '[
    {
        "name": "funil_vendas",
        "description": "Lista e gerencia pipeline de leads com estágios (lead, qualificação, proposta, negociação, contrato, fechamento)",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "gerar_proposta",
        "description": "Cria proposta comercial personalizada baseada em regime, porte e serviços do cliente",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "gerar_contrato_servico",
        "description": "Elabora contrato de prestação de serviços contábeis com escopo, honorário, SLA e cláusulas",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "analise_churn",
        "description": "Identifica clientes em risco de sair cruzando NPS, inadimplência e interação",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "relatorio_comercial",
        "description": "Gera KPIs comerciais: taxa de conversão, ticket médio, CAC, LTV, receita recorrente",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "oportunidade_upsell",
        "description": "Detecta clientes que se beneficiariam de serviços adicionais ou migração de regime",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "consultar_vendas_gesthub",
        "description": "Consulta vendas, leads e status comercial no Gesthub",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    }
]'::jsonb
WHERE name = 'Valência';

-- MAIA — Estrategista de Marketing (tools ainda sem implementação, manter schema vazio)
UPDATE agents SET tools = '[
    {
        "name": "campanha_whatsapp",
        "description": "Planeja e agenda campanha de mensagens via Luna para segmentos específicos de clientes",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "gerar_conteudo",
        "description": "Cria conteúdo educativo sobre tributação, obrigações, dicas fiscais e mudanças legislativas",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "segmentar_clientes",
        "description": "Segmenta base de clientes por regime, porte, setor, NPS e comportamento para ações direcionadas",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "calendario_marketing",
        "description": "Gerencia calendário de ações de marketing alinhado com datas fiscais e eventos do setor",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "programa_indicacao",
        "description": "Gerencia programa de referral identificando promotores (NPS >= 9) e criando incentivos",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "nutrir_lead",
        "description": "Cria sequência de nutrição para leads em diferentes estágios (frio, morno, quente)",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "relatorio_marketing",
        "description": "Gera métricas de marketing: engajamento, leads gerados, CAC, conversão de campanhas",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    }
]'::jsonb
WHERE name = 'Maia';

-- DARA — Secretária Executiva (tools ainda sem implementação, manter schema vazio)
UPDATE agents SET tools = '[
    {
        "name": "pesquisar_web",
        "description": "Busca conteúdos, artigos, legislação e notícias na internet",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "resumir_conteudo",
        "description": "Resume textos longos em pontos-chave objetivos",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "gerenciar_agenda",
        "description": "Cria, consulta e gerencia compromissos do Caio",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "lembrete",
        "description": "Cria lembretes pessoais e profissionais com data e hora",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "briefing_reuniao",
        "description": "Prepara briefing com contexto e dados relevantes para reuniões",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    },
    {
        "name": "filtrar_demandas",
        "description": "Avalia e prioriza demandas que chegam ao Caio dos outros agentes",
        "input_schema": { "type": "object", "properties": {}, "required": [] }
    }
]'::jsonb
WHERE name = 'Dara';
