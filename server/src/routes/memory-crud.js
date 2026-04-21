// CRUD completo para luna_v2.memories + listas auxiliares
import { query } from '../db/pool.js';

export function registerMemoryCrud(app) {
  // Lista de clientes pra dropdown — UNION Gesthub (master) + luna_v2.clients (cached)
  // Retorna TODOS os clientes do Gesthub; o scope_id no POST aceita tanto uuid
  // (luna_v2) quanto gesthub_id (int). O endpoint /contacts sabe resolver ambos.
  app.get('/api/memory/clients', async (req, res) => {
    try {
      const gh = await import('../services/gesthub.js');
      const clientes = await gh.getClients().catch(() => []);
      const out = clientes.map(c => {
        // Prioriza razao social; fallback pra nome_fantasia; por ultimo id
        const nome = c.legalName || c.tradeName || c.razaoSocial || c.nomeFantasia || c.name || (`Empresa #${c.id}`);
        return {
          id: String(c.id),           // id Gesthub (int) como string
          nome,
          cnpj: c.document || c.cnpj || null,
          source: 'gesthub',
        };
      }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      res.json(out);
    } catch (e) {
      console.error('[memory clients]', e.message);
      res.status(500).json({ error: e.message });
    }
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
      const { title, content, summary, category = 'general', agent_id, scope_id,
              tags = [], priority = 5, is_rag_enabled = true, status = 'approved',
              scope_type = 'agent' } = req.body || {};
      if (!title || !content) return res.status(400).json({ error: 'title e content obrigatorios' });

      // scope_id pode vir como:
      //   'client'  + "<gesthub_id>"            → upsert luna_v2.clients  → uuid
      //   'contact' + "<gh_client>:<gh_contato>" → upsert luna_v2.contacts → uuid
      //   qualquer  + <uuid>                       → usa direto
      let effScopeId = null;
      if ((scope_type === 'client' || scope_type === 'contact') && scope_id) {
        // Contato composite: "gesthub_client_id:gesthub_contact_id"
        if (scope_type === 'contact' && /^\d+:\d+$/.test(String(scope_id))) {
          try {
            const [ghClient, ghContact] = String(scope_id).split(':').map(Number);
            const gh = await import('../services/gesthub.js');
            const clientes = await gh.getClients().catch(() => []);
            const c = clientes.find(x => String(x.id) === String(ghClient));
            const contato = c && Array.isArray(c.contatos)
              ? c.contatos.find(t => Number(t.id) === ghContact) : null;
            if (contato) {
              const up = await query(
                `INSERT INTO luna_v2.contacts (gesthub_client_id, gesthub_contact_id, nome, funcao, telefone, email)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (gesthub_client_id, gesthub_contact_id) DO UPDATE
                   SET nome = EXCLUDED.nome, funcao = EXCLUDED.funcao,
                       telefone = EXCLUDED.telefone, email = EXCLUDED.email, updated_at = NOW()
                 RETURNING id`,
                [ghClient, ghContact, contato.nome || '(sem nome)', contato.funcao || null, contato.telefone || null, contato.email || null]
              );
              effScopeId = up.rows[0]?.id || null;
            }
          } catch (e) { console.error('[memory knowledge] resolve contact:', e.message); }
        } else if (/^\d+$/.test(String(scope_id))) {
          // int → gesthub_id. Upsert em luna_v2.clients pra obter uuid.
          try {
            const gh = await import('../services/gesthub.js');
            const clientes = await gh.getClients().catch(() => []);
            const c = clientes.find(x => String(x.id) === String(scope_id));
            if (c) {
              const cnpjDigits = String(c.document || c.cnpj || '').replace(/\D/g, '');
              const nomeLegal = c.legalName || c.razaoSocial || c.tradeName || `Empresa #${c.id}`;
              const nomeFantasia = c.tradeName || null;
              const regime = c.taxRegime || null;
              if (cnpjDigits.length === 14) {
                const formatted = `${cnpjDigits.slice(0,2)}.${cnpjDigits.slice(2,5)}.${cnpjDigits.slice(5,8)}/${cnpjDigits.slice(8,12)}-${cnpjDigits.slice(12,14)}`;
                const up = await query(
                  `INSERT INTO luna_v2.clients (cnpj, nome_legal, nome_fantasia, regime_tributario, gesthub_id, sync_gesthub_at)
                   VALUES ($1, $2, $3, $4, $5, NOW())
                   ON CONFLICT (cnpj) DO UPDATE SET nome_legal=EXCLUDED.nome_legal,
                     nome_fantasia=EXCLUDED.nome_fantasia, regime_tributario=EXCLUDED.regime_tributario,
                     gesthub_id=EXCLUDED.gesthub_id, sync_gesthub_at=NOW()
                   RETURNING id`,
                  [formatted, nomeLegal, nomeFantasia, regime, parseInt(scope_id, 10)]
                );
                effScopeId = up.rows[0]?.id || null;
              }
            }
          } catch (e) { console.error('[memory knowledge] resolve scope:', e.message); }
        } else {
          // Ja e UUID
          effScopeId = scope_id;
        }
      }
      const r = await query(
        `INSERT INTO public.memories
           (scope_type, scope_id, agent_id, category, title, content, summary, source_type,
            tags, priority, is_rag_enabled, status)
         VALUES ($1::memory_scope, $2, $3, $4::memory_category, $5, $6, $7, 'manual',
                 $8, $9, $10, $11::memory_status)
         RETURNING *`,
        [scope_type, effScopeId, agent_id || null, category, title, content, summary || null,
         tags, priority, is_rag_enabled, status]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Lista FLAT de todos os contatos do Gesthub (pessoas) pra dropdown direto.
  // Cada contato vem com o nome da empresa pra contexto.
  app.get('/api/memory/contacts', async (req, res) => {
    try {
      const gh = await import('../services/gesthub.js');
      const clientes = await gh.getClients().catch(() => []);
      const flat = [];
      for (const c of clientes) {
        const empresa = c.legalName || c.tradeName || c.razaoSocial || c.nomeFantasia || `Empresa #${c.id}`;
        const contatos = Array.isArray(c.contatos) ? c.contatos : Array.isArray(c.contacts) ? c.contacts : [];
        for (const ct of contatos) {
          if (!ct || (!ct.nome && !ct.name)) continue;
          flat.push({
            id: `${c.id}:${ct.id || ct.nome || ct.telefone}`,  // composto: gesthub_empresa:contato_id
            gesthub_client_id: c.id,
            gesthub_contact_id: ct.id || null,
            nome: ct.nome || ct.name || '',
            funcao: ct.funcao || ct.role || null,
            telefone: ct.telefone || ct.phone || null,
            email: ct.email || null,
            empresa,
          });
        }
      }
      flat.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      res.json(flat);
    } catch (e) { console.error('[memory contacts flat]', e.message); res.status(500).json({ error: e.message }); }
  });

  // Lista contatos de um cliente pra dropdown (Melhoria RAG abr/2026)
  // Fonte: API Gesthub (cached via gesthub.js)
  app.get('/api/memory/clients/:id/contacts', async (req, res) => {
    try {
      const { id } = req.params;
      const gh = await import('../services/gesthub.js');
      const clients = await gh.getClients();
      // id aqui é o id interno luna_v2.clients.id (uuid). Precisamos mapear via gesthub_id
      // ou se passar um numero direto, assume gesthub id.
      let gesthubId = null;
      if (/^\d+$/.test(id)) {
        gesthubId = parseInt(id, 10);
      } else {
        // UUID → busca em luna_v2.clients.gesthub_id
        const r = await query(`SELECT gesthub_id FROM luna_v2.clients WHERE id = $1`, [id]).catch(() => ({ rows: [] }));
        gesthubId = r.rows[0]?.gesthub_id || null;
      }
      if (!gesthubId) return res.json([]);
      const cliente = clients.find(c => c.id === gesthubId);
      const contatos = Array.isArray(cliente?.contatos) ? cliente.contatos : [];
      res.json(contatos.map(c => ({
        id: c.id,
        nome: c.nome || '(sem nome)',
        funcao: c.funcao || null,
        telefone: c.telefone || null,
        email: c.email || null,
      })));
    } catch (e) { console.error('[memory contacts]', e.message); res.status(500).json({ error: e.message }); }
  });

  // Actions sobre memórias públicas (arquivar / excluir / toggle RAG)
  app.post('/api/memory/:id/archive', async (req, res) => {
    try {
      const r = await query(
        `UPDATE public.memories SET status = 'archived'::memory_status, updated_at = NOW()
           WHERE id = $1 RETURNING id, status`,
        [req.params.id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'memoria nao encontrada' });
      res.json({ ok: true, ...r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/memory/:id/unarchive', async (req, res) => {
    try {
      const r = await query(
        `UPDATE public.memories SET status = 'approved'::memory_status, updated_at = NOW()
           WHERE id = $1 RETURNING id, status`,
        [req.params.id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'memoria nao encontrada' });
      res.json({ ok: true, ...r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/memory/:id', async (req, res) => {
    try {
      const r = await query(`DELETE FROM public.memories WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'memoria nao encontrada' });
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/memory/:id/enable-rag', async (req, res) => {
    try {
      const r = await query(
        `UPDATE public.memories SET is_rag_enabled = true, updated_at = NOW()
           WHERE id = $1 RETURNING id, is_rag_enabled`,
        [req.params.id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'memoria nao encontrada' });
      res.json({ ok: true, ...r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/memory/:id/disable-rag', async (req, res) => {
    try {
      const r = await query(
        `UPDATE public.memories SET is_rag_enabled = false, updated_at = NOW()
           WHERE id = $1 RETURNING id, is_rag_enabled`,
        [req.params.id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'memoria nao encontrada' });
      res.json({ ok: true, ...r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

}
