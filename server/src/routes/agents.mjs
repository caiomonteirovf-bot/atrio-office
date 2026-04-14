/**
 * Luna v2 - Agents Delegate API
 * Recebe delegacoes da Luna (OpenClaw) e cria tasks para agentes especialistas
 */
import { Router } from 'express';
import { query } from '../db/pool.js';
import { randomUUID } from 'crypto';

const router = Router();

// Buscar prestador pelo telefone do WhatsApp
async function buscarPrestador(phone) {
  if (!phone) return { encontrado: false };
  const phoneLimpo = phone.replace("@c.us", "").replace(/\D/g, "");
  try {
    const r1 = await query(
      `SELECT nome_legal, cnpj, inscricao_estadual FROM luna_v2.clients WHERE contatos @> $1::jsonb LIMIT 1`,
      [JSON.stringify([{ tipo: "whatsapp", valor: phoneLimpo }])]
    );
    if (r1.rows.length > 0) {
      return { encontrado: true, dados: { prestador_cnpj: r1.rows[0].cnpj, prestador_nome: r1.rows[0].nome_legal, inscricao_estadual: r1.rows[0].inscricao_estadual } };
    }
    return { encontrado: false };
  } catch (err) {
    console.error("[buscarPrestador] Erro:", err.message);
    return { encontrado: false };
  }
}

// POST /api/agents/delegate
router.post('/delegate', async (req, res) => {
  const {
    agent_target,
    task_type,
    conversation_id,
    client_id,
    payload,
    source = 'luna',
    priority = 'media',
    phone
  } = req.body;

  const validAgents = ['campelo', 'rodrigo', 'sneijder', 'sofia'];
  if (!validAgents.includes(agent_target)) {
    return res.status(400).json({ error: 'Agente invalido', validos: validAgents });
  }
  if (!task_type) {
    return res.status(400).json({ error: 'task_type obrigatorio' });
  }

    // Busca automatica do prestador para NFSe
    let payloadFinal = { ...payload };
    if (task_type === 'nfse_emitir' && phone) {
      const busca = await buscarPrestador(phone);
      if (busca.encontrado) {
        Object.assign(payloadFinal, busca.dados);
        console.log('[Delegate] Prestador encontrado: ' + busca.dados.prestador_nome);
      } else {
        console.log('[Delegate] Prestador NAO encontrado para ' + phone);
      }
    }
  if (!conversation_id) {
    return res.status(400).json({ error: 'conversation_id obrigatorio' });
  }

  try {
    const taskId = randomUUID();
    const descricao = '[' + source + '] ' + task_type + ' para ' + agent_target;

    const insertResult = await query(
      'INSERT INTO luna_v2.tasks (id, conversation_id, tipo, agente_designado, descricao, payload, status, deadline) VALUES ($1, $2, $3, $4, $5, $6, \'pending\', NOW() + INTERVAL \'2 hours\') RETURNING *',
      [taskId, conversation_id, task_type, agent_target, descricao, JSON.stringify(payloadFinal || {})]
    );
    const task = insertResult.rows[0];

    await query(
      'INSERT INTO luna_v2.calendar_events (titulo, tipo, start_time, conversation_id, origem, status) VALUES ($1, \'task\', NOW(), $2, \'luna\', \'scheduled\')',
      [descricao, conversation_id]
    );

    await query(
      'INSERT INTO luna_v2.notifications (tipo, team_member_id, titulo, mensagem, task_id, conversation_id) VALUES (\'task_delegated\', $1, \'Nova task delegada\', $2, $3, $4)',
      [agent_target, 'Task ' + task_type + ' delegada para ' + agent_target, taskId, conversation_id]
    );

    console.log('[Agents] Task ' + task.id + ' criada para ' + agent_target);

    res.json({
      success: true,
      task_id: task.id,
      agent: agent_target,
      status: 'pending',
      estimated_time: getEstimatedTime(task_type),
      message: 'Task criada e atribuida a ' + agent_target
    });
  } catch (error) {
    console.error('[Agents] Erro ao delegar:', error);
    res.status(500).json({ error: 'Erro interno ao criar task', detail: error.message });
  }
});

