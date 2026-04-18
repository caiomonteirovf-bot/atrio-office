// Endpoints de limpeza de dados (hidden em Crons)
import { query } from '../db/pool.js';
import { logEvent } from '../services/activity-log.js';

// Para alvos que apagam a tabela inteira usamos TRUNCATE ... CASCADE
// (PG resolve a cadeia de FKs — notifications, calendar_events, etc.)
// Para alvos com WHERE, limpamos manualmente as tabelas dependentes antes.
const TARGETS = {
  tasks_pending: {
    count: "SELECT count(*) FROM public.tasks WHERE status='pending'",
    label: 'Tasks pendentes (public.tasks)',
    sqls: [
      "DELETE FROM public.notifications WHERE task_id IN (SELECT id FROM public.tasks WHERE status='pending')",
      "DELETE FROM public.calendar_events WHERE task_id IN (SELECT id FROM public.tasks WHERE status='pending')",
      "DELETE FROM public.tasks WHERE status='pending'",
    ],
    primary: 2, // índice do DELETE "principal" para reportar rowCount
  },
  tasks_all: {
    count: "SELECT count(*) FROM public.tasks",
    label: 'TODAS tasks',
    truncate: 'public.tasks',
  },
  wpp_messages: {
    count: "SELECT count(*) FROM public.whatsapp_messages",
    label: 'Mensagens WhatsApp (dashboard)',
    truncate: 'public.whatsapp_messages',
  },
  wpp_conversations: {
    count: "SELECT count(*) FROM public.whatsapp_conversations",
    label: 'Conversas WhatsApp (dashboard)',
    truncate: 'public.whatsapp_conversations',
  },
  luna_messages: {
    count: "SELECT count(*) FROM luna_v2.messages",
    label: 'Mensagens Luna v2',
    truncate: 'luna_v2.messages',
  },
  luna_conversations: {
    count: "SELECT count(*) FROM luna_v2.conversations",
    label: 'Conversas Luna v2',
    truncate: 'luna_v2.conversations',
  },
  luna_mem_pending: {
    count: "SELECT count(*) FROM luna_v2.memories WHERE status='pending'",
    label: 'Memorias pendentes',
    sqls: [
      "DELETE FROM luna_v2.memory_usage_log WHERE memory_id IN (SELECT id FROM luna_v2.memories WHERE status='pending')",
      "DELETE FROM luna_v2.memories WHERE status='pending'",
    ],
    primary: 1,
  },
  luna_mem_orphan: {
    count: "SELECT count(*) FROM luna_v2.memories WHERE client_id IS NULL",
    label: 'Memorias orfas (sem cliente)',
    sqls: [
      "DELETE FROM luna_v2.memory_usage_log WHERE memory_id IN (SELECT id FROM luna_v2.memories WHERE client_id IS NULL)",
      "DELETE FROM luna_v2.memories WHERE client_id IS NULL",
    ],
    primary: 1,
  },
  alerts_all: {
    count: "SELECT count(*) FROM public.alerts",
    label: 'Alertas',
    truncate: 'public.alerts',
  },
  agent_chat: {
    count: "SELECT count(*) FROM public.agent_chat_messages",
    label: 'Chat entre agentes',
    truncate: 'public.agent_chat_messages',
  },
};

async function runTarget(t) {
  // TRUNCATE ... RESTART IDENTITY CASCADE cobre toda a cadeia de FKs
  if (t.truncate) {
    const pre = await query(t.count);
    const preCount = parseInt(pre.rows[0].count) || 0;
    await query(`TRUNCATE TABLE ${t.truncate} RESTART IDENTITY CASCADE`);
    return preCount;
  }
  // Lista de DELETEs em ordem (dependentes primeiro, alvo por último)
  let primaryDeleted = 0;
  for (let i = 0; i < t.sqls.length; i++) {
    const r = await query(t.sqls[i]);
    if (i === (t.primary ?? t.sqls.length - 1)) primaryDeleted = r.rowCount || 0;
  }
  return primaryDeleted;
}

export function registerAdminCleanup(app) {
  app.get('/api/admin/data-audit', async (req, res) => {
    try {
      const out = {};
      for (const [k, v] of Object.entries(TARGETS)) {
        try { const r = await query(v.count); out[k] = { label: v.label, count: parseInt(r.rows[0].count) }; }
        catch { out[k] = { label: v.label, count: null }; }
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/cleanup', async (req, res) => {
    try {
      const { targets = [], confirm } = req.body || {};
      if (confirm !== 'LIMPAR') return res.status(400).json({ error: 'confirm deve ser "LIMPAR"' });
      const results = {};
      for (const t of targets) {
        if (!TARGETS[t]) { results[t] = { error: 'alvo desconhecido' }; continue; }
        try {
          const deleted = await runTarget(TARGETS[t]);
          results[t] = { deleted, label: TARGETS[t].label };
        } catch (e) { results[t] = { error: e.message }; }
      }
      logEvent({
        actor_type: 'user', actor_id: req.ip || 'anon',
        event_type: 'data.cleanup', action: 'truncate',
        entity_type: 'cleanup', entity_id: targets.join(','),
        payload: { targets, results },
        severity: 'critical',
      });
      res.json({ ok: true, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
