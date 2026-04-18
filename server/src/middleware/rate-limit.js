// middleware/rate-limit.js
// Rate limiter em memoria (sem dependencia externa).
// Algoritmo: sliding window contador por IP+bucket.
// Uso:
//   app.use('/api/ingest', rateLimit({ windowMs: 60_000, max: 20, bucket: 'ingest' }));

import { logEvent } from '../services/activity-log.js';

export function rateLimit({ windowMs = 60_000, max = 60, bucket = 'default', keyFn = null } = {}) {
  // Map<key, {count, windowStart}>
  const hits = new Map();
  const CLEANUP_EVERY = 5 * 60_000;
  setInterval(() => {
    const cutoff = Date.now() - windowMs * 2;
    for (const [k, v] of hits) if (v.windowStart < cutoff) hits.delete(k);
  }, CLEANUP_EVERY).unref?.();

  return (req, res, next) => {
    const baseKey = keyFn ? keyFn(req) : (req.ip || req.headers['x-forwarded-for'] || 'unknown');
    const key = `${bucket}:${baseKey}`;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', '0');
      res.set('X-RateLimit-Reset', String(Math.ceil((entry.windowStart + windowMs) / 1000)));

      // Log primeira vez que alguem passa do limite (evita spam)
      if (entry.count === max + 1) {
        logEvent({
          actor_type: 'system', actor_id: 'rate-limit',
          event_type: 'security.rate_limit', action: 'block',
          entity_type: 'endpoint', entity_id: bucket,
          payload: { ip: baseKey, limit: max, window_ms: windowMs, retry_after_sec: retryAfterSec, path: req.originalUrl },
          severity: 'warn',
        });
      }

      return res.status(429).json({
        error: 'rate limit excedido',
        retry_after_seconds: retryAfterSec,
        limit: max,
        window_seconds: Math.floor(windowMs / 1000),
      });
    }

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    next();
  };
}
