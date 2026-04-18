import { query } from '../db/pool.js';
import { logEvent } from './activity-log.js';
import { chatWithAgent } from './claude.js';
import { executeToolCall } from '../tools/registry.js';
import { sendNfseToGroup, sendAlertToGroup, sendMessage } from './whatsapp.js';
import * as telegram from './telegram.js';
import { createNotification } from './notifications.js';

let broadcastFn = null;
let logChatFn = null;
const taskStates = new Map(); // taskId → 'processing' | 'done' (atomic check-and-set)
const recentlyNotifiedClients = new Set(); // Evita mensagem duplicada ao mesmo cliente

export function setBroadcast(fn) {
  broadcastFn = fn;
}

export function setLogChat(fn) {
  logChatFn = fn;
}

function chat(msg) {
  logChatFn?.(msg);
}

// ============================================
// PROCESSA TASK → AGENTE IA
// ============================================
export async function processTask(taskId) {
  if (taskStates.has(taskId)) return;
  taskStates.set(taskId, 'processing');
  setTimeout(() => taskStates.delete(taskId), 5 * 60 * 1000);

  try {
    const { rows: tasks } = await query(`
      SELECT t.*, tm.agent_id, tm.type as member_type, tm.name as assigned_name
      FROM tasks t
      JOIN team_members tm ON t.assigned_to = tm.id
      WHERE t.id = $1
    `, [taskId]);

    if (!tasks.length) return;
    const task = tasks[0];

    if (task.member_type !== 'ai' || !task.agent_id) {
      console.log(`[Orchestrator] Task ${taskId} → humano (${task.assigned_name})`);
      return;
    }

    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [task.agent_id]);
    if (!agents.length) {
      console.log(`[Orchestrator] Task ${taskId}: agente id=${task.agent_id} não encontrado no banco`);
      await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
        [JSON.stringify({ error: `Agente IA (id=${task.agent_id}) não encontrado no banco de dados` }), taskId]);
      broadcastFn?.({ type: 'task_blocked', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'blocked' } });
      await notifyTeamFailure({ title: task.title, assigned_name: task.assigned_name || 'N/A' }, `Agente IA (id=${task.agent_id}) não encontrado no banco de dados. Task ficará bloqueada até correção.`);
      return;
    }
    const agent = agents[0];

    // Preserva metadata original (chatId do cliente)
    let originalMeta = null;
    try {
      if (task.result) originalMeta = typeof task.result === 'string' ? JSON.parse(task.result) : task.result;
    } catch {}

    // Guard de aprovacao humana: se a task foi criada com esse flag,
    // nao processa ate humano aprovar (ex: cobranca via Luna).
    if (originalMeta?.aguardando_aprovacao_humana === true) {
      console.log(`[Orchestrator] Task ${taskId} aguardando aprovacao humana — skip`);
      taskStates.delete(taskId);
      return;
    }

    console.log(`[Orchestrator] Processando "${task.title}" → ${agent.name}`);
    // Atomic checkout — garante que somente um worker processa
    // Permite claim a partir de 'pending' OU 'in_progress' (recovery de crash)
    const claim = await query(
      `UPDATE tasks
          SET status = 'in_progress', updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'in_progress')
      RETURNING id, status`,
      [taskId]
    );
    if (!claim.rows.length) {
      console.log(`[Orchestrator] Task ${taskId} ja foi processada ou cancelada — skip`);
      taskStates.delete(taskId);
      return;
    }
    broadcastFn?.({ type: 'task_updated', task: { id: taskId, status: 'in_progress', assigned_name: task.assigned_name } });

    // Chat: Rodrigo delega para o agente — extrai info da metadata para mensagem rica
    const clienteName = originalMeta?.cliente_nome || extractClientName(task, originalMeta);
    const isNfseTask = task.title?.includes('[NFSE]') || task.title?.includes('[FISCAL]')
      || /nfs.?-?e|nota fiscal|emiss[aã]o|emitir/i.test(task.title || '');
    const parsedFields = originalMeta?.parsed_fields || {};

    // Notificação no chat: sistema informa que task foi delegada
    chat({ from: agent.name, text: `📋 Recebi a task: ${task.title.replace(/^\[.*?\]\s*/, '')}. Processando...`, tag: isNfseTask ? 'nfs-e' : 'task' });

    // Monta prompt com dados estruturados para NFS-e
    let taskPrompt;
    if (isNfseTask && Object.keys(parsedFields).length > 0) {
      const pf = parsedFields;
      const clientePhoneCtx = originalMeta?.cliente_phone || '';
      taskPrompt = `Voce recebeu uma tarefa de emissao de NFS-e.

TAREFA: ${task.title}
PRIORIDADE: ${task.priority}

DADOS ESTRUTURADOS (use EXATAMENTE estes valores na tool emitir_nfse):
- prestador_cnpj: ${pf.prestador_cnpj || 'NAO INFORMADO - passe cliente_phone como fallback'}
- prestador_nome: ${pf.prestador_nome || 'NAO INFORMADO'}
- tomador_cpf_cnpj: ${pf.tomador_cpf_cnpj || 'NAO INFORMADO'}
- tomador_tipo_doc: ${pf.tomador_tipo_doc || 'NAO INFORMADO'}
- valor: ${pf.valor || 'NAO INFORMADO'}
- descricao: ${pf.descricao || 'NAO INFORMADA'}
- cep_tomador: ${pf.cep_tomador || 'NAO INFORMADO'}
- cliente_phone (solicitante WhatsApp): ${clientePhoneCtx || 'NAO INFORMADO'}

REGRA: prestador = cliente da carteira que solicitou via WhatsApp, identificado pelo telefone.
SE prestador_cnpj acima estiver NAO INFORMADO mas cliente_phone existir, passe cliente_phone na tool emitir_nfse - ela resolve via Gesthub automaticamente.

IMPORTANTE: tomador_cpf_cnpj e ${pf.tomador_cpf_cnpj || '?'} (NAO confunda com CEP ou outros numeros).
${task.description ? `\nCONTEXTO: ${task.description}` : ''}

Execute a emissao usando a tool emitir_nfse.`;
    } else {
      taskPrompt = `Você recebeu uma tarefa delegada por Rodrigo (Diretor de Operações).

TAREFA: ${task.title}
${task.description ? `DESCRIÇÃO: ${task.description}` : ''}
PRIORIDADE: ${task.priority}
${task.due_date ? `PRAZO: ${new Date(task.due_date).toLocaleDateString('pt-BR')}` : ''}

Execute a tarefa usando suas ferramentas disponíveis e retorne o resultado.`;
    }

    // Wrapper do tool executor: auto-injeta cliente_phone, prestador_cnpj,
    // tomador_cpf_cnpj e task_id em chamadas emitir_nfse. Essa e a fonte de
    // verdade da task — LLM nao precisa lembrar de preencher.
    const taskToolExecutor = async (name, args) => {
      if (name === 'emitir_nfse' && isNfseTask) {
        const pf = parsedFields || {};
        const phone = originalMeta?.cliente_phone || '';
        const enriched = { ...(args || {}) };
        if (!enriched.prestador_cnpj && pf.prestador_cnpj) enriched.prestador_cnpj = pf.prestador_cnpj;
        if (!enriched.cliente_phone && phone) enriched.cliente_phone = String(phone).replace(/\D/g, '');
        if (!enriched.tomador_cpf_cnpj && pf.tomador_cpf_cnpj) enriched.tomador_cpf_cnpj = pf.tomador_cpf_cnpj;
        if (!enriched.tomador_nome && pf.tomador_nome) enriched.tomador_nome = pf.tomador_nome;
        if (!enriched.valor && pf.valor) enriched.valor = pf.valor;
        if (!enriched.descricao && pf.descricao) enriched.descricao = pf.descricao;
        if (!enriched.task_id) enriched.task_id = taskId;
        const added = Object.keys(enriched).filter(k => !(k in (args || {})));
        if (added.length) console.log('[Orchestrator] emitir_nfse auto-inject:', added.join(','));
        return executeToolCall(name, enriched);
      }
      return executeToolCall(name, args);
    };

    let response = await chatWithAgent(agent, [
      { role: 'user', content: taskPrompt },
    ], taskToolExecutor);

    // Post-flight fallback: se e task NFSe e LLM nao fez chamada bem-sucedida
    // de emitir_nfse mas temos todos os dados, chama a tool diretamente.
    // Defesa contra instrucao-nao-seguida do LLM (Grok as vezes "desiste").
    if (response.success && isNfseTask) {
      const calls = response.toolCallTrace || [];
      const successfulEmit = calls.some(c => c.name === 'emitir_nfse' && c.ok);
      const pf = parsedFields || {};
      const phone = originalMeta?.cliente_phone || '';
      const canAutoEmit = (pf.prestador_cnpj || phone) && pf.tomador_cpf_cnpj && pf.valor && pf.descricao;
      if (!successfulEmit && canAutoEmit) {
        console.log('[Orchestrator] LLM nao emitiu NFSe mas dados estao completos — fallback deterministico');
        const enriched = {
          prestador_cnpj: pf.prestador_cnpj || undefined,
          cliente_phone: phone ? String(phone).replace(/\D/g, '') : undefined,
          tomador_cpf_cnpj: pf.tomador_cpf_cnpj,
          tomador_nome: pf.tomador_nome || undefined,
          valor: pf.valor,
          descricao: pf.descricao,
          codigo_servico: pf.codigo_servico || undefined,
          aliquota_iss: pf.aliquota_iss || undefined,
          task_id: taskId,
        };
        const fallbackResult = await executeToolCall('emitir_nfse', enriched);
        const fallbackCall = {
          name: 'emitir_nfse',
          args: enriched,
          ok: fallbackResult?.sucesso === true,
          summary: fallbackResult?.sucesso
            ? 'nfse=' + (fallbackResult.numero_nfse || '?') + ' status=' + (fallbackResult.status_nfse || '?')
            : 'erro: ' + String(fallbackResult?.erro || 'falha').slice(0, 100),
          ms: 0,
          iteration: -1,
          via: 'orchestrator-fallback',
        };
        response = {
          ...response,
          text: (response.text || '') + '\n\n---\n[Orchestrator fallback] emitir_nfse chamada diretamente: ' + fallbackCall.summary,
          toolCallTrace: [...calls, fallbackCall],
        };
      }
    }

    // Inspeciona resultados das tools — detecta falha mesmo com response.success=true
    // (ex: emitir_nfse retornou sucesso:false mas o agente nao bloqueou sozinho)
    const toolCalls = response.toolCallTrace || [];
    const toolFailures = toolCalls.filter(c => c?.ok === false || /sucesso.{0,5}false|"ok"\s*:\s*false|\berro[":\s]/i.test(String(c?.summary || '')));
    const hasToolFailure = toolFailures.length > 0;
    const taskActuallyFailed = !response.success || hasToolFailure;

    if (!taskActuallyFailed) {
      await query(`
        UPDATE tasks SET status = 'done', result = $1, completed_at = NOW() WHERE id = $2
      `, [JSON.stringify({ text: response.text, usage: response.usage, tool_calls: toolCalls }), taskId]);

      console.log(`[Orchestrator] "${task.title}" concluída por ${agent.name}`);
      broadcastFn?.({ type: 'task_completed', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'done' } });

      // Notification: task concluída
      createNotification({
        type: 'task_complete',
        title: 'Tarefa concluída',
        message: `${task.title} — concluída por ${agent.name}`,
        severity: 'success',
        agentId: agent.id,
        taskId,
      }).catch(() => {});

      // Chat: agente reporta conclusão com detalhes acionáveis
      let chatResult;
      let statusEmoji = '✅';
      if (isNfseTask) {
        const sucesso = response.text?.match(/"sucesso"\s*:\s*true/);
        if (sucesso) {
          chatResult = `NFS-e de ${clienteName} emitida com sucesso!`;
        } else {
          statusEmoji = '⚠️';
          // Extrai motivo real do resultado do Campelo
          const erroApi = response.text?.match(/`([^`]*(?:CPF|CNPJ|campo|inválido|obrigatório)[^`]*)`/i);
          const bloqueado = response.text?.match(/BLOQUEADO[^—]*—\s*(.+?)(?:\n|$)/);
          const acao = response.text?.match(/[Aa][çc][ãa]o [Nn]ecess[áa]ria[:\s]*\*?\*?\s*(.+?)(?:\n|$)/);
          const motivo = erroApi?.[1] || bloqueado?.[1]?.trim() || acao?.[1]?.replace(/\*/g, '').trim() || 'dados insuficientes';
          chatResult = `NFS-e de ${clienteName} pendente: ${motivo}. Equipe, verifiquem e reenviem.`;
        }
      } else {
        chatResult = `Tarefa de ${clienteName} concluída.`;
      }
      chat({ from: agent.name, text: `${statusEmoji} ${chatResult}`, tag: isNfseTask ? 'nfs-e' : 'concluído' });

      // Responde ao cliente se for NFS-e/fiscal
      await notifyClientIfNfse(task, response.text, originalMeta);
    } else {
      const blockReason = response.error
        || (toolFailures.length ? `tool ${toolFailures[0].name || 'desconhecida'} falhou: ${toolFailures[0].summary || 'sem detalhe'}` : 'sem detalhe');
      await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
        [JSON.stringify({ error: blockReason, tool_failures: toolFailures, tool_calls: toolCalls, text: response.text }), taskId]);
      console.log(`[Orchestrator] "${task.title}" bloqueada: ${blockReason}`);
      broadcastFn?.({ type: 'task_blocked', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'blocked' } });

      // Chat: avisa equipe com motivo REAL da falha (nao so 'erro generico')
      const chatMsg = isNfseTask
        ? `NFS-e de ${clienteName || 'cliente'} FALHOU: ${String(blockReason).slice(0, 160)}. Equipe, revisem no NFS-e System.`
        : `Tarefa de ${clienteName || 'cliente'} BLOQUEADA: ${String(blockReason).slice(0, 160)}.`;
      chat({ from: agent.name, text: `⚠️ ${chatMsg}`, tag: isNfseTask ? 'nfs-e' : 'bloqueado' });
      // continua com o fluxo original (createNotification abaixo)

      // Notification: escalation / task bloqueada
      createNotification({
        type: 'escalation',
        title: 'Escalation — tarefa bloqueada',
        message: `${task.title} bloqueada: ${(response.error || 'Erro desconhecido').substring(0, 200)}`,
        severity: 'warning',
        agentId: agent.id,
        taskId,
      }).catch(() => {});

      // Chat: agente reporta bloqueio
      // Notificação no chat: task bloqueada
      const erroLimpo = (response.error || 'Erro desconhecido').substring(0, 150);
      chat({ from: agent.name, text: `🚫 Bloqueado: ${erroLimpo}. Verifiquem os dados e reenviem a task.`, tag: 'bloqueado' });

      await notifyTeamFailure(task, response.error);
    }
  } catch (err) {
    console.error(`[Orchestrator] Erro task ${taskId}:`, err.message);
    await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
      [JSON.stringify({ error: err.message }), taskId]).catch(() => {});
    await notifyTeamFailure({ title: `Task ${taskId}`, assigned_name: 'sistema' }, err.message);
  }
}

