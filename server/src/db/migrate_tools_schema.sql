-- ============================================
-- MIGRAÇÃO: Adicionar input_schema a todas as tools
-- ============================================

-- RODRIGO — Diretor de Operações
UPDATE agents SET tools = '[
  {
    "name": "status_equipe",
    "description": "Consulta o status atual de todos os membros da equipe (IA e humanos)",
    "input_schema": {"type": "object", "properties": {}, "required": []}
  },
  {
    "name": "fila_prioridades",
    "description": "Lista as tarefas pendentes e em andamento, ordenadas por prioridade",
    "input_schema": {"type": "object", "properties": {}, "required": []}
  },
  {
    "name": "delegar_tarefa",
    "description": "Cria uma tarefa e delega para um membro da equipe",
    "input_schema": {
      "type": "object",
      "properties": {
        "titulo": {"type": "string", "description": "Título da tarefa a ser delegada"},
        "responsavel": {"type": "string", "description": "Nome do membro da equipe que vai executar (ex: Campelo, Sneijder, Luna, Sofia, Deyvison, Diego)"},
        "descricao": {"type": "string", "description": "Descrição detalhada da tarefa"},
        "prioridade": {"type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Nível de prioridade"},
        "prazo": {"type": "string", "description": "Data limite no formato YYYY-MM-DD"},
        "cliente_id": {"type": "string", "description": "UUID do cliente relacionado"}
      },
      "required": ["titulo", "responsavel"]
    }
  },
  {
    "name": "relatorio_diario",
    "description": "Gera o relatório de produtividade do dia atual com tarefas concluídas, pendentes e por membro",
    "input_schema": {"type": "object", "properties": {}, "required": []}
  },
  {
    "name": "escalar_para_caio",
    "description": "Registra uma escalação urgente para Caio (CEO) quando algo está bloqueado ou precisa de decisão",
    "input_schema": {
      "type": "object",
      "properties": {
        "motivo": {"type": "string", "description": "Motivo da escalação"},
        "contexto": {"type": "string", "description": "Detalhes adicionais sobre a situação"}
      },
      "required": ["motivo"]
    }
  },
  {
    "name": "rotear_demanda",
    "description": "Classifica uma demanda por tipo e encaminha para o agente ou humano mais adequado",
    "input_schema": {
      "type": "object",
      "properties": {
        "descricao": {"type": "string", "description": "Descrição da demanda a ser roteada"},
        "tipo": {"type": "string", "enum": ["fiscal", "financeiro", "atendimento", "societario"], "description": "Tipo/setor da demanda"},
        "prioridade": {"type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Prioridade da demanda"}
      },
      "required": ["descricao", "tipo"]
    }
  },
  {
    "name": "agenda_prazos",
    "description": "Lista tarefas com prazos próximos nos próximos dias",
    "input_schema": {
      "type": "object",
      "properties": {
        "dias": {"type": "integer", "description": "Número de dias à frente para verificar (padrão: 7)"}
      },
      "required": []
    }
  }
]'::jsonb
WHERE id = 'a0000001-0000-0000-0000-000000000001';

