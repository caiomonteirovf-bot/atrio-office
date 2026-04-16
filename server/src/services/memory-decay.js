// Passo 5 — TTL decay: arquiva memorias estagnadas conforme politica por tipo.
// Politicas (derivadas de category + metadata):
//   permanent        : nunca arquiva (fiscal_rule, process_rule, preference, tool_result com entity=nfse)
//   observation_90d  : client_fact sem severity (arquiva se 90d sem hit/uso)
//   alert_30d        : client_fact com severity=alta|critica (arquiva se 30d sem hit/uso apos criacao)
//   general_180d     : learned_pattern, correction, general (arquiva se 180d sem hit/uso)
import { query } from '../db/pool.js';

// SQL unico: calcula politica via CASE e filtra vencidos num so pass.
// Retorna ids que SERIAM arquivados (dry-run) ou arquiva de fato.
const DECAY_SQL = `
  WITH classified AS (
    SELECT m.id, m.category, m.title, m.scope_id,
           m.metadata->>'entity_type'     AS entity_type,
           m.metadata->>'severity'        AS severity,
           GREATEST(
             COALESCE(m.last_semantic_hit, 'epoch'::timestamptz),
             COALESCE(m.last_used_at,      'epoch'::timestamptz),
             COALESCE(m.created_at,        'epoch'::timestamptz)
           ) AS last_touch,
           CASE
             WHEN m.category IN ('fiscal_rule','process_rule','preference') THEN 'permanent'
             WHEN m.category = 'tool_result' AND m.metadata->>'entity_type' = 'nfse' THEN 'permanent'
             WHEN m.category = 'client_fact' AND m.metadata->>'severity' IN ('alta','critica') THEN 'alert_30d'
             WHEN m.category = 'client_fact' THEN 'observation_90d'
             WHEN m.category IN ('learned_pattern','correction','general','tool_result') THEN 'general_180d'
             ELSE 'general_180d'
           END AS policy
      FROM memories m
     WHERE m.status = 'approved'::memory_status
  )
  SELECT id, title, category, entity_type, severity, last_touch, policy
    FROM classified
   WHERE (policy = 'alert_30d'       AND last_touch < NOW() - INTERVAL '30 days')
      OR (policy = 'observation_90d' AND last_touch < NOW() - INTERVAL '90 days')
      OR (policy = 'general_180d'    AND last_touch < NOW() - INTERVAL '180 days')
   ORDER BY last_touch ASC
`;

export async function decayScan({ dryRun = false, limit = 500 } = {}) {
  const { rows } = await query(DECAY_SQL);
  const victims = rows.slice(0, limit);
  if (!victims.length) {
    return { ok: true, scanned: rows.length, archived: 0, dryRun, victims: [] };
  }

  if (dryRun) {
    return { ok: true, scanned: rows.length, archived: 0, dryRun: true, victims };
  }

  // Agrupa por politica pro audit log
  const ids = victims.map(v => v.id);
  await query(
    `UPDATE memories SET status = 'archived'::memory_status, updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
    [ids]
  );

  // Audit log por memoria (action=decayed)
  for (const v of victims) {
    await query(
      `INSERT INTO memory_audit_log
         (entity_type, entity_id, action, actor_type, reason, source_ref, after_json)
       VALUES ('memory', $1, 'decayed', 'system', $2, 'cron:decay', $3::jsonb)`,
      [
        v.id,
        `TTL expirado (${v.policy})`,
        JSON.stringify({
          policy: v.policy,
          category: v.category,
          title: v.title,
          entity_type: v.entity_type,
          severity: v.severity,
          last_touch: v.last_touch,
        }),
      ]
    ).catch(err => console.error('[decay] audit fail:', err.message));
  }

  return { ok: true, scanned: rows.length, archived: victims.length, dryRun: false, victims };
}

// Cron: roda 1x por dia as 3am (servidor)
export function startDecayCron() {
  const INTERVAL_MS = Number(process.env.DECAY_INTERVAL_MS || 24 * 60 * 60 * 1000);
  const runOnce = async () => {
    try {
      const r = await decayScan({ dryRun: false });
      if (r.archived) console.log(`[decay] arquivou ${r.archived} memoria(s) (de ${r.scanned} candidatas)`);
    } catch (e) {
      console.error('[decay] falha:', e.message);
    }
  };
  // Primeiro scan 2min apos boot
  setTimeout(runOnce, 2 * 60 * 1000);
  setInterval(runOnce, INTERVAL_MS);
  console.log(`[decay] cron ativo, intervalo=${INTERVAL_MS / 3600000}h`);
}

export default { decayScan, startDecayCron };