// ============================================
// PROCESSA TASKS PENDENTES (loop periódico)
// ============================================
export async function processPendingTasks() {
  const { rows } = await query(`
    SELECT t.id FROM tasks t
    JOIN team_members tm ON t.assigned_to = tm.id
    WHERE t.status = 'pending' AND tm.type = 'ai' AND tm.agent_id IS NOT NULL
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at ASC
    LIMIT 3
  `);

  let processed = 0;
  for (const task of rows) {
    if (!taskStates.has(task.id)) {
      await processTask(task.id);
      processed++;
    }
  }
  return processed;
}

// ============================================
// NOTIFICA CLIENTE VIA WHATSAPP (Luna responde)
// ============================================
async function notifyClientIfNfse(task, agentText, originalMeta) {
  const isNfse = task.title?.includes('[NFSE]') || task.title?.includes('[FISCAL]');
  if (!isNfse) return;

  const clientName = extractClientName(task, originalMeta);
  const firstName = (clientName || 'Cliente').split(' ')[0];

  console.log(`[NFS-e] Resultado do Campelo para ${clientName}`);

  // Verifica status do resultado do Campelo
  const sucessoMatch = agentText?.match(/"sucesso"\s*:\s*true/);
  const processandoMatch = agentText?.match(/"status_nfse"\s*:\s*"processando"/) || agentText?.match(/"processando"/);

  // Extrai motivos de pendência do resultado do Campelo (JSON ou Markdown)
  const erroMatch = agentText?.match(/"erro"\s*:\s*"([^"]+)"/);
  const actionMatch = agentText?.match(/"action_required"\s*:\s*"([^"]+)"/);
  // Fallback: extrai do Markdown — bloco "Informação necessária" ou "Ação requerida"
  const infoMatch = agentText?.match(/[Ii]nforma[çc][ãa]o necess[áa]ria[:\s]*\n([\s\S]*?)(?:\n---|\n\n\*\*)/);
  const acaoMatch = agentText?.match(/[Aa][çc][ãa]o requerida[:\s]*\*?\*?\s*(.+)/);
  const bloqueadoMatch = agentText?.match(/BLOQUEADO[^—]*—\s*(.+)/);
  const pendencia = erroMatch?.[1]
    || actionMatch?.[1]
    || bloqueadoMatch?.[1]?.trim()
    || acaoMatch?.[1]?.replace(/\*/g, '').trim()
    || '';

  let alertMsg;
  let chatStatus;

  if (sucessoMatch && !processandoMatch) {
    // SUCESSO — notifica equipe, equipe envia ao cliente manualmente
    alertMsg = `📄 *NFS-e emitida com sucesso*\nCliente: ${clientName}\n\n_Equipe: enviar PDF ao cliente._`;
    chatStatus = `NFS-e de ${firstName} emitida com sucesso. Equipe notificada para enviar ao cliente.`;
  } else if (sucessoMatch && processandoMatch) {
    // PROCESSANDO na prefeitura — notifica equipe
    alertMsg = `⏳ *NFS-e processando na prefeitura*\nCliente: ${clientName}\n\n_Aguardando autorização. Equipe acompanhar._`;
    chatStatus = `NFS-e de ${firstName} enviada para a prefeitura, aguardando autorização. Equipe notificada.`;
  } else {
    // FALHA — notifica equipe com detalhes acionáveis
    const detalhes = pendencia || 'Dados insuficientes para emissão';

    // Extrai erros específicos da API do resultado
    const erroApiMatch = agentText?.match(/`([^`]{10,150})`/g)?.map(s => s.replace(/`/g, '')).filter(s => /CPF|CNPJ|campo|inválido|obrigat|DPS|série|valor|alíquota|código|tributação/i.test(s));
    const errosApi = erroApiMatch?.length ? `\nErros API: ${erroApiMatch.slice(0, 3).join(' | ')}` : '';

    // Identifica onde corrigir
    let ondeCorrigir = '';
    if (/CPF|CNPJ/i.test(detalhes + (errosApi || ''))) {
      ondeCorrigir = '\nOnde corrigir: Cadastro do tomador ou pedir dado correto ao cliente';
    } else if (/série|DPS/i.test(detalhes)) {
      ondeCorrigir = '\nOnde corrigir: Configuração da série DPS no NFS-e System';
    } else if (/código|tributação/i.test(detalhes)) {
      ondeCorrigir = '\nOnde corrigir: Código de tributação no cadastro do prestador';
    } else if (/valor|alíquota/i.test(detalhes)) {
      ondeCorrigir = '\nOnde corrigir: Dados de valor/alíquota informados pelo cliente';
    }

    alertMsg = `⚠️ *NFS-e pendente*\nCliente: ${clientName}\nMotivo: ${detalhes}${errosApi}${ondeCorrigir}\n\n_Equipe: corrigir e reemitir._`;
    chatStatus = `NFS-e de ${firstName} pendente. Motivo: ${detalhes}. Equipe notificada.`;
  }

  // Notifica EQUIPE (nunca o cliente direto)
  try {
    await sendAlertToGroup(alertMsg);
    console.log(`[NFS-e] Equipe notificada sobre NFS-e de ${clientName}`);
  } catch (err) {
    console.error(`[NFS-e] ERRO ao notificar equipe: ${err.message}`);
  }
  telegram.sendAlert(alertMsg.replace(/\*/g, '').replace(/_/g, ''));
  // Status da NFS-e notificado via grupo WhatsApp + Telegram (não injeta no chat da equipe)
}

