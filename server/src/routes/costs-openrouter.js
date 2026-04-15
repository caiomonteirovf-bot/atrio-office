// Endpoints OpenRouter: saldo + import CSV + summary
import { query } from '../db/pool.js';

function parseCSVLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function registerCostsOpenRouter(app) {
  // Saldo em tempo real
  app.get('/api/costs/openrouter/balance', async (req, res) => {
    try {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return res.status(500).json({ error: 'OPENROUTER_API_KEY ausente' });
      const r = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { 'Authorization': 'Bearer ' + key }
      });
      const j = await r.json();
      res.json(j);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Import CSV (body = texto bruto do CSV)
  app.post('/api/costs/openrouter/import', async (req, res) => {
    try {
      const raw = typeof req.body === 'string' ? req.body : (req.body?.csv || '');
      if (!raw) return res.status(400).json({ error: 'Envie o CSV no body (text/csv ou { csv: "..." })' });
      const lines = raw.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return res.status(400).json({ error: 'CSV vazio' });
      const header = parseCSVLine(lines[0]).map(h => h.trim());
      const idx = (name) => header.indexOf(name);
      const iId = idx('generation_id');
      const iCreated = idx('created_at');
      const iCost = idx('cost_total');
      const iCache = idx('cost_cache');
      const iTP = idx('tokens_prompt');
      const iTC = idx('tokens_completion');
      const iTR = idx('tokens_reasoning');
      const iTCh = idx('tokens_cached');
      const iModel = idx('model_permaslug');
      const iProv = idx('provider_name');
      const iApp = idx('app_name');
      const iKey = idx('api_key_name');
      const iFinish = idx('finish_reason_normalized');
      const iGenT = idx('generation_time_ms');
      const iCanc = idx('cancelled');

      let inserted = 0, skipped = 0;
      for (let i = 1; i < lines.length; i++) {
        const c = parseCSVLine(lines[i]);
        const gid = c[iId];
        if (!gid) { skipped++; continue; }
        try {
          const r = await query(
            `INSERT INTO public.openrouter_activity
              (generation_id, created_at, cost_total, cost_cache, tokens_prompt, tokens_completion,
               tokens_reasoning, tokens_cached, model, provider_name, app_name, api_key_name,
               finish_reason, generation_time_ms, cancelled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (generation_id) DO NOTHING RETURNING generation_id`,
            [
              gid, c[iCreated] || new Date().toISOString(),
              parseFloat(c[iCost] || 0), parseFloat(c[iCache] || 0),
              parseInt(c[iTP] || 0), parseInt(c[iTC] || 0),
              parseInt(c[iTR] || 0), parseInt(c[iTCh] || 0),
              c[iModel] || null, c[iProv] || null, c[iApp] || null, c[iKey] || null,
              c[iFinish] || null, parseInt(c[iGenT] || 0) || null,
              (c[iCanc] || '').toLowerCase() === 'true'
            ]
          );
          if (r.rowCount > 0) inserted++; else skipped++;
        } catch (e) { skipped++; }
      }
      res.json({ ok: true, inserted, skipped, total: lines.length - 1 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Resumo agregado
  app.get('/api/costs/openrouter/summary', async (req, res) => {
    try {
      const days = parseInt(req.query.days || 30);
      const [daily, byModel, byKey, totals, recent] = await Promise.all([
        query(`SELECT date_trunc('day', created_at) AS day,
                      SUM(cost_total) AS cost,
                      SUM(tokens_prompt + tokens_completion) AS tokens,
                      COUNT(*) AS calls
               FROM public.openrouter_activity
               WHERE created_at > now() - ($1 || ' days')::interval
               GROUP BY 1 ORDER BY 1`, [days]),
        query(`SELECT model,
                      SUM(cost_total) AS cost,
                      SUM(tokens_prompt) AS tokens_prompt,
                      SUM(tokens_completion) AS tokens_completion,
                      SUM(tokens_reasoning) AS tokens_reasoning,
                      SUM(tokens_cached) AS tokens_cached,
                      COUNT(*) AS calls,
                      AVG(generation_time_ms)::int AS avg_latency_ms
               FROM public.openrouter_activity
               WHERE created_at > now() - ($1 || ' days')::interval
               GROUP BY model ORDER BY cost DESC`, [days]),
        query(`SELECT api_key_name, app_name,
                      SUM(cost_total) AS cost,
                      SUM(tokens_prompt + tokens_completion) AS tokens,
                      COUNT(*) AS calls
               FROM public.openrouter_activity
               WHERE created_at > now() - ($1 || ' days')::interval
               GROUP BY api_key_name, app_name ORDER BY cost DESC`, [days]),
        query(`SELECT
                 SUM(cost_total) FILTER (WHERE created_at::date = CURRENT_DATE) AS today,
                 SUM(cost_total) FILTER (WHERE created_at > date_trunc('month', now())) AS month,
                 SUM(cost_total) AS all_time,
                 SUM(tokens_prompt + tokens_completion) AS tokens_all_time,
                 COUNT(*) AS calls_all_time
               FROM public.openrouter_activity`),
        query(`SELECT generation_id, created_at, cost_total, tokens_prompt, tokens_completion,
                      tokens_reasoning, tokens_cached, model, provider_name, app_name,
                      api_key_name, finish_reason, generation_time_ms
               FROM public.openrouter_activity
               ORDER BY created_at DESC LIMIT 50`),
      ]);
      res.json({
        daily: daily.rows,
        by_model: byModel.rows,
        by_key: byKey.rows,
        totals: totals.rows[0] || {},
        recent: recent.rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
