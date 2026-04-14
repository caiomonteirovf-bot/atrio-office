/**
 * Webhook Handler - WhatsApp → OpenClaw
 * Intercepta mensagens do WhatsApp e delega ao OpenClaw
 * 
 * Arquivo: server/src/services/whatsapp/webhook-handler.mjs
 * Format: ES Modules
 */

// axios removed - using native fetch

const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://localhost:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';

/**
 * Handler principal - chamado pelo whatsapp.js quando recebe mensagem
 */
async function handleWhatsAppMessage(message, clientInfo, conversationInfo) {
  // 1. Formatar payload para OpenClaw
  const payload = formatMessage(message, clientInfo, conversationInfo);
  
  try {
    // 2. Enviar para Luna (OpenClaw)
    const result = await sendToOpenClaw(payload);
    
    // 3. Processar resposta da Luna com validação obrigatória
    return await processLunaResponseComValidacao(result, payload, conversationInfo);
    
  } catch (error) {
    console.error('[Webhook] Erro:', error.message);
    return {
      action: 'error',
      message: 'Desculpe, tive um problema. Transferindo para atendente.',
      fallback: true
    };
  }
}

/**
 * Envia mensagem para OpenClaw
 */
async function sendToOpenClaw(payload) {
  const data = {
    sessionKey: `luna:${payload.conversation_id}`,
    agentId: 'luna-orchestrator',
    task: `Processar mensagem de ${payload.cliente.name}`,
    attachments: [{
      name: 'whatsapp.json',
      content: JSON.stringify(payload),
      mimeType: 'application/json'
    }],
    timeoutSeconds: 60
  };

  const response = await fetch(
    `${OPENCLAW_GATEWAY}/api/sessions/spawn`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OPENCLAW_TOKEN && { 'Authorization': `Bearer ${OPENCLAW_TOKEN}` })
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(65000)
    }
  );

  const resData = await response.json();
  return resData;
}

const CAMPOS_OBRIGATORIOS = {
  nfse_emitir: ['cnpj_tomador', 'valor', 'descricao'],
  default: []
};

function validarDados(taskType, payload = {}) {
  const campos = CAMPOS_OBRIGATORIOS[taskType] || CAMPOS_OBRIGATORIOS.default;
  const faltando = campos.filter((campo) => {
    const valor = payload[campo];
    return valor === undefined || valor === null || valor === '';
  });

  if (faltando.length === 0) {
    return { valido: true, faltando: [] };
  }

  const labels = {
    cnpj_tomador: 'CPF ou CNPJ do tomador',
    valor: 'valor do serviço',
    descricao: 'descrição do serviço prestado'
  };

  const camposTexto = faltando.map((c) => labels[c] || c);
  const mensagem = faltando.length === 1
    ? `Certo. Falta só ${camposTexto[0]}. Pode me enviar?`
    : `Recebi parte das informações. Para continuar, preciso de: ${camposTexto.join(', ')}.`;

  return { valido: false, faltando, mensagem };
}

