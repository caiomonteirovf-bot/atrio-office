/**
 * Webhook Handler - WhatsApp → OpenClaw
 * Intercepta mensagens do WhatsApp e delega ao OpenClaw
 * 
 * Arquivo: server/src/services/whatsapp/webhook-handler.mjs
 * Format: ES Modules
 */

// axios removed - using native fetch
import { buildContext, persistTurn, extractFactsAsync } from '../luna-memory.js';
import { detectConfidentialityLeak, pickSafeReplacement, logLeakAttempt } from '../confidentiality-vetter.js';
import { query as _vetterQuery } from '../../db/pool.js';
import { contextoTemporal, isHorarioComercial } from '../business-hours.js';
import { runWithContext } from '../luna-observer.js';
import { chatWithAgent, extractText } from '../claude.js';
import { makeLunaExecutor } from '../luna-tools.js';
import { query } from '../../db/pool.js';

const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://localhost:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';

/**
 * Handler principal - chamado pelo whatsapp.js quando recebe mensagem
 */
function stripCtx(t){ const i = t.indexOf('---FIM CONTEXTO---'); return i>=0 ? t.slice(i+'---FIM CONTEXTO---'.length).replace(/^\s+/, '') : t; }
async function handleWhatsAppMessage(message, clientInfo, conversationInfo) {
  // 0.0. GUARD COLABORADOR: se o remetente é da equipe Átrio (Gesthub /colaboradores),
  //       tratamos como COMUNICAÇÃO INTERNA. Luna não responde, não alerta, não escala.
  //       Só registra no chat da equipe com tag [INTERNO].
  try {
    const phoneIn = String(message?.from || message?.author || '').replace(/\D/g, '');
    if (phoneIn) {
      const { detectTeamMember } = await import('../team-member-guard.js');
      const member = await detectTeamMember(phoneIn);
      if (member) {
        const rawText = String(message?.body || message?.content || '').trim().slice(0, 400);
        console.log(`[TeamGuard] INTERNO: ${member.nome} (${member.areas?.join('/') || '—'}) — msg: ${rawText.slice(0, 80)}`);
        // Registra no chat interno pra visibilidade, sem responder nem escalar
        try {
          const { logAgentChat } = await import('../agent-chat-logger.js').catch(() => ({}));
          if (typeof logAgentChat === 'function') {
            logAgentChat({
              from: 'Sistema',
              text: `📨 Comunicação interna de *${member.nome}* (${member.areas?.[0] || 'equipe'}): _${rawText}_`,
              tag: 'interno',
            });
          }
        } catch {}
        return { action: 'defer', reason: 'colaborador-atrio-comunicacao-interna', _internal: true };
      }
    }
  } catch (e) {
    console.error('[TeamGuard] erro (seguindo com fluxo normal):', e.message);
  }

  // 0. GUARD DE ESCOPO — Luna só responde IMEDIATO se a intenção for inequivocamente NFS-e.
  //    Para qualquer outra mensagem: alerta no grupo (já rola) + aguarda 5min pra humano responder.
  //    Se 5min passaram sem humano, a Luna entra e faz triagem (luna-first-touch.js).
  const rawText = String(message?.body || message?.content || '').trim();

  const nfseIntent = /(emit\w*|nota\s*fiscal|\bnfs-?e\b|nfs\w?e)/i.test(rawText);
  const hasDoc = /\b\d{2}\.?\d{3}\.?\d{3}[\/\-]?\d{4}?\-?\d{2}\b|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(rawText);
  const isConfirmation = rawText.length <= 30
    && /^(sim|ok\b|confirmo|pode (emitir|enviar|seguir)|correto|confere|certo|isso)\b/i.test(rawText);

  // Verifica se existe intake NFS-e em andamento (continuação natural de coleta)
  let nfseIntakeAtivo = false;
  try {
    if (conversationInfo?.id) {
      const { query } = await import('../../db/pool.js');
      const { rows } = await query(
        `SELECT 1 FROM luna_v2.conversations WHERE id = $1 AND nfse_intake IS NOT NULL AND nfse_intake::text != '{}' LIMIT 1`,
        [conversationInfo.id]
      );
      nfseIntakeAtivo = rows.length > 0;
    }
  } catch {}

  // Luna responde IMEDIATO apenas quando:
  //  - Pedido claro de NFS-e  OU
  //  - Envio de CPF/CNPJ (tomador pra emissão)  OU
  //  - Confirmação curta enquanto intake NFS-e está ativo
  const lunaRespondeAgora = nfseIntent || hasDoc || (nfseIntakeAtivo && isConfirmation);

  if (!lunaRespondeAgora) {
    // Agenda Luna pra entrar daqui 5min se humano não responder
    try {
      const { scheduleLunaFirstTouch } = await import('../luna-first-touch.js');
      const phone = message?.from || message?.author || null;
      if (phone) {
        scheduleLunaFirstTouch({
          phone,
          conversationId: conversationInfo?.id || null,
          clientInfo,
          message,
          sendFn: async (to, text) => {
            const wa = await import('../whatsapp.js');
            return wa.botSend ? wa.botSend(to, text) : null;
          },
          log: (m) => console.log(m),
        });
      }
    } catch (e) {
      console.error('[ScopeGuard] scheduleLunaFirstTouch falhou:', e.message);
    }

    console.log(`[ScopeGuard] DEFER Luna → ${clientInfo?.legalName || 'lead'} (len=${rawText.length}) — humano tem 5min pra assumir`);

    // Cria task administrativa pra equipe ver no painel (não bloqueia)
    try {
      fetch('http://localhost:3010/api/luna/delegate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_target: 'Rodrigo',
          task_type: 'administrativo',
          conversation_id: conversationInfo?.id || null,
          client_id: clientInfo?.id || clientInfo?.gesthub_id || null,
          payload: {
            motivo: 'Aguardando resposta humana (Luna triagem em 5min se ninguém assumir)',
            mensagem_original: rawText.slice(0, 2000),
            contato: clientInfo?.contato?.nome || clientInfo?.name || null,
          },
        }),
      }).catch(() => {});
    } catch {}

    // NÃO envia resposta ao cliente agora — o alerta no grupo + timer cuidam
    return { action: 'defer', reason: 'awaiting-human-5min' };
  }

  // Luna responde — segue fluxo normal do LLM
  // 1. Formatar payload para OpenClaw
  const payload = formatMessage(message, clientInfo, conversationInfo);

  // 1.b RAG: injeta contexto (perfil + memorias + historico) antes de chamar Luna
  let ctx = { block: '', conversationId: null, clientId: null };
  try {
    ctx = await buildContext({ phone: payload.phone, clientInfo });
    // Injeta contextoTemporal DENTRO do bloco de contexto (antes do marker ---FIM CONTEXTO---)
    // pra que stripCtx consiga removê-lo. Antes, tempCtx vinha DEPOIS do marker e vazava pro DB.
    const tempCtx = contextoTemporal();
    const baseBlock = ctx.block
      ? ctx.block.replace(/---FIM CONTEXTO---\s*\n*$/, '')
      : '---CONTEXTO---\n';
    const ctxFinal = baseBlock + tempCtx + '\n---FIM CONTEXTO---\n\n';
    payload.mensagem = payload.mensagem || {};
    payload.mensagem.conteudo = ctxFinal + (payload.mensagem.conteudo || '');
  } catch (e) {
    console.error('[Webhook] buildContext erro (seguindo sem contexto):', e.message);
  }

  const userContent = stripCtx(payload.mensagem?.conteudo || '');


  try {
    // 2. Enviar para Luna (OpenClaw) — instrumenta latencia
    // Injeta ctx no payload pra makeLunaExecutor receber conversationId/clientId/phone corretamente
    payload.__conversationId = ctx.conversationId;
    payload.__clientId = ctx.clientId;
    const __t0 = Date.now();
    const result = await runWithContext(
      { conversationId: ctx.conversationId, clientId: ctx.clientId },
      () => sendToOpenClaw(payload)
    );
    const __latencyMs = Date.now() - __t0;

    // 2.b Retroalimentacao: grava turno em luna_v2.messages
    persistTurn({
      conversationId: ctx.conversationId,
      userContent,
      assistantContent: result?.reply || result?.message || '',
      llmLatencyMs: __latencyMs,
      modelUsed: result?.provider || null,
      toolCalls: result?.usage?.tool_calls || 0,
    }).catch((e) => console.error('[Webhook] persistTurn:', e.message));
    extractFactsAsync({ conversationId: ctx.conversationId, clientId: ctx.clientId, userContent, assistantContent: result?.reply }).catch(() => {});

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
  // LLM direto + tool use loop via claude.js chatWithAgent.
  const { rows } = await query(
    "SELECT id, name, role, system_prompt, personality, tools, config FROM public.agents WHERE name = 'Luna' LIMIT 1"
  );
  if (!rows[0]) throw new Error('Agente Luna nao encontrado em public.agents');
  const lunaAgent = rows[0];

  const userContent = payload.mensagem?.conteudo || payload.message?.body || payload.message?.text || payload.text || '';
  const executor = makeLunaExecutor({
    conversationId: payload.__conversationId || null,
    clientId: payload.__clientId || null,
    phone: payload.phone || null,
  });

  const resp = await chatWithAgent(lunaAgent, [{ role: 'user', content: userContent }], executor);
  if (!resp?.success) throw new Error('LLM Luna erro: ' + (resp?.error || 'desconhecido'));
  let reply = (resp.text || '').trim() || '...';

  // === CONFIDENTIALITY VETTER (defense-in-depth) ===
  // Intercepta vazamento de dados internos antes de chegar no cliente.
  // Se detectar, substitui por msg segura + loga incidente pra equipe.
  const leakCheck = detectConfidentialityLeak(reply);
  if (leakCheck.leak) {
    console.error('[VETTER] Bloqueio de vazamento — pattern=' + leakCheck.pattern + ' matched=' + (leakCheck.matched || '').slice(0, 100));
    logLeakAttempt({
      conversationId: payload.__conversationId || null,
      phone: payload.phone,
      clientName: payload.cliente?.nome,
      originalReply: reply,
      detection: leakCheck,
      queryFn: _vetterQuery,
    }).catch(() => {});
    reply = pickSafeReplacement({
      patternId: leakCheck.pattern,
      conversationId: payload.__conversationId || null,
    });
  }
  return {
    type: 'message',
    message: reply,
    success: true,
    reply,
    provider: resp.provider,
    usage: resp.usage,
  };
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
    phone: (client?.realPhone || msg.from?.replace(/@.*$/, '') || '').replace(/\D/g, ''),
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
