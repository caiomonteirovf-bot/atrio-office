// Datalake viewer — endpoints de leitura (cliente_360 + contatos + conversas)
import { query } from '../db/pool.js';

export function registerDatalake(app) {
  // Lista de clientes com filtros
  app.get('/api/datalake/clientes', async (req, res) => {
    try {
      const { q = '', analyst, regime, status, sem_luna, limit = '200' } = req.query;
      const where = [];
      const params = [];
      let i = 1;
      if (q) {
        where.push(`(razao_social ILIKE '%'||$${i}||'%' OR nome_fantasia ILIKE '%'||$${i}||'%' OR regexp_replace(cnpj,'\D','','g') LIKE '%'||regexp_replace($${i},'\D','','g')||'%' OR socio_responsavel ILIKE '%'||$${i}||'%')`);
        params.push(q); i++;
      }
      if (analyst) { where.push(`analyst = $${i}`); params.push(analyst); i++; }
      if (regime)  { where.push(`regime = $${i}`);  params.push(regime);  i++; }
      if (status)  { where.push(`status_gesthub = $${i}`); params.push(status); i++; }
      if (sem_luna === 'true') where.push('luna_client_id IS NULL');

      const sql = `SELECT gesthub_id, cnpj, razao_social, nome_fantasia, regime, status_gesthub, optante_simples, fator_r, porte, qtd_contatos, qtd_socios, nfse_emitidas, nfse_ultima_emissao,
                          mensalidade, socio_responsavel, analyst, city, state, headcount,
                          contas_bancarias, memorias_ativas, conversas_whatsapp, luna_client_id
                   FROM datalake.cliente_360
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY mensalidade DESC NULLS LAST, razao_social
                   LIMIT $${i}`;
      params.push(Math.min(500, parseInt(limit) || 200));
      const r = await query(sql, params);
      res.json({ total: r.rowCount, rows: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Detalhe completo de 1 cliente
  app.get('/api/datalake/cliente/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'id invalido' });

      const [c360, contatos, socios] = await Promise.all([
        query(`SELECT * FROM datalake.cliente_360 WHERE gesthub_id = $1`, [id]),
        query(`SELECT id, nome, funcao, telefone, email, cpf FROM datalake_gesthub.cliente_contatos WHERE cliente_id = $1 ORDER BY funcao, nome`, [id]),
        query(`SELECT nome, cpf_cnpj, email, telefone, qualificacao, participacao FROM datalake_gesthub.socios WHERE cliente_id =  AND ativo = true ORDER BY participacao DESC NULLS LAST$1`, [id]).catch(() => ({ rows: [] })),
      ]);

      const cliente = c360.rows[0];
      if (!cliente) return res.status(404).json({ error: 'cliente nao encontrado' });

      // Conversas Luna + memorias (se vinculado)
      let conversas = [], memorias = [];
      if (cliente.luna_client_id) {
        const [conv, mem] = await Promise.all([
          query(`SELECT id, phone, attendance_status, last_inbound_at, last_outbound_at, last_human_reply_at, mensagens_count, started_at FROM luna_v2.conversations WHERE client_id = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 20`, [cliente.luna_client_id]).catch(() => ({ rows: [] })),
          query(`SELECT id, tipo, titulo, conteudo, prioridade, created_at FROM luna_v2.memories WHERE client_id = $1 AND status='ativa' ORDER BY prioridade DESC, created_at DESC LIMIT 50`, [cliente.luna_client_id]).catch(() => ({ rows: [] })),
        ]);
        conversas = conv.rows; memorias = mem.rows;
      }

      res.json({ cliente, contatos: contatos.rows, socios: socios.rows, conversas, memorias });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Facetas pra filtros
  app.get('/api/datalake/facets', async (req, res) => {
    try {
      const r = await query(`
        SELECT 'analyst' AS tipo, analyst AS valor, count(*)::int AS n FROM datalake.cliente_360 WHERE analyst IS NOT NULL GROUP BY analyst
        UNION ALL
        SELECT 'regime', regime, count(*)::int FROM datalake.cliente_360 WHERE regime IS NOT NULL GROUP BY regime
        UNION ALL
        SELECT 'status', status_gesthub, count(*)::int FROM datalake.cliente_360 WHERE status_gesthub IS NOT NULL GROUP BY status_gesthub
        ORDER BY tipo, n DESC`);
      const out = { analyst: [], regime: [], status: [] };
      for (const row of r.rows) out[row.tipo]?.push({ valor: row.valor, n: row.n });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Resumo/stats
  app.get('/api/datalake/summary', async (req, res) => {
    try {
      const r = await query(`SELECT count(*)::int AS total,
                                     count(*) FILTER (WHERE status_gesthub='ATIVO')::int AS ativos,
                                     count(*) FILTER (WHERE luna_client_id IS NOT NULL)::int AS com_luna,
                                     count(*) FILTER (WHERE luna_client_id IS NULL AND status_gesthub='ATIVO')::int AS sem_luna,
                                     COALESCE(sum(mensalidade),0)::numeric AS receita_mensal
                              FROM datalake.cliente_360`);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