async function processLunaResponseComValidacao(result, originalPayload, conversationInfo = {}) {
  // Nova skill retorna JSON estruturado com campo 'tool'
  const toolResult = result?.tool || result?.response?.tool;
  const toolPayload = result?.payload || result?.response?.payload || {};
  const toolMessage = result?.mensagem || result?.response?.mensagem;
  const camposFaltando = result?.campos_faltando || result?.response?.campos_faltando;
  
  // Se for tool estruturado, processar de forma diferente
  if (toolResult) {
    // Tool pedir_info = coletando dados
    if (toolResult === 'pedir_info') {
      conversationInfo.coleta_parcial = toolPayload || {};
      conversationInfo.coleta_faltando = camposFaltando || [];
      conversationInfo.intent_pendente = 'nfse_emitir';
      
      return {
        action: 'send_message',
        content: toolMessage || 'Preciso de mais informações para prosseguir.',
        delay: 500
      };
    }
    
    // Tool nfse_emitir = validar e delegar
    if (toolResult === 'nfse_emitir') {
      const validacao = validarDados('nfse_emitir', toolPayload);
      
      if (!validacao.valido) {
        conversationInfo.coleta_parcial = toolPayload || {};
        conversationInfo.coleta_faltando = validacao.faltando;
        conversationInfo.intent_pendente = 'nfse_emitir';
        
        return {
          action: 'send_message',
          content: validacao.mensagem,
          delay: 500
        };
      }
      
      // Todos os dados válidos, delegar
      return {
        action: 'delegate',
        agent_target: 'campelo',
        task_type: 'nfse_emitir',
        payload: toolPayload,
        ack: 'Perfeito! Estou passando para o Campelo emitir a nota fiscal. Assim que sair ele manda aqui.'
      };
    }
    
    // Tool chat = resposta simples
    if (toolResult === 'chat') {
      return {
        action: 'send_message',
        content: toolMessage || 'Entendido. Como posso ajudar?',
        delay: 500
      };
    }
    
    // Tool escalation = transferir
    if (toolResult === 'escalation') {
      return {
        action: 'escalate',
        content: toolMessage || 'Transferindo para atendente...',
        reason: result?.motivo || 'solicitacao_cliente'
      };
    }
  }
  
  // Fallback para formato antigo (type/task_type)
  const type = result?.type || result?.response?.type || 'message';
  const taskType = result?.task_type || result?.response?.task_type;
  const payload = result?.payload || result?.response?.payload || {};

  if (type === 'delegate' && taskType === 'nfse_emitir') {
    const validacao = validarDados(taskType, payload);

    if (!validacao.valido) {
      conversationInfo.coleta_parcial = payload;
      conversationInfo.coleta_faltando = validacao.faltando;
      conversationInfo.intent_pendente = taskType;

      return {
        action: 'send_message',
        content: validacao.mensagem,
        delay: 500
      };
    }
  }

  return processLunaResponse(result, originalPayload);
}

/**
 * Processa resposta da Luna
 */
async function processLunaResponse(result, originalPayload) {
  const type = result?.type || result?.response?.type || 'message';
  
  switch (type) {
    case 'message':
      // Luna respondeu direto
      return {
        action: 'send_message',
        content: result.message || result.response?.message,
        delay: result.delay || 1000
      };
    
    case 'delegate':
      // Delegar para especialista
      return {
        action: 'delegate',
        ack: result.acknowledgment || 'Entendido. Vou verificar isso.',
        agent: result.agent_target,
        task: result.task_type,
        payload: result.payload
      };
    
    case 'nfs_coleta':
      // Coletar dados antes de delegar
      return {
        action: 'coletar_dados',
        campos: result.campos,
        pergunta: result.pergunta,
        stage: 'nfs_coleta'
      };
    
    case 'escalation':
      // Transferir para humano
      return {
        action: 'escalate',
        content: result.message || 'Transferindo para atendente...',
        reason: result.reason
      };
    
    default:
      return {
        action: 'send_message',
        content: 'Entendido. Estou processando sua solicitação.',
        delay: 2000
      };
  }
}

/**
 * Formata mensagem do WhatsApp
 */
function formatMessage(msg, client, conversation) {
  return {
    message_id: msg.id?.id || `msg_${Date.now()}`,
    conversation_id: conversation.id,
    phone: msg.from?.replace('@c.us', '') || '',
    cliente: {
      id: client.id,
      nome: client.name || 'Cliente',
      empresa: client.trade_name,
      plano: client.plano || null
    },
    mensagem: {
      tipo: msg.type || 'chat',
      conteudo: msg.body || '',
      timestamp: msg.timestamp || Date.now()/1000,
      has_media: msg.hasMedia || false
    },
    contexto: {
      fora_horario: isOutsideBusinessHours(),
      primeira_msg: conversation.mensagens_count === 0,
      classificacao_anterior: conversation.classificacao,
      agente_atual: conversation.agente_atual
    }
  };
}

function isOutsideBusinessHours() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  return (day === 0 || day === 6 || hour < 8 || hour >= 18);
}

// Exportações
export { handleWhatsAppMessage, sendToOpenClaw };
export default { handleWhatsAppMessage };
