// CRUD completo para luna_v2.memories + listas auxiliares
import { query } from '../db/pool.js';

export function registerMemoryCrud(app) {
  // Lista de clientes pra dropdown
  app.get('/api/memory/clients', async (req, res) => {
    try {
      const r = await query(
        `SELECT id, COALESCE(nome_fantasia, nome_legal) AS nome, cnpj
         FROM luna_v2.clients
         ORDER BY nome LIMIT 500`
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Lista de agentes pra dropdown
  app.get('/api/memory/agents-list', async (req, res) => {
    try {
      const r = await query(`SELECT id, name, role FROM public.agents ORDER BY name`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Criar fato/regra/erro/preferência (luna_v2.memories)
  app.post('/api/memory/luna-facts', async (req, res) => {
    try {
      const { tipo = 'preferencia', titulo, conteudo, agent_id = 'luna', client_id,
              tags, area = 'geral', prioridade = 5, confianca = 1.0, status = 'ativa',
              is_rag_enabled = true } = req.body || {};
      if (!titulo || !conteudo) return res.status(400).json({ error: 'titulo e conteudo obrigatorios' });
      const r = await query(
        `INSERT INTO luna_v2.memories
           (tipo, titulo, conteudo, agent_id, client_id, tags, area, prioridade, confianca,
            status, is_rag_enabled, trigger_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual')
         RETURNING *`,
        [tipo, titulo, conteudo, agent_id, client_id || null,
         Array.isArray(tags) ? tags : null, area, prioridade, confianca, status, is_rag_enabled]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Editar
  app.put('/api/memory/luna-facts/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const allowed = ['tipo','titulo','conteudo','agent_id','client_id','tags','area',
                       'prioridade','confianca','status','is_rag_enabled'];
      const sets = []; const params = [];
      for (const k of allowed) {
        if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k} = $${params.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
      params.push(id);
      const r = await query(
        `UPDATE luna_v2.memories SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${params.length} RETURNING *`, params
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'nao encontrado' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Excluir
  app.delete('/api/memory/luna-facts/:id', async (req, res) => {
    try {
      await query('DELETE FROM luna_v2.memories WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Criar memória em public.memories (conhecimento curado)
  app.post('/api/memory/knowledge', async (req, res) => {
    try {
      const { title, content, summary, category = 'general', agent_id,
              tags = [], priority = 5, is_rag_enabled = true, status = 'approved',
              scope_type = 'agent' } = req.body || {};
      if (!title || !content) return res.status(400).json({ error: 'title e content obrigatorios' });
      const r = await query(
        `INSERT INTO public.memories
           (scope_type, agent_id, category, title, content, summary, source_type,
            tags, priority, is_rag_enabled, status)
         VALUES ($1::memory_scope, $2, $3::memory_category, $4, $5, $6, 'manual',
                 $7, $8, $9, $10::memory_status)
         RETURNING *`,
        [scope_type, agent_id || null, category, title, content, summary || null,
         tags, priority, is_rag_enabled, status]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
