// routes/activity.js
// Endpoints de consulta ao activity_log imutável.

import { listEvents, summary24h } from '../services/activity-log.js';
import { query } from '../db/pool.js';

export function registerActivityRoutes(app) {
  app.get('/api/activity', async (req, res) => {
    try {
      const rows = await listEvents(req.query);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/activity/summary', async (_req, res) => {
    try {
      const rows = await summary24h();
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/activity/event-types', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT event_type, COUNT(*) AS total
           FROM activity_log
          WHERE ts >= NOW() - INTERVAL '30 days'
       GROUP BY event_type
       ORDER BY total DESC`
      );
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/activity/:id', async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM activity_log WHERE id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'evento nao encontrado' });
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
