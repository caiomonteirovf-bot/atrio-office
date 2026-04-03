import { query } from '../db/pool.js';
import { chatWithAgent } from './claude.js';
import { executeToolCall } from '../tools/registry.js';

let broadcastFn = null;

export function setBroadcast(fn) {
  broadcastFn = fn;
}

/**
 * Processa uma task atribuída a um agente IA automaticamente.
 * Chamada quando uma task é criada via tool (delegar_tarefa, rotear_demanda, etc.)
 */
export async function processTask(taskId) {
  try {
    // Busca task com info do assignee
    const { rows: tasks } = await query(`
      SELECT t.*, tm.agent_id, tm.type as member_type, tm.name as assigned_name
      FROM tasks t
      JOIN team_members tm ON t.assigned_to = tm.id
      WHERE t.id = $1
    `, [taskId]);

    if (!tasks.length) return;
    const task = tasks[0];

    // Só processa se atribuída a um agente IA
    if (task.member_type !== 'ai' || !task.agent_id) {
      console.log(`[Orchestrator] Task ${taskId} atribuída a humano (${task.assigned_name}) — aguardando execução manual`);
      return;
    }

    // Busca o agente
    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [task.agent_id]);
    if (!agents.length) return;
    const agent = agents[0];

    console.log(`[Orchestrator] Processando task "${task.title}" → ${agent.name}`);

    // Atualiza status para in_progress
    await query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [taskId]);
    broadcastFn?.({ type: 'task_updated', task: { id: taskId, status: 'in_progress', assigned_name: task.assigned_name } });

    // Monta prompt da task para o agente
    const taskPrompt = `Você recebeu uma tarefa delegada por Rodrigo (Diretor de Operações).

TAREFA: ${task.title}
${task.description ? `DESCRIÇÃO: ${task.description}` : ''}
PRIORIDADE: ${task.priority}
${task.due_date ? `PRAZO: ${new Date(task.due_date).toLocaleDateString('pt-BR')}` : ''}

Execute a tarefa usando suas ferramentas disponíveis e retorne o resultado.`;

    // Executa o agente com suas tools
    const response = await chatWithAgent(agent, [
      { role: 'user', content: taskPrompt },
    ], executeToolCall);

    if (response.success) {
      // Salva resultado na task
      await query(`
        UPDATE tasks SET
          status = 'done',
          result = $1,
          completed_at = NOW()
        WHERE id = $2
      `, [JSON.stringify({ text: response.text, usage: response.usage }), taskId]);

      console.log(`[Orchestrator] Task "${task.title}" concluída por ${agent.name}`);

      broadcastFn?.({
        type: 'task_completed',
        task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'done' },
        result_preview: response.text?.substring(0, 200),
      });
    } else {
      // Marca como bloqueada
      await query(`
        UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2
      `, [JSON.stringify({ error: response.error }), taskId]);

      console.log(`[Orchestrator] Task "${task.title}" bloqueada: ${response.error}`);

      broadcastFn?.({
        type: 'task_blocked',
        task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'blocked', error: response.error },
      });
    }
  } catch (err) {
    console.error(`[Orchestrator] Erro processando task ${taskId}:`, err.message);
    await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
      [JSON.stringify({ error: err.message }), taskId]).catch(() => {});
  }
}

/**
 * Verifica e processa tasks pendentes atribuídas a agentes IA.
 * Chamada periodicamente ou sob demanda.
 */
export async function processPendingTasks() {
  const { rows: pendingTasks } = await query(`
    SELECT t.id
    FROM tasks t
    JOIN team_members tm ON t.assigned_to = tm.id
    WHERE t.status = 'pending'
      AND tm.type = 'ai'
      AND tm.agent_id IS NOT NULL
    ORDER BY
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      t.created_at ASC
    LIMIT 3
  `);

  for (const task of pendingTasks) {
    await processTask(task.id);
  }

  return pendingTasks.length;
}
