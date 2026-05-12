// services/security.js — Middleware de segurança baseline pro Atrio Office.
//
// Inclui:
//   - Headers de segurança HTTP (HSTS, X-Frame, CSP basico, etc)
//   - Rate limiting in-memory por IP (sliding window)
//
// Sem dependências externas. Pra produção real (multi-instância),
// trocar rate limit pra Redis-backed.

// ============================================
// SECURITY HEADERS
// ============================================
export function securityHeaders(req, res, next) {
  // Embed permitido em telas do mesmo ecossistema (Gesthub embeda /atendimento).
  // CSP frame-ancestors substitui X-Frame-Options (suporta multiplas origens).
  // Ver: RUNBOOK.md > Integracao Gesthub-Atrio Office
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' http://31.97.175.200 https://gesthub.atrio.contadores.app.br http://gesthub-app"
  );
  // Previne MIME-sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Referrer só envia origin, sem path
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions: bloqueia features sensíveis por padrão
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Em produção (HTTPS), força HSTS — só ativa se request veio via HTTPS pra evitar quebrar HTTP local
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Remove header X-Powered-By que vaza Express
  res.removeHeader('X-Powered-By');
  next();
}

// ============================================
// RATE LIMIT — sliding window in-memory
// ============================================
// Pra produção multi-instância, trocar por Redis (key = ip:path:bucket).
// Default: 600 req/min por IP em endpoints públicos, 120/min em /api,
// 10/min em endpoints sensíveis (login futuro).
const _buckets = new Map(); // key = `${ip}:${rule}` → [timestamps]
const _CLEANUP_MS = 5 * 60 * 1000;

function _bucketKey(req, ruleName) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';
  return `${ip}:${ruleName}`;
}

function _allow(key, limit, windowMs) {
  const now = Date.now();
  const arr = _buckets.get(key) || [];
  // Remove timestamps fora da janela
  const filtered = arr.filter(t => now - t < windowMs);
  if (filtered.length >= limit) {
    _buckets.set(key, filtered);
    return { allowed: false, retryAfter: Math.ceil((windowMs - (now - filtered[0])) / 1000) };
  }
  filtered.push(now);
  _buckets.set(key, filtered);
  return { allowed: true, remaining: limit - filtered.length };
}

// Limpeza periódica pra evitar leak (>10k IPs/min seria suspeito)
setInterval(() => {
  const cutoff = Date.now() - _CLEANUP_MS;
  for (const [k, arr] of _buckets) {
    const keep = arr.filter(t => t > cutoff);
    if (keep.length === 0) _buckets.delete(k);
    else _buckets.set(k, keep);
  }
}, _CLEANUP_MS).unref?.();

/**
 * Factory de middleware de rate limit.
 * @param {object} opts { name, limit, windowMs, skip(req) }
 */
export function rateLimit({ name = 'default', limit = 600, windowMs = 60_000, skip } = {}) {
  return (req, res, next) => {
    if (skip && skip(req)) return next();
    const key = _bucketKey(req, name);
    const r = _allow(key, limit, windowMs);
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfter));
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: `Muitas requisições — aguarde ${r.retryAfter}s.`,
        retry_after_seconds: r.retryAfter,
      });
    }
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    next();
  };
}

// Pre-sets comuns
export const rateLimitGeneral = rateLimit({ name: 'general', limit: 600, windowMs: 60_000 });
export const rateLimitApi     = rateLimit({ name: 'api', limit: 240, windowMs: 60_000 });
export const rateLimitWrite   = rateLimit({ name: 'write', limit: 60, windowMs: 60_000 });
export const rateLimitSensitive = rateLimit({ name: 'sensitive', limit: 10, windowMs: 60_000 });

// Stats endpoint helper
export function rateLimitStats() {
  return {
    active_buckets: _buckets.size,
    sample: Array.from(_buckets.entries()).slice(0, 10).map(([k, v]) => ({ key: k, hits: v.length })),
  };
}
