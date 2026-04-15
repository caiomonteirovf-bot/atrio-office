import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { query } from './db/pool.js';
import { chatWithAgent, extractText } from './services/claude.js';
import { startWatchdog } from './services/luna-watchdog.js';
import { executeToolCall, setOnTaskCreated } from './tools/registry.js';
import { processTask, processPendingTasks, setBroadcast, setLogChat } from './services/orchestrator.js';
import { createNotification } from './services/notifications.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Serve frontend estático em produção
// Em dev: ../../client/dist, em Docker: ../client/dist
const clientDistOptions = [
  path.join(__dirname, '../../client/dist'),   // dev local
  path.join(__dirname, '../client/dist'),       // Docker
];
import fs from 'fs';
const clientDist = clientDistOptions.find(p => fs.existsSync(p)) || clientDistOptions[0];
app.use(express.static(clientDist, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', async (req, res) => {
  const services = {}

  // PostgreSQL
  try {
    const start = Date.now()
    await query('SELECT 1')
    services.postgres = { status: 'ok', latency: Date.now() - start }
  } catch (e) {
    services.postgres = { status: 'error', error: e.message }
  }

  // WhatsApp
  try {
    const waStatus = whatsapp.getStatus()
    services.whatsapp = { status: waStatus.connected ? 'ok' : 'disconnected', ...waStatus }
  } catch (e) {
    services.whatsapp = { status: 'unknown' }
  }

  // Agents count
  try {
    const { rows } = await query("SELECT status, COUNT(*) as count FROM agents GROUP BY status")
    services.agents = { status: 'ok', breakdown: rows }
  } catch (e) {
    services.agents = { status: 'error' }
  }

  const allOk = Object.values(services).every(s => s.status === 'ok')
  res.json({
    status: allOk ? 'ok' : 'degraded',
    service: 'atrio-office',
    timestamp: new Date(),
    services
  })
});