-- CAMPELO — Analista Fiscal
UPDATE agents SET tools = '[
  {
    "name": "consultar_cnpj",
    "description": "Consulta dados de um cliente pelo CNPJ na base do escritório",
    "input_schema": {
      "type": "object",
      "properties": {
        "cnpj": {"type": "string", "description": "CNPJ do cliente (com ou sem formatação)"}
      },
      "required": ["cnpj"]
    }
  },
  {
    "name": "calcular_fator_r",
    "description": "Calcula o Fator R (folha/receita) para determinar se empresa no Simples Nacional se enquadra no Anexo III ou V",
    "input_schema": {
      "type": "object",
      "properties": {
        "folha_12m": {"type": "number", "description": "Total da folha de pagamento dos últimos 12 meses em reais"},
        "receita_12m": {"type": "number", "description": "Receita bruta acumulada dos últimos 12 meses em reais"}
      },
      "required": ["folha_12m", "receita_12m"]
    }
  },
  {
    "name": "calcular_impostos",
    "description": "Calcula os impostos do período para o regime tributário do cliente",
    "input_schema": {
      "type": "object",
      "properties": {
        "regime": {"type": "string", "enum": ["simples", "presumido", "real"], "description": "Regime tributário"},
        "faturamento_mensal": {"type": "number", "description": "Faturamento do mês em reais"},
        "folha_mensal": {"type": "number", "description": "Folha de pagamento mensal em reais"},
        "atividade": {"type": "string", "description": "Tipo de atividade (serviço, comércio, indústria)"}
      },
      "required": ["regime", "faturamento_mensal"]
    }
  },
  {
    "name": "simular_regime",
    "description": "Simula e compara a carga tributária entre Simples Nacional, Lucro Presumido e Lucro Real",
    "input_schema": {
      "type": "object",
      "properties": {
        "faturamento_anual": {"type": "number", "description": "Faturamento anual estimado em reais"},
        "folha_anual": {"type": "number", "description": "Folha de pagamento anual em reais"},
        "atividade": {"type": "string", "description": "Tipo de atividade (serviço, comércio, indústria)"}
      },
      "required": ["faturamento_anual"]
    }
  },
  {
    "name": "alertas_prazos",
    "description": "Lista as obrigações acessórias com prazos próximos (DCTF, EFD, SPED, DIRF, DAS, etc.)",
    "input_schema": {
      "type": "object",
      "properties": {
        "mes": {"type": "integer", "description": "Mês de referência (1-12, padrão: mês atual)"}
      },
      "required": []
    }
  },
  {
    "name": "gerar_guia_das",
    "description": "Calcula o valor do DAS (Simples Nacional) com base no faturamento",
    "input_schema": {
      "type": "object",
      "properties": {
        "receita_bruta_12m": {"type": "number", "description": "Receita bruta acumulada dos últimos 12 meses"},
        "receita_bruta_mensal": {"type": "number", "description": "Receita bruta do mês de apuração"},
        "anexo": {"type": "string", "enum": ["I", "II", "III", "IV", "V"], "description": "Anexo do Simples Nacional"}
      },
      "required": ["receita_bruta_12m", "receita_bruta_mensal", "anexo"]
    }
  },
  {
    "name": "emitir_nfse",
    "description": "Emite nota fiscal de serviço eletrônica (integração futura com Nuvem Fiscal)",
    "input_schema": {
      "type": "object",
      "properties": {
        "cliente_cnpj": {"type": "string", "description": "CNPJ do tomador"},
        "valor": {"type": "number", "description": "Valor do serviço"},
        "descricao": {"type": "string", "description": "Descrição do serviço"}
      },
      "required": ["cliente_cnpj", "valor", "descricao"]
    }
  }
]'::jsonb
WHERE id = 'a0000001-0000-0000-0000-000000000002';

-- SNEIJDER — Analista Financeiro
UPDATE agents SET tools = '[
  {
    "name": "conciliar_extrato",
    "description": "Concilia extrato bancário com lançamentos contábeis (integração futura)",
    "input_schema": {"type": "object", "properties": {}, "required": []}
  },
  {
    "name": "fluxo_caixa",
    "description": "Gera relatório de fluxo de caixa com receitas e despesas previstas",
    "input_schema": {
      "type": "object",
      "properties": {
        "meses": {"type": "integer", "description": "Quantidade de meses para projeção (padrão: 3)"}
      },
      "required": []
    }
  },
  {
    "name": "contas_pagar",
    "description": "Lista contas a pagar pendentes e próximas do vencimento",
    "input_schema": {"type": "object", "properties": {}, "required": []}
  },
  {
    "name": "contas_receber",
    "description": "Lista contas a receber e identifica inadimplências",
    "input_schema": {"type": "object", "properties": {}, "required": []}
  },
  {
    "name": "alertas_cobranca",
    "description": "Identifica clientes com pagamentos atrasados e gera alertas de cobrança",
    "input_schema": {"type": "object", "properties": {}, "required": []}
  },
  {
    "name": "relatorio_dre",
    "description": "Gera demonstrativo de resultado do exercício simplificado",
    "input_schema": {
      "type": "object",
      "properties": {
        "periodo": {"type": "string", "description": "Período do relatório (ex: 2024-01, 2024-Q1, 2024)"}
      },
      "required": []
    }
  }
]'::jsonb
WHERE id = 'a0000001-0000-0000-0000-000000000003';

