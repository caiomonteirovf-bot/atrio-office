// server/src/routes/rag.js — endpoints de busca semantica e backfill
import { searchMemories, embedMemory, backfillEmbeddings } from '../services/embeddings.js';
import { query } from '../db/pool.js';

export function registerRagRoutes(app) {
  // POST /api/memory/search — busca por similaridade semantica
  app.post('/api/memory/search', async (req, res) => {
    try {
      const { q, agent_id, scope_type, scope_id, category, limit } = req.body || {};
      if (!q) return res.status(400).json({ error: 'q obrigatorio' });
      const results = await searchMemories(q, { agent_id, scope_type, scope_id, category, limit });
      res.json({ ok: true, count: results.length, results });
    } catch (err) {
      console.error('[rag/search]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/memory/:id/embed — (re)gera embedding de uma memoria
  app.post('/api/memory/:id/embed', async (req, res) => {
    try {
      const r = await embedMemory(req.params.id);
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/memory/embeddings/backfill — processa em lote (limit default 50)
  app.post('/api/memory/embeddings/backfill', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.body?.limit) || 50, 500);
      const result = await backfillEmbeddings({ limit });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/memory/embeddings/status — dashboard
  app.get('/api/memory/embeddings/status', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM memories_rag_status');
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