// GET /api/agents/tasks
router.get('/tasks', async (req, res) => {
  const { agent, status, limit = 50 } = req.query;
  try {
    let sql = 'SELECT t.*, c.nome_legal as cliente_nome, conv.phone as cliente_phone FROM luna_v2.tasks t LEFT JOIN luna_v2.conversations conv ON t.conversation_id = conv.id LEFT JOIN luna_v2.clients c ON conv.client_id = c.id WHERE 1=1';
    const params = [];
    if (agent) { params.push(agent); sql += ' AND t.agente_designado = $' + params.length; }
    if (status) { params.push(status); sql += ' AND t.status = $' + params.length; }
    params.push(parseInt(limit));
    sql += ' ORDER BY t.created_at DESC LIMIT $' + params.length;
    const result = await query(sql, params);
    res.json({ tasks: result.rows, total: result.rows.length });
  } catch (error) {
    console.error('[Agents] Erro ao listar tasks:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/agents/tasks/:id
router.get('/tasks/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT t.*, c.nome_legal as cliente_nome, conv.phone as cliente_phone FROM luna_v2.tasks t LEFT JOIN luna_v2.conversations conv ON t.conversation_id = conv.id LEFT JOIN luna_v2.clients c ON conv.client_id = c.id WHERE t.id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task nao encontrada' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('[Agents] Erro ao buscar task:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/agents/tasks/:id/status
router.patch('/tasks/:id/status', async (req, res) => {
  const { status, resultado } = req.body;
  const validStatuses = ['pending', 'processing', 'completed', 'failed', 'escalated'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Status invalido', validos: validStatuses });
  }
  try {
    const updates = ['status = $2'];
    const params = [req.params.id, status];
    if (status === 'processing') updates.push('started_at = NOW()');
    if (status === 'completed' || status === 'failed') updates.push('completed_at = NOW()');
    if (resultado) { params.push(JSON.stringify(resultado)); updates.push('resultado = $' + params.length); }
    const result = await query('UPDATE luna_v2.tasks SET ' + updates.join(', ') + ' WHERE id = $1 RETURNING *', params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task nao encontrada' });
    await query('INSERT INTO luna_v2.notifications (tipo, team_member_id, titulo, mensagem, task_id) VALUES (\'status_changed\', $1, \'Status atualizado\', $2, $3)', [result.rows[0].agente_designado, 'Task atualizada para ' + status, req.params.id]);
    res.json({ success: true, task: result.rows[0] });
  } catch (error) {
    console.error('[Agents] Erro ao atualizar status:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/agents/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [tasksByAgent, tasksByStatus, recentTasks] = await Promise.all([
      query('SELECT agente_designado as agent, COUNT(*) as total, COUNT(*) FILTER (WHERE status = \'completed\') as completed, COUNT(*) FILTER (WHERE status = \'pending\') as pending, COUNT(*) FILTER (WHERE status = \'processing\') as processing FROM luna_v2.tasks GROUP BY agente_designado'),
      query('SELECT status, COUNT(*) as total FROM luna_v2.tasks GROUP BY status'),
      query('SELECT t.*, c.nome_legal as cliente_nome FROM luna_v2.tasks t LEFT JOIN luna_v2.conversations conv ON t.conversation_id = conv.id LEFT JOIN luna_v2.clients c ON conv.client_id = c.id ORDER BY t.created_at DESC LIMIT 10')
    ]);
    res.json({ by_agent: tasksByAgent.rows, by_status: tasksByStatus.rows, recent: recentTasks.rows });
  } catch (error) {
    console.error('[Agents] Erro dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

function getEstimatedTime(taskType) {
  const estimates = {
    'nfse_emitir': '5 minutos',
    'nfse_consultar': '2 minutos',
    'boleto_gerar': '3 minutos',
    'contrato_criar': '10 minutos',
    'consulta_cnpj': '1 minuto',
    'onboarding': '15 minutos',
    'followup': '5 minutos',
    'inadimplencia_cobrar': '5 minutos'
  };
  return estimates[taskType] || '10 minutos';
}

// POST /api/luna/tasks (para o cron processar tasks pendentes)
router.post('/tasks', async (req, res) => {
  const { action } = req.body;
  
  if (action === 'process_pending') {
    try {
      // Buscar tasks pendentes
      const { rows: tasks } = await query(
        `SELECT * FROM luna_v2.tasks 
         WHERE status = 'pending' 
         AND agente_designado IS NOT NULL
         ORDER BY created_at ASC 
         LIMIT 5`
      );
      
      if (tasks.length === 0) {
        return res.json({ processed: 0, message: 'Nenhuma task pendente' });
      }
      
      let processed = 0;
      for (const task of tasks) {
        // Marcar como processando
        await query(
          `UPDATE luna_v2.tasks 
           SET status = 'processing', started_at = NOW(), tentativas = tentativas + 1 
           WHERE id = $1`,
          [task.id]
        );
        
        console.log(`[Cron] Processando task ${task.id} - ${task.tipo}`);
        
        // Aqui chamaria o worker real - por enquanto só log
        // TODO: Implementar chamada ao agente (Campelo via tool call)
        
        processed++;
      }
      
      res.json({ processed, tasks: tasks.map(t => t.id) });
    } catch (error) {
      console.error('[Agents] Erro ao processar tasks:', error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(400).json({ error: 'Ação inválida', validas: ['process_pending'] });
  }
});

// PATCH /api/luna/tasks/:id/complete
router.patch('/tasks/:id/complete', async (req, res) => {
  const { id } = req.params;
  const { resultado } = req.body;
  
  try {
    const { rows } = await query(
      `UPDATE luna_v2.tasks 
       SET status = 'completed', completed_at = NOW(), resultado = $2 
       WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(resultado || {})]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task não encontrada' });
    }
    
    res.json({ success: true, task: rows[0] });
  } catch (error) {
    console.error('[Agents] Erro ao completar task:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
