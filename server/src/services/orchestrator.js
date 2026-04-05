import { query } from '../db/pool.js';
import { chatWithAgent } from './claude.js';
import { executeToolCall } from '../tools/registry.js';
import { sendNfseToGroup, sendAlertToGroup, sendMessage } from './whatsapp.js';
import * as telegram from './telegram.js';

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

    if (isNfseTask) {
      const valor = parsedFields.valor ? `R$ ${Number(parsedFields.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '';
      const prestador = originalMeta?.prestador_nome || '';
      const tomador = parsedFields.tomador_cpf_cnpj || '';
      chat({ from: 'Rodrigo', to: agent.name, text: `${agent.name}, ${clienteName} solicitou emissão de NFS-e.${prestador ? ` Empresa: ${prestador}.` : ''}${valor ? ` Valor: ${valor}.` : ''}${tomador ? ` Tomador: ${tomador}.` : ''} Processa por favor.`, tag: 'nfs-e' });
      chat({ from: agent.name, to: 'Rodrigo', text: `Recebido, Rodrigo. Vou verificar os dados e emitir a nota.` });
    } else {
      const resumo = task.title.replace(/^\[.*?\]\s*/, '');
      chat({ from: 'Rodrigo', to: agent.name, text: `${agent.name}, demanda de ${clienteName}: ${resumo}. Prioridade: ${task.priority}.`, tag: task.priority });
      chat({ from: agent.name, to: 'Rodrigo', text: `Entendido, Rodrigo. Estou analisando.` });
    }

    const taskPrompt = `Você recebeu uma tarefa delegada por Rodrigo (Diretor de Operações).

TAREFA: ${task.title}
${task.description ? `DESCRIÇÃO: ${task.description}` : ''}
PRIORIDADE: ${task.priority}
${task.due_date ? `PRAZO: ${new Date(task.due_date).toLocaleDateString('pt-BR')}` : ''}

Execute a tarefa usando suas ferramentas disponíveis e retorne o resultado.`;

    const response = await chatWithAgent(agent, [
      { role: 'user', content: taskPrompt },
    ], executeToolCall);

    if (response.success) {
      await query(`
        UPDATE tasks SET status = 'done', result = $1, completed_at = NOW() WHERE id = $2
      `, [JSON.stringify({ text: response.text, usage: response.usage }), taskId]);

      console.log(`[Orchestrator] "${task.title}" concluída por ${agent.name}`);
      broadcastFn?.({ type: 'task_completed', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'done' } });

      // Chat: agente reporta conclusão — mensagem limpa para o CEO, sem dados técnicos
      let chatResult;
      if (isNfseTask) {
        const sucesso = response.text?.match(/"sucesso"\s*:\s*true/);
        chatResult = sucesso
          ? `NFS-e de ${clienteName} processada com sucesso.`
          : `Analisei a solicitação de ${clienteName}. Precisa de ajustes nos dados para emitir.`;
      } else {
        chatResult = `Tarefa de ${clienteName} concluída.`;
      }
      chat({ from: agent.name, to: 'Rodrigo', text: chatResult, tag: 'concluído' });
      chat({ from: 'Rodrigo', to: agent.name, text: `Perfeito, ${agent.name}. Registrado.` });

      // Responde ao cliente se for NFS-e/fiscal
      await notifyClientIfNfse(task, response.text, originalMeta);
    } else {
      await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
        [JSON.stringify({ error: response.error }), taskId]);
      console.log(`[Orchestrator] "${task.title}" bloqueada: ${response.error}`);
      broadcastFn?.({ type: 'task_blocked', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'blocked' } });

      // Chat: agente reporta bloqueio
      chat({ from: agent.name, to: 'Rodrigo', text: `Rodrigo, encontrei um problema: ${(response.error || '').substring(0, 80)}`, tag: 'bloqueado' });
      chat({ from: 'Rodrigo', text: `Equipe, precisamos resolver isso. Vou escalar.`, tag: 'alerta' });

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

  // Extrai motivos de pendência do resultado do Campelo
  const erroMatch = agentText?.match(/"erro"\s*:\s*"([^"]+)"/);
  const actionMatch = agentText?.match(/"action_required"\s*:\s*"([^"]+)"/);
  const pendencia = erroMatch?.[1] || actionMatch?.[1] || '';

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
    // FALHA — notifica equipe com motivos da pendência
    alertMsg = `⚠️ *NFS-e pendente*\nCliente: ${clientName}${pendencia ? `\nMotivo: ${pendencia}` : ''}\n\n_Equipe: emitir manualmente ou corrigir dados._`;
    chatStatus = `NFS-e de ${firstName} pendente.${pendencia ? ` Motivo: ${pendencia}.` : ''} Equipe notificada.`;
  }

  // Notifica EQUIPE (nunca o cliente direto)
  try {
    await sendAlertToGroup(alertMsg);
    console.log(`[NFS-e] Equipe notificada sobre NFS-e de ${clientName}`);
  } catch (err) {
    console.error(`[NFS-e] ERRO ao notificar equipe: ${err.message}`);
  }
  telegram.sendAlert(alertMsg.replace(/\*/g, '').replace(/_/g, ''));
  chat({ from: 'Luna', text: chatStatus, tag: 'nfs-e' });
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
  const alertMsg = `${icon} *Task BLOQUEADA*\n\nTask: ${task.title}\nAgente: ${task.assigned_name || 'N/A'}\nErro: ${errorMsg || 'Desconhecido'}`;

  telegram.sendAlert(alertMsg.replace(/\*/g, ''));
  try { await sendAlertToGroup(alertMsg); } catch {}
}
