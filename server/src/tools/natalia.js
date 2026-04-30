// tools/natalia.js
// Tools da agente Natalia — Diretora de Growth.
// Foco: visao da carteira, pipeline e conversao. v1 INTERNO (nao fala com cliente direto).

import { query } from '../db/pool.js';

const NATALIA_ID = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab';

function fmtBRL(n) {
  return 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export const tools = {
  /**
   * KPIs gerais da carteira: ativos, MRR, prospects, novos 30d, frios, conversao 30d.
   * Use sempre que perguntarem "como esta a carteira?", "qual MRR?", "quantos clientes?".
   */
  async natalia_kpis() {
    try {
      const FINANCE = process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000';

      const { rows: ativos } = await query(
        `SELECT COUNT(*)::int AS total, COALESCE(SUM(monthly_fee), 0)::numeric AS mrr_total
           FROM datalake_gesthub.clients WHERE status = 'ATIVO'`
      );
      const { rows: prospects } = await query(
        `SELECT COUNT(*)::int AS total
           FROM datalake_gesthub.clients WHERE client_type = 'PROSPECT' AND status = 'ATIVO'`
      );
      const { rows: novos30d } = await query(
        `SELECT COUNT(*)::int AS total
           FROM datalake_gesthub.clients
          WHERE status = 'ATIVO' AND start_date IS NOT NULL AND start_date <> ''
            AND start_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND start_date::date >= CURRENT_DATE - INTERVAL '30 days'`
      ).catch(() => ({ rows: [{ total: 0 }] }));

      const { rows: pipeline } = await query(
        `SELECT result->>'source' AS source, COUNT(*)::int AS total
           FROM tasks
          WHERE assigned_to = $1 AND status IN ('pending','in_progress')
          GROUP BY 1`,
        [NATALIA_ID]
      );

      const { rows: convTotals } = await query(
        `SELECT
            COUNT(*) FILTER (WHERE result->>'sent_to' IS NOT NULL)::int AS enviadas,
            COUNT(*) FILTER (WHERE result->>'response_status' = 'responded')::int AS respondidas,
            COUNT(*) FILTER (WHERE result->>'response_status' = 'silent')::int AS silent
           FROM tasks
          WHERE assigned_to = $1
            AND (result->>'approved_at')::timestamptz > NOW() - INTERVAL '30 days'`,
        [NATALIA_ID]
      ).catch(() => ({ rows: [{ enviadas: 0, respondidas: 0, silent: 0 }] }));

      // Frios: ativos > 60d sem upload no Finance
      let frios = null;
      try {
        const r = await fetch(`${FINANCE}/api/uploads?dias=60`);
        const j = await r.json();
        const ups = j?.data || j || [];
        const comUpload = new Set(ups.map(u => u.clienteGesthubId || u.cliente_gesthub_id));
        const { rows: at } = await query(
          `SELECT id FROM datalake_gesthub.clients
            WHERE status='ATIVO'
              AND (start_date IS NULL OR start_date = ''
                   OR (start_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND start_date::date < CURRENT_DATE - INTERVAL '60 days'))`
        );
        frios = at.filter(c => !comUpload.has(c.id)).length;
      } catch { /* finance off */ }

      const conv = convTotals[0];
      const taxaResp = conv.enviadas > 0 ? Math.round((conv.respondidas / conv.enviadas) * 100) : null;
      const pipelineTotal = pipeline.reduce((sum, p) => sum + p.total, 0);

      return {
        clientes_ativos: ativos[0].total,
        mrr: fmtBRL(ativos[0].mrr_total),
        mrr_brl_num: parseFloat(ativos[0].mrr_total),
        prospects: prospects[0].total,
        novos_30d: novos30d[0].total,
        clientes_frios_60d: frios,
        pipeline_total: pipelineTotal,
        pipeline_por_origem: pipeline.reduce((acc, p) => { acc[p.source] = p.total; return acc }, {}),
        conversao_30d: {
          enviadas: conv.enviadas,
          respondidas: conv.respondidas,
          silent: conv.silent,
          taxa_resposta_pct: taxaResp,
        },
        resumo: `${ativos[0].total} ativos · MRR ${fmtBRL(ativos[0].mrr_total)} · ${frios ?? '?'} frios · pipeline ${pipelineTotal} task(s)${taxaResp != null ? ` · ${taxaResp}% resposta 30d` : ''}`,
      };
    } catch (e) {
      return { erro: e.message };
    }
  },

  /**
   * Lista tasks do pipeline (assigned_to=Natalia) com filtros.
   * Use quando perguntarem "o que tenho na fila?", "mostra os clientes frios", "leads novos".
   */
  async natalia_pipeline_status({ source = null, status = 'pending,in_progress', limit = 30 } = {}) {
    try {
      const statusList = String(status).split(',').map(s => s.trim()).filter(Boolean);
      let sql = `SELECT id, title, priority, status, created_at, result->>'source' AS source,
                        result->>'gesthub_client_id' AS gesthub_client_id,
                        result->>'msg_sugerida' AS msg_sugerida,
                        result->>'response_status' AS response_status,
                        result->>'sent_to' AS sent_to
                   FROM tasks
                  WHERE assigned_to = $1
                    AND status = ANY($2::text[])`;
      const params = [NATALIA_ID, statusList];
      if (source) {
        params.push(source);
        sql += ` AND result->>'source' = $${params.length}`;
      }
      sql += ` ORDER BY priority DESC, created_at DESC LIMIT ${Math.min(limit, 100)}`;

      const { rows } = await query(sql, params);
      return {
        total: rows.length,
        tasks: rows.map(r => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          status: r.status,
          source: r.source,
          gesthub_client_id: r.gesthub_client_id,
          response_status: r.response_status,
          sent_to: r.sent_to,
          msg_sugerida_preview: r.msg_sugerida ? String(r.msg_sugerida).slice(0, 120) : null,
          created_at: r.created_at,
        })),
        resumo: `${rows.length} task(s)${source ? ` na origem ${source}` : ''}${statusList.length === 1 ? ` (${statusList[0]})` : ''}`,
      };
    } catch (e) {
      return { erro: e.message };
    }
  },

  /**
   * Snapshot rapido das mensagens enviadas e respostas dos ultimos N dias.
   * Use quando perguntarem "quantas mensagens enviei essa semana?", "quem respondeu?".
   */
  async natalia_mensagens_enviadas({ dias = 30, com_resposta = null } = {}) {
    try {
      const sql = `SELECT id, title,
                          result->>'sent_to' AS sent_to,
                          result->>'sent_message' AS sent_message,
                          (result->>'approved_at')::timestamptz AS approved_at,
                          result->>'response_status' AS response_status,
                          result->>'response_preview' AS response_preview,
                          (result->>'responded_at')::timestamptz AS responded_at
                     FROM tasks
                    WHERE assigned_to = $1
                      AND result->>'sent_to' IS NOT NULL
                      AND (result->>'approved_at')::timestamptz > NOW() - INTERVAL '${parseInt(dias) || 30} days'
                    ORDER BY (result->>'approved_at')::timestamptz DESC LIMIT 50`;
      const { rows } = await query(sql, [NATALIA_ID]);

      const filtered = com_resposta === true
        ? rows.filter(r => r.response_status === 'responded')
        : com_resposta === false
        ? rows.filter(r => r.response_status === 'silent')
        : rows;

      return {
        total: filtered.length,
        periodo_dias: dias,
        mensagens: filtered.map(r => ({
          task_id: r.id,
          titulo: r.title,
          enviada_para: r.sent_to,
          enviada_em: r.approved_at,
          mensagem: String(r.sent_message || '').slice(0, 200),
          status_resposta: r.response_status || 'pending',
          respondeu_em: r.responded_at,
          resposta_preview: r.response_preview ? String(r.response_preview).slice(0, 200) : null,
        })),
      };
    } catch (e) {
      return { erro: e.message };
    }
  },
};
