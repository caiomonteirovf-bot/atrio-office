import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { tenantMiddleware } from './services/tenant-context.js';
import { query } from './db/pool.js';
import { chatWithAgent, extractText } from './services/claude.js';
import { humanizeError } from './services/error-humanizer.js';
import { startWatchdog } from './services/luna-watchdog.js';
import { startRegressionDetector, runDetector } from './services/luna-regression-detector.js';
import { executeToolCall, setOnTaskCreated } from './tools/registry.js';
import { processTask, processPendingTasks, setBroadcast, setLogChat, recoverStrandedTasks } from './services/orchestrator.js';
import { syncAgentsFromFiles } from './services/agent-loader.js';
import { createNotification } from './services/notifications.js';

dotenv.config();
installGlobalHandlers();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3010;

import { securityHeaders, rateLimitGeneral, rateLimitApi } from './services/security.js';

// Headers de segurança HTTP — antes de tudo
app.use(securityHeaders);
// Rate limit geral (600/min por IP) — frente 7 baseline
app.use(rateLimitGeneral);
// Rate limit mais apertado em /api (240/min)
app.use('/api', rateLimitApi);

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(express.json({ limit: '30mb' }));  // 30mb pra base64 de anexos (PDFs ~20mb)
app.use(tenantMiddleware);  // multi-tenancy: X-Atrio-Tenant header ou DEFAULT_TENANT_ID

// SSO compartilhado com Gesthub (cookie httpOnly + JWT mesmo SECRET)
import { attachUser, requireAuth } from './middleware/auth.js';
app.use(attachUser);

