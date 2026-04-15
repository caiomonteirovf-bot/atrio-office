// Endpoints de limpeza de dados (hidden em Crons)
import { query } from '../db/pool.js';

const TARGETS = {
  tasks_pending:      { sql: "DELETE FROM public.tasks WHERE status='pending'", count: "SELECT count(*) FROM public.tasks WHERE status='pending'", label: 'Tasks pendentes (public.tasks)' },
  tasks_all:          { sql: "DELETE FROM public.tasks", count: "SELECT count(*) FROM public.tasks", label: 'TODAS tasks' },
  wpp_messages:       { sql: "DELETE FROM public.whatsapp_messages", count: "SELECT count(*) FROM public.whatsapp_messages", label: 'Mensagens WhatsApp (dashboard)' },
  wpp_conversations:  { sql: "DELETE FROM public.whatsapp_conversations", count: "SELECT count(*) FROM public.whatsapp_conversations", label: 'Conversas WhatsApp (dashboard)' },
  luna_messages:      { sql: "DELETE FROM luna_v2.messages", count: "SELECT count(*) FROM luna_v2.messages", label: 'Mensagens Luna v2' },
  luna_conversations: { sql: "DELETE FROM luna_v2.conversations", count: "SELECT count(*) FROM luna_v2.conversations", label: 'Conversas Luna v2' },
  luna_mem_pending:   { sql: "DELETE FROM luna_v2.memories WHERE status='pending'", count: "SELECT count(*) FROM luna_v2.memories WHERE status='pending'", label: 'Memorias pendentes' },
  luna_mem_orphan:    { sql: "DELETE FROM luna_v2.memories WHERE client_id IS NULL", count: "SELECT count(*) FROM luna_v2.memories WHERE client_id IS NULL", label: 'Memorias orfas (sem cliente)' },
  alerts_all:         { sql: "DELETE FROM public.alerts", count: "SELECT count(*) FROM public.alerts", label: 'Alertas' },
  agent_chat:         { sql: "DELETE FROM public.agent_chat_messages", count: "SELECT count(*) FROM public.agent_chat_messages", label: 'Chat entre agentes' },
};

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
          const r = await query(TARGETS[t].sql);
          results[t] = { deleted: r.rowCount, label: TARGETS[t].label };
        } catch (e) { results[t] = { error: e.message }; }
      }
      res.json({ ok: true, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
