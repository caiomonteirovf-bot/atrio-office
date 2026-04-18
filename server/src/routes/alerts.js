// routes/alerts.js
// Config + monitoramento do sistema de alertas Luna.

import { getAlertConfig, updateLevels, updateMeta, findConversationsToAutoResolve, markResolved } from '../services/alert-config.js';
import { logEvent } from '../services/activity-log.js';

export function registerAlertsRoutes(app) {
  // GET: lista atual
  app.get('/api/alerts/config', async (_req, res) => {
    try {
      const cfg = await getAlertConfig();
      res.json({ ok: true, ...cfg });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT: salva niveis em lote
  app.put('/api/alerts/config/levels', async (req, res) => {
    try {
      const { levels = [] } = req.body || {};
      if (!Array.isArray(levels) || !levels.length) return res.status(400).json({ error: 'levels obrigatorio' });
      await updateLevels(levels);
      logEvent({
        actor_type: 'user', actor_id: req.ip || 'anon',
        event_type: 'alert_config.update', action: 'update',
        entity_type: 'alert_levels', entity_id: levels.map(l => l.level).join(','),
        payload: { count: levels.length, levels: levels.map(l => ({ level: l.level, minutes: l.minutes, active: l.active })) },
      });
      res.json({ ok: true, updated: levels.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT: salva metadados (auto_resolve_hours, horarios, etc)
  app.put('/api/alerts/config/meta', async (req, res) => {
    try {
      const meta = req.body?.meta || {};
      if (!Object.keys(meta).length) return res.status(400).json({ error: 'meta obrigatorio' });
      await updateMeta(meta);
      logEvent({
        actor_type: 'user', actor_id: req.ip || 'anon',
        event_type: 'alert_config.update', action: 'update',
        entity_type: 'alert_meta', entity_id: Object.keys(meta).join(','),
        payload: { meta },
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET: conversas candidatas a auto-resolver (preview)
  app.get('/api/alerts/auto-resolve/candidates', async (_req, res) => {
    try {
      const rows = await findConversationsToAutoResolve();
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST: disparar auto-resolve manualmente (util para debug)
  app.post('/api/alerts/auto-resolve/run', async (_req, res) => {
    try {
      const rows = await findConversationsToAutoResolve();
      for (const r of rows) {
        await markResolved(r.phone, 'auto_resolve_timeout');
        logEvent({
          actor_type: 'system', actor_id: 'auto-resolve',
          event_type: 'whatsapp.conversation.auto_resolved', action: 'resolve',
          entity_type: 'whatsapp_conversation', entity_id: r.phone,
          payload: { client_name: r.client_name, escalation_level: r.escalation_level, last_message_at: r.last_message_at },
          severity: 'warn',
        });
      }
      res.json({ ok: true, resolved: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
