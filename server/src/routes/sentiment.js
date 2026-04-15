import { query } from '../db/pool.js';

export function registerSentiment(app) {
  app.get('/api/dashboard/sentiment', async (req, res) => {
    try {
      const days = Math.min(30, Math.max(1, Number(req.query.days || 7)));
      const since = `NOW() - INTERVAL '${days} days'`;

      // Agregados
      const r = await query(`
        WITH erros AS (
          SELECT count(*) AS total,
                 count(*) FILTER (WHERE prioridade >= 9) AS criticos,
                 count(*) FILTER (WHERE prioridade BETWEEN 7 AND 8) AS altos,
                 count(DISTINCT client_id) AS clientes_afetados
          FROM luna_v2.memories
          WHERE tipo = 'erro' AND created_at > ${since}
        ),
        handoffs AS (
          SELECT count(*) FILTER (WHERE title LIKE '%handoff_inertia%') AS inercias,
                 count(*) FILTER (WHERE title LIKE '%handoff_vague%') AS vagas
          FROM public.tasks
          WHERE created_at > ${since}
        ),
        convos AS (
          SELECT count(*) AS total_conversas,
                 count(DISTINCT client_id) FILTER (WHERE client_id IS NOT NULL) AS clientes_distintos
          FROM luna_v2.conversations
          WHERE last_message_at > ${since}
        ),
        alarmes AS (
          SELECT count(*) AS alarmes_total,
                 count(DISTINCT conversation_id) AS conversas_com_alarme
          FROM luna_v2.messages
          WHERE direction = 'inbound'
            AND created_at > ${since}
            AND content ~* '(descaso|absurd|inaceit|process|reclamar|reclamacao|reclamação|nao consegue ajudar|não consegue ajudar|não ajuda em nada|nao ajuda em nada|ridicul|pessim|péssim|horr[íi]vel|cancelar contrato|trocar de contador|perdi a paciencia|perdi a paciência|nunca mais|desisto)'
        )
        SELECT erros.*, handoffs.*, convos.*, alarmes.* FROM erros, handoffs, convos, alarmes
      `);

      const row = r.rows[0] || {};
      const criticos = Number(row.criticos || 0);
      const altos = Number(row.altos || 0);
      const inercias = Number(row.inercias || 0);
      const vagas = Number(row.vagas || 0);
      const total = Number(row.total_conversas || 0);
      const alarmes = Number(row.alarmes_total || 0);
      const conversasAlarme = Number(row.conversas_com_alarme || 0);

      // Score 0-100: penaliza criticos (20), altos (10), handoffs (5), alarmes inbound (15 por conversa)
      let score = 100;
      score -= criticos * 20;
      score -= altos * 10;
      score -= (inercias + vagas) * 5;
      score -= conversasAlarme * 15;
      score = Math.max(0, Math.min(100, score));

      let nivel = score >= 85 ? 'otimo' : score >= 70 ? 'bom' : score >= 50 ? 'atencao' : 'critico';
      // Se ha qualquer sinal de frustracao/alarme ou handoff problema, nunca marca como otimo
      if ((conversasAlarme > 0 || inercias > 0 || vagas > 0 || criticos > 0) && nivel === 'otimo') nivel = 'bom';
      if (criticos > 0 && nivel === 'bom') nivel = 'atencao';
      const label = nivel === 'otimo' ? 'Ótimo' : nivel === 'bom' ? 'Bom' : nivel === 'atencao' ? 'Atenção' : 'Crítico';

      // Ultimos erros
      const { rows: ultimos } = await query(`
        SELECT m.id, m.titulo, m.conteudo, m.prioridade, m.created_at,
               c.nome_fantasia, c.nome_legal
        FROM luna_v2.memories m
        LEFT JOIN luna_v2.clients c ON c.id = m.client_id
        WHERE m.tipo = 'erro' AND m.created_at > ${since}
        ORDER BY m.prioridade DESC, m.created_at DESC LIMIT 5
      `);

      res.json({
        periodo_dias: days,
        score,
        nivel, label,
        conversas: total,
        clientes_distintos: Number(row.clientes_distintos || 0),
        erros: { total: Number(row.total || 0), criticos, altos, clientes_afetados: Number(row.clientes_afetados || 0) },
        handoffs: { inercias, vagas },
        alarmes: { total: alarmes, conversas_afetadas: conversasAlarme },
        ultimos_erros: ultimos,
      });
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });
}