// ============================================
// ENCONTRA CHATID DO CLIENTE
// ============================================
async function findClientChatId(task, originalMeta) {
  // 1. Da metadata original (Luna criou a task com chatId)
  if (originalMeta?.cliente_chatId) return originalMeta.cliente_chatId;

  // 2. Extrai identificador da description e busca no banco
  const idMatch = task.description?.match(/\((\d{10,20})\)/);
  if (idMatch) {
    const { rows } = await query(
      'SELECT chat_id FROM whatsapp_conversations WHERE phone = $1 ORDER BY last_message_at DESC LIMIT 1',
      [idMatch[1]]
    );
    if (rows.length) return rows[0].chat_id;
  }

  // 3. Busca pelo nome do cliente na conversa mais recente
  const clientName = extractClientName(task, originalMeta);
  if (clientName) {
    const { rows } = await query(
      'SELECT chat_id FROM whatsapp_conversations WHERE client_name ILIKE $1 ORDER BY last_message_at DESC LIMIT 1',
      [`%${clientName}%`]
    );
    if (rows.length) return rows[0].chat_id;
  }

  return null;
}

function extractClientName(task, originalMeta) {
  if (originalMeta?.cliente_nome) return originalMeta.cliente_nome;
  // Extrai do título: "[FISCAL] Solicitação de ... — Nome"
  const match = task.title?.match(/—\s*(.+)$/);
  return match?.[1]?.trim() || 'Cliente';
}

