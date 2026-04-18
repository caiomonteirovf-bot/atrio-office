// services/agent-budget.js
// Enforcement de orçamento mensal por agente.
// Inspirado no padrão cost_events + budget_policies do paperclipai/paperclip.
//
// Uso:
//   import { checkBudget, recordAlert } from './agent-budget.js';
//   const gate = await checkBudget(agent);
//   if (gate.blocked) return { error: 'budget_exceeded', detail: gate };
//
// Status: ok (<80%) | warn (80-99%) | blocked (>=100%)
// Downgrade automático: se blocked, retorna flag pra caller trocar para DeepSeek barato.

import { query } from '../db/pool.js';
import { logEvent } from './activity-log.js';

const WARN_AT = 0.80;
const BLOCK_AT = 1.00;

const cache = new Map(); // agent_id -> { status, spent, budget, pct, cached_at }
const CACHE_MS = 30_000; // 30s — evita hit constante no DB

export async function checkBudget(agent) {
  if (!agent?.id) return { status: 'ok', blocked: false };

  // cache curto para alta frequência
  const cached = cache.get(agent.id);
  if (cached && (Date.now() - cached.cached_at) < CACHE_MS) {
    return cached.result;
  }

  try {
    const { rows } = await query(
      `SELECT budget_usd, spent_usd, pct_used, budget_status
         FROM agent_budget_status WHERE agent_id = $1`,
      [agent.id]
    );
    const r = rows[0];
    if (!r || !r.budget_usd) {
      const result = { status: 'ok', blocked: false, spent: 0, budget: null, pct: null };
      cache.set(agent.id, { result, cached_at: Date.now() });
      return result;
    }

    const budget = parseFloat(r.budget_usd);
    const spent = parseFloat(r.spent_usd) || 0;
    const pct = budget > 0 ? spent / budget : 0;

    let status = 'ok';
    if (pct >= BLOCK_AT) status = 'blocked';
    else if (pct >= WARN_AT) status = 'warn';

    // Persiste mudança de status (se mudou)
    if (r.budget_status !== status) {
      await query(
        `UPDATE agents SET budget_status = $1,
                           budget_blocked_at = CASE WHEN $1 = 'blocked' THEN now() ELSE NULL END
          WHERE id = $2`,
        [status, agent.id]
      );
      await recordAlert(agent, status, spent, budget);
    }

    const result = {
      status,
      blocked: status === 'blocked',
      spent: Number(spent.toFixed(4)),
      budget,
      pct: Number((pct * 100).toFixed(1)),
    };
    cache.set(agent.id, { result, cached_at: Date.now() });
    return result;
  } catch (err) {
    console.error('[agent-budget] erro:', err.message);
    return { status: 'ok', blocked: false, error: err.message };
  }
}

/** Invalida cache de um agente (chamar apos recordTokenUsage para ter leitura fresca). */
export function invalidateBudgetCache(agentId) {
  if (agentId) cache.delete(agentId);
}

/** Registra alerta (notifications) quando muda de patamar. */
async function recordAlert(agent, status, spent, budget) {
  logEvent({
    actor_type: 'system', actor_id: 'budget-watcher',
    event_type: `budget.${status}`, action: 'threshold',
    entity_type: 'agent', entity_id: agent.id, actor_name: agent.name,
    payload: { spent_usd: Number(spent.toFixed(4)), budget_usd: budget, pct: Number(((spent/budget)*100).toFixed(1)) },
    severity: status === 'blocked' ? 'critical' : status === 'warn' ? 'warn' : 'info',
  });
  const emoji = status === 'blocked' ? '🚫' : status === 'warn' ? '⚠️' : '✅';
  const title = status === 'blocked'
    ? `${emoji} ${agent.name} atingiu 100% do orçamento mensal`
    : status === 'warn'
    ? `${emoji} ${agent.name} passou de 80% do orçamento mensal`
    : `${emoji} Orçamento do ${agent.name} normalizado`;
  const body = `Gasto: $${spent.toFixed(2)} / $${budget.toFixed(2)} USD (${((spent/budget)*100).toFixed(1)}%)`;
  try {
    await query(
      `INSERT INTO notifications (agent_id, type, title, message, severity, created_at)
       VALUES ($1, 'budget', $2, $3, $4, now())`,
      [agent.id, title, body, status === 'blocked' ? 'critical' : status === 'warn' ? 'warning' : 'info']
    );
  } catch (err) {
    // Tabela notifications pode ter schema diferente; log silencioso
    console.error('[agent-budget] notification falhou:', err.message);
  }
  console.log(`[Budget] ${title} — ${body}`);
}

/** Retorna snapshot do status de todos os agentes (para dashboard). */
export async function listBudgetStatus() {
  const { rows } = await query(
    `SELECT agent_id, name, role, budget_usd, spent_usd, pct_used, budget_status, budget_blocked_at
       FROM agent_budget_status
      ORDER BY COALESCE(pct_used, 0) DESC, name`
  );
  return rows;
}
