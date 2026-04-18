// routes/errors.js
// Endpoints de consulta ao error_log.

import { listErrorGroups, listErrorsByFingerprint, markResolved } from '../services/error-collector.js';

export function registerErrorsRoutes(app) {
  app.get('/api/errors/groups', async (req, res) => {
    try {
      const resolved = req.query.resolved === 'true' ? true : req.query.resolved === 'false' ? false : false;
      res.json({ ok: true, data: await listErrorGroups({ resolved, limit: req.query.limit }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/errors/group/:fp', async (req, res) => {
    try {
      res.json({ ok: true, data: await listErrorsByFingerprint(req.params.fp, req.query.limit || 50) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/errors/group/:fp/resolve', async (req, res) => {
    try {
      const n = await markResolved(req.params.fp, req.body?.note || null);
      res.json({ ok: true, resolved_rows: n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
