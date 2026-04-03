import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { query } from './db/pool.js';
import { chatWithAgent, extractText } from './services/claude.js';
import { executeToolCall, setOnTaskCreated } from './tools/registry.js';
import { processTask, processPendingTasks, setBroadcast } from './services/orchestrator.js';

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
app.use(express.static(clientDist));

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'atrio-office', timestamp: new Date() });
});

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
app.post('/api/chat/:agentId', async (req, res) => {
  const { agentId } = req.params;
  const { message, conversationId } = req.body;

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
    res.status(201).json(rows[0]);
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
    const [tasks, clients, conversations] = await Promise.all([
      query(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`),
      query(`SELECT status, COUNT(*) as count FROM clients GROUP BY status`),
      query(`SELECT status, COUNT(*) as count FROM conversations GROUP BY status`),
    ]);
    res.json({
      tasks: Object.fromEntries(tasks.rows.map(r => [r.status, parseInt(r.count)])),
      clients: Object.fromEntries(clients.rows.map(r => [r.status, parseInt(r.count)])),
      conversations: Object.fromEntries(conversations.rows.map(r => [r.status, parseInt(r.count)])),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
import { scheduleDailyReport, generateDailyReport } from './services/daily-report.js';

app.get('/api/whatsapp/status', (req, res) => {
  res.json(whatsapp.getStatus());
});

app.get('/api/whatsapp/qr', (req, res) => {
  const qr = whatsapp.getQRCode();
  if (!qr) return res.json({ hasQR: false, message: 'Nenhum QR disponível. WhatsApp pode já estar conectado.' });
  res.json({ hasQR: true, qr });
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

app.get('/api/whatsapp/conversations', (req, res) => {
  const list = [];
  const convs = whatsapp.getPendingMessages();
  res.json(convs);
});

app.post('/api/whatsapp/mark-replied/:phone', (req, res) => {
  const ok = whatsapp.markAsReplied(req.params.phone);
  res.json({ success: ok });
});

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
server.listen(PORT, () => {
  // Conecta orchestrator ao broadcast e ao registry
  setBroadcast(broadcast);
  setOnTaskCreated((taskId) => processTask(taskId));

  // Inicializa WhatsApp (Luna)
  whatsapp.setBroadcast(broadcast);
  whatsapp.initialize().catch(err => console.error('[WhatsApp] Falha:', err.message));

  // Telegram Bot — desativado por enquanto (ativar se necessário)
  // telegram.initialize(process.env.TELEGRAM_BOT_TOKEN).catch(err => console.error('[Telegram] Falha:', err.message));

  // Agenda relatório diário do Rodrigo (18h)
  scheduleDailyReport();

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
