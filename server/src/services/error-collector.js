// services/error-collector.js
// Captura de erros inspirada no modelo Sentry — mas local, sem deps externas.
// Integra com activity-log (usa redaction) e persiste em error_log.
//
// API:
//   captureException(err, ctx = {})
//   expressErrorHandler — middleware final do Express
//   installGlobalHandlers() — chama uma vez no boot

import crypto from 'crypto';
import { query } from '../db/pool.js';
import { redact } from './activity-log.js';

function fingerprint(err) {
  // Agrupa por (kind + nome_arquivo + funcao_linha). Mensagem varia (params), stack top eh estavel.
  const stackLine = String(err?.stack || err?.message || '').split('\n')[1] || err?.message || '';
  const sig = `${err?.name || 'Error'}::${stackLine.trim().slice(0, 200)}`;
  return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 32);
}

export async function captureException(err, ctx = {}) {
  try {
    const level = ctx.level || 'error';
    const kind = ctx.kind || (err?.name || 'Error');
    const message = String(err?.message || err || 'unknown error').slice(0, 2000);
    const stack = String(err?.stack || '').slice(0, 8000);
    const fp = fingerprint(err);

    const context = {
      ...(ctx.context || {}),
      error_name: err?.name,
      error_code: err?.code,
    };
    // Nunca persistir body inteiro — so snippet redacted
    if (ctx.body_snippet) context.body_snippet = redact(String(ctx.body_snippet).slice(0, 500));

    await query(
      `INSERT INTO error_log
         (level, kind, message, stack, fingerprint,
          url, method, status_code, request_id,
          actor_type, actor_id, context, user_agent, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::inet)`,
      [
        level, kind, message, stack, fp,
        ctx.url || null, ctx.method || null, ctx.status_code || null, ctx.request_id || null,
        ctx.actor_type || null, ctx.actor_id || null,
        JSON.stringify(redact(context)),
        ctx.user_agent || null, ctx.ip_address || null,
      ]
    );
  } catch (dbErr) {
    // NUNCA deixar o collector crashar o processo — so imprime em stderr como ultima linha de defesa
    console.error('[error-collector] falha ao gravar:', dbErr.message, '\nerro original:', err);
  }
}

/** Middleware Express terminal — chamar DEPOIS de todas as rotas. */
export function expressErrorHandler() {
  return (err, req, res, _next) => {
    const status = err?.status || err?.statusCode || 500;
    captureException(err, {
      kind: 'express',
      level: status >= 500 ? 'critical' : 'error',
      url: req.originalUrl,
      method: req.method,
      status_code: status,
      request_id: req.get?.('x-request-id') || null,
      user_agent: req.get?.('user-agent'),
      ip_address: req.ip || req.headers?.['x-forwarded-for'] || null,
      context: {
        query: req.query,
        params: req.params,
      },
      body_snippet: typeof req.body === 'object' ? JSON.stringify(req.body).slice(0, 500) : String(req.body || '').slice(0, 500),
    });
    if (res.headersSent) return;
    res.status(status).json({
      error: err?.message || 'erro interno',
      ref: req.get?.('x-request-id') || null,
    });
  };
}

/** Handlers globais de processo — chamar uma vez no boot. */
export function installGlobalHandlers() {
  process.on('uncaughtException', (err) => {
    captureException(err, { kind: 'uncaughtException', level: 'critical' });
    console.error('[uncaughtException]', err);
    // Nao sai do processo — deixa PM2/Docker restartar se for fatal
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    captureException(err, { kind: 'unhandledRejection', level: 'error' });
    console.error('[unhandledRejection]', err);
  });
}

/** Lista grupos de erro (para o painel). */
export async function listErrorGroups({ resolved = false, limit = 50 } = {}) {
  const where = resolved === null ? '' : `WHERE all_resolved = ${resolved ? 'true' : 'false'}`;
  const { rows } = await query(
    `SELECT * FROM v_error_groups ${where}
     ORDER BY last_seen DESC LIMIT ${Math.min(parseInt(limit) || 50, 200)}`
  );
  return rows;
}

export async function listErrorsByFingerprint(fp, limit = 50) {
  const { rows } = await query(
    `SELECT * FROM error_log WHERE fingerprint = $1 ORDER BY ts DESC LIMIT $2`,
    [fp, limit]
  );
  return rows;
}

export async function markResolved(fingerprint_hash, note = null) {
  const { rowCount } = await query(
    `UPDATE error_log SET resolved = true, resolved_at = NOW(), resolved_note = $2
      WHERE fingerprint = $1 AND resolved = false`,
    [fingerprint_hash, note]
  );
  return rowCount;
}