// ============================================
// NOTIFICATIONS — Central de notificações
// ============================================
app.get('/api/notifications', async (req, res) => {
  try {
    const unreadOnly = req.query.unread === 'true'
    const limit = parseInt(req.query.limit) || 50
    let sql = 'SELECT * FROM notifications'
    if (unreadOnly) sql += ' WHERE read = false'
    sql += ' ORDER BY created_at DESC LIMIT $1'
    const { rows } = await query(sql, [limit])
    const countResult = await query('SELECT COUNT(*) FROM notifications WHERE read = false')
    res.json({ notifications: rows, unreadCount: parseInt(countResult.rows[0].count) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.patch('/api/notifications/read-all', async (req, res) => {
  try {
    await query('UPDATE notifications SET read = true WHERE read = false')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.patch('/api/notifications/:id', async (req, res) => {
  try {
    await query('UPDATE notifications SET read = true WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/notifications/read', async (req, res) => {
  try {
    await query('DELETE FROM notifications WHERE read = true')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
});

// ============================================
// ACTIVITY — Heatmap + stats
// ============================================
app.get('/api/analytics/activity', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 365
    // Get activity counts per day from tasks + messages
    const { rows } = await query(`
      SELECT date_trunc('day', created_at)::date as day, COUNT(*) as count
      FROM (
        SELECT created_at FROM tasks WHERE created_at > NOW() - INTERVAL '${days} days'
        UNION ALL
        SELECT created_at FROM messages WHERE created_at > NOW() - INTERVAL '${days} days'
      ) combined
      GROUP BY date_trunc('day', created_at)::date
      ORDER BY day
    `)

    // Get today's stats
    const todayStats = await query(`
      SELECT
        (SELECT COUNT(*) FROM tasks WHERE created_at::date = CURRENT_DATE) as tasks_today,
        (SELECT COUNT(*) FROM messages WHERE created_at::date = CURRENT_DATE) as messages_today,
        (SELECT COUNT(*) FROM tasks WHERE status = 'done' AND updated_at::date = CURRENT_DATE) as completed_today
    `)

    res.json({
      heatmap: rows.map(r => ({ date: r.day, count: parseInt(r.count) })),
      today: todayStats.rows[0] || { tasks_today: 0, messages_today: 0, completed_today: 0 }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================
// CRON MANAGER — Visual cron management
// ============================================
app.get('/api/crons', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM cron_jobs ORDER BY name')
    res.json({ crons: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/crons/:id', async (req, res) => {
  try {
    const { status, schedule, description } = req.body
    const updates = []
    const values = []
    let idx = 1

    if (status) { updates.push(`status = $${idx++}`); values.push(status) }
    if (schedule) { updates.push(`schedule = $${idx++}`); values.push(schedule) }
    if (description) { updates.push(`description = $${idx++}`); values.push(description) }

    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.params.id)
    const { rows } = await query(
      `UPDATE cron_jobs SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    )
    if (rows.length === 0) return res.status(404).json({ error: 'Cron job not found' })
    res.json({ cron: rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/crons/:id/trigger', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM cron_jobs WHERE id = $1', [req.params.id])
    if (rows.length === 0) return res.status(404).json({ error: 'Cron job not found' })

    const cron = rows[0]

    // Actually execute the handler via cronScheduler
    const result = await executeCronJob(cron)

    res.json({
      ok: result.success,
      message: `Cron "${cron.name}" triggered`,
      duration_ms: result.duration,
      output: result.success ? result.output : undefined,
      error: result.success ? undefined : result.error
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/crons/:id/runs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const { rows } = await query(
      'SELECT * FROM cron_runs WHERE cron_job_id = $1 ORDER BY started_at DESC LIMIT $2',
      [req.params.id, limit]
    )
    res.json({ runs: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================
// ANALYTICS — IA Costs + Token Usage
// ============================================
app.get('/api/analytics/costs', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30

    // Daily costs
    const daily = await query(`
      SELECT date_trunc('day', created_at)::date as day,
             SUM(tokens_input) as total_input,
             SUM(tokens_output) as total_output,
             SUM(cost_usd) as total_cost,
             COUNT(*) as requests
      FROM token_usage
      WHERE created_at > NOW() - INTERVAL '${days} days'
      GROUP BY date_trunc('day', created_at)::date
      ORDER BY day
    `)

    // Per agent breakdown
    const byAgent = await query(`
      SELECT a.name as agent_name, a.role,
             COALESCE(SUM(t.tokens_input), 0) as total_input,
             COALESCE(SUM(t.tokens_output), 0) as total_output,
             COALESCE(SUM(t.cost_usd), 0) as total_cost,
             COUNT(t.id) as requests
      FROM agents a
      LEFT JOIN token_usage t ON t.agent_id = a.id AND t.created_at > NOW() - INTERVAL '${days} days'
      GROUP BY a.id, a.name, a.role
      ORDER BY total_cost DESC
    `)

    // Totals
    const totals = await query(`
      SELECT
        COALESCE(SUM(CASE WHEN created_at::date = CURRENT_DATE THEN cost_usd ELSE 0 END), 0) as cost_today,
        COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN cost_usd ELSE 0 END), 0) as cost_month,
        COALESCE(SUM(tokens_input + tokens_output), 0) as total_tokens,
        COUNT(*) as total_requests
      FROM token_usage
      WHERE created_at > NOW() - INTERVAL '30 days'
    `)

    res.json({
      daily: daily.rows.map(r => ({
        date: r.day,
        input: parseInt(r.total_input),
        output: parseInt(r.total_output),
        cost: parseFloat(r.total_cost),
        requests: parseInt(r.requests)
      })),
      byAgent: byAgent.rows.map(r => ({
        name: r.agent_name,
        role: r.role,
        input: parseInt(r.total_input),
        output: parseInt(r.total_output),
        cost: parseFloat(r.total_cost),
        requests: parseInt(r.requests)
      })),
      totals: totals.rows[0] || { cost_today: 0, cost_month: 0, total_tokens: 0, total_requests: 0 }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================
// SESSIONS — Histórico de conversas
// ============================================
app.get('/api/sessions', async (req, res) => {
  try {
    const { agent, client, channel, status, limit: lim, offset: off } = req.query
    const limit = parseInt(lim) || 50
    const offset = parseInt(off) || 0

    let sql = `
      SELECT c.*,
             a.name as agent_name, a.role as agent_role,
             cl.name as client_name,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
             (SELECT COALESCE(SUM(t.tokens_input + t.tokens_output), 0) FROM token_usage t WHERE t.conversation_id = c.id) as total_tokens
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      LEFT JOIN clients cl ON c.client_id = cl.id
      WHERE 1=1
    `
    const params = []
    let idx = 1

    if (agent) { sql += ` AND c.agent_id = $${idx++}`; params.push(agent) }
    if (client) { sql += ` AND c.client_id = $${idx++}`; params.push(client) }
    if (channel) { sql += ` AND c.channel = $${idx++}`; params.push(channel) }
    if (status) { sql += ` AND c.status = $${idx++}`; params.push(status) }

    sql += ` ORDER BY c.started_at DESC LIMIT $${idx++} OFFSET $${idx++}`
    params.push(limit, offset)

    const { rows } = await query(sql, params)

    // Total count for pagination
    let countSql = 'SELECT COUNT(*) FROM conversations WHERE 1=1'
    const countParams = []
    let ci = 1
    if (agent) { countSql += ` AND agent_id = $${ci++}`; countParams.push(agent) }
    if (client) { countSql += ` AND client_id = $${ci++}`; countParams.push(client) }
    if (channel) { countSql += ` AND channel = $${ci++}`; countParams.push(channel) }
    if (status) { countSql += ` AND status = $${ci++}`; countParams.push(status) }

    const countResult = await query(countSql, countParams)

    res.json({
      sessions: rows,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    )
    res.json({ messages: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================
// CALENDAR — Prazos fiscais + eventos
// ============================================
app.get('/api/calendar', async (req, res) => {
  try {
    const { start, end, type, category } = req.query

    let sql = 'SELECT * FROM calendar_events WHERE 1=1'
    const params = []
    let idx = 1

    if (start) { sql += ` AND start_time >= $${idx++}`; params.push(start) }
    if (end) { sql += ` AND start_time <= $${idx++}`; params.push(end) }
    if (type) { sql += ` AND type = $${idx++}`; params.push(type) }
    if (category) { sql += ` AND category = $${idx++}`; params.push(category) }

    sql += ' ORDER BY start_time ASC'
    const { rows } = await query(sql, params)
    res.json({ events: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/calendar', async (req, res) => {
  try {
    const { title, description, type, category, start_time, end_time, all_day, color, agent_id, task_id, client_id, recurrence, metadata } = req.body
    if (!title || !start_time) return res.status(400).json({ error: 'title and start_time required' })

    const { rows } = await query(
      `INSERT INTO calendar_events (title, description, type, category, start_time, end_time, all_day, color, agent_id, task_id, client_id, recurrence, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [title, description || null, type || 'task', category || null, start_time, end_time || null, all_day || false, color || null, agent_id || null, task_id || null, client_id || null, recurrence || null, metadata || {}]
    )
    res.status(201).json({ event: rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/calendar/:id', async (req, res) => {
  try {
    const { title, description, type, category, start_time, end_time, all_day, color, metadata } = req.body
    const { rows } = await query(
      `UPDATE calendar_events SET
        title = COALESCE($1, title), description = COALESCE($2, description),
        type = COALESCE($3, type), category = COALESCE($4, category),
        start_time = COALESCE($5, start_time), end_time = COALESCE($6, end_time),
        all_day = COALESCE($7, all_day), color = COALESCE($8, color),
        metadata = COALESCE($9, metadata)
       WHERE id = $10 RETURNING *`,
      [title, description, type, category, start_time, end_time, all_day, color, metadata || null, req.params.id]
    )
    if (rows.length === 0) return res.status(404).json({ error: 'Event not found' })
    res.json({ event: rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/calendar/:id', async (req, res) => {
  try {
    await query('DELETE FROM calendar_events WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================
// MEMORY — Agent knowledge/context browser
// ============================================
app.get('/api/agents/:agentId/memory', async (req, res) => {
  try {
    const { category } = req.query
    let sql = 'SELECT * FROM agent_memory WHERE agent_id = $1'
    const params = [req.params.agentId]

    if (category) {
      sql += ' AND category = $2'
      params.push(category)
    }

    sql += ' ORDER BY pinned DESC, updated_at DESC'
    const { rows } = await query(sql, params)
    res.json({ memories: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/agents/:agentId/memory', async (req, res) => {
  try {
    const { category, title, content, metadata, pinned } = req.body
    if (!content) return res.status(400).json({ error: 'content required' })

    const { rows } = await query(
      `INSERT INTO agent_memory (agent_id, category, title, content, metadata, pinned)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.agentId, category || 'general', title || null, content, metadata || {}, pinned || false]
    )
    res.status(201).json({ memory: rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/agents/:agentId/memory/:memId', async (req, res) => {
  try {
    const { category, title, content, metadata, pinned } = req.body
    const { rows } = await query(
      `UPDATE agent_memory SET
        category = COALESCE($1, category), title = COALESCE($2, title),
        content = COALESCE($3, content), metadata = COALESCE($4, metadata),
        pinned = COALESCE($5, pinned), updated_at = NOW()
       WHERE id = $6 AND agent_id = $7 RETURNING *`,
      [category, title, content, metadata, pinned, req.params.memId, req.params.agentId]
    )
    if (rows.length === 0) return res.status(404).json({ error: 'Memory not found' })
    res.json({ memory: rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/agents/:agentId/memory/:memId', async (req, res) => {
  try {
    await query('DELETE FROM agent_memory WHERE id = $1 AND agent_id = $2', [req.params.memId, req.params.agentId])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================
// AGENTS — Listar agentes
// ============================================
app.get('/api/agents', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, role, department, personality, status, config
       FROM agents ORDER BY (config->>'order')::int`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM agents WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Agente não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TEAM — Listar equipe (IA + humanos)
// ============================================
app.get('/api/team', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT tm.*, a.config 
       FROM team_members tm
       LEFT JOIN agents a ON tm.agent_id = a.id
       ORDER BY tm.type, tm.name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CHAT — Conversar com um agente
// ============================================
// Sanitiza input do chat — remove tentativas de prompt injection
function sanitizeMessage(text) {
  if (!text || typeof text !== 'string') return '';
  // Remove instruções que tentam alterar comportamento do agente
  const patterns = [
    /ignore\s+(all\s+)?previous\s+instructions/gi,
    /you\s+are\s+now\s+/gi,
    /forget\s+(all\s+)?your\s+(instructions|rules|prompt)/gi,
    /system\s*:\s*/gi,
    /\[SYSTEM\]/gi,
    /\[INST\]/gi,
    /<\/?system>/gi,
  ];
  let sanitized = text;
  for (const p of patterns) sanitized = sanitized.replace(p, '[BLOQUEADO] ');
  // Limita tamanho
  return sanitized.substring(0, 4000);
}

app.post('/api/chat/:agentId', async (req, res) => {
  const { agentId } = req.params;
  const { message: rawMessage, conversationId } = req.body;
  const message = sanitizeMessage(rawMessage);

  if (!message.trim()) return res.status(400).json({ error: 'Mensagem vazia' });

  try {
    // Busca agente
    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [agentId]);
    if (!agents.length) return res.status(404).json({ error: 'Agente não encontrado' });
    const agent = agents[0];

    // Busca ou cria conversa
    let convId = conversationId;
    if (!convId) {
      const { rows } = await query(
        `INSERT INTO conversations (agent_id, channel, title)
         VALUES ($1, 'dashboard', $2) RETURNING id`,
        [agentId, `Chat com ${agent.name}`]
      );
      convId = rows[0].id;
    }

    // Salva mensagem do usuário
    await query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
      [convId, message]
    );

    // Busca histórico da conversa
    const { rows: history } = await query(
      `SELECT role, content FROM messages 
       WHERE conversation_id = $1 ORDER BY created_at`,
      [convId]
    );

    // Envia para Claude
    const response = await chatWithAgent(agent, history, executeToolCall);

    if (!response.success) {
      return res.status(500).json({ error: response.error });
    }

    // Salva resposta do agente
    await query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
      [convId, response.text]
    );

    res.json({
      conversationId: convId,
      agent: agent.name,
      response: response.text,
      usage: response.usage,
    });
  } catch (err) {
    console.error('[Chat] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CONVERSATIONS — Histórico
// ============================================
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ACTIVITY FEED — Atividades relevantes para o CEO
// ============================================
app.get('/api/activity-feed', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT t.*, tm.name as assigned_name, tm.type as assigned_type,
             d.name as delegated_name, c.name as client_name
      FROM tasks t
      LEFT JOIN team_members tm ON t.assigned_to = tm.id
      LEFT JOIN team_members d ON t.delegated_by = d.id
      LEFT JOIN clients c ON t.client_id = c.id
      WHERE t.status IN ('blocked', 'in_progress')
         OR (t.status = 'pending' AND t.priority IN ('high', 'urgent'))
         OR (t.status != 'done' AND t.status != 'cancelled' AND (t.title LIKE '%[NFSE]%' OR t.title LIKE '%[FISCAL]%'))
      ORDER BY
        CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        t.created_at DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TASKS — CRUD básico
// ============================================
app.get('/api/tasks', async (req, res) => {
  const { status, assigned_to } = req.query;
  try {
    let sql = `SELECT t.*, tm.name as assigned_name, tm.type as assigned_type,
               d.name as delegated_name, c.name as client_name
               FROM tasks t
               LEFT JOIN team_members tm ON t.assigned_to = tm.id
               LEFT JOIN team_members d ON t.delegated_by = d.id
               LEFT JOIN clients c ON t.client_id = c.id
               WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); sql += ` AND t.status = $${params.length}`; }
    if (assigned_to) { params.push(assigned_to); sql += ` AND t.assigned_to = $${params.length}`; }
    sql += ' ORDER BY t.priority DESC, t.created_at DESC';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const { title, description, assigned_to, delegated_by, client_id, priority, due_date } = req.body;
  try {
    const { rows } = await query(
      `INSERT INTO tasks (title, description, assigned_to, delegated_by, client_id, priority, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, description, assigned_to, delegated_by, client_id, priority || 'medium', due_date]
    );
    const newTask = rows[0];

    // Notification: nova tarefa criada
    createNotification({
      type: 'task_created',
      title: 'Nova tarefa criada',
      message: newTask.title,
      severity: 'info',
      taskId: newTask.id,
      metadata: { priority: newTask.priority, assigned_to },
    }).catch(() => {});

    res.status(201).json(newTask);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH task — atualizar status (inclui hook de NFS-e → Luna notifica cliente)
app.patch('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { status, result } = req.body;
  try {
    const completedExpr = status === 'done' ? 'NOW()'
      : (status === 'pending' || status === 'in_progress') ? 'NULL'
      : 'completed_at';
    const { rows } = await query(
      `UPDATE tasks SET status = $1, result = COALESCE($2, result),
       completed_at = ${completedExpr},
       updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, result ? JSON.stringify(result) : null, id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Task não encontrada' });

    const task = rows[0];

    // Hook: Task concluída → broadcast para dashboard
    if (status === 'done') {
      broadcast({ type: 'task_completed', task });

      // Notification: tarefa concluída via API
      createNotification({
        type: 'task_complete',
        title: 'Tarefa concluída',
        message: task.title,
        severity: 'success',
        taskId: task.id,
      }).catch(() => {});
    }

    broadcast({ type: 'task_updated', task });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CLIENTS — CRUD básico
// ============================================
app.get('/api/clients', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM clients ORDER BY name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PORTAL DO CLIENTE — Acesso por CNPJ
// ============================================
import * as gesthub from './services/gesthub.js';

app.get('/api/portal/login/:cnpj', async (req, res) => {
  try {
    const cnpj = req.params.cnpj.replace(/\D/g, '');
    if (cnpj.length < 11) return res.status(400).json({ error: 'CNPJ/CPF inválido' });

    const clients = await gesthub.getClients();
    const client = clients.find(c => c.document?.replace(/\D/g, '') === cnpj);

    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

    res.json({
      id: client.id,
      name: client.legalName,
      tradeName: client.tradeName,
      document: client.document,
      regime: client.taxRegime,
      status: client.status,
      type: client.type,
      city: client.city,
      state: client.state,
      analyst: client.analyst || client.officeOwner,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/portal/client/:id', async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const [bootstrap, client360] = await Promise.all([
      gesthub.getBootstrap(),
      gesthub.getClient360(clientId).catch(() => null),
    ]);

    const client = bootstrap.clients.find(c => c.id === clientId);
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

    // Busca legalizações do cliente
    const legalizations = bootstrap.legalizations.filter(l => l.clientId === clientId);

    // Busca tasks relacionadas ao cliente no Átrio
    const { rows: tasks } = await query(
      `SELECT t.title, t.status, t.priority, t.created_at, t.completed_at,
              tm.name as assigned_name
       FROM tasks t
       LEFT JOIN team_members tm ON t.assigned_to = tm.id
       WHERE t.client_id = $1
       ORDER BY t.created_at DESC LIMIT 10`,
      [clientId.toString()]
    ).catch(() => ({ rows: [] }));

    res.json({
      profile: {
        id: client.id,
        name: client.legalName,
        tradeName: client.tradeName,
        document: client.document,
        regime: client.taxRegime,
        status: client.status,
        type: client.type,
        city: client.city,
        state: client.state,
        analyst: client.analyst || client.officeOwner,
        monthlyFee: client.monthlyFee,
        startDate: client.startDate,
        fatorR: client.fatorR,
      },
      legalizations: legalizations.map(l => ({
        id: l.id,
        processType: l.processType,
        status: l.status,
        organ: l.organ,
        protocol: l.protocol,
        openDate: l.openDate,
        expectedDate: l.expectedDate,
      })),
      tasks: tasks.map(t => ({
        title: t.title,
        status: t.status,
        priority: t.priority,
        assigned: t.assigned_name,
        date: t.created_at,
        completed: t.completed_at,
      })),
      client360: client360 || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// STATS — Dashboard KPIs
// ============================================
app.get('/api/stats', async (req, res) => {
  try {
    const [pending, blocked, todayConvs, sentiment] = await Promise.all([
      // Atendimentos pendentes — conversas WhatsApp abertas (não resolvidas)
      query(`SELECT COUNT(*) as count FROM whatsapp_conversations WHERE resolved = false`),
      // Alertas — tasks bloqueadas que precisam de ação
      query(`SELECT COUNT(*) as count FROM tasks WHERE status = 'blocked'`),
      // Conversas hoje — contatos do dia
      query(`SELECT COUNT(*) as count FROM whatsapp_conversations WHERE DATE(started_at) = CURRENT_DATE`),
      // Sentimento — média NPS das análises do dia (analysis JSONB contém nps_estimado)
      query(`SELECT
        AVG((analysis->>'nps_estimado')::numeric) as avg_nps,
        COUNT(*) FILTER (WHERE (analysis->>'sentimento_cliente') IN ('insatisfeito', 'irritado')) as negativos,
        COUNT(*) FILTER (WHERE analysis IS NOT NULL) as total_analisados
        FROM whatsapp_conversations
        WHERE DATE(started_at) >= CURRENT_DATE - INTERVAL '7 days' AND analysis IS NOT NULL`),
    ]);

    const sentData = sentiment.rows[0] || {};
    const avgNps = sentData.avg_nps ? parseFloat(parseFloat(sentData.avg_nps).toFixed(1)) : null;

    res.json({
      pendentes: parseInt(pending.rows[0]?.count || 0),
      alertas: parseInt(blocked.rows[0]?.count || 0),
      conversas_hoje: parseInt(todayConvs.rows[0]?.count || 0),
      sentimento: {
        nps_medio: avgNps,
        negativos: parseInt(sentData.negativos || 0),
        total_analisados: parseInt(sentData.total_analisados || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AGENT CHAT — Log de interações entre agentes
// ============================================
const agentChatLog = []; // In-memory (últimas 100 interações)
const MAX_CHAT_LOG = 100;

export function logAgentChat(msg) {
  const entry = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), timestamp: new Date().toISOString(), ...msg };
  agentChatLog.push(entry);
  if (agentChatLog.length > MAX_CHAT_LOG) agentChatLog.shift();
  broadcast({ type: 'agent_chat', message: entry });
}

app.get('/api/agent-chat', (req, res) => {
  res.json({ messages: agentChatLog });
});

// CEO envia mensagem no chat da equipe → agente responde via IA
app.post('/api/agent-chat', async (req, res) => {
  const { text, to } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Texto obrigatório' });

  // Loga mensagem do CEO
  logAgentChat({ from: 'Caio', to: to || null, text: text.trim(), tag: 'ceo' });

  // Encontra agente alvo (mencionado ou Rodrigo por padrão)
  const targetName = to || detectAgentMention(text) || 'Rodrigo';

  try {
    const { rows: agents } = await query('SELECT * FROM agents WHERE name ILIKE $1 LIMIT 1', [targetName]);
    if (!agents.length) {
      logAgentChat({ from: 'Sistema', text: `Agente "${targetName}" não encontrado.`, tag: 'erro' });
      return res.json({ ok: true, agentResponse: null });
    }

    const agent = agents[0];

    // Monta contexto: últimas mensagens do chat + pergunta do CEO
    const recentChat = agentChatLog.slice(-20).map(m => `${m.from}: ${m.text}`).join('\n');
    const prompt = `Você está no chat interno da equipe do Átrio Contabilidade. O CEO Caio acabou de enviar uma mensagem para você.

CONTEXTO DAS ÚLTIMAS MENSAGENS:
${recentChat}

MENSAGEM DO CEO CAIO: ${text.trim()}

Responda de forma direta e útil. Se ele perguntou sobre uma tarefa ou resultado, explique com clareza. Seja conciso (2-3 frases).`;

    // Chat da equipe: com tools para que o agente possa executar ações reais
    const response = await chatWithAgent(agent, [{ role: 'user', content: prompt }], executeToolCall);

    const agentText = response.success
      ? (response.text || 'Processado.')
      : 'Desculpe, não consegui processar no momento.';

    logAgentChat({ from: agent.name, to: 'Caio', text: agentText });

    res.json({ ok: true, agentResponse: agentText });
  } catch (err) {
    console.error('[AgentChat] Erro ao responder CEO:', err.message);
    logAgentChat({ from: 'Sistema', text: `Erro ao processar: ${err.message}`, tag: 'erro' });
    res.json({ ok: true, agentResponse: null });
  }
});

function detectAgentMention(text) {
  const names = ['Rodrigo', 'Campelo', 'Sneijder', 'Luna', 'Sofia', 'Valência', 'Valencia', 'Maia'];
  const lower = text.toLowerCase();
  for (const name of names) {
    if (lower.includes(name.toLowerCase())) return name === 'Valencia' ? 'Valência' : name;
  }
  return null;
}

// ============================================
// HTTP + WEBSOCKET SERVER
// ============================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('[WS] Cliente conectado');
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    console.log('[WS] Mensagem recebida:', msg.type);
  });
  ws.on('close', () => console.log('[WS] Cliente desconectado'));
});

// Broadcast para todos os clients WS
export function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// ============================================
// WHATSAPP — Luna
// ============================================
import * as whatsapp from './services/whatsapp.js';
import * as telegram from './services/telegram.js';
import * as omie from './services/omie.js';
import { scheduleDailyReport, generateDailyReport } from './services/daily-report.js';
import * as scheduler from './services/scheduler.js';
import { startCronScheduler, registerCronHandler, executeCronJob, getCronHandler } from './services/cronScheduler.js';
import { checkInadimplencia, checkContasPagar, checkSemHonorario, checkAlertasFiscais, checkDadosIncompletos } from './services/scheduler.js';
import agentsRouter from './routes/agents.mjs';

app.get('/api/whatsapp/status', (req, res) => {
  res.json(whatsapp.getStatus());
});

app.get('/api/whatsapp/qr', (req, res) => {
  const qr = whatsapp.getQRCode();
  if (!qr) return res.json({ hasQR: false, message: 'Nenhum QR disponível. WhatsApp pode já estar conectado.' });
  res.json({ hasQR: true, qr });
});

// Gerar relatório executivo sob demanda
app.post('/api/daily-report', async (req, res) => {
  try {
    const report = await generateDailyReport();
    if (report) {
      res.json({ report: report.substring(0, 500) });
    } else {
      res.json({ error: 'Não foi possível gerar o relatório — verifique se o agente Rodrigo está configurado.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/pending', (req, res) => {
  res.json(whatsapp.getPendingMessages());
});

app.post('/api/whatsapp/send', async (req, res) => {
  const { phone, message } = req.body;
  try {
    await whatsapp.sendMessage(phone, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/conversations', async (req, res) => {
  // Conversas ativas (memória) ou históricas (banco)
  const { history } = req.query;
  if (history === 'true') {
    try {
      const { rows } = await query(`
        SELECT c.*,
          (SELECT COUNT(*) FROM whatsapp_messages WHERE conversation_id = c.id) as message_count,
          (SELECT body FROM whatsapp_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
        FROM whatsapp_conversations c
        ORDER BY started_at DESC LIMIT 50
      `);
      return res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json(whatsapp.getPendingMessages());
});

// Histórico de mensagens de uma conversa específica
app.get('/api/whatsapp/conversations/:id/messages', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT sender, body, metadata, created_at FROM whatsapp_messages WHERE conversation_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Métricas dos agentes
app.get('/api/metrics', async (req, res) => {
  const { agent, days = 7 } = req.query;
  try {
    const params = [parseInt(days) || 7];
    let sql = `SELECT agent_name, event_type, COUNT(*) as total FROM agent_metrics WHERE created_at > NOW() - INTERVAL '1 day' * $1`;
    if (agent) { params.push(agent); sql += ` AND agent_name = $${params.length}`; }
    sql += ` GROUP BY agent_name, event_type ORDER BY total DESC`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/mark-replied/:phone', (req, res) => {
  const ok = whatsapp.markAsReplied(req.params.phone);
  res.json({ success: ok });
});

app.post('/api/whatsapp/conversations/:phone/resolve', (req, res) => {
  whatsapp.resolveConversation(req.params.phone);
  broadcast({ type: 'whatsapp_resolved', phone: req.params.phone });
  res.json({ success: true });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    await whatsapp.destroy();
    broadcast({ type: 'whatsapp_disconnected' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/reconnect', async (req, res) => {
  try {
    await whatsapp.destroy();
    // Responde imediato — initialize sobe Puppeteer e QR chega via WebSocket
    res.json({ success: true, message: 'Reconectando... QR Code será enviado via WebSocket.' });
    whatsapp.initialize().catch(err => console.error('[WhatsApp] Falha ao reconectar:', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Luna v2 - Agents API
// === MEMORY ROUTES ===
// GET /api/memory - List all approved memories
app.get('/api/memory', async (req, res) => {
  try {
    const { status = 'approved', agent, category, search, limit = 100 } = req.query;
    let sql = `SELECT m.*, a.name as agent_name, a.role as agent_role 
               FROM memories m 
               LEFT JOIN agents a ON m.agent_id = a.id 
               WHERE 1=1`;
    const params = [];
    
    if (status && status !== 'all') { params.push(status); sql += ` AND m.status = $${params.length}::memory_status`; }
    if (agent) { params.push(agent); sql += ` AND a.name ILIKE $${params.length}`; }
    if (category) { params.push(category); sql += ` AND m.category = $${params.length}::memory_category`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (m.title ILIKE $${params.length} OR m.content ILIKE $${params.length} OR m.summary ILIKE $${params.length})`; }
    
    params.push(parseInt(limit));
    sql += ` ORDER BY m.priority DESC, m.updated_at DESC LIMIT $${params.length}`;
    
    const result = await query(sql, params);
    
    // Stats
    const stats = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'approved') as active,
        COUNT(*) FILTER (WHERE status = 'draft' OR status = 'pending_review') as pending_review,
        COUNT(*) as total
      FROM memories
    `);
    
    res.json({ 
      memories: result.rows,
      stats: stats.rows[0] || { active: 0, pending_review: 0, total: 0 }
    });
  } catch (error) {
    console.error('[Memory] Erro ao listar:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/memory/suggestions - List pending suggestions for review
app.get('/api/memory/suggestions', async (req, res) => {
  try {
    const { status = 'pending', limit = 50 } = req.query;
    const result = await query(
      `SELECT ms.*, a.name as agent_name 
       FROM memory_suggestions ms 
       LEFT JOIN agents a ON ms.agent_id = a.id 
       WHERE ms.review_status = $1::suggestion_status
       ORDER BY ms.priority_score DESC, ms.created_at DESC 
       LIMIT $2`,
      [status, parseInt(limit)]
    );
    res.json({ suggestions: result.rows });
  } catch (error) {
    console.error('[Memory] Erro suggestions:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/memory/suggestions/:id/approve - Approve a suggestion
app.post('/api/memory/suggestions/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body || {};
    
    // Get the suggestion
    const sugResult = await query('SELECT * FROM memory_suggestions WHERE id = $1', [id]);
    if (sugResult.rows.length === 0) return res.status(404).json({ error: 'Suggestion not found' });
    const suggestion = sugResult.rows[0];
    
    // Create memory from suggestion
    const memResult = await query(
      `INSERT INTO memories (agent_id, scope_type, category, title, content, summary, source_type, source_ref, confidence_score, status, tags)
       VALUES ($1, 'agent', $2, $3, $4, $5, $6, $7, $8, 'approved', $9) RETURNING *`,
      [suggestion.agent_id, suggestion.category || 'general', suggestion.title, 
       suggestion.proposed_content, suggestion.proposed_summary,
       suggestion.trigger_type || 'manual', suggestion.trigger_ref,
       suggestion.confidence_score || 0.8, suggestion.tags || '{}']
    );
    
    // Update suggestion status
    await query(
      `UPDATE memory_suggestions SET review_status = 'approved', review_notes = $1, reviewed_at = now(), promoted_memory_id = $2 WHERE id = $3`,
      [notes || 'Approved', memResult.rows[0].id, id]
    );
    
    // Audit log
    await query(
      `INSERT INTO memory_audit_log (memory_id, action, performed_by, details) VALUES ($1, 'created_from_suggestion', 'admin', $2)`,
      [memResult.rows[0].id, JSON.stringify({ suggestion_id: id })]
    ).catch(() => {});
    
    res.json({ success: true, memory: memResult.rows[0] });
  } catch (error) {
    console.error('[Memory] Erro ao aprovar:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/memory/suggestions/:id/reject - Reject a suggestion
app.post('/api/memory/suggestions/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body || {};
    await query(
      `UPDATE memory_suggestions SET review_status = 'rejected', review_notes = $1, reviewed_at = now() WHERE id = $2`,
      [notes || 'Rejected', id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('[Memory] Erro ao rejeitar:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/memory/teach - Teach something new to an agent
app.post('/api/memory/teach', async (req, res) => {
  try {
    const { agent_id, category = 'general', title, content, summary, tags = [] } = req.body;
    if (!content || !title) return res.status(400).json({ error: 'title e content obrigatorios' });
    
    const result = await query(
      `INSERT INTO memories (agent_id, scope_type, category, title, content, summary, source_type, status, tags, confidence_score)
       VALUES ($1, CASE WHEN $1 IS NULL THEN 'team' ELSE 'agent' END, $2::memory_category, $3, $4, $5, 'manual', 'approved', $6, 1.0) RETURNING *`,
      [agent_id || null, category, title, content, summary || '', tags]
    );
    
    res.status(201).json({ memory: result.rows[0] });
  } catch (error) {
    console.error('[Memory] Erro ao ensinar:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/memory/:id - Update a memory
app.put('/api/memory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, summary, category, tags, status } = req.body;
    
    const updates = [];
    const params = [];
    
    if (title !== undefined) { params.push(title); updates.push(`title = $${params.length}`); }
    if (content !== undefined) { params.push(content); updates.push(`content = $${params.length}`); }
    if (summary !== undefined) { params.push(summary); updates.push(`summary = $${params.length}`); }
    if (category !== undefined) { params.push(category); updates.push(`category = $${params.length}::memory_category`); }
    if (tags !== undefined) { params.push(tags); updates.push(`tags = $${params.length}`); }
    if (status !== undefined) { params.push(status); updates.push(`status = $${params.length}::memory_status`); }
    
    updates.push('updated_at = now()');
    params.push(id);
    
    const result = await query(
      `UPDATE memories SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Memory not found' });
    res.json({ memory: result.rows[0] });
  } catch (error) {
    console.error('[Memory] Erro ao atualizar:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/memory/:id - Archive a memory (soft delete)
app.delete('/api/memory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await query(`UPDATE memories SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('[Memory] Erro ao arquivar:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/memory/audit - Audit log of memory changes
app.get('/api/memory/audit', async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const result = await query(
      `SELECT mal.*, m.title as memory_title, a.name as agent_name
       FROM memory_audit_log mal 
       LEFT JOIN memories m ON mal.memory_id = m.id
       LEFT JOIN agents a ON m.agent_id = a.id
       ORDER BY mal.created_at DESC LIMIT $1`,
      [parseInt(limit)]
    );
    res.json({ audit: result.rows });
  } catch (error) {
    console.error('[Memory] Erro audit:', error);
    // Return empty if table structure differs
    res.json({ audit: [] });
  }
});

// POST /api/memory/triggers/run - Run memory triggers (scan for auto-suggestions)
app.post('/api/memory/triggers/run', async (req, res) => {
  try {
    // Count pending suggestions
    const pending = await query(`SELECT COUNT(*) as count FROM memory_suggestions WHERE review_status = 'pending'`);
    res.json({ 
      success: true, 
      message: 'Triggers executados',
      pending_suggestions: parseInt(pending.rows[0]?.count || 0)
    });
  } catch (error) {
    console.error('[Memory] Erro triggers:', error);
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/memory/luna-facts', async (req, res) => {
  try {
    const { client, search, status, area, areas, tipos, limit = 200 } = req.query;
    let sql = `SELECT m.id, m.tipo, m.titulo, m.conteudo, m.agent_id, m.client_id, m.area,
                      m.tags, m.prioridade, m.confianca, m.uso_count, m.status,
                      m.is_rag_enabled, m.trigger_type, m.trigger_ref,
                      m.created_at, m.updated_at, m.last_used_at,
                      COALESCE(c.nome_fantasia, c.nome_legal, c2.nome_fantasia, c2.nome_legal) AS client_name,
                      COALESCE(c.cnpj, c2.cnpj) AS client_cnpj,
                      conv.phone AS conversation_phone,
                      conv.id AS conversation_id
               FROM luna_v2.memories m
               LEFT JOIN luna_v2.clients c ON c.id = m.client_id
               LEFT JOIN luna_v2.conversations conv ON conv.id::text = m.trigger_ref
               LEFT JOIN luna_v2.clients c2 ON c2.id = conv.client_id
               WHERE 1=1`;
    const params=[];
    if (client) { params.push(client); sql += ` AND COALESCE(c.nome_fantasia, c.nome_legal) ILIKE '%'||$${params.length}||'%'`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (m.titulo ILIKE $${params.length} OR m.conteudo ILIKE $${params.length})`; }
    if (status && status !== 'all') { params.push(status); sql += ` AND m.status = $${params.length}`; }
    const areaList = areas ? String(areas).split(',').filter(Boolean) : (area ? [area] : []);
    if (areaList.length) { params.push(areaList); sql += ` AND m.area = ANY($${params.length}::text[])`; }
    const tipoList = tipos ? String(tipos).split(',').filter(Boolean) : [];
    if (tipoList.length) { params.push(tipoList); sql += ` AND m.tipo = ANY($${params.length}::text[])`; }
    params.push(parseInt(limit));
    sql += ` ORDER BY m.updated_at DESC LIMIT $${params.length}`;
    const r = await query(sql, params);
    const stats = await query(`SELECT
      COUNT(*) FILTER (WHERE status='ativa') AS ativa,
      COUNT(*) FILTER (WHERE status='pending') AS pending,
      COUNT(*) FILTER (WHERE last_used_at IS NULL AND created_at < now() - interval '30 days') AS stale,
      COUNT(DISTINCT client_id) AS clients,
      COUNT(*) AS total FROM luna_v2.memories`);
    res.json({ facts: r.rows, stats: stats.rows[0] });
  } catch (e) { console.error('[LunaFacts]', e); res.status(500).json({ error: e.message }); }
});
app.use('/api/luna', agentsRouter);

import { registerCostsOpenRouter } from './routes/costs-openrouter.js';
app.use(express.text({ type: 'text/csv', limit: '50mb' }));
registerCostsOpenRouter(app);
import { registerMemoryCrud } from './routes/memory-crud.js';
registerMemoryCrud(app);
import { registerAdminCleanup } from './routes/admin-cleanup.js';
import { registerDatalake } from './routes/datalake.js';
import { registerMemoryReflect } from './routes/memory-reflect.js';
import { registerSentiment } from './routes/sentiment.js';
import { registerLunaHealth } from './routes/luna-health.js';
registerAdminCleanup(app);
registerDatalake(app);
registerMemoryReflect(app);
registerSentiment(app);
registerLunaHealth(app);

// ============================================
// SPA FALLBACK — Serve index.html para rotas do frontend
// ============================================
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).json({ error: 'Not found' });
  });
});

// ============================================
// ORCHESTRATOR — Processa tasks pendentes
// ============================================
app.get('/api/scheduler/prazos', async (req, res) => {
  try {
    const alertas = await scheduler.checkPrazosFiscais();
    res.json({ total: alertas.length, alertas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scheduler/inadimplencia', async (req, res) => {
  try {
    await scheduler.checkInadimplencia();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/run', async (req, res) => {
  try {
    const count = await processPendingTasks();
    res.json({ processed: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// STARTUP
// ============================================
startWatchdog();
server.listen(PORT, () => {
  // Conecta orchestrator ao broadcast e ao registry
  setBroadcast(broadcast);
  setLogChat(logAgentChat);
  setOnTaskCreated((taskId) => processTask(taskId));

  // Inicializa WhatsApp (Luna) — conecta broadcast + processamento de tasks
  whatsapp.setBroadcast(broadcast);
  whatsapp.setLogChat(logAgentChat);
  whatsapp.setOnTaskCreated((taskId) => processTask(taskId));
  whatsapp.initialize().catch(err => console.error('[WhatsApp] Falha:', err.message));

  // Loop periódico: processa tasks pendentes a cada 30s (safety net)
  setInterval(() => {
    processPendingTasks().then(count => {
      if (count > 0) console.log(`[Orchestrator] ${count} tasks pendentes processadas (loop)`);
    }).catch(() => {});
  }, 30000);

  // Telegram Bot — desativado por enquanto (ativar se necessário)
  // telegram.initialize(process.env.TELEGRAM_BOT_TOKEN).catch(err => console.error('[Telegram] Falha:', err.message));

  // Agenda relatório diário do Rodrigo (18h)
  scheduleDailyReport();

  // Limpeza automática — tasks concluídas/canceladas > 7 dias
  setInterval(async () => {
    try {
      const { rowCount } = await query(`DELETE FROM tasks WHERE status IN ('done', 'cancelled') AND completed_at < NOW() - INTERVAL '7 days'`);
      if (rowCount > 0) console.log(`[Cleanup] ${rowCount} tasks antigas removidas`);
    } catch {}
  }, 6 * 3600 * 1000); // a cada 6h

  // Inicia scheduler (verificações automáticas às 8h)
  scheduler.start();

  // ============================================
  // CRON SCHEDULER — Register handlers and start
  // ============================================
  registerCronHandler('health_check', async () => {
    const start = Date.now()
    await query('SELECT 1')
    const dbLatency = Date.now() - start
    const waStatus = whatsapp.getStatus()
    const omieOk = omie.isConfigured() ? 'configured' : 'not configured'
    return `Database OK (${dbLatency}ms), WhatsApp: ${waStatus.connected ? 'connected' : 'disconnected'}, Omie: ${omieOk}`
  })

  registerCronHandler('omie_sync', async () => {
    if (!omie.isConfigured()) return 'Omie not configured — skipped'
    const inadimplentes = await checkInadimplencia()
    const contas = await checkContasPagar()
    return `Omie sync: ${inadimplentes.length} inadimplentes, ${contas.length} contas a pagar`
  })

  registerCronHandler('gesthub_sync', async () => {
    const clients = await gesthub.getClients()
    const semHonorario = await checkSemHonorario()
    const incompletos = await checkDadosIncompletos()
    return `Gesthub sync: ${clients.length} clientes, ${semHonorario.length} sem honorario, ${incompletos.length} incompletos`
  })

  registerCronHandler('relatorio_diario', async () => {
    const report = await generateDailyReport()
    return report ? 'Relatorio diario gerado' : 'Nenhuma atividade para reportar'
  })

  registerCronHandler('backup_db', async () => {
    return 'Backup placeholder (paused by default — configure pg_dump externally)'
  })

  registerCronHandler('limpeza_logs', async () => {
    const msgs = await query("DELETE FROM messages WHERE created_at < NOW() - INTERVAL '90 days'")
    const tasks = await query("DELETE FROM tasks WHERE status IN ('done', 'cancelled') AND completed_at < NOW() - INTERVAL '30 days'")
    const runs = await query("DELETE FROM cron_runs WHERE started_at < NOW() - INTERVAL '90 days'")
    return `Limpeza: ${msgs.rowCount || 0} mensagens, ${tasks.rowCount || 0} tasks, ${runs.rowCount || 0} cron runs removidos`
  })

  startCronScheduler().catch(err => console.error('[CRON] Failed to start:', err.message))

  console.log(`\n⬡ Átrio Office Server rodando na porta ${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`  WS:  ws://localhost:${PORT}/ws`);
  console.log(`  Orchestrator: ativo`);
  console.log(`  WhatsApp: inicializando...\n`);

  // Processa tasks pendentes ao iniciar
  processPendingTasks().then(count => {
    if (count > 0) console.log(`[Orchestrator] ${count} tasks pendentes processadas no startup`);
  }).catch(() => {});
});

// Dara Orquestrador - Auto-correção
import('./services/dara-orquestrador.cjs').then(m => (m.default || m).iniciar()).catch(e => console.log('[Dara] optional:', e.message));

// Start task processor worker
import('./workers/task-processor.cjs').catch(e => console.log('[Worker] optional:', e.message));
