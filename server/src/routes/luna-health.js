import { query } from '../db/pool.js';

export function registerLunaHealth(app) {
  app.get('/api/luna/health', async (req, res) => {
    try {
      const days = Math.min(30, Math.max(1, Number(req.query.days || 7)));
      const since = `NOW() - INTERVAL '${days} days'`;

      // Conversas, mensagens, latencia (tempo entre inbound e proximo outbound)
      const main = await query(`
        WITH outs AS (
          SELECT conversation_id, created_at
          FROM luna_v2.messages
          WHERE direction = 'outbound' AND created_at > ${since}
        ),
        latencias AS (
          SELECT m.conversation_id, m.created_at AS in_at,
                 (SELECT MIN(o.created_at) FROM outs o
                  WHERE o.conversation_id = m.conversation_id AND o.created_at > m.created_at) AS out_at
          FROM luna_v2.messages m
          WHERE m.direction = 'inbound' AND m.created_at > ${since}
        ),
        stats AS (
          SELECT
            count(*) FILTER (WHERE llm_latency_ms IS NOT NULL) AS respostas,
            avg(llm_latency_ms)::int AS avg_latencia_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY llm_latency_ms) AS p50_latencia_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY llm_latency_ms) AS p95_latencia_ms,
            sum(tool_calls)::int AS total_tool_calls
          FROM luna_v2.messages
          WHERE direction='outbound' AND llm_latency_ms IS NOT NULL AND created_at > ${since}
        ),
        msgs AS (
          SELECT
            count(*) FILTER (WHERE direction='inbound') AS inbound,
            count(*) FILTER (WHERE direction='outbound') AS outbound,
            count(DISTINCT conversation_id) AS conversas_ativas
          FROM luna_v2.messages WHERE created_at > ${since}
        ),
        handoff AS (
          SELECT
            count(*) FILTER (WHERE title LIKE '%handoff_inertia%') AS inercias,
            count(*) FILTER (WHERE title LIKE '%handoff_vague%') AS vagas,
            count(*) FILTER (WHERE title LIKE '[ALERTA]%') AS alertas_total
          FROM public.tasks WHERE created_at > ${since}
        ),
        refl AS (
          SELECT count(*) AS pendentes FROM luna_v2.memories
          WHERE status = 'pending' AND trigger_type = 'reflection'
        ),
        buffer AS (
          SELECT count(*) AS ativos FROM luna_v2.inbound_buffer
        )
        SELECT stats.*, msgs.*, handoff.*, refl.*, buffer.* FROM stats, msgs, handoff, refl, buffer
      `);

      const r = main.rows[0] || {};

      // Top 5 respostas mais lentas (LLM)
      const { rows: lentas } = await query(`
        SELECT m.llm_latency_ms, m.model_used, c.phone, cl.nome_fantasia, LEFT(m.content, 80) AS resposta
        FROM luna_v2.messages m
        JOIN luna_v2.conversations c ON c.id = m.conversation_id
        LEFT JOIN luna_v2.clients cl ON cl.id = c.client_id
        WHERE m.direction='outbound' AND m.llm_latency_ms IS NOT NULL AND m.created_at > ${since}
        ORDER BY m.llm_latency_ms DESC
        LIMIT 5
      `);

      res.json({
        periodo_dias: days,
        latencia_llm: {
          avg_ms: r.avg_latencia_ms ? Number(r.avg_latencia_ms) : null,
          p50_ms: r.p50_latencia_ms ? Math.round(Number(r.p50_latencia_ms)) : null,
          p95_ms: r.p95_latencia_ms ? Math.round(Number(r.p95_latencia_ms)) : null,
          respostas_amostradas: Number(r.respostas || 0),
          total_tool_calls: Number(r.total_tool_calls || 0),
        },
        mensagens: {
          inbound: Number(r.inbound || 0),
          outbound: Number(r.outbound || 0),
          conversas_ativas: Number(r.conversas_ativas || 0),
        },
        handoffs: {
          inercias: Number(r.inercias || 0),
          vagas: Number(r.vagas || 0),
          alertas_total: Number(r.alertas_total || 0),
        },
        reflector: {
          memorias_pendentes: Number(r.pendentes || 0),
        },
        buffer: {
          ativos_agora: Number(r.ativos || 0),
        },
        top_lentas: lentas.map(l => ({
          phone: l.phone,
          cliente: l.nome_fantasia || 'desconhecido',
          latencia_ms: l.llm_latency_ms,
          model: l.model_used,
          resposta: l.resposta,
        })),
      });
    } catch (e) {
      console.error('[luna/health]', e);
      res.status(500).json({ erro: e.message });
    }
  });
}
