// services/tenant-context.js — contexto de tenant para requests HTTP e jobs.
//
// Paradigma: single-database multi-tenant.
// Cada request carrega um `tenant_id`, todas as queries app-layer devem filtrar por ele.
//
// Fontes (ordem de precedência):
//   1) Header `X-Atrio-Tenant` (trust somente em ambiente interno/gateway)
//   2) JWT claim `tenant_id` (quando autenticação JWT estiver ativa)
//   3) Env DEFAULT_TENANT_ID (dev/single-tenant)
//   4) Fallback 'atrio'
//
// Uso:
//   import { tenantMiddleware, currentTenant } from './services/tenant-context.js';
//   app.use(tenantMiddleware);
//   ...
//   const tid = currentTenant(req);
//   await query(`SELECT ... WHERE tenant_id = $1`, [tid, ...]);

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const DEFAULT = process.env.DEFAULT_TENANT_ID || 'atrio';

/**
 * Express middleware — resolve tenant e injeta em req + AsyncLocalStorage.
 * Rode ANTES das rotas.
 */
export function tenantMiddleware(req, res, next) {
  const headerTenant = req.get('X-Atrio-Tenant');
  const jwtTenant = req.user?.tenant_id;  // preenchido por jwt middleware upstream

  const tenant_id = headerTenant || jwtTenant || DEFAULT;

  req.tenant_id = tenant_id;
  res.set('X-Atrio-Tenant', tenant_id);

  storage.run({ tenant_id }, () => next());
}

/**
 * Helper — retorna tenant do request corrente, com fallback sensato.
 * Preferir `req.tenant_id` direto em handlers que têm req.
 * Usar isso em services que não têm acesso a req (jobs, orchestrator interno).
 */
export function currentTenant(req) {
  if (req?.tenant_id) return req.tenant_id;
  const ctx = storage.getStore();
  return ctx?.tenant_id || DEFAULT;
}

/**
 * Para jobs/workers que criam o próprio escopo.
 * Ex.: cron job `dispatchTasks({ tenant_id: 'atrio' })` →
 *      `withTenant('atrio', async () => { ... })`
 */
export function withTenant(tenant_id, fn) {
  return storage.run({ tenant_id }, fn);
}

/**
 * Validação simples — retorna true se tenant existe e está ativo.
 * Chamar no startup do middleware opcionalmente pra rejeitar tenants inválidos.
 */
export async function isValidTenant(tenant_id, queryFn) {
  try {
    const { rows } = await queryFn(
      `SELECT 1 FROM tenants WHERE tenant_id = $1 AND status = 'active'`,
      [tenant_id]
    );
    return rows.length > 0;
  } catch { return false; }
}
