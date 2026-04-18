// routes/ingest.js v2
// Adiciona:
//   - POST   /api/ingest/reject          — muda status para rejected e zera embedding
//   - GET    /api/ingest/file/:id        — serve o arquivo original (se file_path ainda existe)
//   - GET    /api/ingest/pending         — filtros: client_id, q, doc_type
//   - GET    /api/memory/usage-stats     — auditoria RAG (top hits, por agente, por cliente)

import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { ingestFile } from '../services/ingest.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { logEvent, ctxFromRequest } from '../services/activity-log.js';
import { query } from '../db/pool.js';

const STORAGE_DIR = process.env.INGEST_STORAGE_DIR || '/app/storage/ingest';
const MIME_BY_EXT = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export function registerIngestRoutes(app) {
  // ----- upload -----
  app.post('/api/ingest', rateLimit({ windowMs: 60_000, max: 20, bucket: 'ingest-upload' }), upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'campo "file" ausente' });
      const { client_id, agent_id, title } = req.body || {};
      const tags = (req.body?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      const result = await ingestFile(req.file.buffer, req.file.mimetype, {
        filename: req.file.originalname,
        client_id: client_id || null,
        agent_id: agent_id || null,
        title: title || null,
        tags,
      });
      logEvent({
        actor_type: 'user', actor_id: req.ip || 'anon',
        event_type: 'memory.ingest', action: 'create',
        entity_type: 'memory',
        entity_id: result.memory_id || (result.memory_ids && result.memory_ids[0]) || null,
        payload: { filename: req.file.originalname, mime: req.file.mimetype, size: req.file.size, client_id, result_type: result.type, ok: result.ok, chunks: result.chunks, doc_type: result.doc_type },
        severity: result.ok ? 'info' : 'warn',
        ...ctxFromRequest(req),
      });
      res.json(result);
    } catch (e) {
      console.error('[ingest]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ----- aprovar em lote -----
  app.post('/api/ingest/approve', rateLimit({ windowMs: 60_000, max: 60, bucket: 'ingest-approve' }), async (req, res) => {
    try {
      const { memory_ids = [] } = req.body || {};
      if (!Array.isArray(memory_ids) || !memory_ids.length) {
        return res.status(400).json({ error: 'memory_ids deve ser array nao vazio' });
      }
      const { rowCount } = await query(
        `UPDATE memories
            SET status = 'approved'::memory_status,
                approved_at = NOW(),
                is_rag_enabled = true
          WHERE id = ANY($1::uuid[])`,
        [memory_ids]
      );
      logEvent({
        actor_type: 'user', actor_id: req.ip || 'anon',
        event_type: 'memory.approve', action: 'approve',
        entity_type: 'memory', entity_id: memory_ids.join(','),
        payload: { approved: rowCount, ids: memory_ids.slice(0, 20) },
        ...ctxFromRequest(req),
      });
      res.json({ ok: true, approved: rowCount });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- rejeitar em lote (marca + zera embedding + apaga arquivo do disco) -----
  app.post('/api/ingest/reject', rateLimit({ windowMs: 60_000, max: 60, bucket: 'ingest-reject' }), async (req, res) => {
    try {
      const { memory_ids = [] } = req.body || {};
      if (!Array.isArray(memory_ids) || !memory_ids.length) {
        return res.status(400).json({ error: 'memory_ids deve ser array nao vazio' });
      }
      // Busca file_paths antes de atualizar
      const { rows: paths } = await query(
        `SELECT DISTINCT metadata->>'file_path' AS fp
           FROM memories WHERE id = ANY($1::uuid[]) AND metadata->>'file_path' IS NOT NULL`,
        [memory_ids]
      );
      // Apaga arquivos (best-effort; um arquivo pode servir multiplos chunks — so apagamos quando nenhum outro chunk usa)
      for (const r of paths) {
        if (!r.fp) continue;
        const { rows: others } = await query(
          `SELECT 1 FROM memories
            WHERE metadata->>'file_path' = $1
              AND id <> ALL($2::uuid[])
            LIMIT 1`,
          [r.fp, memory_ids]
        );
        if (!others.length) {
          try { await fs.promises.unlink(path.join(STORAGE_DIR, r.fp)); }
          catch (e) { /* ja apagado ou inexistente */ }
        }
      }
      const { rowCount } = await query(
        `UPDATE memories
            SET status = 'rejected'::memory_status,
                is_rag_enabled = false,
                embedding = NULL
          WHERE id = ANY($1::uuid[])`,
        [memory_ids]
      );
      logEvent({
        actor_type: 'user', actor_id: req.ip || 'anon',
        event_type: 'memory.reject', action: 'reject',
        entity_type: 'memory', entity_id: memory_ids.join(','),
        payload: { rejected: rowCount, files_removed: paths.length, ids: memory_ids.slice(0, 20) },
        severity: 'warn',
        ...ctxFromRequest(req),
      });
      res.json({ ok: true, rejected: rowCount, files_removed: paths.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- listar pendentes com filtros -----
  app.get('/api/ingest/pending', async (req, res) => {
    try {
      const { client_id, q, doc_type, status = 'draft' } = req.query;
      const where = [`source_type = 'document'::memory_source`];
      const params = [];
      let i = 0;
      // status pode ser 'draft,rejected' (lista)
      const statuses = String(status).split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        where.push(`status = $${++i}::memory_status`); params.push(statuses[0]);
      } else if (statuses.length > 1) {
        const placeholders = statuses.map(() => `$${++i}::memory_status`).join(',');
        where.push(`status IN (${placeholders})`);
        statuses.forEach(s => params.push(s));
      }
      if (client_id) {
        where.push(`metadata->>'gesthub_client_id' = $${++i}`);
        params.push(String(client_id));
      }
      if (doc_type) {
        where.push(`metadata->>'document_type' = $${++i}`);
        params.push(doc_type);
      }
      if (q) {
        where.push(`(title ILIKE '%'||$${++i}||'%' OR summary ILIKE '%'||$${i}||'%' OR metadata->>'filename' ILIKE '%'||$${i}||'%')`);
        params.push(q);
      }
      const sql = `SELECT id, title, summary, scope_type, scope_id, status,
                          metadata->>'document_type'         AS document_type,
                          metadata->>'filename'              AS filename,
                          metadata->>'pages'                 AS pages,
                          metadata->>'file_path'             AS file_path,
                          metadata->>'gesthub_client_id'     AS gesthub_client_id,
                          confidence_score, created_at
                     FROM memories
                    WHERE ${where.join(' AND ')}
                    ORDER BY created_at DESC
                    LIMIT 300`;
      const { rows } = await query(sql, params);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- servir arquivo original -----
  app.get('/api/ingest/file/:id', async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT metadata->>'file_path' AS fp,
                metadata->>'filename'  AS filename,
                metadata->>'mime_type' AS mime
           FROM memories WHERE id = $1`,
        [req.params.id]
      );
      const r = rows[0];
      if (!r || !r.fp) return res.status(404).json({ error: 'arquivo original nao encontrado' });
      const abs = path.join(STORAGE_DIR, r.fp);
      if (!fs.existsSync(abs)) return res.status(410).json({ error: 'arquivo original ja foi removido do disco' });
      const ext = path.extname(abs).toLowerCase();
      const mime = r.mime || MIME_BY_EXT[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      // inline para PDF/imagem (previewvel no browser), attachment para docx/xlsx
      const dispose = (mime === 'application/pdf' || mime.startsWith('image/')) ? 'inline' : 'attachment';
      res.setHeader('Content-Disposition', `${dispose}; filename="${r.filename || 'documento' + ext}"`);
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- stats gerais de uso do RAG -----
  app.get('/api/memory/usage-stats', async (_req, res) => {
    try {
      const [top, byAgent, byClient, approvedByType] = await Promise.all([
        query(`SELECT id, title, semantic_hits, last_semantic_hit, confidence_score,
                      metadata->>'document_type' AS doc_type,
                      metadata->>'gesthub_client_id' AS client_id,
                      status
                 FROM memories
                WHERE semantic_hits > 0
             ORDER BY semantic_hits DESC, last_semantic_hit DESC
                LIMIT 20`),
        query(`SELECT a.name AS agent, COUNT(*) FILTER (WHERE m.status='approved'::memory_status) AS approved,
                      COUNT(*) FILTER (WHERE m.status='draft'::memory_status) AS draft,
                      COALESCE(SUM(m.semantic_hits),0) AS total_hits
                 FROM agents a
            LEFT JOIN memories m ON m.agent_id = a.id
             GROUP BY a.name
             ORDER BY total_hits DESC`),
        query(`SELECT metadata->>'gesthub_client_id' AS client_id,
                      COUNT(*) AS total,
                      COALESCE(SUM(semantic_hits),0) AS hits
                 FROM memories
                WHERE metadata->>'gesthub_client_id' IS NOT NULL
             GROUP BY metadata->>'gesthub_client_id'
             ORDER BY hits DESC, total DESC
                LIMIT 30`),
        query(`SELECT COALESCE(metadata->>'document_type','text') AS doc_type,
                      status, COUNT(*) AS total
                 FROM memories
             GROUP BY doc_type, status
             ORDER BY doc_type, status`),
      ]);
      res.json({
        ok: true,
        top_hits: top.rows,
        by_agent: byAgent.rows,
        by_client: byClient.rows,
        by_type: approvedByType.rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
