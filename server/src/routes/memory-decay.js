import { decayScan, startDecayCron } from '../services/memory-decay.js';

export function registerMemoryDecay(app) {
  // GET dry-run: lista candidatas sem arquivar
  app.get('/api/memory/decay/preview', async (req, res) => {
    try {
      const r = await decayScan({ dryRun: true, limit: Number(req.query.limit) || 200 });
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // POST executa de fato
  app.post('/api/memory/decay/run', async (req, res) => {
    try {
      const r = await decayScan({ dryRun: false, limit: Number(req.body?.limit) || 500 });
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Cron interno
  startDecayCron();
}
