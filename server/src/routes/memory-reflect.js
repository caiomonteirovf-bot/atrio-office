import { reflectConversation, runReflectionScan } from '../services/luna-reflector.js';

export function registerMemoryReflect(app) {
  // Dispara reflexao manual de 1 conversa
  app.post('/api/memory/reflect-conversation/:id', async (req, res) => {
    try {
      const r = await reflectConversation(req.params.id);
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Dispara scan manual (pra debug / botao admin)
  app.post('/api/memory/reflect-scan', async (req, res) => {
    try {
      const r = await runReflectionScan({ maxBatch: Number(req.body?.max || 5) });
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Cron interno: a cada 10min, escaneia conversas inativas
  const INTERVAL_MS = Number(process.env.LUNA_REFLECT_INTERVAL_MS || 10 * 60 * 1000);
  setInterval(() => {
    runReflectionScan({ maxBatch: 5 })
      .then(r => { if (r.scanned) console.log('[luna-reflector] scan:', r.scanned, 'conversa(s)'); })
      .catch(e => console.error('[luna-reflector] scan erro:', e.message));
  }, INTERVAL_MS);
  console.log('[luna-reflector] cron ativo a cada', INTERVAL_MS / 60000, 'min');
}