app.get('/api/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Nao autenticado' });
  try {
    const r = await fetch('http://gesthub-app:8000/api/auth/me', {
      headers: { Cookie: req.headers.cookie || '' },
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(503).json({ error: 'Gesthub auth indisponivel: ' + e.message });
  }
});

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
app.post('/api/luna/regression-scan', async (_req, res) => { try { const r = await runDetector({ hours: 24 }); res.json({ ok: true, ...r }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/health/llm', async (req, res) => {
  try {
    const { health } = await import('./services/llm-gateway.js');
    res.json({ status: 'ok', ...health() });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

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
// SECURITY — kill-switch agente→cliente
// ============================================
app.get('/api/security/agent-outbound-status', async (req, res) => {
  try {
    const envEnabled = process.env.AGENT_CLIENT_OUTBOUND === 'on'
    const { rows: ovr } = await query("SELECT value FROM app_settings WHERE key = 'agent_client_outbound'")
    const dbEnabled = ovr[0]?.value?.enabled === true
    const enabled = envEnabled || dbEnabled
    const { rows } = await query(
      `SELECT
          COUNT(*) FILTER (WHERE blocked_at > NOW() - INTERVAL '24 hours')::int AS total_24h,
          COUNT(*) FILTER (WHERE blocked_at > NOW() - INTERVAL '7 days')::int AS total_7d,
          COUNT(*)::int AS total_alltime
         FROM agent_outbound_blocks`
    ).catch(() => ({ rows: [{ total_24h: 0, total_7d: 0, total_alltime: 0 }] }))
    res.json({
      kill_switch_active: !enabled,
      agent_outbound_enabled: enabled,
      source: envEnabled ? 'env' : (dbEnabled ? 'db' : null),
      blocks_24h: rows[0].total_24h,
      blocks_7d: rows[0].total_7d,
      blocks_total: rows[0].total_alltime,
      updated_by: ovr[0]?.value?.updated_by || null,
      updated_at: ovr[0]?.value?.updated_at || null,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/security/agent-outbound-toggle', async (req, res) => {
  try {
    const { enabled, by } = req.body || {}
    const val = !!enabled
    const updatedAt = new Date().toISOString()
    const meta = { enabled: val, updated_by: by || 'caio', updated_at: updatedAt }
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ('agent_client_outbound', $1::jsonb, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [JSON.stringify(meta), by || 'caio']
    )
    // Atualiza no servico em memoria
    const ws = await import('./services/whatsapp.js')
    ws.setAgentOutboundOverride?.(val)

    // Audit + notificacao
    await createNotification({
      type: 'kill_switch_toggle',
      title: val ? '🔓 Agentes liberados pra falar com clientes' : '🔒 Kill-switch ATIVADO — agentes nao falam com clientes',
      message: `Mudanca aplicada por ${by || 'caio'} as ${new Date().toLocaleString('pt-BR')}`,
      severity: val ? 'warning' : 'info',
      metadata: { handler: 'agent_outbound_toggle', enabled: val, by },
      push: { tag: 'kill-switch' },
    })
    res.json({ ok: true, enabled: val })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/security/agent-outbound-blocks', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const { rows } = await query(
      `SELECT id, chat_id, suggested_text, blocked_at, redirected_to_group
         FROM agent_outbound_blocks
        ORDER BY blocked_at DESC LIMIT $1`,
      [limit]
    )
    res.json({ ok: true, total: rows.length, blocks: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ============================================
// EXPIRING DATA — agrega TUDO que vence (cert NFS-e, docs clientes, contratos)
// para o banner de alerta global na TopBar.
// Severities:
//   - vencido: ja venceu (data <= hoje)
//   - critico: <= 7 dias
//   - atencao: <= 30 dias
// ============================================
app.get('/api/expiring-data', async (req, res) => {
  const out = { items: [], counts: { vencido: 0, critico: 0, atencao: 0 } }
  const now = new Date()
  const daysBetween = (d) => Math.floor((new Date(d).getTime() - now.getTime()) / 86400000)
  const classify = (days) => days < 0 ? 'vencido' : days <= 7 ? 'critico' : days <= 30 ? 'atencao' : null

  // 1) Certificado NFS-e proprio (Atrio)
  try {
    const NFSE = process.env.NFSE_SYSTEM_URL || 'http://31.97.175.200:3020'
    const r = await fetch(`${NFSE}/api/prestador`)
    const j = await r.json()
    const p = j?.data
    if (p?.certificadoValidade) {
      const days = daysBetween(p.certificadoValidade)
      const sev = classify(days)
      if (sev) {
        out.items.push({
          id: 'nfse-cert',
          severity: sev,
          category: 'certificado',
          title: `Certificado A1 ${p.razaoSocial}`,
          subtitle: days < 0 ? `venceu ha ${Math.abs(days)}d` : `vence em ${days}d`,
          dueDate: p.certificadoValidade,
          daysUntil: days,
          system: 'nfse',
          url: 'http://31.97.175.200:3020',
        })
        out.counts[sev]++
      }
    }
  } catch (e) { console.error('[expiring/nfse]', e.message) }

  // 2) Contratos de clientes com data_fim proxima
  try {
    const { rows: contratos } = await query(
      `SELECT ct.id, ct.numero_contrato, ct.data_fim, ct.valor_mensal,
              c.legal_name, c.trade_name
         FROM datalake_gesthub.contratos ct
         JOIN datalake_gesthub.clients c ON c.id = ct.cliente_id
        WHERE ct.ativo = TRUE
          AND ct.data_fim IS NOT NULL
          AND ct.data_fim <= CURRENT_DATE + INTERVAL '30 days'`
    ).catch(() => ({ rows: [] }))
    for (const ct of contratos) {
      const days = daysBetween(ct.data_fim)
      const sev = classify(days)
      if (!sev) continue
      out.items.push({
        id: `contrato-${ct.id}`,
        severity: sev,
        category: 'contrato_honorarios',
        title: `Contrato ${ct.numero_contrato} — ${ct.trade_name || ct.legal_name}`,
        subtitle: days < 0 ? `expirou ha ${Math.abs(days)}d (R$ ${ct.valor_mensal}/mes)` : `expira em ${days}d (R$ ${ct.valor_mensal}/mes)`,
        dueDate: ct.data_fim,
        daysUntil: days,
        system: 'gesthub',
        url: 'http://31.97.175.200/contratos',
      })
      out.counts[sev]++
    }
  } catch (e) { console.error('[expiring/contratos]', e.message) }

  // 3) Documentos de clientes (Gesthub)
  try {
    const GH = process.env.GESTHUB_API_URL || 'http://31.97.175.200'
    const r = await fetch(`${GH}/api/client-files/expiring?days=30`)
    const j = await r.json()
    const docs = Array.isArray(j?.data) ? j.data : []
    for (const d of docs) {
      const days = d.diasParaVencer
      const sev = classify(days)
      if (!sev) continue
      out.items.push({
        id: `gesthub-doc-${d.id}`,
        severity: sev,
        category: 'documento_cliente',
        title: `${d.nome} — ${d.clientName}`,
        subtitle: days < 0 ? `venceu ha ${Math.abs(days)}d (${d.categoria})` : `vence em ${days}d (${d.categoria})`,
        dueDate: d.dataVencimento || d.validade,
        daysUntil: days,
        system: 'gesthub',
        url: `http://31.97.175.200/clientes/${d.clientId}`,
      })
      out.counts[sev]++
    }
  } catch (e) { console.error('[expiring/gesthub]', e.message) }

  // Ordena: vencido > critico > atencao, depois por daysUntil asc
  const order = { vencido: 0, critico: 1, atencao: 2 }
  out.items.sort((a, b) => order[a.severity] - order[b.severity] || a.daysUntil - b.daysUntil)
  res.json(out)
})

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


// GET /api/mission-control — snapshot agregado de tudo que importa no Escritório
app.get('/api/mission-control', async (req, res) => {
  const tenant = req.tenant_id || 'atrio';
  try {
    const [active, pending, blocked, recentDone] = await Promise.all([
      query(`
        SELECT t.id, t.title, t.status, t.priority, t.created_at, t.updated_at,
               tm.name AS assigned_name,
               EXTRACT(EPOCH FROM (NOW() - t.updated_at))/60 AS age_min,
               t.result->>'text' AS text_preview
          FROM tasks t
          LEFT JOIN team_members tm ON t.assigned_to = tm.id
         WHERE t.status = 'in_progress' AND t.tenant_id = $1
         ORDER BY t.updated_at DESC
         LIMIT 10
      `, [tenant]),
      query(`
        SELECT t.id, t.title, t.priority, t.created_at,
               tm.name AS assigned_name, tm.type AS assigned_type,
               EXTRACT(EPOCH FROM (NOW() - t.created_at))/60 AS waiting_min
          FROM tasks t
          LEFT JOIN team_members tm ON t.assigned_to = tm.id
         WHERE t.status = 'pending' AND t.tenant_id = $1
         ORDER BY
           CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           t.created_at ASC
         LIMIT 15
      `, [tenant]),
      query(`
        SELECT t.id, t.title, t.priority, t.updated_at,
               tm.name AS assigned_name,
               t.result->>'error' AS erro,
               t.result->'tool_failures' AS tool_failures
          FROM tasks t
          LEFT JOIN team_members tm ON t.assigned_to = tm.id
         WHERE t.status = 'blocked' AND t.tenant_id = $1
         ORDER BY t.updated_at DESC
         LIMIT 10
      `, [tenant]),
      query(`
        SELECT t.id, t.title, t.completed_at, t.created_at,
               tm.name AS assigned_name,
               EXTRACT(EPOCH FROM (t.completed_at - t.created_at))/60 AS duration_min
          FROM tasks t
          LEFT JOIN team_members tm ON t.assigned_to = tm.id
         WHERE t.status = 'done' AND t.tenant_id = $1
           AND t.completed_at >= NOW() - INTERVAL '24 hours'
         ORDER BY t.completed_at DESC
         LIMIT 15
      `, [tenant]),
    ]);

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      active: active.rows,
      pending: pending.rows,
      blocked: blocked.rows,
      recent_done: recentDone.rows,
      totals: {
        active: active.rows.length,
        pending: pending.rows.length,
        blocked: blocked.rows.length,
        recent_done: recentDone.rows.length,
      },
    });
  } catch (err) {
    console.error('[MissionControl]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/blocked — lista detalhada de tasks bloqueadas com motivo
app.get('/api/tasks/blocked', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.title, t.status, t.priority, t.created_at, t.updated_at,
              tm.name AS assigned_name,
              t.result->>'error' AS erro,
              t.result->'tool_failures' AS tool_failures,
              t.result->>'retry_reason' AS last_retry,
              t.result->>'stranded_retries' AS stranded_retries,
              COALESCE(LEFT(t.result->>'text', 400), NULL) AS texto_resumo
         FROM tasks t
         LEFT JOIN team_members tm ON t.assigned_to = tm.id
        WHERE t.status = 'blocked'
        ORDER BY t.updated_at DESC
        LIMIT 100`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/unblock — volta task blocked → pending (orquestrador reprocessa)
app.post('/api/tasks/:id/unblock', async (req, res) => {
  try {
    const { note } = req.body || {};
    const { rows } = await query(
      `UPDATE tasks
          SET status = 'pending',
              result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
                'retry_reason', COALESCE($2, 'unblocked manualmente via UI'),
                'retried_at',  NOW(),
                'previous_error', COALESCE(result->>'error', '')
              )
        WHERE id = $1 AND status = 'blocked'
      RETURNING id, title, status`,
      [req.params.id, note || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task nao encontrada ou nao esta bloqueada' });

    // Dispara reprocessamento imediato em vez de esperar loop 30s
    setImmediate(() => {
      processTask(rows[0].id).catch(e => console.error('[unblock] falha reprocess:', e.message));
    });

    res.json({ ok: true, task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/cancel — cancela task permanentemente
app.post('/api/tasks/:id/cancel', async (req, res) => {
  try {
    const { note } = req.body || {};
    const { rows } = await query(
      `UPDATE tasks SET status = 'cancelled',
              completed_at = NOW(),
              result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('cancel_reason', $2::text, 'cancelled_at', NOW()::text)
        WHERE id = $1 AND status IN ('blocked', 'pending', 'in_progress') RETURNING id, title`,
      [req.params.id, note || 'cancelada manualmente via UI']
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Task nao encontrada ou nao cancelavel' });
    res.json({ ok: true, task: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/tasks/:id/manual-resolve — marca como done com nota manual
app.post('/api/tasks/:id/manual-resolve', async (req, res) => {
  try {
    const { note } = req.body || {};
    const { rows } = await query(
      `UPDATE tasks SET status = 'done',
              completed_at = NOW(),
              result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('manual_resolve_note', $2::text, 'manually_resolved_at', NOW()::text, 'manually_resolved_by', 'caio')
        WHERE id = $1 AND status IN ('blocked', 'pending', 'in_progress') RETURNING id, title`,
      [req.params.id, note || 'resolvida manualmente via UI']
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Task nao encontrada' });
    broadcast({ type: 'task_completed', task: rows[0] });
    res.json({ ok: true, task: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/tasks/:id/reassign — muda assigned_to (humano ou outro agente)
app.post('/api/tasks/:id/reassign', async (req, res) => {
  try {
    const { assigned_to, note } = req.body || {};
    if (!assigned_to) return res.status(400).json({ ok: false, error: 'assigned_to obrigatorio' });
    const { rows } = await query(
      `UPDATE tasks SET assigned_to = $2, status = 'pending',
              result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('reassigned_at', NOW()::text, 'reassign_note', $3::text)
        WHERE id = $1 RETURNING id, title, assigned_to`,
      [req.params.id, assigned_to, note || 'reassigned via UI']
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Task nao encontrada' });
    broadcast({ type: 'task_updated', task: rows[0] });
    res.json({ ok: true, task: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT t.*, tm.name as assigned_name, tm.type as assigned_type, d.name as delegated_name, c.name as client_name FROM tasks t LEFT JOIN team_members tm ON t.assigned_to = tm.id LEFT JOIN team_members d ON t.delegated_by = d.id LEFT JOIN clients c ON t.client_id = c.id WHERE t.id = $1 LIMIT 1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Task não encontrada' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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

    // Notification: nova tarefa criada + push (alta/urgente so)
    const shouldPush = newTask.priority === 'high' || newTask.priority === 'urgent';
    createNotification({
      type: 'task_created',
      title: 'Nova tarefa criada',
      message: `${newTask.title}${assigned_to ? ` → ${assigned_to}` : ''}`,
      severity: 'info',
      taskId: newTask.id,
      metadata: { priority: newTask.priority, assigned_to },
      push: shouldPush ? { url: `/?task=${newTask.id}`, tag: `task-${newTask.id}` } : false,
    }).catch(() => {});

    res.status(201).json(newTask);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/:id/export-csv — baixa CSV com os CNPJs/clientes listados no description
app.get('/api/tasks/:id/export-csv', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await query('SELECT id, title, description FROM tasks WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Task não encontrada' });
    const task = rows[0];

    // Parse description linha-a-linha: cada linha que comeca com "-" é um item
    const items = String(task.description || '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('-'))
      .map(l => l.replace(/^-\s*/, ''));

    // Extrai CNPJ/CPF + nome + "falta: ..." — suporta 2 formatos:
    //   A) "42.864.557 NOME DO CLIENTE — falta: email, telefone"
    //   B) "NOME DO CLIENTE (42.864.557/0001-10)"
    //   C) "NOME DO CLIENTE (05811705476)"  (CPF 11 digitos)
    const linhas = items.map(line => {
      // Procura primeiro um CNPJ COMPLETO (com /xxxx-dd) ou CPF dentro de parenteses
      const fullCnpj = line.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);
      const cpfMatch = line.match(/(\d{3}\.\d{3}\.\d{3}-\d{2})/);
      // Raiz CNPJ (8 digitos formatados) quando nao tem o completo
      const rootCnpj = !fullCnpj && !cpfMatch ? line.match(/^(\d{2}\.\d{3}\.\d{3})\s/) : null;
      const faltaMatch = line.match(/—\s*falta:\s*(.+)$/i);

      let doc = '';
      if (fullCnpj) doc = fullCnpj[1];
      else if (cpfMatch) doc = cpfMatch[1];
      else if (rootCnpj) doc = rootCnpj[1];

      // Nome: remove CNPJ/CPF e "— falta:..."
      let nome = line;
      nome = nome.replace(/\(?\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\)?/, '');
      nome = nome.replace(/\(?\d{3}\.\d{3}\.\d{3}-\d{2}\)?/, '');
      nome = nome.replace(/^\d{2}\.\d{3}\.\d{3}\s+/, '');
      nome = nome.replace(/—\s*falta:.*$/i, '');
      nome = nome.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();

      return { nome, doc, falta: faltaMatch ? faltaMatch[1].trim() : '' };
    });

    // Monta CSV
    const header = 'CNPJ/CPF,Nome,Campos Faltantes\n';
    const body = linhas.map(l =>
      `"${(l.doc || '').replace(/"/g, '""')}","${(l.nome || '').replace(/"/g, '""')}","${(l.falta || '').replace(/"/g, '""')}"`
    ).join('\n');
    const csv = '\uFEFF' + header + body; // BOM pra Excel ler UTF-8

    const safeTitle = String(task.title || 'task').replace(/[^\w.-]/g, '_').slice(0, 60);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/enrich — enriquece automaticamente os CNPJs listados no description
app.post('/api/tasks/:id/enrich', async (req, res) => {
  const { id } = req.params;
  try {
    const { enrichTaskById } = await import('./services/task-enricher.js');
    // Responde imediato; enrichment roda em background (20 CNPJs * 1.2s = 24s)
    res.json({ ok: true, message: 'Enriquecimento iniciado. Acompanhe em tasks.result.enrich.' });
    enrichTaskById(id, {
      rewriteDescription: req.body?.rewriteDescription !== false,
      completeIfAllOk: true,
      logToChat: async (msg) => {
        try { logAgentChat({ from: 'Sistema', text: msg, tag: 'enriquecimento' }); } catch {}
      },
    }).catch(e => console.error('[enrich] background falhou:', e.message));
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
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

      // Notification: tarefa concluída via API (push só se cliente aguarda — por ora, info apenas)
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

// POST /api/tasks/:id/approve — libera task que estava aguardando aprovacao humana.
// Flipa result.aguardando_aprovacao_humana=false, aprova metadata, e dispara processTask.
app.post('/api/tasks/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { aprovado_por, observacao, mensagem_override } = req.body || {};
  try {
    const { rows } = await query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Task nao encontrada' });
    const task = rows[0];
    if (task.status !== 'pending') {
      return res.status(409).json({ error: `Task ja esta ${task.status}, aprovacao so aplicavel em pending.` });
    }
    const currentResult = typeof task.result === 'string' ? JSON.parse(task.result || '{}') : (task.result || {});
    if (currentResult.aguardando_aprovacao_humana !== true) {
      return res.status(400).json({ error: 'Task nao esta aguardando aprovacao humana.' });
    }
    const approvedResult = {
      ...currentResult,
      aguardando_aprovacao_humana: false,
      aprovado_em: new Date().toISOString(),
      aprovado_por: aprovado_por || 'humano',
      aprovacao_observacao: observacao || null,
      ...(mensagem_override ? { mensagem_sugerida: mensagem_override } : {}),
    };
    await query(
      `UPDATE tasks SET result = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(approvedResult), id]
    );

    createNotification({
      type: 'approval_granted',
      title: 'Aprovacao concedida',
      message: `${task.title} liberada para execucao`,
      severity: 'success',
      taskId: id,
    }).catch(() => {});

    // Dispara processamento em background (orchestrator agora passa do guard).
    processTask(id).catch(err => console.error('[approve] processTask erro:', err.message));

    broadcast({ type: 'task_approved', task_id: id });
    res.json({ ok: true, task_id: id, status: 'approved_and_dispatched' });
  } catch (err) {
    console.error('[approve] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/reject — rejeita task que aguardava aprovacao humana.
app.post('/api/tasks/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { rejeitado_por, motivo } = req.body || {};
  try {
    const { rows } = await query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Task nao encontrada' });
    const task = rows[0];
    const currentResult = typeof task.result === 'string' ? JSON.parse(task.result || '{}') : (task.result || {});
    if (currentResult.aguardando_aprovacao_humana !== true) {
      return res.status(400).json({ error: 'Task nao esta aguardando aprovacao humana.' });
    }
    const rejectedResult = {
      ...currentResult,
      aguardando_aprovacao_humana: false,
      rejeitado_em: new Date().toISOString(),
      rejeitado_por: rejeitado_por || 'humano',
      motivo_rejeicao: motivo || null,
    };
    await query(
      `UPDATE tasks SET status = 'cancelled', result = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(rejectedResult), id]
    );
    broadcast({ type: 'task_rejected', task_id: id });
    res.json({ ok: true, task_id: id, status: 'cancelled' });
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
      // Atendimentos pendentes — conversas COM cliente aguardando resposta humana
      // (existe msg cliente sem resposta posterior de team/luna/bot).
      // Antes era "WHERE resolved=false" que contava conversas antigas em fantasma.
      query(`
        SELECT COUNT(DISTINCT c.id) as count
        FROM whatsapp_conversations c
        WHERE c.resolved = false
          AND EXISTS (
            SELECT 1 FROM whatsapp_messages m
            WHERE m.conversation_id = c.id AND m.sender = 'client'
              AND NOT EXISTS (
                SELECT 1 FROM whatsapp_messages m2
                WHERE m2.conversation_id = c.id
                  AND m2.sender IN ('team','luna','bot')
                  AND m2.created_at > m.created_at
              )
          )
      `),
      // Alertas — tasks bloqueadas que precisam de ação
      query(`SELECT COUNT(*) as count FROM tasks WHERE status = 'blocked'`),
      // Conversas hoje — distintas com mensagem hoje (cliente OU equipe).
      // Antes era DATE(started_at)=CURRENT_DATE que ignorava recorrentes.
      query(`
        SELECT COUNT(DISTINCT m.conversation_id) as count
        FROM whatsapp_messages m
        WHERE DATE(m.created_at) = CURRENT_DATE
      `),
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
      logAgentChat({ from: 'Sistema', text: `Não consegui achar um agente chamado "${targetName}" no escritório. Verifique o nome e tente de novo.`, tag: 'erro' });
      return res.json({ ok: true, agentResponse: null });
    }

    const agent = agents[0];

    // === RETROALIMENTACAO: busca tasks REAIS do agente nas ultimas 24h ===
    // Isso garante que o agente responde baseado no estado factual, NUNCA apenas
    // no que disse no chat (que pode ser otimista/incorreto). Inclui status + result
    // da task (o result contem tool_failures quando houve erro em tool interna).
    let tasksReais = '';
    try {
      const { rows: recentTasks } = await query(
        `SELECT t.title, t.status, t.completed_at, t.created_at,
                t.result->>'error'           AS erro,
                t.result->'tool_failures'    AS tool_failures,
                t.result->>'text'            AS texto_resumo
           FROM tasks t
           JOIN team_members tm ON t.assigned_to = tm.id
          WHERE tm.agent_id = $1
            AND t.created_at > NOW() - INTERVAL '24 hours'
          ORDER BY t.created_at DESC
          LIMIT 8`,
        [agent.id]
      );
      if (recentTasks.length) {
        tasksReais = '\n\nSUAS ULTIMAS TASKS (estado REAL do banco — NUNCA contradiga isso):\n' +
          recentTasks.map(t => {
            const marker = t.status === 'blocked' ? '🔴 BLOQUEADA/FALHOU'
                         : t.status === 'done'     ? '✅ concluida'
                         : t.status === 'in_progress' ? '⏳ em andamento'
                         : `· ${t.status}`;
            let linha = `${marker} | ${t.title}`;
            if (t.erro) linha += `\n    ↳ ERRO: ${String(t.erro).slice(0, 220)}`;
            if (t.tool_failures && Array.isArray(t.tool_failures) && t.tool_failures.length) {
              const tf = t.tool_failures[0];
              linha += `\n    ↳ tool "${tf.name || '?'}" falhou: ${String(tf.summary || '').slice(0, 180)}`;
            }
            return linha;
          }).join('\n');
      }
    } catch (e) {
      console.warn('[AgentChat] falha ao buscar tasks reais:', e.message);
    }

    // === RETROALIMENTACAO: busca memorias correctionss (erros passados aprendidos) ===
    let licoesAprendidas = '';
    try {
      const { rows: correcoes } = await query(
        `SELECT title, summary FROM memories
          WHERE agent_id = $1
            AND category IN ('correction'::memory_category, 'learned_pattern'::memory_category)
            AND status = 'approved'::memory_status
            AND is_rag_enabled = true
          ORDER BY priority DESC, updated_at DESC
          LIMIT 3`,
        [agent.id]
      );
      if (correcoes.length) {
        licoesAprendidas = '\n\nLICOES APRENDIDAS (aplicar SEMPRE):\n' +
          correcoes.map(c => `- ${c.title}: ${c.summary || ''}`).join('\n');
      }
    } catch {}

    // === RETROALIMENTACAO: conversas WhatsApp (essencial quando pergunta e sobre atendimento) ===
    // Se pergunta mencionar atendimento/conversa/WhatsApp/humano/intervencao OU nome de pessoa,
    // puxa contexto de conversas da luna_v2 para responder com base em dados REAIS.
    let whatsappContexto = '';
    try {
      const lowerTxt = text.toLowerCase();
      const isSobreAtendimento = /atendiment|conversa|whats|intervenc|humano|respond|cliente|atendeu|falou\s+com/i.test(lowerTxt);
      const mencionaNome = /\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]{2,})\b/.test(text);

      if (isSobreAtendimento || mencionaNome) {
        const palavras = text.match(/\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]{2,}\b/g) || [];
        const nomesPossiveis = palavras.filter(p => !['Caio','Luna','Rodrigo','Campelo','Sneijder','Sofia','Natalia','Saldanha','Andre','André'].includes(p));

        // Detecta numero de telefone na pergunta (6+ digitos)
        const phoneMatch = text.match(/\b(\d{6,})\b/);

        let filtroWhere = '';
        const params = [];
        if (phoneMatch) {
          // Filtro por telefone especifico (match parcial — inclusao)
          filtroWhere = ' AND c.phone ILIKE $1';
          params.push(`%${phoneMatch[1]}%`);
        } else if (nomesPossiveis.length > 0) {
          const term = nomesPossiveis[0];
          // Procura cliente luna por nome
          const { rows: matches } = await query(
            `SELECT id FROM luna_v2.clients WHERE nome_fantasia ILIKE $1 OR nome_legal ILIKE $1 LIMIT 3`,
            [`%${term}%`]
          ).catch(() => ({ rows: [] }));
          // Ou contato gesthub — acha pessoa no Gesthub e correlaciona com luna_v2 via gesthub_id
          if (matches.length === 0) {
            const { rows: gh } = await query(
              `SELECT DISTINCT cc.cliente_id, cc.telefone FROM datalake_gesthub.cliente_contatos cc
                WHERE cc.nome ILIKE $1 LIMIT 5`,
              [`%${term}%`]
            ).catch(() => ({ rows: [] }));
            if (gh.length > 0) {
              // tenta por gesthub_id em luna_v2.clients
              const ghIds = gh.map(r => r.cliente_id).filter(Boolean);
              if (ghIds.length > 0) {
                const { rows: lunaMatches } = await query(
                  `SELECT id FROM luna_v2.clients WHERE gesthub_id = ANY($1::int[])`, [ghIds]
                ).catch(() => ({ rows: [] }));
                matches.push(...lunaMatches);
              }
              // tenta por telefone direto em conversations
              const phones = gh.map(r => (r.telefone || '').replace(/\D/g, '')).filter(p => p.length >= 8);
              if (phones.length > 0) {
                // Aplica filtro por phone se nao achou cliente
                if (matches.length === 0) {
                  filtroWhere = ' AND (' + phones.map((_, i) => `c.phone ILIKE $${i + 1}`).join(' OR ') + ')';
                  params.push(...phones.map(p => `%${p}%`));
                }
              }
            }
          }
          // Tambem tenta colaboradores (Deyvison, Diogo, etc sao internos) e whatsapp_conversations.client_name
          if (matches.length === 0 && !filtroWhere) {
            const { rows: wac } = await query(
              `SELECT phone, real_phone FROM whatsapp_conversations WHERE client_name ILIKE $1 LIMIT 5`,
              [`%${term}%`]
            ).catch(() => ({ rows: [] }));
            const waPhones = [];
            for (const w of wac) {
              if (w.phone) waPhones.push(w.phone);
              if (w.real_phone) waPhones.push(w.real_phone);
            }
            const { rows: colabs } = await query(
              `SELECT telefone FROM datalake_gesthub.colaboradores WHERE nome ILIKE $1 AND telefone IS NOT NULL LIMIT 3`,
              [`%${term}%`]
            ).catch(() => ({ rows: [] }));
            const colPhones = colabs.map(c => (c.telefone || '').replace(/\D/g, '')).filter(p => p.length >= 8);
            const todos = [...new Set([...waPhones, ...colPhones])];
            if (todos.length > 0) {
              filtroWhere = ' AND (' + todos.map((_, i) => `c.phone ILIKE $${i + 1}`).join(' OR ') + ')';
              params.push(...todos.map(p => `%${p}%`));
            }
          }
          if (matches.length > 0 && !filtroWhere) {
            filtroWhere = ' AND c.client_id = ANY($1::uuid[])';
            params.push(matches.map(m => m.id));
          }
        }

        const { rows: stats } = await query(`
          SELECT
            c.id as conv_id,
            c.phone,
            c.attendance_status,
            c.last_message_at,
            c.last_human_reply_at,
            c.last_inbound_at,
            c.last_outbound_at,
            COALESCE(cli.nome_fantasia, cli.nome_legal, wac.client_name, '') as cliente_nome,
            wac.real_phone,
            wac.human_replied as wac_human_replied,
            wac.human_replied_at as wac_human_replied_at,
            (SELECT COUNT(*) FROM luna_v2.messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound') as inbound_count,
            (SELECT COUNT(*) FROM luna_v2.messages m WHERE m.conversation_id = c.id AND m.direction = 'outbound' AND m.sender_type = 'agent') as luna_count,
            (SELECT COUNT(*) FROM luna_v2.messages m WHERE m.conversation_id = c.id AND m.direction = 'outbound' AND m.sender_type = 'human') as human_count,
            (SELECT COUNT(*) FROM whatsapp_messages wm JOIN whatsapp_conversations wc2 ON wc2.id = wm.conversation_id WHERE wc2.phone = c.phone AND wm.sender = 'team') as wa_human_count
          FROM luna_v2.conversations c
          LEFT JOIN luna_v2.clients cli ON cli.id = c.client_id
          LEFT JOIN whatsapp_conversations wac ON wac.phone = c.phone
          WHERE c.last_message_at > NOW() - INTERVAL '30 days'${filtroWhere}
          ORDER BY c.last_message_at DESC
          LIMIT 10
        `, params).catch((e) => { console.warn('[AgentChat] whatsapp stats:', e.message); return { rows: [] }; });

        if (stats.length > 0) {
          whatsappContexto = '\n\nCONVERSAS WHATSAPP REAIS (evidencia factual — NUNCA contradiga):\n';
          for (const s of stats) {
            const identif = s.cliente_nome || s.phone;
            const humanMsgs = parseInt(s.human_count || 0);
            const waHumanMsgs = parseInt(s.wa_human_count || 0);
            const totalHumano = humanMsgs + waHumanMsgs;
            const lunaMsgs = parseInt(s.luna_count || 0);
            const inboundMsgs = parseInt(s.inbound_count || 0);
            const teveHumano = totalHumano > 0 || !!s.last_human_reply_at || !!s.wac_human_replied;

            whatsappContexto += `\n• ${identif} [${s.attendance_status || '?'}] phone=${s.phone}${s.real_phone ? ` (real: ${s.real_phone})` : ''}`;
            whatsappContexto += `\n  Mensagens: ${inboundMsgs} do cliente, ${lunaMsgs} da Luna, ${totalHumano} da equipe (humano)`;
            if (teveHumano) {
              const quando = s.last_human_reply_at || s.wac_human_replied_at;
              if (quando) {
                whatsappContexto += `\n  => HOUVE INTERVENCAO HUMANA — ultima em ${new Date(quando).toLocaleString('pt-BR')}`;
              } else {
                whatsappContexto += `\n  => HOUVE INTERVENCAO HUMANA (${totalHumano} msg da equipe)`;
              }
            } else {
              whatsappContexto += `\n  => Sem intervencao humana registrada na base (porem se usuario viu resposta no WA, pode ser falha de captura)`;
            }
            if (s.last_message_at) {
              whatsappContexto += `\n  Ultima msg: ${new Date(s.last_message_at).toLocaleString('pt-BR')}`;
            }

            const { rows: msgsRec } = await query(`
              SELECT direction, sender_type, agent_id, substring(content, 1, 180) as content, created_at
                FROM luna_v2.messages
               WHERE conversation_id = $1
               ORDER BY created_at DESC LIMIT 6
            `, [s.conv_id]).catch(() => ({ rows: [] }));
            if (msgsRec.length > 0) {
              whatsappContexto += `\n  Ultimas mensagens:`;
              for (const m of msgsRec.reverse()) {
                const quem = m.direction === 'inbound' ? 'CLIENTE'
                           : m.sender_type === 'human' ? 'EQUIPE(humano)'
                           : m.sender_type === 'agent' ? 'LUNA(bot)'
                           : 'outbound';
                whatsappContexto += `\n    [${quem}] ${(m.content || '').replace(/\n/g, ' ').slice(0, 180)}`;
              }
            }
          }
          whatsappContexto += '\n\nAo responder sobre intervencao humana: use os campos acima (human_count + last_human_reply_at). NAO diga "nao tenho registro" se a evidencia mostrar intervencao.';
        }
      }
    } catch (e) { console.warn('[AgentChat] whatsapp context fail:', e.message); }

    // Monta contexto: últimas mensagens do chat + pergunta do CEO
    const recentChat = agentChatLog.slice(-20).map(m => `${m.from}: ${m.text}`).join('\n');
    const prompt = `Você está no chat interno da equipe do Átrio Contabilidade. O CEO Caio acabou de enviar uma mensagem para você.

REGRA ABSOLUTA — ANTI-ALUCINACAO:
- JAMAIS afirme que emitiu, concluiu, enviou ou finalizou algo sem ter a evidencia factual abaixo.
- Se sua propria TASK estiver BLOQUEADA/FALHOU na secao "SUAS ULTIMAS TASKS", voce DEVE reportar isso honestamente — NUNCA dizer "sim, foi emitida".
- Se o CEO perguntar sobre status/resultado, sempre USE as tools disponiveis (ex: consultar_status_nfse) antes de afirmar.
- Se nao tem certeza, responda "deixa eu verificar" e chame a tool apropriada.${tasksReais}${licoesAprendidas}${whatsappContexto}

CONTEXTO DAS ULTIMAS MENSAGENS DO CHAT (pode estar desatualizado — confie no estado real das tasks/conversas acima):
${recentChat}

MENSAGEM DO CEO CAIO: ${text.trim()}

Responda de forma direta e honesta. Seja conciso (2-3 frases). Se ha falha/erro nas suas tasks recentes, COMECE a resposta reconhecendo o problema.`;

    // Chat da equipe: com tools para que o agente possa executar ações reais
    const response = await chatWithAgent(agent, [{ role: 'user', content: prompt }], executeToolCall);

    const agentText = response.success
      ? (response.text || 'Processado.')
      : 'Desculpe, não consegui processar no momento.';

    logAgentChat({ from: agent.name, to: 'Caio', text: agentText });

    res.json({ ok: true, agentResponse: agentText });
  } catch (err) {
    console.error('[AgentChat] Erro ao responder CEO:', err.message);
    logAgentChat({ from: 'Sistema', text: `Não consegui processar essa mensagem: ${humanizeError(err, { maxLen: 140 })}`, tag: 'erro' });
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
import { cleanupExpiredAttachments, formatBytes as fmtBytes } from './services/attachment-retention.js';
import * as pushSvc from './services/push.js';
import * as telegram from './services/telegram.js';
import * as omie from './services/omie.js';
import { scheduleDailyReport, generateDailyReport } from './services/daily-report.js';
import { scheduleAuditorDaily, generateAuditorReport } from './services/auditor-daily.js';
import { scheduleSaldanhaDaily, generateSaldanhaReport } from './services/saldanha-daily.js';
import { feriadosDoAno, checarFeriado } from './services/feriados.js';
import * as scheduler from './services/scheduler.js';
import { startCronScheduler, registerCronHandler, executeCronJob, getCronHandler } from './services/cronScheduler.js';
import { checkInadimplencia, checkContasPagar, checkSemHonorario, checkAlertasFiscais, checkDadosIncompletos } from './services/scheduler.js';
import agentsRouter from './routes/agents.mjs';


// ============================================
// /api/atendimento/daily-summary — auditoria do dia
// Junta atendimento + tasks + extratos (do Atrio Finance) num so payload.
// Util pra responder: "o que foi solicitado/resolvido hoje?" e
// "todos os extratos enviados foram encaminhados pro Finance?"
// ============================================
// Helper compartilhado: computa o daily-summary pra um dado date YYYY-MM-DD.
// Usado tanto pelo GET /daily-summary quanto pelo POST /daily-summary/narrate.
async function computeDailySummary(date) {
    // 1) Atendimento (whatsapp_conversations)
    const atendQ = await query(`
      SELECT
        COUNT(*) FILTER (WHERE started_at::date = $1::date AND COALESCE(is_group,false) = false) AS abertas_hoje,
        COUNT(*) FILTER (WHERE resolved_at::date = $1::date AND COALESCE(is_group,false) = false) AS resolvidas_hoje,
        COUNT(*) FILTER (WHERE COALESCE(resolved,false) = false
                         AND COALESCE(human_replied,false) = false
                         AND COALESCE(is_group,false) = false) AS ainda_aguardando,
        COUNT(*) FILTER (WHERE resolved_at::date = $1::date
                         AND COALESCE(resolution_reason,'') ILIKE '%auto%'
                         AND COALESCE(is_group,false) = false) AS auto_resolvidas
      FROM whatsapp_conversations
    `, [date]);

    // 2) Tasks
    const tasksQ = await query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at::date = $1::date) AS criadas,
        COUNT(*) FILTER (WHERE status = 'done' AND updated_at::date = $1::date) AS concluidas,
        COUNT(*) FILTER (WHERE status = 'blocked' AND updated_at::date = $1::date) AS bloqueadas
      FROM tasks
    `, [date]);

    // 3) Extratos (chama Atrio Finance internamente)
    let extratos = {
      auto_importados: 0,
      em_fila_aprovacao: 0,
      total: 0,
      lista: [],
      error: null,
    };
    try {
      const FINANCE_URL = process.env.ATRIO_FINANCE_URL || process.env.BANKING_URL || 'http://atrio-banking-system-1:3000';
      const isToday = (iso) => typeof iso === 'string' && iso.slice(0, 10) === date;
      const fetchJSON = async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Finance ${url} HTTP ${r.status}`);
        return r.json();
      };
      const [uplResp, pendResp] = await Promise.all([
        fetchJSON(`${FINANCE_URL}/api/uploads`).catch(e => ({ data: [], _err: e.message })),
        fetchJSON(`${FINANCE_URL}/api/extratos-pending`).catch(e => ({ data: [], _err: e.message })),
      ]);
      const errs = [uplResp._err, pendResp._err].filter(Boolean);
      if (errs.length) extratos.error = errs.join('; ');

      const uploads = Array.isArray(uplResp.data) ? uplResp.data : [];
      const pending = Array.isArray(pendResp.data) ? pendResp.data : [];

      const todayUploads = uploads.filter(u => isToday(u.createdAt || u.created_at));
      const todayPending = pending.filter(p => isToday(p.createdAt || p.created_at));

      extratos.auto_importados = todayUploads.filter(u => (u.status || '').toLowerCase() === 'imported').length;
      extratos.em_fila_aprovacao = todayPending.length;
      extratos.total = todayUploads.length + todayPending.length;
      extratos.lista = [
        ...todayUploads.map(u => ({
          source: 'imported',
          id: u.id,
          filename: u.filename,
          status: u.status,
          transacoes: u.transacoesCount ?? u.transacoes_count ?? null,
          clienteId: u.clienteGesthubId ?? u.cliente_gesthub_id ?? null,
          createdAt: u.createdAt || u.created_at,
        })),
        ...todayPending.map(p => ({
          source: 'pending',
          id: p.id,
          filename: p.filename || p.original_filename,
          status: 'pending_approval',
          motivo: p.observacoes || null,
          clienteId: p.cliente_gesthub_id_sugerido || p.cliente_gesthub_id || null,
          recebidoVia: p.recebido_via || null,
          recebidoNome: p.recebido_nome || null,
          createdAt: p.createdAt || p.created_at,
        })),
      ].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    } catch (e) {
      extratos.error = e.message;
    }

    return {
      date,
      generated_at: new Date().toISOString(),
      atendimento: atendQ.rows[0] || {},
      tasks: tasksQ.rows[0] || {},
      extratos,
    };
}

// GET /api/atendimento/daily-summary — usado pelo drawer
app.get('/api/atendimento/daily-summary', async (req, res) => {
  let date = (req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = new Date().toISOString().slice(0, 10);
  }
  try {
    const data = await computeDailySummary(date);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/atendimento/daily-summary/narrate — Rodrigo (LLM) gera briefing
// executivo do dia. Latencia tipica 3-15s. Retorna { ok, text, summary }.
app.post('/api/atendimento/daily-summary/narrate', async (req, res) => {
  let date = (req.body?.date || req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = new Date().toISOString().slice(0, 10);
  }
  try {
    const summary = await computeDailySummary(date);
    const a = summary.atendimento || {};
    const t = summary.tasks || {};
    const ex = summary.extratos || {};

    const ext_problemas = (ex.lista || [])
      .filter(it => it.source === 'pending')
      .slice(0, 5)
      .map(it => `  - ${it.filename || '(sem nome)'} — motivo: ${it.motivo || 'cliente/conta a confirmar'}`)
      .join('\n');

    const RODRIGO_AGENT_ID = 'a0000001-0000-0000-0000-000000000001';
    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [RODRIGO_AGENT_ID]);
    if (!agents.length) {
      return res.status(500).json({ ok: false, error: 'Rodrigo nao encontrado no banco' });
    }

    const prompt = `Voce eh Rodrigo, Diretor de Operacoes do Atrio Office.
O CEO (Caio) quer um briefing rapido do dia ${date}.

NUMEROS:

ATENDIMENTO WHATSAPP
- Conversas abertas hoje: ${a.abertas_hoje || 0}
- Resolvidas: ${a.resolvidas_hoje || 0}
- Ainda aguardando resposta: ${a.ainda_aguardando || 0}
- Auto-resolvidas (cliente sinalizou ou timeout): ${a.auto_resolvidas || 0}

TASKS DA EQUIPE
- Criadas: ${t.criadas || 0}
- Concluidas: ${t.concluidas || 0}
- Bloqueadas: ${t.bloqueadas || 0}

EXTRATOS BANCARIOS (Atrio Finance)
- Recebidos hoje: ${ex.total || 0}
- Importados automaticamente: ${ex.auto_importados || 0}
- Em fila de aprovacao (precisa humano confirmar cliente/conta): ${ex.em_fila_aprovacao || 0}
${ext_problemas ? '\nExtratos pendentes detalhados:\n' + ext_problemas : ''}

Gere um briefing executivo em portugues do Brasil:
1. UMA frase abrindo (dia produtivo, gargalos, dia leve, etc)
2. 3-5 bullets curtos e diretos com observacoes/insights — NAO repita numeros, interprete-os
3. UMA acao recomendada para amanha se houver gargalo, senao omita

Tom: direto, executivo. Sem markdown elaborado, sem emojis em excesso.
Maximo 200 palavras.`;

    const { chatWithAgent } = await import('./services/claude.js');
    const response = await chatWithAgent(
      { ...agents[0], tools: [] },
      [{ role: 'user', content: prompt }]
    );

    if (!response?.success || !response?.text) {
      return res.status(502).json({ ok: false, error: 'Rodrigo nao respondeu', detail: response?.error || null });
    }

    res.json({ ok: true, text: response.text, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/whatsapp/status', async (req, res) => {
  try {
    const s = await whatsapp.getStatusLive();
    res.json(s);
  } catch (e) {
    // fallback para o status estatico se a verificacao live falhar
    res.json(whatsapp.getStatus());
  }
});

app.get('/api/whatsapp/health', async (req, res) => {
  try {
    const h = await whatsapp.getHealthStatus();
    res.json(h);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/whatsapp/qr', (req, res) => {
  const qr = whatsapp.getQRCode();
  if (!qr) return res.json({ hasQR: false, message: 'Nenhum QR disponível. WhatsApp pode já estar conectado.' });
  res.json({ hasQR: true, qr });
});

/**
 * POST /api/whatsapp/resync-chats
 * Resgata mensagens que ficaram offline (celular tem mas Office nao tem).
 * Itera todas as conversas ativas e busca as ultimas N msgs de cada via
 * whatsapp-web.js. Dedupe por wa_msg_id (nao duplica).
 *
 * Body opcional: { limit_per_chat: 30, only_recent_hours: 48 }
 * Resposta: stats { conversations_scanned, messages_fetched, messages_inserted, errors }
 */
app.post('/api/whatsapp/resync-chats', async (req, res) => {
  try {
    const result = await whatsapp.resyncChatHistory(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/whatsapp/repair-attachments
 * Repara msgs que vieram do resync sem anexo baixado (has_media:true mas
 * attachment IS NULL). Itera ate 100 msgs e baixa cada attachment.
 */
app.post('/api/whatsapp/repair-attachments', async (_req, res) => {
  try {
    const result = await whatsapp.repairResyncAttachments();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});



/**
 * GET /api/whatsapp/pairing-status — diagnostico do guard de pareamentos.
 * Mostra quantos QRs foram gerados nas ultimas 24h e ultimos eventos do log.
 */
app.get('/api/whatsapp/pairing-status', async (req, res) => {
  try {
    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS attempts_24h FROM wa_pairing_log
        WHERE event_type = 'pairing_attempt'
          AND created_at > NOW() - INTERVAL '24 hours'`
    );
    const { rows: lastEvents } = await query(
      `SELECT event_type, phone, metadata, created_at FROM wa_pairing_log
        ORDER BY created_at DESC LIMIT 10`
    );
    const qrCount = parseInt(countRows[0]?.attempts_24h || 0, 10);
    const limit = 5;
    res.json({
      window_hours: 24,
      attempts_count: qrCount,
      attempts_limit: limit,
      remaining: Math.max(0, limit - qrCount),
      blocked: qrCount >= limit,
      bypass_enabled: process.env.WA_BYPASS_PAIRING_GUARD === 'true',
      last_events: lastEvents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/whatsapp/pairing-reset — limpa contador (apos coordenacao com user).
 * Use APENAS quando voce confirma que NAO ha risco de ban (ex: pareou em outro
 * numero e quer voltar pro original com contador limpo).
 * Body: { confirm: 'I_UNDERSTAND_BAN_RISK' }
 */
app.post('/api/whatsapp/pairing-reset', async (req, res) => {
  if (req.body?.confirm !== 'I_UNDERSTAND_BAN_RISK') {
    return res.status(400).json({
      error: 'Confirme com body: { confirm: "I_UNDERSTAND_BAN_RISK" }',
      warning: 'Limpar contador NAO impede ban server-side se voce ja excedeu limite',
    });
  }
  try {
    await query(`DELETE FROM wa_pairing_log WHERE event_type = 'pairing_attempt' AND created_at > NOW() - INTERVAL '24 hours'`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /qr — pagina HTML standalone com o QR Code em tela cheia.
 * Ignora bundle React/Service Worker/cache. Para emergencias de pareamento.
 * Auto-refresh a cada 3s.
 */
app.get('/qr', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<title>WhatsApp QR — Atrio Office</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #f8faff;
    color: #0f172a;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  h1 { font-size: 24px; font-weight: 800; margin-bottom: 8px; }
  .sub { font-size: 14px; color: #475569; margin-bottom: 24px; text-align: center; max-width: 480px; }
  .card {
    background: white;
    padding: 24px;
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    border: 1px solid #e2e8f0;
  }
  #qr-img { width: 320px; height: 320px; display: block; }
  .status {
    margin-top: 20px;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .status.waiting { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
  .status.ok { background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; }
  .status.err { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
  .help {
    margin-top: 24px;
    font-size: 12px;
    color: #64748b;
    text-align: center;
    line-height: 1.6;
    max-width: 360px;
  }
  .help b { color: #0f172a; }
  .pulse {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f59e0b;
    margin-right: 6px;
    animation: pulse 1s infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
</head>
<body>
  <h1>WhatsApp Atrio Office</h1>
  <p class="sub">Escaneie o QR Code abaixo com o WhatsApp do escritorio</p>
  <div class="card">
    <img id="qr-img" alt="QR Code" />
  </div>
  <div id="status" class="status waiting"><span class="pulse"></span><span id="status-text">Carregando QR...</span></div>
  <div class="help">
    No celular: <b>WhatsApp</b> &rarr; menu (3 pontos) &rarr; <b>Aparelhos conectados</b> &rarr; <b>Conectar aparelho</b><br><br>
    Esta pagina recarrega o QR a cada 3 segundos automaticamente.
  </div>
<script>
let connected = false;
async function refresh() {
  if (connected) return;
  try {
    const s = await fetch('/api/whatsapp/status', { cache: 'no-store' }).then(r => r.json());
    if (s.connected) {
      connected = true;
      document.getElementById('qr-img').style.display = 'none';
      const st = document.getElementById('status');
      st.className = 'status ok';
      document.getElementById('status-text').textContent = '✓ Conectado: +' + s.phone;
      return;
    }
    if (s.hasQR) {
      const q = await fetch('/api/whatsapp/qr', { cache: 'no-store' }).then(r => r.json());
      if (q.hasQR) {
        document.getElementById('qr-img').src = q.qr;
        document.getElementById('status-text').textContent = 'Aguardando voce escanear...';
      }
    } else {
      document.getElementById('status-text').textContent = 'Inicializando WhatsApp...';
    }
  } catch (e) {
    const st = document.getElementById('status');
    st.className = 'status err';
    document.getElementById('status-text').textContent = 'Erro: ' + e.message;
  }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
// qr-fullscreen marker


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
  const { phone, message, from_name } = req.body;
  try {
    // manual=true bypassa o kill-switch agente→cliente (humano via painel).
    // from_name: nome do colaborador logado no Gesthub (vai gravado em metadata).
    await whatsapp.sendMessage(phone, message, { manual: true, fromName: from_name || null });
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
          (SELECT body FROM whatsapp_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
          (SELECT sender FROM whatsapp_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_sender,
          (SELECT MAX(created_at) FROM whatsapp_messages WHERE conversation_id = c.id AND sender = 'client') as last_client_at,
          link.gesthub_client_id as linked_client_id,
          link.relacao as linked_relacao,
          link.contato_funcao as linked_contato_funcao,
          (
            SELECT m.created_at
              FROM whatsapp_messages m
             WHERE m.conversation_id = c.id AND m.sender = 'client'
               AND NOT EXISTS (
                 SELECT 1 FROM whatsapp_messages m2
                  WHERE m2.conversation_id = c.id
                    AND m2.sender IN ('team','luna','bot')
                    AND m2.created_at > m.created_at
               )
             ORDER BY m.created_at DESC LIMIT 1
          ) as waiting_since
        FROM whatsapp_conversations c
        LEFT JOIN LATERAL (
          SELECT gesthub_client_id, relacao, contato_funcao
            FROM whatsapp_conversation_clients wcc
           WHERE wcc.conversation_id = c.id
           ORDER BY wcc.is_primary DESC, wcc.created_at ASC
           LIMIT 1
        ) link ON true
        ORDER BY COALESCE(c.last_message_at, c.started_at) DESC
        LIMIT 200
      `);

      // Resolve nome do cliente vinculado (Gesthub) em batch
      const linkedIds = [...new Set(rows.map(r => r.linked_client_id).filter(Boolean).map(Number))];
      let clientsMap = {};
      if (linkedIds.length) {
        try {
          const { getClients } = await import('./services/gesthub.js');
          const all = await getClients();
          clientsMap = Object.fromEntries(
            (all || [])
              .filter(c => linkedIds.includes(Number(c.id)))
              .map(c => [Number(c.id), c])
          );
        } catch (e) { /* sem nome — front exibe id */ }
      }
      const enriched = rows.map(r => {
        if (!r.linked_client_id) return r;
        const client = clientsMap[Number(r.linked_client_id)];
        return {
          ...r,
          linked_client_name: client?.legalName || client?.tradeName || null,
        };
      });
      return res.json(enriched);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json(whatsapp.getPendingMessages());
});



/**
 * POST /api/admin/recover-attachments/:conversation_id
 * Tenta re-baixar anexos perdidos via WhatsApp Web (re-fetch). So funciona pra
 * msgs ainda no cache do whatsapp-web.js (algumas semanas).
 *
 * Retorna: { tried, recovered, failed, errors[] }
 */
app.post('/api/admin/recover-attachments/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;
    const fs = await import('fs');

    const { rows } = await query(`
      SELECT id, metadata
        FROM whatsapp_messages
       WHERE conversation_id = $1
         AND metadata->'attachment'->>'storage_path' IS NOT NULL
    `, [conversation_id]);

    const targets = [];
    for (const r of rows) {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
      const storage = meta?.attachment?.storage_path;
      const waId = meta?.wa_msg_id;
      if (!storage || !waId) continue;
      if (fs.existsSync(storage)) continue;
      targets.push({ message_id: r.id, wa_msg_id: waId, storage_path: storage });
    }

    if (targets.length === 0) {
      return res.json({ ok: true, tried: 0, recovered: 0, failed: 0, message: 'nada perdido nesta conversa' });
    }

    const wa = await import('./services/whatsapp.js');
    let recovered = 0;
    let failed = 0;
    const errors = [];

    for (const t of targets) {
      try {
        const r = await wa.recoverAttachmentByWaId(t.wa_msg_id, t.storage_path);
        if (r.ok) recovered++;
        else { failed++; errors.push({ wa_msg_id: t.wa_msg_id.slice(0, 40), error: r.error }); }
      } catch (e) {
        failed++;
        errors.push({ wa_msg_id: t.wa_msg_id.slice(0, 40), error: e.message });
      }
      await new Promise(r => setTimeout(r, 250));
    }

    res.json({ ok: true, tried: targets.length, recovered, failed, errors: errors.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/whatsapp/conversations/:id/snooze
 * Body: { until: ISO datetime } OU { preset: '1h'|'4h'|'tomorrow'|'friday'|'7d' }
 *       optional: { reason: string }
 */
app.post('/api/whatsapp/conversations/:id/snooze', async (req, res) => {
  try {
    const { id } = req.params;
    const { until, preset, reason } = req.body || {};
    let target;
    if (preset) {
      const now = new Date();
      switch (String(preset).toLowerCase()) {
        case '1h':       target = new Date(now.getTime() + 60 * 60 * 1000); break;
        case '4h':       target = new Date(now.getTime() + 4 * 60 * 60 * 1000); break;
        case 'tomorrow': {
          // amanha as 9h (horario de Recife)
          const t = new Date(now);
          t.setDate(t.getDate() + 1);
          t.setHours(12, 0, 0, 0); // 12 UTC = 9h BRT
          target = t;
          break;
        }
        case 'friday': {
          // proxima sexta as 9h BRT
          const t = new Date(now);
          const day = t.getDay(); // 0=dom, 5=sex
          const daysUntilFriday = (5 - day + 7) % 7 || 7;
          t.setDate(t.getDate() + daysUntilFriday);
          t.setHours(12, 0, 0, 0);
          target = t;
          break;
        }
        case '7d':       target = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); break;
        default: return res.status(400).json({ error: 'preset invalido (use 1h|4h|tomorrow|friday|7d)' });
      }
    } else if (until) {
      target = new Date(until);
      if (isNaN(target.getTime())) return res.status(400).json({ error: 'until invalido (ISO datetime)' });
    } else {
      return res.status(400).json({ error: 'fornecer preset ou until' });
    }
    if (target <= new Date()) {
      return res.status(400).json({ error: 'data deve ser futura' });
    }

    const { rows } = await query(
      `UPDATE whatsapp_conversations
          SET snoozed_until = $2, snoozed_at = NOW(), snoozed_reason = $3
        WHERE id = $1
        RETURNING id, snoozed_until, snoozed_at, snoozed_reason`,
      [id, target.toISOString(), (reason || '').slice(0, 120) || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'conversa nao encontrada' });

    broadcast({ type: 'conversation_snoozed', conversation_id: id, snoozed_until: target.toISOString() });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/whatsapp/conversations/:id/unsnooze
 * Cancela snooze ativo (volta a conversa pra fila normal).
 */
app.post('/api/whatsapp/conversations/:id/unsnooze', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `UPDATE whatsapp_conversations
          SET snoozed_until = NULL, snoozed_at = NULL, snoozed_reason = NULL
        WHERE id = $1
        RETURNING id`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'conversa nao encontrada' });
    broadcast({ type: 'conversation_unsnoozed', conversation_id: id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico de mensagens de uma conversa específica
app.get('/api/whatsapp/conversations/:id/messages', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, sender, body, metadata, created_at FROM whatsapp_messages WHERE conversation_id = $1 ORDER BY created_at`,
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

app.post('/api/whatsapp/conversations/:phone/resolve', async (req, res) => {
  try {
    const result = await whatsapp.resolveConversation(req.params.phone);
    if (!result?.ok) {
      return res.status(404).json({ success: false, error: result?.error || 'Conversa nao encontrada' });
    }
    broadcast({ type: 'whatsapp_resolved', phone: req.params.phone, count: result.count });
    res.json({ success: true, count: result.count, conversations: result.conversations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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

// ============================================
// Atendimento — integração com Gesthub (painel direito da conversa)
// ============================================

/**
 * GET /api/atendimento/conversation/:id/client-context
 * Retorna dados do cliente vinculado + histórico rápido pra exibir no painel direito.
 * Se a conversa nao esta linkada, retorna { linked: false }.
 */
app.get('/api/atendimento/conversation/:id/client-context', async (req, res) => {
  try {
    const { id } = req.params;
    // 1) Busca a conversa e o client_id vinculado
    const { rows: convRows } = await query(
      `SELECT id, phone, real_phone, client_name, gesthub_client_id, contact_type, contact_label, contact_details
       FROM whatsapp_conversations WHERE id = $1`,
      [id]
    );
    if (!convRows.length) return res.status(404).json({ error: 'conversa nao encontrada' });
    const conv = convRows[0];

    // 2) Busca TODOS os clientes vinculados (N:M via whatsapp_conversation_clients)
    const { rows: links } = await query(
      `SELECT gesthub_client_id, is_primary, relacao, contato_funcao FROM whatsapp_conversation_clients WHERE conversation_id = $1 ORDER BY is_primary DESC, created_at ASC`,
      [id]
    );

    // Fallback retro: se ja tem gesthub_client_id mas junction vazia, considera o existente
    const linkedIds = links.length
      ? links.map(l => Number(l.gesthub_client_id))
      : (conv.gesthub_client_id ? [Number(conv.gesthub_client_id)] : []);

    if (linkedIds.length === 0) {
      return res.json({ linked: false, conversation: conv, clients: [] });
    }

    const { getClients, getBootstrap } = await import('./services/gesthub.js');
    const allClients = await getClients();
    const linkedClients = linkedIds.map(cid => allClients.find(c => Number(c.id) === cid)).filter(Boolean);
    if (linkedClients.length === 0) {
      return res.json({ linked: false, conversation: conv, warning: 'client_ids invalidos', clients: [] });
    }

    // Anexa info do vinculo (relacao + contato_funcao) em cada cliente
    const linkInfoById = {};
    for (const l of links) {
      linkInfoById[Number(l.gesthub_client_id)] = {
        relacao: l.relacao || null,
        contato_funcao: l.contato_funcao || null,
        is_primary: !!l.is_primary,
      };
    }
    for (const c of linkedClients) {
      const info = linkInfoById[Number(c.id)];
      if (info) {
        c.relacao = info.relacao;
        c.contato_funcao = info.contato_funcao;
        c.is_primary = info.is_primary;
      }
    }
    const primary = linkedClients[0]; // primeiro = primary
    // Vinculo principal (pode ser satelite)
    const primaryLink = links[0] ? {
      client_id: Number(links[0].gesthub_client_id),
      is_primary: !!links[0].is_primary,
      relacao: links[0].relacao || null,
      contato_funcao: links[0].contato_funcao || null,
    } : null;

    // 3) Badges + legalizacoes + onboardings somente do primary (compat retro)
    let badges = null;
    try {
      const r = await fetch(`http://localhost:3010/api/datalake/cliente-badges?ids=${linkedClients.map(c => c.id).join(',')}`);
      if (r.ok) {
        const j = await r.json();
        badges = j?.[String(primary.id)] || null;
      }
    } catch { /* ignora */ }

    const bs = await getBootstrap().catch(() => ({}));
    const docs = linkedClients.map(c => String(c.document || '').replace(/\D/g, '')).filter(Boolean);
    const legalizacoes = (bs?.legalizations || []).filter(l => docs.includes(String(l.document || '').replace(/\D/g, '')));
    const onboardings = (bs?.onboardings || []).filter(o => linkedIds.includes(Number(o.clienteId)));

    // 4) Observacoes/notas importantes do primary (Gesthub /clients/:id/360)
    let observacoes = [];
    try {
      const GESTHUB_URL = process.env.GESTHUB_URL || 'http://gesthub-app:8000';
      const r360 = await fetch(`${GESTHUB_URL}/api/clients/${primary.id}/360`);
      if (r360.ok) {
        const d = await r360.json();
        // Filtra apenas obs com texto util e ordena por data desc
        observacoes = (d?.data?.observacoes || [])
          .filter(o => o && (o.descricao || o.texto) && String(o.descricao || o.texto).trim().length >= 8)
          .slice(0, 8); // top 8 mais recentes
      }
    } catch (e) {
      console.warn('[client-context] obs Gesthub falhou:', e.message);
    }

    res.json({
      linked: true,
      conversation: conv,
      client: primary,           // compat retro: primeiro cliente como client
      clients: linkedClients,    // NOVO: array de todos os vinculados (com relacao/contato_funcao)
      primaryLink,               // NOVO: vinculo principal (pode ser satelite)
      badges,
      legalizacoes,
      onboardings,
      observacoes,               // NOVO: notas/observacoes do Gesthub 360
    });
  } catch (err) {
    console.error('[client-context] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});


/**
 * POST /api/atendimento/conversation/:id/add-observation
 * Cria uma observacao no Gesthub para o cliente vinculado a esta conversa.
 * Body: { descricao, tipo?, autor? }
 *  - descricao: obrigatorio
 *  - tipo: 'nota' | 'alerta' (default: 'nota')
 *  - autor: nome de quem registrou (default: 'Atendimento WhatsApp')
 *
 * Funciona tanto pra vinculo direto (cliente Atrio) quanto satelite (tomador, socio, etc).
 * Em vinculo satelite, a observacao vai pro cliente Atrio relacionado, com prefixo no autor.
 */
app.post('/api/atendimento/conversation/:id/add-observation', async (req, res) => {
  try {
    const { id } = req.params;
    const { descricao, tipo, autor } = req.body || {};
    if (!descricao || !String(descricao).trim()) {
      return res.status(400).json({ error: 'descricao obrigatoria' });
    }
    // Busca cliente vinculado (prioriza primary, senao primeiro da junction)
    const { rows: links } = await query(
      `SELECT gesthub_client_id, is_primary, relacao, contato_funcao
         FROM whatsapp_conversation_clients
        WHERE conversation_id = $1
        ORDER BY is_primary DESC, created_at ASC
        LIMIT 1`,
      [id]
    );
    let clientId = links[0]?.gesthub_client_id;
    let satelite = null;
    if (links[0]?.relacao) {
      satelite = { relacao: links[0].relacao, contato_funcao: links[0].contato_funcao };
    }
    // Fallback retro: gesthub_client_id direto na conversa
    if (!clientId) {
      const { rows: convRows } = await query(
        `SELECT gesthub_client_id FROM whatsapp_conversations WHERE id = $1`, [id]
      );
      clientId = convRows[0]?.gesthub_client_id;
    }
    if (!clientId) {
      return res.status(400).json({ error: 'conversa nao tem cliente vinculado — vincule antes de registrar observacao' });
    }
    // Monta autor: se satelite, anota a relacao no autor (auditoria)
    let finalAutor = (autor || '').trim() || 'Atendimento WhatsApp';
    if (satelite) {
      finalAutor = finalAutor + ` (via conversa com ${satelite.relacao}${satelite.contato_funcao ? ': ' + satelite.contato_funcao : ''})`;
    }
    const GH = process.env.GESTHUB_API_URL || process.env.GESTHUB_URL || 'http://31.97.175.200';
    const r = await fetch(`${GH}/api/clients/${clientId}/observacoes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        descricao: String(descricao).trim(),
        tipo: tipo || 'nota',
        autor: finalAutor,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        error: data?.detail || data?.error || `Gesthub HTTP ${r.status}`,
      });
    }
    // Invalida cache pro proximo client-context puxar a nova obs
    try { (await import('./services/gesthub.js')).invalidateCache?.(); } catch {}
    res.json({ ok: true, data: data?.data, client_id: clientId, satelite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/atendimento/conversation/:id/candidates
 * Retorna TODOS os clientes Gesthub cujo telefone bate com o da conversa.
 * Permite que o painel direito mostre switcher quando o mesmo numero pertence
 * a mais de uma empresa (ex: socio de 2 empresas).
 */
app.get('/api/atendimento/conversation/:id/candidates', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: cRows } = await query(
      `SELECT id, phone, real_phone, display_phone, gesthub_client_id, client_name
       FROM whatsapp_conversations WHERE id = $1`,
      [id]
    );
    if (!cRows.length) return res.status(404).json({ error: 'conversa nao encontrada' });
    const conv = cRows[0];

    // Normaliza digits11 dos identificadores
    const toDigits11 = (s) => {
      const d = String(s || '').replace(/\D/g, '');
      if (!d) return null;
      if ((d.length === 13 || d.length === 12) && d.startsWith('55')) return d.slice(2);
      return d;
    };
    const candidates = [conv.phone, conv.real_phone, conv.display_phone].map(toDigits11).filter(Boolean);

    const { getClients } = await import('./services/gesthub.js');
    const all = await getClients();
    const matches = [];
    for (const c of all) {
      const phones = [];
      if (Array.isArray(c.contatos)) for (const ct of c.contatos) phones.push(ct.telefone);
      if (c.phone) phones.push(c.phone);
      const normalized = phones.map(toDigits11).filter(p => p && p.length >= 10);
      if (candidates.some(q => normalized.includes(q))) {
        matches.push({
          id: c.id,
          legalName: c.legalName,
          tradeName: c.tradeName,
          document: c.document,
          status: c.status,
          type: c.type,
          taxRegime: c.taxRegime,
          city: c.city,
          state: c.state,
        });
      }
    }

    res.json({
      data: matches,
      current_id: conv.gesthub_client_id,
      conversation: conv,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/atendimento/clientes/search?q=...
 * Busca clientes no Gesthub por nome/CNPJ. Retorna top 20.
 */
app.get('/api/atendimento/clientes/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ data: [] });
    const { getClients } = await import('./services/gesthub.js');
    const clients = await getClients();
    const qDigits = q.replace(/\D/g, '');
    const matches = clients.filter(c => {
      const name = String(c.legalName || c.tradeName || '').toLowerCase();
      const doc = String(c.document || '').replace(/\D/g, '');
      if (name.includes(q)) return true;
      if (qDigits && doc.includes(qDigits)) return true;
      return false;
    }).slice(0, 20).map(c => ({
      id: c.id,
      legalName: c.legalName,
      tradeName: c.tradeName,
      document: c.document,
      status: c.status,
      type: c.type,
      city: c.city,
      state: c.state,
    }));
    res.json({ data: matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/atendimento/conversation/:id/link-client
 * Vincula uma conversa a um cliente do Gesthub.
 * body: { client_id, update_phone?: bool }
 *   - update_phone=true: envia PATCH pro Gesthub adicionando o número como contato do cliente
 */
app.post('/api/atendimento/conversation/:id/link-client', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      client_id, update_phone = true, contato_nome, contato_funcao,
      set_primary = true,
      relacao, // tomador|socio|contador|financeiro|outro — define vinculo satelite
    } = req.body || {};
    // Se ha relacao, eh vinculo satelite (contato representa um terceiro do cliente):
    //   - nao vira is_primary
    //   - nao atualiza gesthub_client_id da conversa
    const isSatelite = !!relacao;
    const effectivePrimary = isSatelite ? false : set_primary;
    if (!client_id) return res.status(400).json({ error: 'client_id obrigatorio' });

    // Verifica conv existe
    const { rows: convRows } = await query(
      `SELECT id, phone, real_phone, client_name, gesthub_client_id FROM whatsapp_conversations WHERE id = $1`,
      [id]
    );
    if (!convRows.length) return res.status(404).json({ error: 'conversa nao encontrada' });

    // Insere no junction (idempotente). Em conflito, atualiza relacao/contato_funcao
    // (permite mudar o tipo de vinculo sem precisar deletar antes).
    await query(
      `INSERT INTO whatsapp_conversation_clients
         (conversation_id, gesthub_client_id, is_primary, relacao, contato_funcao)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conversation_id, gesthub_client_id) DO UPDATE
         SET is_primary = EXCLUDED.is_primary,
             relacao = COALESCE(EXCLUDED.relacao, whatsapp_conversation_clients.relacao),
             contato_funcao = COALESCE(EXCLUDED.contato_funcao, whatsapp_conversation_clients.contato_funcao)`,
      [id, Number(client_id), !!effectivePrimary, relacao || null, contato_funcao || null]
    );

    // Se eh primary (e nao satelite), ajusta flag e atualiza gesthub_client_id (compat retro)
    if (effectivePrimary) {
      await query(
        `UPDATE whatsapp_conversation_clients SET is_primary = (gesthub_client_id = $2) WHERE conversation_id = $1`,
        [id, Number(client_id)]
      );
      await query(
        `UPDATE whatsapp_conversations SET gesthub_client_id = $1 WHERE id = $2`,
        [Number(client_id), id]
      );
    }

    const { rows } = await query(
      `SELECT id, phone, real_phone, client_name, gesthub_client_id FROM whatsapp_conversations WHERE id = $1`,
      [id]
    );
    const conv = rows[0];

    // Invalida cache do bootstrap pra proximo lookup puxar dados atualizados
    try { (await import('./services/gesthub.js')).invalidateCache(); } catch {}

    // Adiciona o telefone como contato do cliente no Gesthub (se ainda nao existir).
    // EXCETO em vinculo satelite — telefone do tomador/financeiro NAO deve virar
    // contato direto do nosso cliente na Carteira (eh um terceiro relacionado).
    let contatoCriado = null
    let contatoSkipReason = null
    // Relacoes "internas" (sao contatos diretos do cliente): socio, financeiro.
    // "Externas" (terceiros, NAO cadastrar como contato): tomador, contador, outro.
    const relacoesInternas = ['socio', 'financeiro']
    const isExternal = isSatelite && !relacoesInternas.includes(relacao)
    if (isExternal) {
      contatoSkipReason = 'vinculo externo (' + relacao + ') — terceiro relacionado, nao vira contato direto do cliente'
    } else if (update_phone !== false) {
      const phoneClean = String(conv.real_phone || conv.phone || '').replace(/\D/g, '')
      if (phoneClean.length >= 10) {
        try {
          const GH = process.env.GESTHUB_API_URL || 'http://31.97.175.200'
          // Verifica duplicatas
          const existing = await fetch(`${GH}/api/clients/${client_id}/contatos`).then(r => r.json()).catch(() => ({}))
          const list = existing?.data || []
          // Dedupe tolerante: compara últimos 8 dígitos OU normaliza removendo "9" do celular BR
          const norm = (p) => {
            const d = String(p || '').replace(/\D/g, '')
            // Remove DDI 55, depois remove "9" móvel se for celular BR (após DDD)
            const noDDI = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
            // Se tem 11 dígitos (DDD + 9 + 8) e o 3º dígito é 9, remove
            if (noDDI.length === 11 && noDDI[2] === '9') return noDDI.slice(0,2) + noDDI.slice(3)
            return noDDI
          }
          const targetNorm = norm(phoneClean)
          const dup = list.find(c => norm(c.telefone) === targetNorm)
          if (dup) {
            contatoSkipReason = `Ja existe contato com este telefone (id=${dup.id}, ${dup.nome})`
          } else {
            const nome = contato_nome || conv.client_name || `Contato WhatsApp`
            const isGroupConv = !!conv.is_group || String(conv.chat_id || '').endsWith('@g.us')
            const funcao = contato_funcao || (relacao ? relacao.toUpperCase() : (isGroupConv ? 'GRUPO_WHATSAPP' : 'WHATSAPP'))
            const r = await fetch(`${GH}/api/clients/${client_id}/contatos`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ nome, telefone: phoneClean, funcao, email: '', cpf: '' }),
            })
            const j = await r.json().catch(() => ({}))
            if (r.ok && j?.data) {
              contatoCriado = j.data
            } else {
              contatoSkipReason = `Gesthub rejeitou: ${j?.error || j?.detail || `HTTP ${r.status}`}`
            }
          }
        } catch (e) {
          contatoSkipReason = `Erro ao adicionar contato: ${e.message}`
        }
      } else {
        contatoSkipReason = 'telefone nao identificado (<10 digitos)'
      }
    }

    broadcast({ type: 'conversation_linked', conversation_id: id, client_id });

    res.json({
      ok: true,
      data: conv,
      phone_updated: !!contatoCriado,
      contato_criado: contatoCriado,
      contato_skip_reason: contatoSkipReason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/atendimento/backfill-contatos
 * Para todas as conversations.gesthub_client_id IS NOT NULL, garante que o
 * telefone esteja em gesthub.cliente_contatos (insere se faltar, dedupe por telefone).
 */
app.post('/api/atendimento/backfill-contatos', async (req, res) => {
  const GH = process.env.GESTHUB_API_URL || 'http://31.97.175.200'
  try {
    const { rows: convs } = await query(
      `SELECT id, phone, real_phone, client_name, gesthub_client_id
         FROM whatsapp_conversations
        WHERE gesthub_client_id IS NOT NULL AND is_group = FALSE`
    )

    let inserted = 0, skipped = 0, errors = 0
    const detalhes = []

    for (const conv of convs) {
      const phoneClean = String(conv.real_phone || conv.phone || '').replace(/\D/g, '')
      if (phoneClean.length < 10) { skipped++; continue }
      try {
        const existing = await fetch(`${GH}/api/clients/${conv.gesthub_client_id}/contatos`).then(r => r.json()).catch(() => ({}))
        const list = existing?.data || []
        const _norm = (p) => {
          const d = String(p || '').replace(/\D/g, '')
          const noDDI = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
          if (noDDI.length === 11 && noDDI[2] === '9') return noDDI.slice(0,2) + noDDI.slice(3)
          return noDDI
        }
        const targetN = _norm(phoneClean)
        const dup = list.find(c => _norm(c.telefone) === targetN)
        if (dup) { skipped++; continue }
        const nome = conv.client_name || 'Contato WhatsApp'
        const r = await fetch(`${GH}/api/clients/${conv.gesthub_client_id}/contatos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nome, telefone: phoneClean, funcao: 'WHATSAPP', email: '', cpf: '' }),
        })
        if (r.ok) {
          inserted++
          detalhes.push({ cliente_id: conv.gesthub_client_id, nome, telefone: phoneClean })
        } else {
          errors++
        }
      } catch { errors++ }
    }

    res.json({ ok: true, total_conversas: convs.length, inserted, skipped, errors, sample: detalhes.slice(0, 10) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /api/atendimento/conversation/:id/save-as-contact
 * Categoriza uma conversa que NAO e cliente (parceiro, fornecedor, prospect, pessoal, spam).
 * body: { type, label? }
 *   - type: 'parceiro' | 'fornecedor' | 'prospect' | 'pessoal' | 'spam'
 *   - label: nome/descricao amigavel (ex: "WiseHub Certificados")
 */
app.post('/api/atendimento/conversation/:id/save-as-contact', async (req, res) => {
  try {
    const { id } = req.params;
    const { type, label, details } = req.body || {};
    const validTypes = ['equipe', 'parceiro', 'fornecedor', 'prospect', 'pessoal', 'spam', 'cliente_externo'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `type invalido. Use: ${validTypes.join(', ')}` });
    }
    // Sanitiza details — so chaves esperadas, strings <= 500 char
    const cleanDetails = {}
    if (details && typeof details === 'object') {
      const allowed = ['subtipo', 'descricao', 'contato_pessoa', 'contato_funcao', 'contato_email', 'site', 'cnpj', 'oque_fazem', 'como_usamos', 'observacoes']
      for (const k of allowed) {
        if (typeof details[k] === 'string' && details[k].trim()) {
          cleanDetails[k] = details[k].trim().slice(0, 500)
        }
      }
      cleanDetails.updated_at = new Date().toISOString()
      cleanDetails.updated_by = 'caio' // futuro: pegar do auth
    }
    const { rows } = await query(
      `UPDATE whatsapp_conversations
       SET contact_type = $1,
           contact_label = $2,
           contact_details = $3::jsonb,
           gesthub_client_id = NULL
       WHERE id = $4
       RETURNING id, phone, client_name, contact_type, contact_label, contact_details`,
      [type, (label || '').slice(0, 200) || null, JSON.stringify(cleanDetails), id]
    );
    if (!rows.length) return res.status(404).json({ error: 'conversa nao encontrada' });
    broadcast({ type: 'contact_saved', conversation_id: id, contact_type: type });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/atendimento/conversation/:id/unlink-client
 * Remove o vinculo (caso vinculo errado, ex: LID ambiguo).
 */
app.post('/api/atendimento/conversation/:id/unlink-client', async (req, res) => {
  try {
    const { id } = req.params;
    const { client_id } = req.body || {};
    if (client_id) {
      // Remove só esse vínculo do junction
      await query(
        `DELETE FROM whatsapp_conversation_clients WHERE conversation_id = $1 AND gesthub_client_id = $2`,
        [id, Number(client_id)]
      );
      // Se removeu o primary, eleger outro como primary
      const { rows: rest } = await query(
        `SELECT gesthub_client_id FROM whatsapp_conversation_clients WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [id]
      );
      if (rest.length) {
        await query(`UPDATE whatsapp_conversation_clients SET is_primary = TRUE WHERE conversation_id = $1 AND gesthub_client_id = $2`, [id, rest[0].gesthub_client_id]);
        await query(`UPDATE whatsapp_conversations SET gesthub_client_id = $1 WHERE id = $2`, [rest[0].gesthub_client_id, id]);
      } else {
        await query(`UPDATE whatsapp_conversations SET gesthub_client_id = NULL WHERE id = $1`, [id]);
      }
    } else {
      // Remove todos os vínculos
      await query(`DELETE FROM whatsapp_conversation_clients WHERE conversation_id = $1`, [id]);
      await query(`UPDATE whatsapp_conversations SET gesthub_client_id = NULL WHERE id = $1`, [id]);
    }
    broadcast({ type: 'conversation_unlinked', conversation_id: id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/atendimento/unlink-by-phone
 * Chamado pelo Gesthub quando um contato eh DELETADO da Carteira do cliente.
 * Body: { phone, client_id }
 *   - phone: telefone do contato deletado (so digitos)
 *   - client_id: id do cliente do Gesthub
 * Acha a conversation com esse telefone e remove o vinculo com client_id.
 */
/**
 * POST /api/atendimento/clients/:clientId/contatos-from-vcard
 * Adiciona um contato no Gesthub a partir de um vCard recebido no chat.
 * Body: { nome, telefone }
 * Faz proxy pro endpoint do Gesthub (/api/clients/:id/contatos).
 */
app.post('/api/atendimento/clients/:clientId/contatos-from-vcard', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { nome, telefone } = req.body || {};
    if (!nome || !telefone) {
      return res.status(400).json({ error: 'nome e telefone obrigatorios' });
    }
    const phoneClean = String(telefone).replace(/\D/g, '');
    if (phoneClean.length < 10) {
      return res.status(400).json({ error: 'telefone invalido' });
    }
    const GH = process.env.GESTHUB_API_URL || 'http://31.97.175.200';

    // Verifica duplicata (mesmo numero ja cadastrado)
    try {
      const existing = await fetch(`${GH}/api/clients/${clientId}/contatos`).then(r => r.json()).catch(() => ({}));
      const list = existing?.data || [];
      const norm = (x) => String(x || '').replace(/\D/g, '').slice(-9);
      const dup = list.find(c => norm(c.telefone) === norm(phoneClean));
      if (dup) {
        return res.json({ ok: true, data: dup, duplicate: true });
      }
    } catch {}

    const r = await fetch(`${GH}/api/clients/${clientId}/contatos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, telefone: phoneClean, funcao: 'WHATSAPP', email: '', cpf: '' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.data) {
      return res.status(r.status || 500).json({ error: j?.error || j?.detail || `HTTP ${r.status}` });
    }
    res.json({ ok: true, data: j.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/whatsapp/group/:chatId/participants
 * Lista participantes de um grupo WhatsApp (so existe se chatId termina em @g.us).
 * Resp: { ok, total, participants: [{id, phone, name, isAdmin}] }
 */
app.get('/api/whatsapp/group/:chatId/participants', async (req, res) => {
  try {
    let chatId = req.params.chatId;
    // Aceita chatId completo (xxxxx@g.us) ou so o numero (xxxxx)
    if (!chatId.includes('@')) chatId = `${chatId}@g.us`;
    if (!chatId.endsWith('@g.us')) {
      return res.status(400).json({ error: 'chatId nao e de grupo' });
    }
    const wapp = whatsapp.getClient?.();
    if (!wapp) return res.status(503).json({ error: 'WhatsApp nao conectado' });

    const chat = await wapp.getChatById(chatId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ error: 'Grupo nao encontrado' });
    }
    const participants = chat.participants || [];
    const out = [];
    for (const p of participants) {
      const phoneId = p.id?._serialized || p.id || '';
      const phone = String(phoneId).split('@')[0].replace(/\D/g, '');
      // Tenta resolver nome via contact (se possivel)
      let name = null;
      try {
        const contact = await wapp.getContactById(phoneId);
        name = contact?.pushname || contact?.name || contact?.shortName || null;
      } catch {}
      out.push({
        id: phoneId,
        phone,
        name: name || phone,
        isAdmin: !!p.isAdmin,
        isSuperAdmin: !!p.isSuperAdmin,
      });
    }
    res.json({ ok: true, total: out.length, group_name: chat.name, participants: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/atendimento/unlink-by-phone', async (req, res) => {
  try {
    const { phone, client_id } = req.body || {};
    if (!phone || !client_id) {
      return res.status(400).json({ error: 'phone e client_id obrigatorios' });
    }
    const phoneClean = String(phone).replace(/\D/g, '');
    if (phoneClean.length < 10) {
      return res.status(400).json({ error: 'phone invalido (<10 digitos)' });
    }

    // Acha conversation por phone OR real_phone OR chat_id contendo o numero
    const { rows: convs } = await query(
      `SELECT id FROM whatsapp_conversations
        WHERE phone = $1 OR real_phone = $1 OR chat_id LIKE $2`,
      [phoneClean, `%${phoneClean}%`]
    );

    let removidos = 0;
    for (const c of convs) {
      const r = await query(
        `DELETE FROM whatsapp_conversation_clients
          WHERE conversation_id = $1 AND gesthub_client_id = $2`,
        [c.id, Number(client_id)]
      );
      removidos += r.rowCount || 0;

      // Se removeu o primary, eleger outro
      const { rows: rest } = await query(
        `SELECT gesthub_client_id FROM whatsapp_conversation_clients
          WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [c.id]
      );
      if (rest.length) {
        await query(
          `UPDATE whatsapp_conversation_clients SET is_primary = TRUE
            WHERE conversation_id = $1 AND gesthub_client_id = $2`,
          [c.id, rest[0].gesthub_client_id]
        );
        await query(
          `UPDATE whatsapp_conversations SET gesthub_client_id = $1 WHERE id = $2`,
          [rest[0].gesthub_client_id, c.id]
        );
      } else {
        await query(
          `UPDATE whatsapp_conversations SET gesthub_client_id = NULL WHERE id = $1 AND gesthub_client_id = $2`,
          [c.id, Number(client_id)]
        );
      }

      broadcast({ type: 'conversation_unlinked', conversation_id: c.id });
    }

    // Invalida cache do bootstrap
    try { (await import('./services/gesthub.js')).invalidateCache(); } catch {}

    res.json({ ok: true, conversations_affected: convs.length, links_removed: removidos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================
// Copilot IA — assistente interno dos operadores durante atendimento WhatsApp
// ============================================
/**
 * POST /api/atendimento/copilot
 * Body: { conversation_id, question }
 *
 * Coleta contexto: dados cliente (Gesthub) + ultimas 10 msgs + top 3 memorias RAG
 * + tarefas abertas do cliente. Envia pra LLM (usa mesma config da Luna) e
 * retorna resposta JSON simples.
 *
 * NAO cria memoria, NAO modifica prompts. Apenas consulta + responde.
 */
app.post('/api/atendimento/copilot', async (req, res) => {
  try {
    const { conversation_id, question } = req.body || {};
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id obrigatorio' });
    if (!question || String(question).trim().length < 3) {
      return res.status(400).json({ error: 'pergunta muito curta' });
    }

    // 1) Busca conversa + ultimas msgs
    const { rows: convRows } = await query(
      `SELECT id, phone, real_phone, client_name, gesthub_client_id
       FROM whatsapp_conversations WHERE id = $1`,
      [conversation_id]
    );
    if (!convRows.length) return res.status(404).json({ error: 'conversa nao encontrada' });
    const conv = convRows[0];

    const { rows: msgRows } = await query(
      `SELECT sender, body, created_at FROM whatsapp_messages
       WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 12`,
      [conversation_id]
    );
    const lastMsgs = msgRows.reverse(); // ordem cronologica

    // 2) Busca cliente Gesthub (se linkado)
    let client = null;
    if (conv.gesthub_client_id) {
      try {
        const { getClients } = await import('./services/gesthub.js');
        const all = await getClients();
        client = all.find(c => Number(c.id) === Number(conv.gesthub_client_id));
      } catch (e) { console.error('[copilot] gesthub falhou:', e.message); }
    }

    // 3) RAG: top memorias relevantes pra pergunta
    let memorias = [];
    try {
      const { searchMemories } = await import('./services/embeddings.js');
      memorias = await searchMemories(question, { limit: 5 });
    } catch (e) { console.error('[copilot] RAG falhou:', e.message); }

    // 4) Tasks abertas do cliente (se linkado)
    let tasks = [];
    if (conv.gesthub_client_id) {
      const { rows: tRows } = await query(
        `SELECT title, description, status, priority FROM tasks
         WHERE (result->>'client_id' = $1::text OR result->>'cliente_id' = $1::text)
           AND status IN ('pending', 'in_progress', 'blocked')
         ORDER BY created_at DESC LIMIT 5`,
        [String(conv.gesthub_client_id)]
      ).catch(() => ({ rows: [] }));
      tasks = tRows;
    }

    // 5) Monta prompt estruturado
    const ctxCliente = client ? [
      `- Razão Social: ${client.legalName || '--'}`,
      `- CNPJ: ${client.document || '--'}`,
      `- Tipo: ${client.type || '--'}`,
      `- Regime Tributario: ${client.taxRegime || '--'}`,
      client.fatorR === 'SIM' ? '- Fator R: SIM' : null,
      client.porte ? `- Porte: ${client.porte}` : null,
      `- Sócio responsável: ${client.officeOwner || '--'}`,
      client.analyst ? `- Analista: ${client.analyst}` : null,
      client.celula ? `- Célula: ${client.celula}` : null,
      client.headcount ? `- Headcount: ${client.headcount}` : null,
      client.monthlyFee ? `- Honorário: R$ ${client.monthlyFee}` : null,
      client.city ? `- Local: ${client.city}/${client.state}` : null,
      client.cnae_descricao || client.cnaeDescricao ? `- CNAE: ${client.cnae_descricao || client.cnaeDescricao}` : null,
    ].filter(Boolean).join('\n') : '(cliente NÃO vinculado na Carteira — identificação pendente)';

    const ctxMsgs = lastMsgs.length ? lastMsgs.map(m => {
      const who = m.sender === 'client' ? 'CLIENTE' : (m.sender === 'luna' || m.sender === 'bot' ? 'LUNA' : 'EQUIPE');
      const when = new Date(m.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `[${when} ${who}] ${String(m.body || '').slice(0, 300)}`;
    }).join('\n') : '(sem mensagens ainda)';

    const ctxMems = memorias.length ? memorias.map((m, i) =>
      `${i + 1}. ${m.title}\n   ${String(m.summary || m.content || '').slice(0, 250)}`
    ).join('\n\n') : '(nenhuma regra relevante no RAG)';

    const ctxTasks = tasks.length ? tasks.map(t =>
      `- [${t.status}] ${t.title}${t.description ? ': ' + String(t.description).slice(0, 150) : ''}`
    ).join('\n') : '(nenhuma task aberta)';

    const systemPrompt = `Você é o Copilot interno da Átrio Contabilidade, assistente dos operadores ` +
      `(Quesia, Deyvison, Caio, Diogo, Diego, Natalia) durante atendimento de clientes contábeis.\n\n` +
      `REGRAS CRITICAS:\n` +
      `1. Responda APENAS com dados presentes no contexto fornecido. NUNCA invente status, localização ou estado de documentos/uploads/tasks.\n` +
      `2. Se o operador perguntar sobre um arquivo/documento/status específico que NÃO está explicitamente no contexto, responda: "Não encontrei essa informação no meu contexto. Verifica direto em [Documentos/Finance/etc]".\n` +
      `3. Nunca afirme que algo "está pendente de aprovação", "foi salvo em X" ou "chegou em Y" se isso não está literalmente nos dados fornecidos.\n` +
      `4. Seja CONCISO (máximo 4 frases), direto, sem floreios, sem emojis.\n` +
      `5. Tom técnico-contábil quando apropriado.\n\n` +
      `Se faltar informação pra responder com confiança, diga claramente o que falta.`;

    const userPrompt = `=== CLIENTE (do Gesthub) ===\n${ctxCliente}\n\n` +
      `=== ÚLTIMAS MENSAGENS DA CONVERSA WHATSAPP ===\n${ctxMsgs}\n\n` +
      `=== REGRAS E CONHECIMENTO RELEVANTE (top ${memorias.length} do RAG) ===\n${ctxMems}\n\n` +
      `=== TAREFAS ABERTAS DO CLIENTE ===\n${ctxTasks}\n\n` +
      `=== PERGUNTA DO OPERADOR ===\n${question}`;

    // 6) Chama LLM (usa config da Luna — Kimi K2 via OpenRouter)
    const { query: q2 } = await import('./db/pool.js');
    const { rows: agentRows } = await q2(`SELECT * FROM agents WHERE name = 'Luna' LIMIT 1`);
    const luna = agentRows[0];
    if (!luna) return res.status(500).json({ error: 'Config Luna nao encontrada' });

    const { chatWithAgent } = await import('./services/claude.js');
    const t0 = Date.now();
    const resp = await chatWithAgent(
      { ...luna, system_prompt: systemPrompt },
      [{ role: 'user', content: userPrompt }]
    );
    const latencyMs = Date.now() - t0;

    if (!resp?.success) {
      return res.status(500).json({ error: resp?.error || 'LLM falhou' });
    }

    res.json({
      ok: true,
      answer: (resp.text || '').trim(),
      model: resp.model,
      latency_ms: latencyMs,
      context_used: {
        cliente_linked: !!client,
        msgs_count: lastMsgs.length,
        memorias_count: memorias.length,
        tasks_count: tasks.length,
        memorias_titulos: memorias.map(m => m.title),
      },
    });
  } catch (err) {
    console.error('[copilot] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Detectar compromisso em mensagem enviada — auto-agendamento
// ============================================
/**
 * POST /api/atendimento/detect-commitment
 * Body: { text, conversation_id? }
 *
 * Analisa texto da mensagem (LLM) procurando promessa com data.
 * Exemplos detectaveis:
 *   "até segunda te posiciono sobre o IR"
 *   "envio amanhã"
 *   "resposta na sexta"
 *   "dia 30 te retorno"
 *   "semana que vem"
 *
 * Retorna { commitments: [{date_iso, title, confidence}] } ou {commitments: []}.
 */
app.post('/api/atendimento/detect-commitment', async (req, res) => {
  try {
    const { text, conversation_id } = req.body || {};
    if (!text || String(text).trim().length < 6) {
      return res.json({ commitments: [] });
    }

    // Contexto: cliente linkado, se tiver
    let clientName = null;
    if (conversation_id) {
      try {
        const { rows } = await query(
          `SELECT c.client_name, cl.legal_name, cl.trade_name
           FROM whatsapp_conversations c
           LEFT JOIN clients cl ON cl.id::text = c.gesthub_client_id::text
           WHERE c.id = $1 LIMIT 1`,
          [conversation_id]
        ).catch(() => ({ rows: [] }));
        clientName = rows[0]?.legal_name || rows[0]?.trade_name || rows[0]?.client_name || null;
      } catch {}
    }

    const today = new Date();
    const todayStr = today.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

    const systemPrompt = `Você é um detector de compromissos em texto PT-BR. Dado o texto que um colaborador da Átrio Contabilidade ENVIOU a um cliente, extraia TODOS os compromissos com data/prazo.

Compromisso = promessa do tipo "te envio X na/até segunda", "posiciono amanhã", "resposta até dia 30", "semana que vem".

Hoje é ${todayStr}. Converta TODAS as referências temporais em ISO date (YYYY-MM-DD). Para dias da semana, use o PRÓXIMO dia dessa semana (se hoje é quinta e alguém diz "segunda", é segunda que vem).

Responda APENAS com JSON neste formato (sem texto antes/depois):
{"commitments":[{"date_iso":"YYYY-MM-DD","title":"breve descrição","phrase":"trecho original"}]}

Se NENHUM compromisso detectado, responda: {"commitments":[]}`;

    const userPrompt = `CLIENTE: ${clientName || '(não identificado)'}\nTEXTO ENVIADO:\n${text}`;

    // Usa config da Luna (Kimi) pra inferir
    const { rows: agentRows } = await query(`SELECT * FROM agents WHERE name = 'Luna' LIMIT 1`);
    const luna = agentRows[0];
    if (!luna) return res.json({ commitments: [] });

    const { chatWithAgent } = await import('./services/claude.js');
    const resp = await chatWithAgent(
      { ...luna, system_prompt: systemPrompt, config: { ...luna.config, max_tokens: 400, temperature: 0.1 } },
      [{ role: 'user', content: userPrompt }]
    );

    if (!resp?.success) return res.json({ commitments: [] });

    // Parse JSON da resposta da LLM (tolerante a lixo antes/depois)
    let parsed = { commitments: [] };
    try {
      const raw = (resp.text || '').trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (e) { console.error('[detect-commitment] parse:', e.message); }

    const commitments = Array.isArray(parsed.commitments) ? parsed.commitments.filter(c => c.date_iso && c.title) : [];
    // Filtro de sanidade: data no futuro, no maximo 6 meses adiante
    const now = Date.now();
    const max = now + 180 * 86400 * 1000;
    const valid = commitments.filter(c => {
      const d = new Date(c.date_iso).getTime();
      return !isNaN(d) && d >= now - 86400 * 1000 && d <= max;
    });

    res.json({
      commitments: valid,
      client_name: clientName,
    });
  } catch (err) {
    console.error('[detect-commitment] erro:', err.message);
    res.json({ commitments: [] });  // nao quebra envio de msg
  }
});

// ============================================
// ADMIN: Backfill de historico WhatsApp
// Recupera msgs antigas via chat.fetchMessages e insere as faltantes.
// ============================================
app.post('/api/admin/whatsapp/backfill', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body?.limit ?? req.query?.limit ?? 200, 10) || 200, 1000);
    const dryRun = String(req.body?.dryRun ?? req.query?.dryRun ?? '').toLowerCase() === 'true';
    const onlyConversationId = req.body?.conversation_id || req.query?.conversation_id || null;
    const maxConversations = parseInt(req.body?.max_conversations ?? req.query?.max_conversations ?? 0, 10) || null;
    const whatsappSvc = await import('./services/whatsapp.js');
    if (typeof whatsappSvc.backfillHistory !== 'function') {
      return res.status(500).json({ error: 'backfillHistory nao exportado' });
    }
    const t0 = Date.now();
    const stats = await whatsappSvc.backfillHistory({ limit, dryRun, onlyConversationId, maxConversations });
    stats.elapsed_ms = Date.now() - t0;
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('[backfill] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Download de anexo de mensagem WhatsApp
// ============================================
/**
 * GET /api/whatsapp/messages/:id/attachment
 * Serve o arquivo anexo persistido em storage/whatsapp-attachments.
 * Body da msg deve ter metadata.attachment.storage_path.
 */
app.get('/api/whatsapp/messages/:id/attachment', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT body, metadata FROM whatsapp_messages WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'mensagem nao encontrada' });
    const meta = typeof rows[0].metadata === 'string'
      ? (() => { try { return JSON.parse(rows[0].metadata) } catch { return {} } })()
      : (rows[0].metadata || {});
    const att = meta.attachment;
    if (!att?.storage_path) return res.status(404).json({ error: 'mensagem sem anexo' });

    // Seguranca: restringe path ao diretorio de attachments
    const fs = await import('fs');
    const path = await import('path');
    const allowedBase = process.env.WHATSAPP_ATTACH_DIR || '/app/storage/whatsapp-attachments';
    const resolvedPath = path.resolve(att.storage_path);
    if (!resolvedPath.startsWith(path.resolve(allowedBase))) {
      return res.status(403).json({ error: 'path fora do diretorio permitido' });
    }
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'arquivo nao encontrado no storage' });
    }

    const filename = att.filename || 'anexo.bin';
    const safeName = filename.replace(/[^\w.\-() ]/g, '_');
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    // inline pra PDFs/imagens (previa), attachment pra outros (download)
    const disposition = (att.mime_type?.startsWith('image/') || att.mime_type === 'application/pdf')
      ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
    res.sendFile(resolvedPath);
  } catch (err) {
    console.error('[attachment] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Extratos: status por cliente (proxy Finance) + enviar anexo de mensagem pra fila pending
// ============================================
const FINANCE_URL_DEFAULT = process.env.ATRIO_FINANCE_URL || process.env.FINANCE_URL || 'http://atrio-banking-system-1:3000';

// Pattern de filename de extrato bancário — usado pra decidir se mostra botão "Enviar pro Finance"
// Sem \b no fim porque _ é word-char e quebrava NU_\d+_.
const EXTRATO_FILENAME_RE = /^NU_\d+_|^extrato|^statement|^conta_corrente|nubank|inter|bradesco|itau|santander|caixa|sicoob|sicredi|btg|safra|c6 ?bank/i;

/**
 * GET /api/atendimento/extratos-status/:cliente_id?ano=2026
 * Proxy fino pro Finance /api/controle?cliente_id=X&ano=Y. Retorna grid de meses.
 */
app.get('/api/atendimento/extratos-status/:cliente_id', async (req, res) => {
  try {
    const cid = parseInt(req.params.cliente_id, 10);
    if (!cid) return res.status(400).json({ error: 'cliente_id inválido' });
    const ano = parseInt(req.query.ano, 10) || new Date().getFullYear();
    const url = `${FINANCE_URL_DEFAULT}/api/controle?ano=${ano}&cliente_id=${cid}`;
    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(r.status).json({ error: `Finance retornou ${r.status}`, body: txt.slice(0, 200) });
    }
    const data = await r.json();
    const grid = (data?.data || []).find(g => g.clienteGesthubId === cid) || { clienteGesthubId: cid, totalContas: 0, meses: {} };
    res.json({ ok: true, ano, data: grid });
  } catch (err) {
    console.error('[extratos-status] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/atendimento/messages/:msg_id/enviar-extrato-pending
 * Pega o anexo da mensagem WhatsApp e envia pra fila /api/extratos-pending do Finance.
 * Body: { cliente_id_sugerido?, cliente_nome_sugerido? } — opcionais
 */
app.post('/api/atendimento/messages/:msg_id/enviar-extrato-pending', async (req, res) => {
  try {
    const { msg_id } = req.params;
    const { rows } = await query(
      `SELECT m.id, m.body, m.metadata, m.conversation_id,
              c.gesthub_client_id, c.phone, c.client_name
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_conversations c ON c.id = m.conversation_id
        WHERE m.id = $1`,
      [msg_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'mensagem nao encontrada' });
    const r0 = rows[0];
    const meta = typeof r0.metadata === 'string'
      ? (() => { try { return JSON.parse(r0.metadata) } catch { return {} } })()
      : (r0.metadata || {});
    const att = meta.attachment;
    if (!att?.storage_path) return res.status(400).json({ error: 'mensagem sem anexo' });
    if (att.expired) return res.status(410).json({ error: 'anexo expirado/removido do storage' });

    // Le arquivo do disco
    const fs = await import('fs');
    const path = await import('path');
    const allowedBase = process.env.WHATSAPP_ATTACH_DIR || '/app/storage/whatsapp-attachments';
    const resolvedPath = path.resolve(att.storage_path);
    if (!resolvedPath.startsWith(path.resolve(allowedBase))) {
      return res.status(403).json({ error: 'path fora do diretorio permitido' });
    }
    if (!fs.existsSync(resolvedPath)) return res.status(404).json({ error: 'arquivo nao encontrado no storage' });
    const buf = fs.readFileSync(resolvedPath);

    // Detecta banco pelo filename
    const filename = att.filename || 'extrato.pdf';
    let banco = '', bancoCod = '', conta = '';
    const fname = filename.toLowerCase();
    if (/^nu_(\d+)_/i.test(fname)) {
      banco = 'NUBANK'; bancoCod = '260';
      const m = filename.match(/^NU_(\d+)_/i);
      if (m) conta = m[1];
    } else if (fname.includes('inter')) { banco = 'INTER'; bancoCod = '077'; }
    else if (fname.includes('bradesco')) { banco = 'BRADESCO'; bancoCod = '237'; }
    else if (fname.includes('itau')) { banco = 'ITAU'; bancoCod = '341'; }
    else if (fname.includes('santander')) { banco = 'SANTANDER'; bancoCod = '033'; }
    else if (fname.includes('caixa')) { banco = 'CAIXA'; bancoCod = '104'; }

    // Cliente sugerido: do body > gesthub_client_id da conversa
    const clienteIdSugerido = req.body?.cliente_id_sugerido || r0.gesthub_client_id || null;
    const clienteNomeSugerido = req.body?.cliente_nome_sugerido || r0.client_name || null;

    // Monta multipart
    const form = new FormData();
    form.append('file', new Blob([buf], { type: att.mime_type || 'application/pdf' }), filename);
    if (banco) form.append('banco_detectado', banco);
    if (bancoCod) form.append('banco_codigo_detectado', bancoCod);
    if (conta) form.append('conta_detectada', conta);
    if (clienteIdSugerido) form.append('cliente_gesthub_id_sugerido', String(clienteIdSugerido));
    if (clienteNomeSugerido) form.append('cliente_nome_sugerido', clienteNomeSugerido);
    form.append('recebido_via', 'whatsapp_manual');
    if (r0.phone) form.append('recebido_phone', String(r0.phone));
    if (r0.client_name) form.append('recebido_nome', String(r0.client_name));
    form.append('observacoes', `Enviado manualmente do Atendimento (msg_id=${msg_id}, conv_id=${r0.conversation_id})`);

    const finResp = await fetch(`${FINANCE_URL_DEFAULT}/api/extratos-pending`, { method: 'POST', body: form });
    if (!finResp.ok) {
      const txt = await finResp.text().catch(() => '');
      return res.status(502).json({ error: `Finance retornou ${finResp.status}`, body: txt.slice(0, 300) });
    }
    const data = await finResp.json();
    const pendingId = data.data?.id || null;

    // Persiste no metadata da mensagem pra outras abas que recarregarem ver o estado
    if (pendingId) {
      try {
        await query(
          `UPDATE whatsapp_messages
              SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('finance_pending_id', $2::int, 'finance_sent_at', NOW())
            WHERE id = $1`,
          [msg_id, pendingId]
        );
      } catch (e) { console.error('[finance persist] erro:', e.message); }
    }

    // Broadcast WS pra todas as abas atualizarem em tempo real
    try {
      broadcast({
        type: 'extrato_sent_to_finance',
        msg_id,
        pending_id: pendingId,
        conversation_id: r0.conversation_id,
      });
    } catch {}
    res.json({ ok: true, pending: data.data });
  } catch (err) {
    console.error('[enviar-extrato-pending] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/atendimento/extrato-filename-pattern
 * Frontend usa isso pra saber se deve mostrar botão "Enviar pro Finance" num anexo.
 */
app.get('/api/atendimento/extrato-filename-pattern', (_req, res) => {
  res.json({ ok: true, pattern: EXTRATO_FILENAME_RE.source, flags: EXTRATO_FILENAME_RE.flags });
});

// ============================================
// Upload + envio de anexo pelo painel
// ============================================
/**
 * POST /api/whatsapp/send-media
 * Body multipart: file, phone (ou chat_id), caption (opcional)
 * Envia via whatsapp-web.js MessageMedia.
 */
app.post('/api/whatsapp/send-media', async (req, res) => {
  try {
    const { phone, caption } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone obrigatorio' });
    // multer/busboy nao configurado globalmente — usar stream manual
    // Espera-se que o frontend envie base64 no body JSON pra simplificar
    const { file_base64, file_name, mime_type } = req.body || {};
    if (!file_base64 || !file_name) return res.status(400).json({ error: 'file_base64 e file_name obrigatorios' });

    const whatsappSvc = await import('./services/whatsapp.js');
    // manual=true: humano enviando do painel
    await whatsappSvc.sendMedia(phone, file_base64, file_name, mime_type || 'application/octet-stream', caption || '', { manual: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[send-media] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Apagar mensagem enviada (para todos) — usa wa_msg_id salvo no metadata
// ============================================
app.post('/api/whatsapp/messages/:id/delete', async (req, res) => {
  try {
    const { id } = req.params;
    // Busca mensagem no nosso banco
    const { rows } = await query(
      `SELECT m.id, m.sender, m.body, m.metadata, m.created_at,
              c.phone, c.chat_id
       FROM whatsapp_messages m
       JOIN whatsapp_conversations c ON c.id = m.conversation_id
       WHERE m.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'mensagem nao encontrada' });
    const msg = rows[0];

    // So apagamos mensagens NOSSAS (team/luna/bot) — cliente nao
    if (msg.sender === 'client') {
      return res.status(400).json({ error: 'Nao e possivel apagar mensagem do cliente' });
    }

    // Janela do WhatsApp pra "delete for everyone" e curta (~1h pra msg nova,
    // 2 dias pra 0.31 acima). Se passou, avisa mas ainda marca como apagada localmente.
    const ageMs = Date.now() - new Date(msg.created_at).getTime();
    const withinWindow = ageMs < 60 * 60 * 1000; // 1h

    const meta = typeof msg.metadata === 'string' ? (() => { try { return JSON.parse(msg.metadata) } catch { return {} } })() : (msg.metadata || {});
    const waMsgId = meta.wa_msg_id;
    const chatId = meta.chat_id || msg.chat_id;

    let whatsappResult = null;
    if (waMsgId && withinWindow) {
      try {
        whatsappResult = await whatsapp.deleteMessageForEveryone(waMsgId, chatId);
      } catch (e) {
        console.error('[delete-msg] falha WhatsApp:', e.message);
        whatsappResult = { ok: false, error: e.message };
      }
    }

    // Mesmo que o delete no WA falhe, marca apagada no nosso DB pra consistencia visual
    await query(
      `UPDATE whatsapp_messages
       SET body = '[mensagem apagada]',
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deleted', true, 'deleted_at', NOW(), 'original_body', body)
       WHERE id = $1`,
      [id]
    );

    broadcast({ type: 'message_deleted', message_id: id });
    res.json({
      ok: true,
      whatsapp_deleted: whatsappResult?.ok === true,
      warning: !waMsgId ? 'Mensagem antiga sem wa_msg_id — so apagada localmente' :
               !withinWindow ? 'Janela de exclusao WhatsApp expirou — so apagada localmente' :
               whatsappResult?.error || null,
    });
  } catch (err) {
    console.error('[delete-msg] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Message Templates — atalhos de resposta pro atendimento WhatsApp
// ============================================
app.get('/api/atendimento/templates', async (req, res) => {
  try {
    const { category, q } = req.query;
    let sql = 'SELECT id, name, category, body, usage_count, created_at, updated_at FROM message_templates WHERE is_active = TRUE';
    const params = [];
    if (category) { params.push(category); sql += ` AND category = $${params.length}`; }
    if (q) { params.push(`%${q}%`); sql += ` AND (name ILIKE $${params.length} OR body ILIKE $${params.length})`; }
    sql += ' ORDER BY usage_count DESC NULLS LAST, name ASC LIMIT 100';
    const { rows } = await query(sql, params);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/atendimento/templates', async (req, res) => {
  try {
    const { name, category, body, created_by } = req.body || {};
    if (!name || !body) return res.status(400).json({ error: 'name e body sao obrigatorios' });
    const { rows } = await query(
      `INSERT INTO message_templates (name, category, body, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [String(name).slice(0, 120), category || 'outros', body, created_by || null]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/atendimento/templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, body, is_active } = req.body || {};
    const updates = [];
    const params = [];
    if (name !== undefined) { params.push(name); updates.push(`name = $${params.length}`); }
    if (category !== undefined) { params.push(category); updates.push(`category = $${params.length}`); }
    if (body !== undefined) { params.push(body); updates.push(`body = $${params.length}`); }
    if (is_active !== undefined) { params.push(!!is_active); updates.push(`is_active = $${params.length}`); }
    if (updates.length === 0) return res.status(400).json({ error: 'nada pra atualizar' });
    updates.push('updated_at = NOW()');
    params.push(id);
    const { rows } = await query(
      `UPDATE message_templates SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'template nao encontrado' });
    res.json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Incrementa o uso pra ranking (chamar quando usuario insere o template no chat)
app.post('/api/atendimento/templates/:id/track-use', async (req, res) => {
  try {
    await query('UPDATE message_templates SET usage_count = COALESCE(usage_count, 0) + 1 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/atendimento/templates/:id', async (req, res) => {
  try {
    // soft-delete: marca is_active=FALSE (mantem historico de uso)
    await query('UPDATE message_templates SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Push notifications (Web Push)
// ============================================
app.get('/api/push/public-key', (req, res) => {
  const key = pushSvc.getPublicKey();
  if (!key) return res.status(503).json({ error: 'push nao configurado' });
  res.json({ publicKey: key });
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { userId, subscription, userAgent } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'subscription invalida' });
    }
    const r = await pushSvc.registerSubscription({
      userId: userId || 'caio',
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent || req.headers['user-agent'],
    });
    res.json({ ok: true, id: r.id });
  } catch (err) {
    console.error('[push/subscribe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint obrigatorio' });
    await pushSvc.removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disparar push manualmente (teste). Em producao, triggers estao nos handlers de eventos.
app.post('/api/push/test', async (req, res) => {
  try {
    const { userId, title, body, url } = req.body || {};
    const r = await pushSvc.sendPushToUser(userId || 'caio', {
      title: title || 'Átrio Office',
      body: body || 'Notificação de teste',
      url: url || '/',
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Luna v2 - Agents API
// === MEMORY ROUTES ===
// GET /api/memory - List all approved memories
app.get('/api/memory', async (req, res) => {
  try {
    const { status = 'approved', agent, agent_id, category, categories, search,
            client_id, scope_type, entity_type, source_type, limit = 100 } = req.query;
    let sql = `SELECT m.*, a.name as agent_name, a.role as agent_role,
                      COALESCE(NULLIF(lc.nome_fantasia, ''), lc.nome_legal, 'Sem nome') AS client_name
               FROM memories m 
               LEFT JOIN agents a ON m.agent_id = a.id 
               LEFT JOIN luna_v2.clients lc ON lc.id = m.scope_id AND m.scope_type = 'client'
               WHERE 1=1`;
    const params = [];
    
    if (status && status !== 'all') { params.push(status); sql += ` AND m.status = $${params.length}::memory_status`; }
    if (agent_id) { params.push(agent_id); sql += ` AND m.agent_id = $${params.length}::uuid`; }
    else if (agent) { params.push(agent); sql += ` AND a.name ILIKE $${params.length}`; }
    if (category) { params.push(category); sql += ` AND m.category = $${params.length}::memory_category`; }
    if (categories) {
      const list = String(categories).split(',').map(c => c.trim()).filter(Boolean);
      if (list.length) {
        params.push(list);
        sql += ` AND m.category = ANY($${params.length}::memory_category[])`;
      }
    }
    if (entity_type) { params.push(entity_type); sql += ` AND m.metadata->>'entity_type' = $${params.length}`; }
    if (source_type) { params.push(source_type); sql += ` AND m.metadata->>'source_type' = $${params.length}`; }
    if (scope_type) { params.push(scope_type); sql += ` AND m.scope_type = $${params.length}::memory_scope`; }
    if (client_id) { params.push(client_id); sql += ` AND m.scope_id = $${params.length}::uuid AND m.scope_type = 'client'::memory_scope`; }
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

// GET /api/memory/stats - Counters for HybridMemory sidebar
app.get('/api/memory/stats', async (req, res) => {
  try {
    const mem = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'approved' AND is_rag_enabled = true) AS rag_enabled,
        COUNT(*) FILTER (WHERE status IN ('draft','pending_review')) AS pending_review,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
        COUNT(*) FILTER (WHERE scope_type = 'client') AS with_client
      FROM memories`);
    const sug = await query(`
      SELECT COUNT(*) AS pending
      FROM memory_suggestions WHERE review_status = 'pending'::suggestion_status`).catch(() => ({ rows: [{ pending: 0 }] }));
    const out = mem.rows[0] || {};
    res.json({
      memories: {
        approved: Number(out.approved) || 0,
        rag_enabled: Number(out.rag_enabled) || 0,
        pending_review: Number(out.pending_review) || 0,
        total: Number(out.total) || 0,
        embedded: Number(out.embedded) || 0,
        with_client: Number(out.with_client) || 0,
      },
      suggestions: { pending: Number(sug.rows[0]?.pending) || 0 },
    });
  } catch (e) {
    console.error('[Memory stats]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/memory/clients-with-memories - clients that have at least one memory
app.get('/api/memory/clients-with-memories', async (req, res) => {
  try {
    const r = await query(`
      SELECT lc.id,
             COALESCE(NULLIF(lc.nome_fantasia, ''), lc.nome_legal, 'Sem nome') AS nome,
             lc.cnpj,
             COUNT(m.id) FILTER (WHERE m.status = 'approved') AS total,
             COUNT(m.id) FILTER (WHERE m.status = 'approved') AS approved,
             COUNT(m.id) FILTER (WHERE m.is_rag_enabled = true AND m.status = 'approved') AS rag_enabled
      FROM luna_v2.clients lc
      JOIN memories m ON m.scope_id = lc.id AND m.scope_type = 'client'
      GROUP BY lc.id, lc.nome_fantasia, lc.nome_legal, lc.cnpj
      HAVING COUNT(m.id) FILTER (WHERE m.status = 'approved') > 0
      ORDER BY COUNT(m.id) DESC, nome ASC
      LIMIT 200`);
    res.json(r.rows.map(row => ({
      id: row.id,
      nome: row.nome,
      cnpj: row.cnpj,
      total: Number(row.total) || 0,
      approved: Number(row.approved) || 0,
      rag_enabled: Number(row.rag_enabled) || 0,
    })));
  } catch (e) {
    console.error('[Memory clients-with-memories]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/memory/suggestions - List pending suggestions for review
app.get('/api/memory/suggestions', async (req, res) => {
  try {
    const { status = 'pending', limit = 50 } = req.query;
    const result = await query(
      `SELECT ms.*, a.name AS agent_name,
              COALESCE(NULLIF(cl.nome_fantasia, ''), cl.nome_legal) AS client_nome,
              cl.cnpj AS client_cnpj
         FROM memory_suggestions ms
         LEFT JOIN agents a ON ms.agent_id = a.id
         LEFT JOIN luna_v2.clients cl ON cl.id = ms.scope_id AND ms.scope_type = 'client'
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
    
    // Normaliza trigger_type para valores aceitos pelo enum memory_source
    const SOURCE_MAP = {
      'conversation_insight': 'conversation',
      'conversation_reflection': 'conversation',
      'auto_extract': 'tool_result',
      'manual_teach': 'manual',
    };
    const rawSource = suggestion.trigger_type || 'manual';
    const sourceType = SOURCE_MAP[rawSource] || (['manual','conversation','tool_result','trigger','import','document'].includes(rawSource) ? rawSource : 'conversation');

    // Determina scope_type/scope_id: preserva cliente se sugestao tiver
    const scopeType = suggestion.scope_type || 'agent';
    const scopeId = suggestion.scope_id || null;

    // Create memory from suggestion (preservando scope do cliente + metadata rica)
    const metaFromEvidence = suggestion.evidence_json || {};
    const memResult = await query(
      `INSERT INTO memories (agent_id, scope_type, scope_id, category, title, content, summary,
                              source_type, source_ref, confidence_score, status, tags, metadata,
                              is_rag_enabled)
       VALUES ($1, $2::memory_scope, $3, $4::memory_category, $5, $6, $7,
               $8::memory_source, $9, $10, 'approved'::memory_status, $11, $12::jsonb, true)
       RETURNING *`,
      [suggestion.agent_id, scopeType, scopeId,
       suggestion.category || 'general', suggestion.title,
       suggestion.proposed_content, suggestion.proposed_summary,
       sourceType, suggestion.trigger_ref,
       suggestion.confidence_score || 0.8,
       suggestion.tags || [],
       JSON.stringify({ origin: 'suggestion', ...metaFromEvidence })]
    );
    
    // Update suggestion status
    await query(
      `UPDATE memory_suggestions SET review_status = 'approved', review_notes = $1, reviewed_at = now(), promoted_memory_id = $2 WHERE id = $3`,
      [notes || 'Approved', memResult.rows[0].id, id]
    );
    
    // Audit log
    await query(
      `INSERT INTO memory_audit_log (entity_type, entity_id, action, actor_type, reason, source_ref, after_json)
       VALUES ('memory', $1, 'approved', 'human', 'Sugestao promovida', $2, $3::jsonb)`,
      [memResult.rows[0].id, `suggestion:${id}`, JSON.stringify({ suggestion_id: id, title: memResult.rows[0].title })]
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

    // Governanca em 3 niveis (frente 5 mai/2026):
    //   quarantine (injection) -> status=rejected, tag 'quarantine', confianca 0
    //   review (fato sensivel) -> status=pending_review, tag 'needs_review', confianca 0.5
    //   approve (trivia)       -> status=approved, confianca 1.0
    const { classifyMemory, tagsWithLevel } = await import('./services/memory-classifier.js');
    const decision = classifyMemory(title, content);
    const finalTags = tagsWithLevel(tags, decision.level);
    const confidence = decision.level === 'quarantine' ? 0.0
                     : decision.level === 'review'    ? 0.5
                     : 1.0;

    const result = await query(
      `INSERT INTO memories (agent_id, scope_type, category, title, content, summary, source_type, status, tags, confidence_score)
       VALUES ($1, (CASE WHEN $1::uuid IS NULL THEN 'team' ELSE 'agent' END)::memory_scope, $2::memory_category, $3, $4, $5, 'manual', $7::memory_status, $6, $8) RETURNING *`,
      [agent_id || null, category, title, content, summary || '', finalTags, decision.status, confidence]
    );

    res.status(201).json({
      memory: result.rows[0],
      governance: {
        level: decision.level,
        status: decision.status,
        reasons: decision.reasons,
      },
    });
  } catch (error) {
    console.error('[Memory] Erro ao ensinar:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/memory/governance - Lista pendentes de revisao + quarentena pra triagem humana
app.get('/api/memory/governance', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, title, content, summary, status, tags, confidence_score, created_at, agent_id, scope_type
      FROM memories
      WHERE status IN ('pending_review','rejected')
        AND (tags && ARRAY['needs_review','quarantine'])
      ORDER BY
        CASE WHEN 'quarantine' = ANY(tags) THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 200
    `);
    const stats = {
      pending_review: rows.filter(r => r.tags?.includes('needs_review')).length,
      quarantine: rows.filter(r => r.tags?.includes('quarantine')).length,
      total: rows.length,
    };
    res.json({ ok: true, stats, items: rows });
  } catch (error) {
    console.error('[Memory] governance erro:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/memory/:id/governance/approve - Aprova item de pending_review/quarantine
app.post('/api/memory/:id/governance/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `UPDATE memories SET status='approved'::memory_status, confidence_score=1.0,
         tags = array_remove(array_remove(tags, 'needs_review'), 'quarantine'),
         approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'memoria nao encontrada' });
    res.json({ ok: true, memory: rows[0] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/memory/:id/governance/discard - Descarta definitivamente (archived)
app.post('/api/memory/:id/governance/discard', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `UPDATE memories SET status='archived'::memory_status, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'memoria nao encontrada' });
    res.json({ ok: true, memory: rows[0] });
  } catch (error) { res.status(500).json({ error: error.message }); }
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

// GET /api/memory/audit - Feed de eventos da memoria
app.get('/api/memory/audit', async (req, res) => {
  try {
    const { limit = 100, action, entity_id, since } = req.query;
    const where = [`mal.entity_type = 'memory'`];
    const params = [];
    let idx = 0;
    if (action) { where.push(`mal.action = $${++idx}`); params.push(String(action)); }
    if (entity_id) { where.push(`mal.entity_id = $${++idx}::uuid`); params.push(String(entity_id)); }
    if (since) { where.push(`mal.created_at >= $${++idx}::timestamptz`); params.push(String(since)); }
    params.push(Math.min(parseInt(limit) || 100, 500));
    const result = await query(
      `SELECT mal.id, mal.entity_id, mal.action, mal.actor_type, mal.actor_id,
              mal.reason, mal.source_ref, mal.before_json, mal.after_json, mal.created_at,
              m.title AS memory_title, m.category AS memory_category,
              a.name AS actor_name, lc.nome_fantasia AS client_name
         FROM memory_audit_log mal
         LEFT JOIN memories m ON mal.entity_id = m.id
         LEFT JOIN agents a ON mal.actor_id = a.id
         LEFT JOIN luna_v2.clients lc ON m.scope_id = lc.id AND m.scope_type = 'client'::memory_scope
        WHERE ${where.join(' AND ')}
        ORDER BY mal.created_at DESC
        LIMIT $${++idx}`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    console.error('[Memory] Erro audit:', error);
    res.json([]);
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
import { registerAdminBudgets } from './routes/admin-budgets.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerSkillsRoutes } from './routes/skills.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerErrorsRoutes } from './routes/errors.js';
import { registerAlertsRoutes } from './routes/alerts.js';
import { getImpactMetrics } from './services/impact-metrics.js';
import { addComment, listComments } from './services/task-comments.js';
import { findConversationsToAutoResolve, markResolved } from './services/alert-config.js';
import { installGlobalHandlers, expressErrorHandler } from './services/error-collector.js';
import { registerDatalake } from './routes/datalake.js';
import { registerMemoryReflect } from './routes/memory-reflect.js';
import { registerSentiment } from './routes/sentiment.js';
import { registerLunaHealth } from './routes/luna-health.js';
import { registerRagRoutes } from './routes/rag.js';
import { registerMemoryDecay } from './routes/memory-decay.js';
registerAdminCleanup(app);
registerAdminBudgets(app);
registerIngestRoutes(app);
registerSkillsRoutes(app);
registerActivityRoutes(app);
registerErrorsRoutes(app);
registerAlertsRoutes(app);

// ============================================
// TASK COMMENTS — coordenação interna, @mention dispara wake do agente
// ============================================
app.get('/api/tasks/:id/comments', async (req, res) => {
  try {
    res.json({ ok: true, data: await listComments(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/:id/comments', async (req, res) => {
  try {
    const { content, author_name, author_type = 'user', author_id = null } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: 'content obrigatorio' });
    const comment = await addComment({
      task_id: req.params.id,
      author_type, author_id,
      author_name: author_name || 'Caio',
      content: content.trim(),
    });
    res.json({ ok: true, data: comment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/metrics/impact", async (_req, res) => { try { res.json(await getImpactMetrics()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/saldanha/sweep', async (req, res) => { try { const txt = await generateSaldanhaReport(logAgentChat); res.json({ ok: true, texto: txt }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/auditor/report', async (req, res) => { try { const txt = await generateAuditorReport(logAgentChat); res.json({ ok: true, texto: txt }); } catch (e) { res.status(500).json({ error: e.message }); } });
// Feriados nacionais (fixos + moveis calculados via Pascoa)
app.get('/api/feriados', (req, res) => {
  const ano = parseInt(req.query.ano) || new Date().getFullYear();
  try {
    res.json({ ano, feriados: feriadosDoAno(ano) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/feriados/hoje', (req, res) => {
  try {
    const result = checarFeriado(new Date());
    res.json({ data: new Date().toISOString().slice(0,10), ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Express error handler — DEVE ser o ultimo middleware registrado
app.use(expressErrorHandler());
registerDatalake(app);
registerMemoryReflect(app);
registerSentiment(app);
registerLunaHealth(app);
registerRagRoutes(app);
registerMemoryDecay(app);

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
startRegressionDetector(60);  // scan regressões Luna a cada 60min
server.listen(PORT, async () => {
  // Conecta orchestrator ao broadcast e ao registry
  setBroadcast(broadcast);
  setLogChat(logAgentChat);
  setOnTaskCreated((taskId) => processTask(taskId));

  // Inicializa WhatsApp (Luna) — conecta broadcast + processamento de tasks
  whatsapp.setBroadcast(broadcast);
  whatsapp.setLogChat(logAgentChat);
  whatsapp.setOnTaskCreated((taskId) => processTask(taskId));
  whatsapp.initialize().catch(err => console.error('[WhatsApp] Falha:', err.message));

  // Auto-healing: monitora Chromium/Puppeteer a cada 90s e reinicia se travado
  whatsapp.startHealthcheck(90 * 1000);

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
  scheduleAuditorDaily(logAgentChat);
  scheduleSaldanhaDaily(logAgentChat);

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

  // === Inter Banking — sync diario D-1 pra todas integracoes ativas ===
  registerCronHandler('inter_sync_diario', async () => {
    const url = (process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000') + '/api/integracoes/cron/sincronizar-todos'
    try {
      const resp = await fetch(url, { method: 'POST' })
      const j = await resp.json()
      if (!j.ok) return `Falhou: ${j.error || 'erro desconhecido'}`
      const d = j.data || {}
      return `Inter sync: ${d.sucesso || 0}/${d.total_integracoes || 0} sucesso, ${d.falhas || 0} falhas`
    } catch (e) {
      return `Erro acionando sync Inter: ${e.message}`
    }
  })

  // === Inter Banking — alerta diario de certificados vencendo ===
  registerCronHandler('inter_cert_check', async () => {
    const url = (process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000') + '/api/integracoes/certificados/vencendo'
    try {
      const resp = await fetch(url)
      const j = await resp.json()
      const items = (j.data || [])
      if (items.length === 0) return 'Nenhum certificado proximo do vencimento'

      // Monta mensagem pra cada vencimento e dispara via chat interno
      const { chat } = await import('./services/chat-broadcaster.js').catch(() => ({ chat: null }))
      for (const item of items) {
        const msg = item.dias_ate_expirar <= 0
          ? `🔴 Certificado Inter VENCIDO do cliente #${item.cliente_id} (integracao ${item.integracao_id}). Gere novo no IB e atualize.`
          : `⚠️ Certificado Inter vence em ${item.dias_ate_expirar} dias — cliente #${item.cliente_id}. Lembrar cliente de gerar novo no IB.`
        if (chat) chat({ from: 'Luna', text: msg, tag: 'cert-inter' })
        console.log(`[inter_cert_check] ${msg}`)
      }
      return `${items.length} certificado(s) em alerta notificado(s)`
    } catch (e) {
      return `Erro verificando certificados: ${e.message}`
    }
  })

  // === Continuidade contabil — audita saldos entre meses pra todos clientes ===
  // Regra: saldo_final mes N deve bater com saldo_inicial mes N+1 (mesma conta).
  // Divergencia = upload faltando, duplicado ou parser errado.
  registerCronHandler('continuidade_saldos', async () => {
    const url = (process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000') + '/api/clientes'
    try {
      // Busca todos clientes
      const resp = await fetch(url)
      const j = await resp.json()
      const clientes = j?.data || []
      const divergenciasGlobais = []

      for (const c of clientes) {
        const contUrl = (process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000')
          + `/api/transacoes/continuidade?cliente_id=${c.id}`
        try {
          const r = await fetch(contUrl)
          const cj = await r.json()
          const divergentes = cj?.data?.divergencias || []
          for (const d of divergentes) {
            divergenciasGlobais.push({ cliente_id: c.id, cliente_nome: c.legalName || c.tradeName, ...d })
          }
        } catch (_e) { /* skip cliente */ }
      }

      if (divergenciasGlobais.length === 0) {
        return `Todos clientes com saldos contabeis consistentes (${clientes.length} verificados)`
      }

      // Notifica equipe via createNotification (aparece no sino de notificacoes)
      const top5 = divergenciasGlobais
        .sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca))
        .slice(0, 5)
      const resumo = top5.map(d =>
        `  - ${d.cliente_nome}: saldo ${d.dePeriodoFim || '?'} (R$ ${d.saldoFinalAnterior}) nao bate com inicio ${d.paraPeriodoInicio || '?'} (R$ ${d.saldoInicialProximo}) diff R$ ${d.diferenca}`
      ).join('\n')
      const msg = `Continuidade contabil: ${divergenciasGlobais.length} divergencia(s) detectadas.\n\nTop ${top5.length} por magnitude:\n${resumo}\n\nAbrir Atrio Finance > Transacoes > filtrar cliente afetado pra investigar.`
      try {
        await createNotification({
          type: 'auditoria_saldo',
          title: `Continuidade contabil: ${divergenciasGlobais.length} divergencia(s)`,
          message: msg,
          severity: 'warning',
          metadata: { handler: 'continuidade_saldos', total: divergenciasGlobais.length, top5 },
        })
      } catch (e) { console.error('[continuidade_saldos] notification failed:', e.message) }
      console.log(`[continuidade_saldos] ${divergenciasGlobais.length} divergencias de ${clientes.length} clientes`)
      return `${divergenciasGlobais.length} divergencias de saldo entre meses detectadas em ${clientes.length} clientes (top ${top5.length} notificadas)`
    } catch (e) {
      return `Erro: ${e.message}`
    }
  })

  // === Documentos vencendo — alerta proativo de certificados/procuracoes ===
  // Roda diariamente 09h. Consulta Gesthub /client-files/expiring, agrupa por
  // criticidade (vencido/critico ≤7d/atencao ≤30d) e notifica equipe.
  registerCronHandler('docs_validade_check', async () => {
    const url = (process.env.GESTHUB_API_URL || 'http://31.97.175.200') + '/api/client-files/expiring?days=30'
    try {
      const r = await fetch(url)
      const j = await r.json()
      const docs = Array.isArray(j?.data) ? j.data : []
      if (docs.length === 0) return 'Nenhum documento vencendo nos proximos 30 dias'

      const vencidos = docs.filter(d => d.status === 'vencido')
      const criticos = docs.filter(d => d.status === 'critico')
      const atencao  = docs.filter(d => d.status === 'atencao')

      const linhas = []
      if (vencidos.length) {
        linhas.push(`VENCIDOS (${vencidos.length}):`)
        linhas.push(...vencidos.slice(0, 5).map(d =>
          `  - ${d.clientName}: ${d.nome} (${d.categoria}) venceu ha ${Math.abs(d.diasParaVencer)}d`
        ))
      }
      if (criticos.length) {
        linhas.push(`CRITICOS (${criticos.length}) - vence em <= 7 dias:`)
        linhas.push(...criticos.slice(0, 5).map(d =>
          `  - ${d.clientName}: ${d.nome} vence em ${d.diasParaVencer}d`
        ))
      }
      if (atencao.length) {
        linhas.push(`ATENCAO (${atencao.length}) - vence em 8-30 dias:`)
        linhas.push(...atencao.slice(0, 3).map(d =>
          `  - ${d.clientName}: ${d.nome} vence em ${d.diasParaVencer}d`
        ))
      }

      const msg = linhas.join('\n')
      const severity = vencidos.length > 0 || criticos.length > 0 ? 'warning' : 'info'

      try {
        await createNotification({
          type: 'documento_validade',
          title: `Documentos: ${vencidos.length} vencido(s), ${criticos.length} critico(s), ${atencao.length} atencao`,
          message: msg,
          severity,
          metadata: { handler: 'docs_validade_check', counts: { vencidos: vencidos.length, criticos: criticos.length, atencao: atencao.length } },
        })
      } catch (e) { console.error('[docs_validade] notification failed:', e.message) }

      console.log(`[docs_validade] ${vencidos.length} vencidos, ${criticos.length} criticos, ${atencao.length} atencao`)
      return `${vencidos.length} vencidos, ${criticos.length} criticos, ${atencao.length} atencao (30d)`
    } catch (e) {
      return `Erro: ${e.message}`
    }
  })

  // === Natalia: Health-check da carteira — sinaliza clientes "frios" sem entrega de docs ===
  // Roda semanal segunda 08h. Cliente ativo SEM upload de extrato em 60d → cria task pra Natalia.
  registerCronHandler('natalia_health_check', async () => {
    const NATALIA_ID = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab' // team_members
    const FINANCE = process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000'
    try {
      // Clientes ATIVOS no Gesthub COM mais de 60 dias (recem-criados nao contam)
      const { rows: ativos } = await query(
        `SELECT id, legal_name, trade_name, status, document, monthly_fee
           FROM datalake_gesthub.clients
          WHERE status = 'ATIVO'
            AND (
              start_date IS NULL OR start_date = ''
              OR (start_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND start_date::date < CURRENT_DATE - INTERVAL '60 days')
            )`
      )

      // Cruza com Finance: quem nao tem upload nos ultimos 60d
      const r = await fetch(`${FINANCE}/api/uploads?dias=60`).catch(() => null)
      const j = await r?.json().catch(() => ({}))
      const uploads = j?.data || j || []
      const ativosComUpload = new Set(uploads.map(u => u.clienteGesthubId || u.cliente_gesthub_id))

      const frios = ativos.filter(c => !ativosComUpload.has(c.id))
      let criadas = 0

      // Rate-limit: max 15 tasks novas por execucao pra nao inundar
      // Ordena por monthly_fee desc → prioriza clientes mais valiosos
      const ordenados = frios
        .sort((a, b) => Number(b.monthly_fee || 0) - Number(a.monthly_fee || 0))
        .slice(0, 15)

      for (const c of ordenados) {
        const taskKey = `health-${c.id}`
        const dup = await query(
          `SELECT id FROM tasks WHERE status IN ('pending','in_progress')
             AND result->>'health_key' = $1 LIMIT 1`,
          [taskKey]
        ).catch(() => ({ rows: [] }))
        if (dup.rows.length) continue

        const cliente = c.trade_name || c.legal_name || `cliente ${c.id}`
        const msgSugerida = `Olá! Tudo bem por aí? Notei que faz tempo que não recebemos sua movimentação financeira. Está tudo certo no escritório? Se precisar de algo, é só chamar.`

        await query(
          `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result, created_at)
           VALUES ($1, $2, $3, NULL, 'medium', 'pending', $4::jsonb, NOW())`,
          [
            `Cliente frio (60d sem docs): ${cliente}`,
            `Cliente ativo no Gesthub mas sem upload de extrato/documentos no Atrio Finance ha mais de 60 dias.\n\nPossivel sinal de churn ou apenas inatividade temporaria.\n\nMensagem sugerida (revisar antes de aprovar envio):\n"${msgSugerida}"\n\nLink Gesthub: http://31.97.175.200/clientes/${c.id}`,
            NATALIA_ID,
            JSON.stringify({ source: 'natalia_health_check', health_key: taskKey, gesthub_client_id: c.id, msg_sugerida: msgSugerida }),
          ]
        ).catch(e => console.error('[natalia_health_check] insert:', e.message))
        criadas++
      }

      const resumo = `Carteira: ${ativos.length} ativos, ${frios.length} sem docs ha 60d → ${criadas} task(s) novas pra Natalia (top 15 por valor mensal)`
      console.log(`[natalia_health_check] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[natalia_health_check]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Natalia: Aniversario de cliente — 6m (NPS), 12m+ (reajuste) ===
  // Roda diario 09h. Detecta clientes que completam aniversario hoje e cria task.
  registerCronHandler('natalia_aniversario_cliente', async () => {
    const NATALIA_ID = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab'
    try {
      const { rows: clientes } = await query(
        `SELECT id, legal_name, trade_name, start_date, monthly_fee
           FROM datalake_gesthub.clients
          WHERE status = 'ATIVO'
            AND start_date IS NOT NULL
            AND start_date <> ''
            AND start_date ~ '^\d{4}-\d{2}-\d{2}$'
            AND (
              -- 6 meses exato
              (EXTRACT(MONTH FROM AGE(CURRENT_DATE, start_date::date)) = 6
               AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, start_date::date)) = 0
               AND EXTRACT(DAY FROM AGE(CURRENT_DATE, start_date::date)) = 0)
              OR
              -- multiplos de 12 meses
              (EXTRACT(MONTH FROM start_date::date) = EXTRACT(MONTH FROM CURRENT_DATE)
               AND EXTRACT(DAY FROM start_date::date) = EXTRACT(DAY FROM CURRENT_DATE)
               AND DATE_PART('year', AGE(CURRENT_DATE, start_date::date)) >= 1)
            )`
      ).catch(() => ({ rows: [] }))

      let criadas = 0
      for (const c of clientes) {
        const start = new Date(c.start_date)
        const anos = Math.floor((Date.now() - start.getTime()) / (365.25 * 86400000))
        const meses = Math.floor((Date.now() - start.getTime()) / (30.44 * 86400000))
        const taskKey = `aniv-${c.id}-${new Date().getFullYear()}m${new Date().getMonth() + 1}`
        const dup = await query(
          `SELECT id FROM tasks WHERE result->>'aniv_key' = $1 LIMIT 1`,
          [taskKey]
        ).catch(() => ({ rows: [] }))
        if (dup.rows.length) continue

        const cliente = c.trade_name || c.legal_name || `cliente ${c.id}`
        let titulo, msgSugerida
        if (meses === 6) {
          titulo = `🎉 6 meses: ${cliente} — pesquisa NPS`
          msgSugerida = `Oi! Hoje completam 6 meses do nosso atendimento. Como tem sido pra você? Numa escala de 0 a 10, quanto recomendaria o Atrio pra outro empresario? Se tiver algum ponto que possamos melhorar, conta com a gente!`
        } else if (anos >= 1) {
          titulo = `🎂 ${anos} ano(s): ${cliente} — agradecimento + reajuste`
          msgSugerida = `Oi! Hoje completam ${anos} ano(s) da nossa parceria. Obrigado pela confianca! No proximo mes vamos aplicar o reajuste anual conforme contrato (IGPM/IPCA + servicos agregados). Te envio o detalhe ate o dia 5.`
        }

        await query(
          `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result, created_at)
           VALUES ($1, $2, $3, NULL, 'low', 'pending', $4::jsonb, NOW())`,
          [
            titulo,
            `Cliente ${cliente} (#${c.id}) completa ${meses} meses hoje.\nValor mensal atual: R$ ${c.monthly_fee || '?'}\n\nMensagem sugerida:\n"${msgSugerida}"\n\nLink: http://31.97.175.200/clientes/${c.id}`,
            NATALIA_ID,
            JSON.stringify({ source: 'natalia_aniversario_cliente', aniv_key: taskKey, gesthub_client_id: c.id, meses, msg_sugerida: msgSugerida }),
          ]
        ).catch(e => console.error('[natalia_aniversario] insert:', e.message))
        criadas++
      }

      const resumo = `Aniversarios hoje: ${clientes.length} clientes → ${criadas} task(s) novas`
      console.log(`[natalia_aniversario] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[natalia_aniversario]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Natalia: Qualificar leads novos (PROSPECT) ===
  // Diario 10h. Para cada cliente tipo=PROSPECT recente, enriquece CNPJ e cria task de abordagem.
  registerCronHandler('natalia_qualificar_leads', async () => {
    const NATALIA_ID = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab'
    try {
      const { rows: prospects } = await query(
        `SELECT id, legal_name, trade_name, document, type
           FROM datalake_gesthub.clients
          WHERE client_type = 'PROSPECT'
            AND status = 'ATIVO'
            AND created_at > NOW() - INTERVAL '7 days'`
      ).catch(() => ({ rows: [] }))

      let criadas = 0
      for (const p of prospects) {
        const taskKey = `lead-${p.id}`
        const dup = await query(
          `SELECT id FROM tasks WHERE result->>'lead_key' = $1 LIMIT 1`,
          [taskKey]
        ).catch(() => ({ rows: [] }))
        if (dup.rows.length) continue

        const cliente = p.trade_name || p.legal_name || `prospect ${p.id}`
        const msgSugerida = `Ola! Vi seu CNPJ ativo e queria me apresentar. Sou Natalia do Atrio Contabilidade, atendemos empresas como a sua com BPO contabil/fiscal e financeiro. Voce ja tem contador? Posso te enviar uma analise rapida do seu regime atual?`

        await query(
          `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result, created_at)
           VALUES ($1, $2, $3, NULL, 'medium', 'pending', $4::jsonb, NOW())`,
          [
            `Lead novo: ${cliente}`,
            `Lead PROSPECT cadastrado nos ultimos 7 dias.\nCNPJ: ${p.document || 's/'}\n\nAcao Natalia: enriquecer CNPJ via consulta_cnpj (porte, regime, CNAE, idade), avaliar fit, sugerir abordagem.\n\nMensagem sugerida (revisar):\n"${msgSugerida}"\n\nLink: http://31.97.175.200/clientes/${p.id}`,
            NATALIA_ID,
            JSON.stringify({ source: 'natalia_qualificar_leads', lead_key: taskKey, gesthub_client_id: p.id, msg_sugerida: msgSugerida }),
          ]
        ).catch(e => console.error('[natalia_leads] insert:', e.message))
        criadas++
      }

      const resumo = `Leads ultimos 7d: ${prospects.length} → ${criadas} task(s) novas pra Natalia`
      console.log(`[natalia_qualificar_leads] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[natalia_qualificar_leads]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Aprovar e enviar mensagem sugerida (Natalia) — 1 clique ===
  // POST /api/tasks/:id/approve-and-send
  // body: { message?: string }   — se nao vier, usa result.msg_sugerida
  // Resolve telefone via gesthub_client_id → contatos → primeiro com telefone valido.
  // Envia via WhatsApp, registra historico no task result, marca task done.
  app.post('/api/tasks/:id/approve-and-send', async (req, res) => {
    try {
      const { id } = req.params
      const { message: customMsg, telefone: telefoneOverride } = req.body || {}

      const { rows } = await query('SELECT * FROM tasks WHERE id = $1', [id])
      if (!rows.length) return res.status(404).json({ error: 'task nao encontrada' })
      const task = rows[0]
      const result = task.result || {}
      const msg = customMsg || result.msg_sugerida
      if (!msg) return res.status(400).json({ error: 'sem mensagem (forneca message no body ou result.msg_sugerida)' })

      // Resolve telefone
      let telefone = telefoneOverride
      const gesthubId = result.gesthub_client_id
      if (!telefone && gesthubId) {
        try {
          const GH = process.env.GESTHUB_API_URL || 'http://31.97.175.200'
          const r = await fetch(`${GH}/api/clients/${gesthubId}/contatos`)
          const j = await r.json()
          const contatos = (j?.data || []).filter(c => c.telefone && c.telefone.replace(/\D/g, '').length >= 10)
          // Prioriza SOCIO/DIRETOR, senao primeiro
          const primary = contatos.find(c => /socio|diretor/i.test(c.funcao || '')) || contatos[0]
          telefone = primary?.telefone
        } catch (e) { console.error('[approve-and-send] gesthub:', e.message) }
      }
      if (!telefone) return res.status(400).json({ error: 'cliente sem telefone cadastrado em contatos. Adicione o telefone no Gesthub ou passe telefone no body.' })

      // Envia
      try {
        await whatsapp.sendMessage(telefone, msg)
      } catch (e) {
        return res.status(502).json({ error: `WhatsApp falhou: ${e.message}` })
      }

      // Marca task como done + registra historico
      await query(
        `UPDATE tasks
            SET status = 'done',
                completed_at = NOW(),
                result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
                  'approved_at', NOW(),
                  'sent_to', $1::text,
                  'sent_message', $2::text,
                  'approved_by', 'caio'
                )
          WHERE id = $3`,
        [telefone, msg.slice(0, 1000), id]
      )
      broadcast({ type: 'task_completed', task_id: id })
      res.json({ ok: true, sent_to: telefone })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // === Gera obrigacoes fiscais do mes (dia 1, 06h) ===
  // Chama Gesthub /api/obrigacoes/gerar-mensal — idempotente.
  registerCronHandler('gerar_obrigacoes_mes', async () => {
    const GH = process.env.GESTHUB_API_URL || 'http://31.97.175.200'
    const now = new Date()
    // Gera obrigacoes do MES PASSADO (competencia anterior — eh sobre essa que se paga agora)
    const tgt = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const ano = tgt.getFullYear()
    const mes = tgt.getMonth() + 1

    try {
      const r = await fetch(`${GH}/api/obrigacoes/gerar-mensal?ano=${ano}&mes=${mes}`, { method: 'POST' })
      const j = await r.json()
      const resumo = `Obrigacoes ${mes}/${ano}: ${j.criadas} criadas em ${j.total_clientes} clientes (${j.skipped_sem_template} sem template)`
      console.log(`[gerar_obrigacoes_mes] ${resumo}`)
      try {
        await createNotification({
          type: 'obrigacoes_geradas',
          title: `${j.criadas} obrigacoes fiscais criadas (${mes}/${ano})`,
          message: resumo,
          severity: 'info',
          metadata: { handler: 'gerar_obrigacoes_mes', ano, mes, ...j },
        })
      } catch {}
      return resumo
    } catch (e) {
      return `Erro: ${e.message}`
    }
  })

  // === Aviso obrigacoes prazo D-3, D-1, vencido ===
  registerCronHandler('obrigacoes_aviso_prazo', async () => {
    const GH = process.env.GESTHUB_API_URL || 'http://31.97.175.200'
    try {
      const r = await fetch(`${GH}/api/obrigacoes?status=pendente`)
      const j = await r.json()
      const obrigs = j?.data || []
      const now = new Date()
      const today = now.toISOString().slice(0, 10)
      const buckets = { vencidas: [], hoje: [], d1: [], d3: [] }
      for (const o of obrigs) {
        if (!o.prazo) continue
        const days = Math.ceil((new Date(o.prazo).getTime() - now.getTime()) / 86400000)
        if (days < 0) buckets.vencidas.push(o)
        else if (days === 0) buckets.hoje.push(o)
        else if (days === 1) buckets.d1.push(o)
        else if (days === 3) buckets.d3.push(o)
      }
      const msg = `Obrigacoes: ${buckets.vencidas.length} vencidas, ${buckets.hoje.length} hoje, ${buckets.d1.length} amanha, ${buckets.d3.length} em 3d`
      if (buckets.vencidas.length || buckets.hoje.length) {
        try {
          await createNotification({
            type: 'obrigacao_prazo',
            title: `🚨 Obrigacoes fiscais: ${buckets.vencidas.length} vencida(s), ${buckets.hoje.length} vence(m) hoje`,
            message: msg,
            severity: 'warning',
            metadata: { handler: 'obrigacoes_aviso_prazo', ...buckets },
            push: { tag: 'obrig-prazo' },
          })
        } catch {}
      }
      console.log(`[obrigacoes_aviso] ${msg}`)
      return msg
    } catch (e) {
      return `Erro: ${e.message}`
    }
  })

  // === Snapshot MRR + alerta de queda mensal ===
  // Roda diario 23h. Salva snapshot mensal (1x/mes). No dia 1, compara com mes anterior;
  // se MRR caiu >= 5%, alerta com push critico.
  registerCronHandler('mrr_snapshot_e_alerta', async () => {
    try {
      const { rows: ag } = await query(
        `SELECT COUNT(*)::int AS clientes_ativos, COALESCE(SUM(monthly_fee), 0)::numeric AS mrr_total
           FROM datalake_gesthub.clients WHERE status = 'ATIVO'`
      )
      const c = ag[0]
      const today = new Date().toISOString().slice(0, 10)

      // Insere/atualiza snapshot do dia
      await query(
        `INSERT INTO mrr_snapshots (snapshot_date, clientes_ativos, mrr_brl)
         VALUES ($1, $2, $3)
         ON CONFLICT (snapshot_date) DO UPDATE SET
           clientes_ativos = EXCLUDED.clientes_ativos,
           mrr_brl = EXCLUDED.mrr_brl`,
        [today, c.clientes_ativos, c.mrr_total]
      )

      // Comparar com snapshot de 30d atras
      const { rows: prev } = await query(
        `SELECT clientes_ativos, mrr_brl, snapshot_date
           FROM mrr_snapshots
          WHERE snapshot_date <= CURRENT_DATE - INTERVAL '28 days'
          ORDER BY snapshot_date DESC LIMIT 1`
      )

      let alertaMsg = null
      if (prev.length) {
        const p = prev[0]
        const mrrAntes = parseFloat(p.mrr_brl)
        const mrrAgora = parseFloat(c.mrr_total)
        const deltaPct = mrrAntes > 0 ? ((mrrAgora - mrrAntes) / mrrAntes) * 100 : 0
        const deltaBrl = mrrAgora - mrrAntes
        const clientesDelta = c.clientes_ativos - p.clientes_ativos

        if (deltaPct <= -5) {
          alertaMsg = `📉 MRR caiu ${Math.abs(deltaPct).toFixed(1)}% em relacao a ${p.snapshot_date} (R$ ${mrrAntes.toLocaleString('pt-BR')} → R$ ${mrrAgora.toLocaleString('pt-BR')}, delta R$ ${deltaBrl.toLocaleString('pt-BR')}, clientes: ${clientesDelta >= 0 ? '+' : ''}${clientesDelta})`
          await createNotification({
            type: 'mrr_drop',
            title: `MRR caiu ${Math.abs(deltaPct).toFixed(1)}% no mes`,
            message: alertaMsg,
            severity: 'error',
            metadata: { handler: 'mrr_snapshot_e_alerta', mrr_antes: mrrAntes, mrr_agora: mrrAgora, delta_pct: deltaPct, delta_brl: deltaBrl },
            push: { tag: 'mrr-drop' },
          })
        } else if (deltaPct >= 5) {
          alertaMsg = `📈 MRR subiu ${deltaPct.toFixed(1)}% em relacao a ${p.snapshot_date} (R$ ${mrrAntes.toLocaleString('pt-BR')} → R$ ${mrrAgora.toLocaleString('pt-BR')}, +${clientesDelta} cliente(s))`
          await createNotification({
            type: 'mrr_growth',
            title: `MRR cresceu ${deltaPct.toFixed(1)}% 🎉`,
            message: alertaMsg,
            severity: 'success',
            metadata: { handler: 'mrr_snapshot_e_alerta', mrr_antes: mrrAntes, mrr_agora: mrrAgora, delta_pct: deltaPct },
          })
        } else {
          alertaMsg = `MRR estavel: R$ ${mrrAgora.toLocaleString('pt-BR')} (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% vs ${p.snapshot_date})`
        }
      } else {
        alertaMsg = `Snapshot inicial: ${c.clientes_ativos} ativos, R$ ${parseFloat(c.mrr_total).toLocaleString('pt-BR')} (sem comparativo ainda)`
      }

      console.log(`[mrr_snapshot] ${alertaMsg}`)
      return alertaMsg
    } catch (e) {
      console.error('[mrr_snapshot]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Natalia: Acompanhar respostas — pos-envio detecta se cliente respondeu ===
  // Roda diario 18h. Para cada task done com sent_to nas ultimas 7 dias:
  //   - busca whatsapp_messages.sender='client' do mesmo telefone APOS approved_at
  //   - atualiza result com response_status: 'responded' | 'silent' | 'pending'
  //   - se silent depois de 5d, cria task de follow-up
  registerCronHandler('natalia_acompanhar_respostas', async () => {
    const NATALIA_ID = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab'
    try {
      // Tasks aprovadas (Natalia ou outras com msg_sugerida) ultimas 7d, sem response_status fechado
      const { rows: tasks } = await query(
        `SELECT id, title, result, completed_at
           FROM tasks
          WHERE status = 'done'
            AND result->>'sent_to' IS NOT NULL
            AND result->>'approved_at' IS NOT NULL
            AND (result->>'approved_at')::timestamptz > NOW() - INTERVAL '7 days'
            AND COALESCE(result->>'response_status_final', '') = ''`
      ).catch(() => ({ rows: [] }))

      let respondidas = 0, ainda_silent = 0, followup_criado = 0
      for (const t of tasks) {
        const r = t.result || {}
        const phone = String(r.sent_to || '').replace(/\D/g, '')
        const approvedAt = new Date(r.approved_at)
        if (!phone || !approvedAt) continue

        // Busca msg client desse telefone APOS approved_at
        const { rows: resp } = await query(
          `SELECT m.id, m.body, m.created_at
             FROM whatsapp_messages m
             JOIN whatsapp_conversations c ON c.id = m.conversation_id
            WHERE m.sender = 'client'
              AND m.created_at > $1
              AND (
                regexp_replace(c.phone, '\\D', '', 'g') LIKE '%' || $2
                OR regexp_replace(COALESCE(c.real_phone, ''), '\\D', '', 'g') LIKE '%' || $2
              )
            ORDER BY m.created_at ASC
            LIMIT 1`,
          [approvedAt.toISOString(), phone.slice(-10)]
        ).catch(() => ({ rows: [] }))

        const ageDays = (Date.now() - approvedAt.getTime()) / 86400000

        if (resp.length > 0) {
          // RESPONDEU
          await query(
            `UPDATE tasks
                SET result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
                  'response_status', 'responded',
                  'response_status_final', 'responded',
                  'responded_at', $1::text,
                  'response_preview', $2::text
                )
              WHERE id = $3`,
            [resp[0].created_at, String(resp[0].body || '').slice(0, 500), t.id]
          ).catch(() => {})
          respondidas++
        } else if (ageDays >= 5) {
          // SILENT >= 5d — fecha como silent + cria follow-up
          await query(
            `UPDATE tasks
                SET result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
                  'response_status', 'silent',
                  'response_status_final', 'silent',
                  'silent_check_at', NOW()::text
                )
              WHERE id = $1`,
            [t.id]
          ).catch(() => {})

          // Follow-up task
          const followupKey = `followup-${t.id}`
          const dup = await query(
            `SELECT id FROM tasks WHERE result->>'followup_key' = $1 LIMIT 1`,
            [followupKey]
          ).catch(() => ({ rows: [] }))
          if (!dup.rows.length) {
            const msgFollowup = `Oi! Te mandei uma mensagem dia ${approvedAt.toLocaleDateString('pt-BR')} mas nao tive retorno. Imagino que tenha sido uma semana corrida — quando puder, me avise se faz sentido conversarmos.`
            await query(
              `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result, created_at)
               VALUES ($1, $2, $3, NULL, 'low', 'pending', $4::jsonb, NOW())`,
              [
                `↩ Follow-up sem resposta: ${t.title}`,
                `Task original ${t.id} foi enviada em ${approvedAt.toLocaleDateString('pt-BR')} para ${r.sent_to} mas nao recebeu resposta em 5 dias.\n\nMensagem original:\n"${r.sent_message || '(nao salva)'}"\n\nFollow-up sugerido:\n"${msgFollowup}"`,
                NATALIA_ID,
                JSON.stringify({ source: 'natalia_acompanhar_respostas', followup_key: followupKey, original_task_id: t.id, gesthub_client_id: r.gesthub_client_id, msg_sugerida: msgFollowup }),
              ]
            ).catch(e => console.error('[acompanhar] followup insert:', e.message))
            followup_criado++
          }
          ainda_silent++
        } else {
          // Aguardando ainda — atualiza status interim sem fechar
          await query(
            `UPDATE tasks
                SET result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('response_status', 'pending')
              WHERE id = $1`,
            [t.id]
          ).catch(() => {})
        }
      }

      const resumo = `Acompanhamento: ${tasks.length} aprovadas em 7d, ${respondidas} responderam, ${ainda_silent} silent (5d+), ${followup_criado} follow-up(s) criada(s)`
      console.log(`[natalia_acompanhar] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[natalia_acompanhar]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Natalia: Upsell — Simples proximo do teto, MEI estourando, sem NFS-e ===
  // Roda mensal dia 1, 11h.
  registerCronHandler('natalia_upsell_oportunidades', async () => {
    const NATALIA_ID = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab'
    const FINANCE = process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000'
    try {
      // 1) MEI proximo do teto (>= R$ 70k de receita YTD = 86% de R$81k)
      // 2) Simples Nacional proximo do sub-limite estadual (>= R$ 3.5M de R$4.8M)
      // Vamos cruzar com Finance DRE pra ver receita acumulada YTD por cliente.

      const ano = new Date().getFullYear()
      const { rows: clientes } = await query(
        `SELECT id, legal_name, trade_name, tax_regime, monthly_fee
           FROM datalake_gesthub.clients
          WHERE status = 'ATIVO'
            AND tax_regime IN ('MEI', 'SIMPLES_NACIONAL', 'Simples Nacional', 'MICROEMPRESA')`
      ).catch(() => ({ rows: [] }))

      let criadas = 0, oportunidades = 0
      for (const c of clientes) {
        try {
          const r = await fetch(`${FINANCE}/api/transacoes/dre?cliente_id=${c.id}&ano=${ano}`)
          const j = await r.json()
          const dre = j?.data || j || {}
          const receitaYtd = Number(dre.receita_total || dre.receitaTotal || 0)
          if (!receitaYtd) continue

          // Limite por regime
          const regime = (c.tax_regime || '').toUpperCase()
          let limite, percent, alvo
          if (regime.includes('MEI')) {
            limite = 81000; alvo = 'Lucro Presumido (sair do MEI)'
          } else {
            limite = 4800000; alvo = 'Migracao para Lucro Presumido'
          }
          percent = receitaYtd / limite
          if (percent < 0.7) continue // so alerta a partir de 70% do teto

          oportunidades++
          const taskKey = `upsell-${c.id}-${ano}`
          const dup = await query(
            `SELECT id FROM tasks WHERE result->>'upsell_key' = $1 LIMIT 1`,
            [taskKey]
          ).catch(() => ({ rows: [] }))
          if (dup.rows.length) continue

          const cliente = c.trade_name || c.legal_name
          const msgSugerida = `Oi! Estamos acompanhando o crescimento do ${cliente} e ja chegamos a ${(percent * 100).toFixed(0)}% do limite anual de receita do regime ${regime}. Vale conversarmos sobre ${alvo} pra evitar surpresas. Posso te enviar uma simulacao na proxima semana?`

          await query(
            `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result, created_at)
             VALUES ($1, $2, $3, NULL, 'high', 'pending', $4::jsonb, NOW())`,
            [
              `📈 Upsell: ${cliente} (${(percent * 100).toFixed(0)}% do teto)`,
              `Cliente ${cliente} (#${c.id}) — receita YTD R$ ${receitaYtd.toLocaleString('pt-BR')} de R$ ${limite.toLocaleString('pt-BR')} (${(percent * 100).toFixed(1)}%).\nRegime atual: ${regime}\nProposta sugerida: ${alvo}\n\nMensagem (revisar):\n"${msgSugerida}"\n\nLink: http://31.97.175.200/clientes/${c.id}`,
              NATALIA_ID,
              JSON.stringify({ source: 'natalia_upsell_oportunidades', upsell_key: taskKey, gesthub_client_id: c.id, percent, regime, msg_sugerida: msgSugerida }),
            ]
          ).catch(e => console.error('[natalia_upsell] insert:', e.message))
          criadas++
        } catch (e) { /* skip cliente */ }
      }

      const resumo = `Upsell: ${clientes.length} clientes analisados, ${oportunidades} >70% teto, ${criadas} task(s) novas`
      console.log(`[natalia_upsell] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[natalia_upsell]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Natalia: Recuperacao — clientes inativados nos ultimos 90d ===
  // Mensal dia 15, 11h.
  registerCronHandler('natalia_recuperacao', async () => {
    const NATALIA_ID = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab'
    try {
      const { rows: inativos } = await query(
        `SELECT id, legal_name, trade_name, data_inativacao, motivo_inativacao
           FROM datalake_gesthub.clients
          WHERE status IN ('INATIVO', 'BAIXADA')
            AND data_inativacao IS NOT NULL AND data_inativacao <> ''
            AND data_inativacao ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND data_inativacao::date >= CURRENT_DATE - INTERVAL '90 days'`
      ).catch(() => ({ rows: [] }))

      let criadas = 0
      for (const c of inativos) {
        const taskKey = `recup-${c.id}`
        const dup = await query(
          `SELECT id FROM tasks WHERE result->>'recup_key' = $1 LIMIT 1`,
          [taskKey]
        ).catch(() => ({ rows: [] }))
        if (dup.rows.length) continue

        const cliente = c.trade_name || c.legal_name
        const motivoTxt = c.motivo_inativacao ? ` (motivo registrado: ${c.motivo_inativacao})` : ''
        const msgSugerida = `Oi! Aqui e a equipe Atrio. Notamos que voce saiu da nossa carteira recentemente${motivoTxt}. Queria entender com sinceridade o que faltou pra continuarmos juntos — feedback honesto so nos ajuda a melhorar. Se ainda fizer sentido conversar, estou disponivel.`

        await query(
          `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result, created_at)
           VALUES ($1, $2, $3, NULL, 'medium', 'pending', $4::jsonb, NOW())`,
          [
            `Recuperar inativado: ${cliente}`,
            `Cliente ${cliente} (#${c.id}) saiu em ${c.data_inativacao}${motivoTxt}.\n\nMensagem sugerida (revisar):\n"${msgSugerida}"\n\nLink: http://31.97.175.200/clientes/${c.id}`,
            NATALIA_ID,
            JSON.stringify({ source: 'natalia_recuperacao', recup_key: taskKey, gesthub_client_id: c.id, msg_sugerida: msgSugerida, motivo: c.motivo_inativacao }),
          ]
        ).catch(e => console.error('[natalia_recuperacao] insert:', e.message))
        criadas++
      }

      const resumo = `Recuperacao: ${inativos.length} inativados ultimos 90d → ${criadas} task(s) novas`
      console.log(`[natalia_recuperacao] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[natalia_recuperacao]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Endpoint Growth: KPIs da carteira ===
  app.get('/api/growth/kpis', async (req, res) => {
    try {
      const FINANCE = process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000'

      const { rows: ativos } = await query(
        `SELECT COUNT(*)::int AS total, COALESCE(SUM(monthly_fee), 0)::numeric AS mrr_total
           FROM datalake_gesthub.clients WHERE status = 'ATIVO'`
      )
      const { rows: prospects } = await query(
        `SELECT COUNT(*)::int AS total
           FROM datalake_gesthub.clients WHERE client_type = 'PROSPECT' AND status = 'ATIVO'`
      )
      const { rows: novos30d } = await query(
        `SELECT COUNT(*)::int AS total
           FROM datalake_gesthub.clients
          WHERE status = 'ATIVO' AND start_date IS NOT NULL AND start_date <> ''
            AND start_date::date >= CURRENT_DATE - INTERVAL '30 days'`
      ).catch(() => ({ rows: [{ total: 0 }] }))
      const { rows: inativos90d } = await query(
        `SELECT COUNT(*)::int AS total
           FROM datalake_gesthub.clients
          WHERE status IN ('INATIVO', 'BAIXADA')
            AND data_inativacao IS NOT NULL AND data_inativacao <> ''
            AND data_inativacao::date >= CURRENT_DATE - INTERVAL '90 days'`
      ).catch(() => ({ rows: [{ total: 0 }] }))

      // Tasks da Natalia abertas
      const { rows: pipelineTasks } = await query(
        `SELECT COUNT(*)::int AS total
           FROM tasks
          WHERE assigned_to = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab'
            AND status IN ('pending','in_progress')`
      )

      // Conversao 30d
      const { rows: convTotals } = await query(
        `SELECT
            COUNT(*) FILTER (WHERE result->>'sent_to' IS NOT NULL)::int AS enviadas,
            COUNT(*) FILTER (WHERE result->>'response_status' = 'responded')::int AS respondidas,
            COUNT(*) FILTER (WHERE result->>'response_status' = 'silent')::int AS silent,
            COUNT(*) FILTER (WHERE result->>'response_status' = 'pending')::int AS aguardando
           FROM tasks
          WHERE assigned_to = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab'
            AND (result->>'approved_at')::timestamptz > NOW() - INTERVAL '30 days'`
      ).catch(() => ({ rows: [{ enviadas: 0, respondidas: 0, silent: 0, aguardando: 0 }] }))

      // Clientes frios (sem upload 60d) — usa Finance
      let frios = null
      try {
        const r = await fetch(`${FINANCE}/api/uploads?dias=60`)
        const j = await r.json()
        const ups = j?.data || j || []
        const comUpload = new Set(ups.map(u => u.clienteGesthubId || u.cliente_gesthub_id))
        const { rows: at } = await query(
          `SELECT id FROM datalake_gesthub.clients
            WHERE status='ATIVO'
              AND (
                start_date IS NULL OR start_date = ''
                OR (start_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND start_date::date < CURRENT_DATE - INTERVAL '60 days')
              )`
        )
        frios = at.filter(c => !comUpload.has(c.id)).length
      } catch { /* finance off */ }

      const conv = convTotals[0]
      const taxaResposta = conv.enviadas > 0
        ? Math.round((conv.respondidas / conv.enviadas) * 100)
        : null

      res.json({
        ok: true,
        clientes_ativos: ativos[0].total,
        mrr_brl: parseFloat(ativos[0].mrr_total),
        prospects: prospects[0].total,
        novos_30d: novos30d[0].total,
        inativos_90d: inativos90d[0].total,
        frios_60d: frios,
        natalia_pipeline: pipelineTasks[0].total,
        natalia_30d: {
          enviadas: conv.enviadas,
          respondidas: conv.respondidas,
          silent: conv.silent,
          aguardando: conv.aguardando,
          taxa_resposta_pct: taxaResposta,
        },
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // === Follow-up Saldanha — varre legalizacoes ativas e cria tasks pra acoes pendentes ===
  // Roda 2x/semana (segunda+quinta 09h). Casos surfacados:
  //   - EM EXIGENCIA: orgao pediu correcao — alta prioridade, notificar equipe
  //   - AGUARDANDO DOCUMENTOS: cliente precisa enviar — Saldanha cobra via WhatsApp
  //   - PARADO sem update >14d: investigar
  //   - AGUARDANDO ORGAO sem update >30d: cobrar status no orgao
  registerCronHandler('saldanha_followup', async () => {
    try {
      const SALDANHA_ID = '073072b0-547b-46f5-8e05-4290f9ec637d' // Sofia (team_members) = Saldanha (agents)
      const acoes = []
      let criadas = 0

      // 1) EM EXIGENCIA — todas, alta prioridade
      const exigencias = await query(
        `SELECT l.id, l.name, l.process_type, l.organ, l.pendencies, l.client_id, l.notes,
                c.legal_name, c.trade_name
           FROM datalake_gesthub.legalizations l
           LEFT JOIN datalake_gesthub.clients c ON c.id = l.client_id
          WHERE l.status = 'EM EXIGENCIA'`
      ).catch(() => ({ rows: [] }))
      for (const r of exigencias.rows) acoes.push({ ...r, motivo: 'em_exigencia', priority: 'urgent' })

      // 2) AGUARDANDO DOCUMENTOS
      const aguardDocs = await query(
        `SELECT l.id, l.name, l.process_type, l.organ, l.pendencies, l.client_id,
                c.legal_name, c.trade_name
           FROM datalake_gesthub.legalizations l
           LEFT JOIN datalake_gesthub.clients c ON c.id = l.client_id
          WHERE l.status = 'AGUARDANDO DOCUMENTOS'`
      ).catch(() => ({ rows: [] }))
      for (const r of aguardDocs.rows) acoes.push({ ...r, motivo: 'aguardando_documentos', priority: 'high' })

      // 3) PARADO ha >14 dias sem update
      const parados = await query(
        `SELECT l.id, l.name, l.process_type, l.organ, l.client_id, l.updated_at,
                c.legal_name, c.trade_name
           FROM datalake_gesthub.legalizations l
           LEFT JOIN datalake_gesthub.clients c ON c.id = l.client_id
          WHERE l.status = 'PARADO'
            AND l.updated_at < NOW() - INTERVAL '14 days'`
      ).catch(() => ({ rows: [] }))
      for (const r of parados.rows) acoes.push({ ...r, motivo: 'parado_14d', priority: 'medium' })

      // 4) AGUARDANDO ORGAO ha >30 dias
      const aguardOrgao = await query(
        `SELECT l.id, l.name, l.process_type, l.organ, l.protocol, l.client_id, l.updated_at,
                c.legal_name, c.trade_name
           FROM datalake_gesthub.legalizations l
           LEFT JOIN datalake_gesthub.clients c ON c.id = l.client_id
          WHERE l.status = 'AGUARDANDO ORGAO'
            AND l.updated_at < NOW() - INTERVAL '30 days'`
      ).catch(() => ({ rows: [] }))
      for (const r of aguardOrgao.rows) acoes.push({ ...r, motivo: 'aguardando_orgao_30d', priority: 'medium' })

      // Cria tasks (dedupe: nao cria se ja existe pendente pra mesma legalization_id+motivo)
      for (const a of acoes) {
        const taskKey = `legaliz-${a.id}-${a.motivo}`
        const dup = await query(
          `SELECT id FROM tasks
            WHERE status IN ('pending','in_progress')
              AND result->>'legaliz_key' = $1 LIMIT 1`,
          [taskKey]
        ).catch(() => ({ rows: [] }))
        if (dup.rows.length) continue

        const cliente = a.trade_name || a.legal_name || a.name || 'cliente'
        const titulos = {
          em_exigencia: `🚨 Exigencia ${a.organ}: ${cliente}`,
          aguardando_documentos: `Cobrar documentos: ${cliente} (${a.process_type})`,
          parado_14d: `Investigar processo PARADO: ${cliente} (${a.process_type})`,
          aguardando_orgao_30d: `Cobrar status no ${a.organ}: ${cliente}`,
        }
        const desc = [
          `Legalizacao #${a.id}: ${a.process_type}`,
          `Cliente: ${cliente}`,
          `Orgao: ${a.organ}`,
          a.protocol ? `Protocolo: ${a.protocol}` : null,
          a.pendencies ? `Pendencias: ${a.pendencies}` : null,
          `Motivo da task: ${a.motivo.replace(/_/g, ' ')}`,
          `Link: http://31.97.175.200/legalizations/${a.id}`,
        ].filter(Boolean).join('\n')

        await query(
          `INSERT INTO tasks (title, description, assigned_to, delegated_by, client_id, priority, status, result)
           VALUES ($1, $2, $3, NULL, $4, $5, 'pending', $6::jsonb)`,
          [
            titulos[a.motivo] || `Acao: ${cliente}`,
            desc,
            SALDANHA_ID,
            null, // client_id e UUID local (tasks.clients), Gesthub usa integer — guardamos no result.gesthub_client_id
            a.priority,
            JSON.stringify({ source: 'saldanha_followup', legaliz_key: taskKey, legalization_id: a.id, motivo: a.motivo, gesthub_client_id: a.client_id }),
          ]
        ).catch(e => console.error('[saldanha_followup] insert task:', e.message))
        criadas++
      }

      // Notifica equipe se ha urgentes
      if (exigencias.rows.length > 0) {
        try {
          await createNotification({
            type: 'legalizacao_exigencia',
            title: `${exigencias.rows.length} legalizacao(oes) EM EXIGENCIA — orgao pediu correcao`,
            message: exigencias.rows.slice(0, 5).map(r => `- ${r.trade_name || r.legal_name || r.name} (${r.organ}): ${r.pendencies || 'sem detalhes'}`).join('\n'),
            severity: 'warning',
            metadata: { handler: 'saldanha_followup', total: exigencias.rows.length },
            push: { tag: 'legalizacao-exigencia' },
          })
        } catch (e) { console.error('[saldanha_followup] notif:', e.message) }
      }

      const resumo = `Legalizacoes: ${exigencias.rows.length} em exigencia, ${aguardDocs.rows.length} aguardando docs, ${parados.rows.length} parado >14d, ${aguardOrgao.rows.length} aguardando orgao >30d → ${criadas} task(s) novas pra Saldanha`
      console.log(`[saldanha_followup] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[saldanha_followup]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Aviso proativo de vencimento — chama atencao com antecedencia (30/15/7/3/1d) ===
  // Roda diariamente 08h. Cruza com state de "aviso ja enviado" pra nao repetir.
  // Estado armazenado em handler_state via metadata da notification (key=cert_warning_<id>_<bucket>).
  registerCronHandler('vencimentos_proativo', async () => {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/expiring-data`)
      const data = await r.json()
      const items = data.items || []

      // Buckets de aviso: dispara quando daysUntil cruza um threshold pela primeira vez.
      // Usamos jsonb de avisos enviados por item_id pra deduplicar.
      const buckets = [30, 15, 7, 3, 1, 0, -1] // 0=hoje, -1=ja venceu (re-aviso diario)

      // Carrega historico de avisos
      const { rows: hist } = await query(
        `SELECT metadata->>'item_id' AS item_id, metadata->>'bucket' AS bucket
           FROM notifications
          WHERE type = 'vencimento_aviso'
            AND created_at > NOW() - INTERVAL '60 days'`
      ).catch(() => ({ rows: [] }))
      const sent = new Set(hist.map(r => `${r.item_id}:${r.bucket}`))

      let novos = 0
      for (const it of items) {
        // Pega o menor bucket cuja condicao casa
        const days = it.daysUntil
        let bucket = null
        if (days < 0) bucket = -1
        else if (days === 0) bucket = 0
        else {
          for (const b of buckets.filter(x => x > 0)) {
            if (days <= b) { bucket = b; break }
          }
        }
        if (bucket === null) continue

        const key = `${it.id}:${bucket}`
        if (sent.has(key)) continue

        const titulo = bucket < 0
          ? `🚨 VENCIDO ha ${Math.abs(days)}d: ${it.title}`
          : bucket === 0
            ? `🚨 VENCE HOJE: ${it.title}`
            : `⚠️ Vence em ${days}d: ${it.title}`

        const severity = bucket <= 0 ? 'error' : bucket <= 7 ? 'warning' : 'info'

        await createNotification({
          type: 'vencimento_aviso',
          title: titulo,
          message: `${it.subtitle}. Categoria: ${it.category}. Sistema: ${it.system}.`,
          severity,
          metadata: { item_id: it.id, bucket, daysUntil: days, system: it.system, url: it.url, category: it.category },
          push: bucket <= 7 ? { tag: `venc-${it.id}`, url: it.url } : false,
        })
        novos++

        // Auto-task quando bucket <= 7 (critico ou pior). Nao duplica: dedupe por result.metadata->>'item_id'
        if (bucket <= 7) {
          const dup = await query(
            `SELECT id FROM tasks
              WHERE status IN ('pending','in_progress')
                AND result->>'venc_item_id' = $1
              LIMIT 1`,
            [it.id]
          ).catch(() => ({ rows: [] }))

          if (!dup.rows.length) {
            // Mapeia categoria → team_member
            const assignMap = {
              certificado: '3c98e80e-7245-4819-aa78-24b7249a628a',          // André - TI
              documento_cliente: '073072b0-547b-46f5-8e05-4290f9ec637d',    // Sofia (= Saldanha) - societario
              contrato_honorarios: '9945b340-75f6-4c0d-a6f3-bcbfc7efce3b',  // Rodrigo - operacoes
            }
            const assignedTo = assignMap[it.category] || '9945b340-75f6-4c0d-a6f3-bcbfc7efce3b'
            const taskTitle = bucket <= 0
              ? `🚨 RENOVAR JA: ${it.title}`
              : `Renovar em ${days}d: ${it.title}`
            const taskDesc = `Item: ${it.title}\nVencimento: ${new Date(it.dueDate).toLocaleDateString('pt-BR')}\nStatus: ${it.subtitle}\nSistema: ${it.system}\nLink: ${it.url}\n\nAcao necessaria: providenciar renovacao antes do vencimento. Avisos automaticos serao enviados ate item ser resolvido.`

            await query(
              `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result, created_at)
               VALUES ($1, $2, $3, NULL, $4, 'pending', $5::jsonb, NOW())`,
              [
                taskTitle,
                taskDesc,
                assignedTo,
                bucket <= 0 ? 'urgent' : 'high',
                JSON.stringify({ source: 'vencimentos_proativo', venc_item_id: it.id, category: it.category, daysUntil: days, url: it.url }),
              ]
            ).catch(e => console.error('[vencimentos_proativo] task create:', e.message))
          }
        }
      }

      const resumo = `Vencimentos: ${items.length} itens monitorados, ${novos} avisos novos disparados`
      console.log(`[vencimentos_proativo] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[vencimentos_proativo]', e)
      return `Erro: ${e.message}`
    }
  })

  // === Cobrança mensal de extratos — Sneijder manda WhatsApp cobrando clientes pendentes ===
  // Roda dia 5 de cada mes. Alvo = mes anterior. Status PENDENTE/PARCIAL → envia msg + marca COBRADO.
  registerCronHandler('cobrar_extratos_mes', async () => {
    const FINANCE = process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000'
    const GESTHUB = process.env.GESTHUB_API_URL || 'http://31.97.175.200'
    const now = new Date()
    // Target = previous month
    const tgt = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const targetYear = tgt.getFullYear()
    const targetMonth = tgt.getMonth() + 1
    const monthName = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'][targetMonth - 1]

    try {
      const r = await fetch(`${FINANCE}/api/controle?ano=${targetYear}`)
      const controle = await r.json()
      const rows = Array.isArray(controle) ? controle : (controle?.data || [])

      const pendentes = rows.filter(c => {
        const m = c.meses?.[String(targetMonth)]
        return m && (m.status === 'PENDENTE' || m.status === 'PARCIAL')
      })

      if (pendentes.length === 0) {
        return `${monthName}/${targetYear}: nenhum cliente pendente — todos entregaram.`
      }

      // Template
      const { rows: tplRows } = await query(
        "SELECT body FROM message_templates WHERE name ILIKE 'Solicitacao de extrato%' AND is_active = TRUE LIMIT 1"
      )
      const template = tplRows[0]?.body
        || 'Oi {nome}! Estamos fechando a contabilidade de {mes} e precisamos do extrato bancario. Pode enviar aqui no WhatsApp? Obrigado!'

      let cobrados = 0, semContato = 0, erros = []

      for (const c of pendentes) {
        const cid = c.clienteGesthubId
        try {
          // Client info
          const cr = await fetch(`${GESTHUB}/api/clients/${cid}`)
          const cj = await cr.json().catch(() => ({}))
          const client = cj?.data || cj || {}
          if (client.status && client.status !== 'ATIVO') continue // skip inativos
          const cname = client.tradeName || client.legalName || `cliente ${cid}`

          // Contatos
          const ctr = await fetch(`${GESTHUB}/api/clients/${cid}/contatos`)
          const cjt = await ctr.json().catch(() => ({}))
          const contatos = (cjt?.data || []).filter(ct => ct.telefone && ct.telefone.replace(/\D/g, '').length >= 10)

          if (contatos.length === 0) {
            semContato++
            continue
          }

          // Prefer SOCIO/DIRETOR, senao primeiro
          const primary = contatos.find(ct => /socio|diretor/i.test(ct.funcao || '')) || contatos[0]
          const primeiroNome = (primary.nome || 'cliente').split(/\s+/)[0]
          const msg = template
            .replace(/\{nome\}/g, primeiroNome)
            .replace(/\{mes\}/g, monthName)
            .replace(/\{empresa\}/g, cname)

          await whatsapp.sendMessage(primary.telefone, msg)

          // Marca COBRADO no Finance
          await fetch(`${FINANCE}/api/controle`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              clienteGesthubId: cid,
              ano: targetYear,
              mes: targetMonth,
              status: 'COBRADO',
              observacoes: `Cobrado via WhatsApp (Sneijder) em ${new Date().toLocaleDateString('pt-BR')} — contato: ${primary.nome}`,
            }),
          }).catch(() => {})

          cobrados++
          // Delay pequeno pra nao estourar WA
          await new Promise(r => setTimeout(r, 1500))
        } catch (e) {
          erros.push({ cliente: cid, err: e.message })
        }
      }

      const resumo = `${monthName}/${targetYear}: ${cobrados} cobrados via WhatsApp, ${semContato} sem telefone, ${erros.length} erros, ${pendentes.length - cobrados - semContato - erros.length} skippados (inativos)`

      // Task para Sneijder acompanhar
      if (cobrados > 0 || semContato > 0) {
        try {
          await query(
            `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [
              `Cobrança de extratos ${monthName}/${targetYear}`,
              `${resumo}\n\nClientes sem telefone cadastrado: ${semContato}.\nAcompanhar retornos no WhatsApp e fazer upload dos extratos que chegarem.`,
              'sneijder',
              'sistema',
              'medium',
            ]
          )
        } catch (e) { console.error('[cobrar_extratos] task create failed:', e.message) }
      }

      // Notificacao + push
      try {
        await createNotification({
          type: 'cobranca_extratos',
          title: `Cobrança de extratos ${monthName}`,
          message: resumo,
          severity: semContato > 0 ? 'warning' : 'info',
          metadata: { handler: 'cobrar_extratos_mes', targetYear, targetMonth, cobrados, semContato, erros: erros.length },
          push: cobrados > 0 ? { tag: 'cobranca-extratos' } : false,
        })
      } catch (e) { console.error('[cobrar_extratos] notif failed:', e.message) }

      console.log(`[cobrar_extratos] ${resumo}`)
      return resumo
    } catch (e) {
      console.error('[cobrar_extratos] erro:', e)
      return `Erro: ${e.message}`
    }
  })

  // === Retenção anexos WhatsApp — apaga arquivos > 30d, marca metadata.expired ===
  // Roda diariamente 03h. Mantém referência no DB pra UI mostrar "expirou".
  registerCronHandler('whatsapp_attach_retention', async () => {
    try {
      const r = await cleanupExpiredAttachments({ dryRun: false })
      const msg = `Varredura anexos WhatsApp: ${r.scanned} arquivos no disco, ${r.expired} expirados (>${r.retentionDays}d), ${r.deleted} deletados, ${fmtBytes(r.bytesLiberados)} liberados${r.erros.length ? `, ${r.erros.length} erros` : ''}`
      if (r.deleted > 0 || r.erros.length > 0) {
        try {
          await createNotification({
            type: 'whatsapp_attach_retention',
            title: `Anexos WhatsApp: ${r.deleted} expirado(s) removido(s)`,
            message: msg,
            severity: r.erros.length > 0 ? 'warning' : 'info',
            metadata: { handler: 'whatsapp_attach_retention', ...r },
          })
        } catch (e) { console.error('[attach_retention] notification failed:', e.message) }
      }
      console.log(`[attach_retention] ${msg}`)
      return msg
    } catch (e) {
      console.error('[attach_retention] erro:', e)
      return `Erro: ${e.message}`
    }
  })

  startCronScheduler().catch(err => console.error('[CRON] Failed to start:', err.message))

  console.log(`\n⬡ Átrio Office Server rodando na porta ${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`  WS:  ws://localhost:${PORT}/ws`);
  console.log(`  Orchestrator: ativo`);
  console.log(`  WhatsApp: inicializando...\n`);

  // Sincroniza agents/*/AGENTS.md com o DB (fonte-de-verdade = arquivo)
  try {
    const rep = await syncAgentsFromFiles();
    console.log('[Agents] sync: loaded=' + rep.loaded + ' created=' + rep.created + ' updated=' + rep.updated + ' errors=' + rep.errors.length);
    if (rep.errors.length) rep.errors.forEach(e => console.warn('[Agents] erro: ' + e));
  } catch (e) { console.error('[Agents] sync falhou: ' + e.message); }

  // Processa tasks pendentes ao iniciar
  processPendingTasks().then(count => {
    if (count > 0) console.log(`[Orchestrator] ${count} tasks pendentes processadas no startup`);
  }).catch(() => {});

  // Recovery de tasks orfas (stranded-work) — crashes anteriores
  recoverStrandedTasks().then(r => {
    if (r.retried || r.blocked) {
      console.log(`[Recovery] startup: ${r.retried} retomadas, ${r.blocked} bloqueadas (scan=${r.scanned})`);
    }
  }).catch(e => console.error('[Recovery] startup falhou:', e.message));

  // Recovery periodica a cada 10 min
  setInterval(() => {
    recoverStrandedTasks().then(r => {
      if (r.retried || r.blocked) {
        console.log(`[Recovery] periodica: ${r.retried} retomadas, ${r.blocked} bloqueadas (scan=${r.scanned})`);
      }
    }).catch(() => {});
  }, 10 * 60 * 1000);

  // Auto-unsnooze: conversas com snoozed_until <= NOW() voltam pra fila
  setInterval(async () => {
    try {
      const { rows } = await query(
        `UPDATE whatsapp_conversations
            SET snoozed_until = NULL
          WHERE snoozed_until IS NOT NULL AND snoozed_until <= NOW()
          RETURNING id, phone, client_name`
      );
      for (const r of rows) {
        broadcast({ type: 'conversation_unsnoozed', conversation_id: r.id });
        console.log(`[Snooze] desnooze automatico: ${r.client_name || r.phone}`);
      }
    } catch (e) { console.error('[Snooze] erro auto-unsnooze:', e.message); }
  }, 60 * 1000);

  // Auto-resolve de conversas WhatsApp silenciosas
  setInterval(async () => {
    try {
      const rows = await findConversationsToAutoResolve();
      for (const r of rows) {
        await markResolved(r.phone, 'auto_resolve_timeout');
        console.log(`[AutoResolve] ${r.phone} (${r.client_name}) marcada como resolvida (lvl ${r.escalation_level})`);
      }
      if (rows.length) console.log(`[AutoResolve] ${rows.length} conversa(s) auto-resolvidas`);
    } catch (e) { console.error('[AutoResolve] erro:', e.message); }
  }, 15 * 60 * 1000);
});

// Dara Orquestrador - Auto-correção
import('./services/dara-orquestrador.cjs').then(m => (m.default || m).iniciar()).catch(e => console.log('[Dara] optional:', e.message));

// Start task processor worker
import('./workers/task-processor.cjs').catch(e => console.log('[Worker] optional:', e.message));