-- LUNA — Gestora de Atendimento
UPDATE agents SET tools = '[
  {
    "name": "onboarding_cliente",
    "description": "Gera checklist de onboarding para novo cliente com 6 fases",
    "input_schema": {
      "type": "object",
      "properties": {
        "nome_cliente": {"type": "string", "description": "Nome ou razão social do cliente"},
        "cnpj": {"type": "string", "description": "CNPJ do cliente"}
      },
      "required": ["nome_cliente"]
    }
  },
  {
    "name": "coletar_documento",
    "description": "Registra solicitação ou recebimento de documento de um cliente",
    "input_schema": {
      "type": "object",
      "properties": {
        "cliente": {"type": "string", "description": "Nome do cliente"},
        "documento": {"type": "string", "description": "Tipo do documento (ex: contrato social, comprovante de endereço)"},
        "status": {"type": "string", "enum": ["solicitado", "recebido"], "description": "Status do documento"}
      },
      "required": ["cliente", "documento"]
    }
  },
  {
    "name": "rotear_para_rodrigo",
    "description": "Encaminha uma demanda classificada para Rodrigo decidir o próximo passo",
    "input_schema": {
      "type": "object",
      "properties": {
        "descricao": {"type": "string", "description": "Descrição da demanda do cliente"},
        "tipo": {"type": "string", "enum": ["fiscal", "financeiro", "societario", "administrativo"], "description": "Classificação da demanda"},
        "prioridade": {"type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Urgência"},
        "cliente": {"type": "string", "description": "Nome do cliente"}
      },
      "required": ["descricao", "tipo"]
    }
  },
  {
    "name": "whatsapp_enviar",
    "description": "Envia mensagem via WhatsApp para o cliente (integração futura com Evolution API)",
    "input_schema": {
      "type": "object",
      "properties": {
        "telefone": {"type": "string", "description": "Número do WhatsApp"},
        "mensagem": {"type": "string", "description": "Texto da mensagem"}
      },
      "required": ["telefone", "mensagem"]
    }
  },
  {
    "name": "whatsapp_receber",
    "description": "Processa mensagem recebida do WhatsApp (integração futura)",
    "input_schema": {"type": "object", "properties": {}, "required": []}
  },
  {
    "name": "email_enviar",
    "description": "Envia email para o cliente (integração futura)",
    "input_schema": {
      "type": "object",
      "properties": {
        "destinatario": {"type": "string", "description": "Email do destinatário"},
        "assunto": {"type": "string", "description": "Assunto do email"},
        "corpo": {"type": "string", "description": "Corpo do email"}
      },
      "required": ["destinatario", "assunto", "corpo"]
    }
  }
]'::jsonb
WHERE id = 'a0000001-0000-0000-0000-000000000004';

-- SOFIA — Analista Societário
UPDATE agents SET tools = '[
  {
    "name": "checklist_abertura",
    "description": "Gera checklist completo para abertura de empresa com documentos e etapas necessárias",
    "input_schema": {
      "type": "object",
      "properties": {
        "tipo_empresa": {"type": "string", "enum": ["LTDA", "SLU", "MEI", "SS", "EIRELI"], "description": "Tipo de empresa a ser aberta"},
        "estado": {"type": "string", "description": "UF onde será aberta (ex: PE, SP)"},
        "atividade": {"type": "string", "description": "Atividade principal da empresa"}
      },
      "required": ["tipo_empresa"]
    }
  },
  {
    "name": "consultar_cnpj",
    "description": "Consulta dados de um CNPJ na base do escritório",
    "input_schema": {
      "type": "object",
      "properties": {
        "cnpj": {"type": "string", "description": "CNPJ a consultar"}
      },
      "required": ["cnpj"]
    }
  },
  {
    "name": "simular_estrutura",
    "description": "Simula e compara estruturas societárias possíveis com prós e contras de cada uma",
    "input_schema": {
      "type": "object",
      "properties": {
        "num_socios": {"type": "integer", "description": "Número de sócios"},
        "capital_social": {"type": "number", "description": "Capital social previsto"},
        "atividade": {"type": "string", "description": "Atividade principal"},
        "faturamento_previsto": {"type": "number", "description": "Faturamento anual previsto"}
      },
      "required": ["num_socios", "atividade"]
    }
  },
  {
    "name": "gerar_contrato",
    "description": "Gera modelo de contrato social com cláusulas padrão",
    "input_schema": {
      "type": "object",
      "properties": {
        "tipo_empresa": {"type": "string", "description": "Tipo societário (LTDA, SLU, etc.)"},
        "socios": {"type": "string", "description": "Nomes dos sócios separados por vírgula"},
        "capital_social": {"type": "number", "description": "Capital social em reais"},
        "atividade": {"type": "string", "description": "Objeto social / atividade"}
      },
      "required": ["tipo_empresa", "socios", "capital_social"]
    }
  },
  {
    "name": "alteracao_contratual",
    "description": "Gera modelo de alteração contratual",
    "input_schema": {
      "type": "object",
      "properties": {
        "tipo_alteracao": {"type": "string", "description": "Tipo da alteração (endereço, atividade, sócios, capital, nome)"},
        "detalhes": {"type": "string", "description": "Detalhes da alteração"}
      },
      "required": ["tipo_alteracao", "detalhes"]
    }
  },
  {
    "name": "consultar_jucep",
    "description": "Consulta processos na Junta Comercial (integração futura)",
    "input_schema": {
      "type": "object",
      "properties": {
        "cnpj": {"type": "string", "description": "CNPJ para consulta"},
        "protocolo": {"type": "string", "description": "Número do protocolo"}
      },
      "required": []
    }
  }
]'::jsonb
WHERE id = 'a0000001-0000-0000-0000-000000000005';
