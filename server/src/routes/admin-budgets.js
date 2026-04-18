// Endpoints de monitoramento de orcamento por agente
// GET  /api/admin/budgets            — lista status
// POST /api/admin/budgets/:agentId   — { budget_monthly_usd: number }
// POST /api/admin/budgets/:agentId/reset-status  — libera se bloqueado manualmente

import { query } from '../db/pool.js';
import { listBudgetStatus, invalidateBudgetCache } from '../services/agent-budget.js';
import { logEvent } from '../services/activity-log.js';

export function registerAdminBudgets(app) {
  app.get('/api/admin/budgets', async (_req, res) => {
    try {
      const rows = await listBudgetStatus();
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/budgets/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;
      const { budget_monthly_usd } = req.body || {};
      if (typeof budget_monthly_usd !== 'number' || budget_monthly_usd < 0) {
        return res.status(400).json({ error: 'budget_monthly_usd deve ser numero >= 0' });
      }
      await query(`UPDATE agents SET budget_monthly_usd = $1 WHERE id = $2`, [budget_monthly_usd, agentId]);
      invalidateBudgetCache(agentId);
      logEvent({
        actor_type: 'user', actor_id: req.ip || 'anon',
        event_type: 'budget.update', action: 'update',
        entity_type: 'agent', entity_id: agentId,
        payload: { new_budget_usd: budget_monthly_usd },
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/budgets/:agentId/reset-status', async (req, res) => {
    try {
      const { agentId } = req.params;
      await query(
        `UPDATE agents SET budget_status = 'ok', budget_blocked_at = NULL WHERE id = $1`,
        [agentId]
      );
      invalidateBudgetCache(agentId);
      logEvent({
        actor_type: 'user', actor_id: req.ip || 'anon',
        event_type: 'budget.reset', action: 'reset',
        entity_type: 'agent', entity_id: agentId,
        payload: { reason: 'manual_reset' },
        severity: 'warn',
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
