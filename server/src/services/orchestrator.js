import { query } from '../db/pool.js';
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

    console.log(`[Orchestrator] Processando "${task.title}" → ${agent.name}`);
    await query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [taskId]);
    broadcastFn?.({ type: 'task_updated', task: { id: taskId, status: 'in_progress', assigned_name: task.assigned_name } });

    // Chat: Rodrigo delega para o agente — extrai info da metadata para mensagem rica
    const clienteName = originalMeta?.cliente_nome || extractClientName(task, originalMeta);
    const isNfseTask = task.title?.includes('[NFSE]') || task.title?.includes('[FISCAL]');
    const parsedFields = originalMeta?.parsed_fields || {};

    // Notificação no chat: sistema informa que task foi delegada
    chat({ from: agent.name, text: `📋 Recebi a task: ${task.title.replace(/^\[.*?\]\s*/, '')}. Processando...`, tag: isNfseTask ? 'nfs-e' : 'task' });

    // Monta prompt com dados estruturados para NFS-e
    let taskPrompt;
    if (isNfseTask && Object.keys(parsedFields).length > 0) {
      const pf = parsedFields;
      taskPrompt = `Você recebeu uma tarefa de emissão de NFS-e.

TAREFA: ${task.title}
PRIORIDADE: ${task.priority}

DADOS ESTRUTURADOS (use EXATAMENTE estes valores na tool emitir_nfse):
- prestador_cnpj: ${pf.prestador_cnpj || 'NÃO INFORMADO'}
- prestador_nome: ${pf.prestador_nome || 'NÃO INFORMADO'}
- tomador_cpf_cnpj: ${pf.tomador_cpf_cnpj || 'NÃO INFORMADO'}
- tomador_tipo_doc: ${pf.tomador_tipo_doc || 'NÃO INFORMADO'}
- valor: ${pf.valor || 'NÃO INFORMADO'}
- descricao: ${pf.descricao || 'NÃO INFORMADA'}
- cep_tomador: ${pf.cep_tomador || 'NÃO INFORMADO'}

IMPORTANTE: Use o campo tomador_cpf_cnpj acima (${pf.tomador_cpf_cnpj || '?'}), NÃO confunda com CEP ou outros números.
${task.description ? `\nCONTEXTO: ${task.description}` : ''}

Execute a emissão usando a tool emitir_nfse com os dados acima.`;
    } else {
      taskPrompt = `Você recebeu uma tarefa delegada por Rodrigo (Diretor de Operações).

TAREFA: ${task.title}
${task.description ? `DESCRIÇÃO: ${task.description}` : ''}
PRIORIDADE: ${task.priority}
${task.due_date ? `PRAZO: ${new Date(task.due_date).toLocaleDateString('pt-BR')}` : ''}

Execute a tarefa usando suas ferramentas disponíveis e retorne o resultado.`;
    }

    const response = await chatWithAgent(agent, [
      { role: 'user', content: taskPrompt },
    ], executeToolCall);

    if (response.success) {
      await query(`
        UPDATE tasks SET status = 'done', result = $1, completed_at = NOW() WHERE id = $2
      `, [JSON.stringify({ text: response.text, usage: response.usage }), taskId]);

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
      await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
        [JSON.stringify({ error: response.error }), taskId]);
      console.log(`[Orchestrator] "${task.title}" bloqueada: ${response.error}`);
      broadcastFn?.({ type: 'task_blocked', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'blocked' } });

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