// ============================================
// NOTIFICA EQUIPE SOBRE FALHA
// ============================================
async function notifyTeamFailure(task, errorMsg) {
  const isNfse = task.title?.includes('[NFSE]') || task.title?.includes('[FISCAL]');
  const icon = isNfse ? '🚫' : '⚠️';

  // Extrai detalhes acionáveis do erro
  let onde = 'Átrio Office → Orchestrator';
  let acao = 'Verificar logs do servidor';
  if (errorMsg?.includes('fetch') || errorMsg?.includes('ECONNREFUSED')) {
    onde = 'API externa (Nuvem Fiscal / Gesthub)';
    acao = 'Verificar se a API está acessível e credenciais estão corretas';
  } else if (errorMsg?.includes('CPF') || errorMsg?.includes('CNPJ') || errorMsg?.includes('inválido')) {
    onde = 'Dados do cliente/tomador';
    acao = 'Corrigir CPF/CNPJ no cadastro ou pedir ao cliente novamente';
  } else if (errorMsg?.includes('agent') || errorMsg?.includes('agente')) {
    onde = 'Banco de dados → agents/team_members';
    acao = 'Verificar se o agente existe e está disponível no seed';
  } else if (errorMsg?.includes('tool') || errorMsg?.includes('emitir_nfse')) {
    onde = 'Tool do agente';
    acao = 'Verificar configuração da tool e parâmetros enviados';
  }

  const alertMsg = `${icon} *Task BLOQUEADA*\n\n*Task:* ${task.title}\n*Agente:* ${task.assigned_name || 'N/A'}\n*Erro:* ${errorMsg || 'Desconhecido'}\n*Onde:* ${onde}\n*Ação:* ${acao}`;

  telegram.sendAlert(alertMsg.replace(/\*/g, ''));
  try { await sendAlertToGroup(alertMsg); } catch {}
}


// ============================================
// RECOVERY DE TASKS ORFAS (stranded-work)
// Detecta tasks in_progress ha muito tempo — ninguem tocou.
// 1a tentativa: volta para pending, deixa orquestrador re-pegar
// 2a tentativa: bloqueia e notifica equipe
// Inspirado no padrao heartbeat_runs + stranded-assigned-work do paperclipai/paperclip.
// ============================================
const STRANDED_AFTER_MINUTES = parseInt(process.env.STRANDED_AFTER_MINUTES || '15', 10);
const STRANDED_MAX_RETRIES = parseInt(process.env.STRANDED_MAX_RETRIES || '1', 10);

export async function recoverStrandedTasks({ maxAgeMinutes = STRANDED_AFTER_MINUTES } = {}) {
  try {
    const { rows } = await query(
      `SELECT id, title, result,
              EXTRACT(EPOCH FROM (NOW() - updated_at))/60 AS age_minutes
         FROM tasks
        WHERE status = 'in_progress'
          AND updated_at < NOW() - ($1 || ' minutes')::interval
        LIMIT 20`,
      [String(maxAgeMinutes)]
    );
    if (!rows.length) return { scanned: 0, retried: 0, blocked: 0 };

    let retried = 0, blocked = 0;
    for (const t of rows) {
      // In-memory lock: se a task estiver sendo processada agora, ignora
      if (taskStates.has(t.id)) continue;

      let meta = {};
      try { meta = typeof t.result === 'string' ? JSON.parse(t.result) : (t.result || {}); } catch {}
      const retries = parseInt(meta.stranded_retries || 0, 10);

      if (retries < STRANDED_MAX_RETRIES) {
        meta.stranded_retries = retries + 1;
        meta.last_stranded_at = new Date().toISOString();
        meta.last_stranded_age_min = Math.round(parseFloat(t.age_minutes));
        await query(
          `UPDATE tasks SET status = 'pending', result = $1 WHERE id = $2`,
          [JSON.stringify(meta), t.id]
        );
        retried++;
        logEvent({
          actor_type: 'system', actor_id: 'recovery',
          event_type: 'task.recovery', action: 'retry',
          entity_type: 'task', entity_id: t.id,
          payload: { title: t.title, age_min: Math.round(parseFloat(t.age_minutes)), attempt: retries + 1 },
          severity: 'warn',
        });
        console.log(`[Recovery] Task ${t.id} ("${t.title}") retomada (tentativa ${retries + 1}/${STRANDED_MAX_RETRIES}, idade ${Math.round(parseFloat(t.age_minutes))}min)`);
      } else {
        meta.stranded_blocked_at = new Date().toISOString();
        meta.error = 'task orfa: excedeu tentativas de recovery (processo pode ter crashado)';
        await query(
          `UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
          [JSON.stringify(meta), t.id]
        );
        blocked++;
        logEvent({
          actor_type: 'system', actor_id: 'recovery',
          event_type: 'task.recovery', action: 'block',
          entity_type: 'task', entity_id: t.id,
          payload: { title: t.title, retries_exhausted: retries },
          severity: 'critical',
        });
        console.warn(`[Recovery] Task ${t.id} ("${t.title}") BLOQUEADA apos ${retries} retries`);
        // Notifica equipe
        try { await notifyTeamFailure({ title: t.title, assigned_name: 'sistema' }, `Task orfa apos ${retries} retries — requer revisao manual`); } catch {}
      }
    }
    return { scanned: rows.length, retried, blocked };
  } catch (err) {
    console.error('[Recovery] erro:', err.message);
    return { scanned: 0, retried: 0, blocked: 0, error: err.message };
  }
}
