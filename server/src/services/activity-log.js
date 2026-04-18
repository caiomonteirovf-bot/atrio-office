// services/activity-log.js
// Logging append-only com redacao automatica de secrets.
// Inspirado no padrao log-redaction + activity_log do paperclipai/paperclip.
//
// Uso:
//   import { logEvent } from './activity-log.js';
//   await logEvent({
//     actor_type: 'agent', actor_id: lunaId, actor_name: 'Luna',
//     event_type: 'memory.ingest', action: 'create',
//     entity_type: 'memory', entity_id: memId,
//     payload: { filename, pages, client_id },
//     source: 'whatsapp',
//   });
//
// Padrao fire-and-forget: nao bloqueia a operacao principal.

import crypto from 'crypto';
import { query } from '../db/pool.js';

// Chaves cujos valores sao redacted independente do conteudo
const SECRET_KEY_PATTERNS = [
  /password/i, /passwd/i, /secret/i, /token/i, /api[-_]?key/i,
  /authorization/i, /bearer/i, /cookie/i, /session/i, /csrf/i,
  /private[-_]?key/i, /certificate/i, /pfx/i, /senha/i, /chave/i,
];

// Padroes de valor que sempre devem ser redacted (mesmo sob chaves "normais")
const SECRET_VALUE_PATTERNS = [
  { regex: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, label: '[CPF_REDACTED]' },
  { regex: /\b\d{11}\b/g, label: '[CPF_OR_TEL_REDACTED]',
    // Cuidado: 11 digitos pode ser CPF ou celular. Redactar por seguranca.
    cond: (str) => /\d{11}/.test(str) && !/\d{12,}/.test(str) },
  { regex: /sk-[a-zA-Z0-9_-]{20,}/g, label: '[SK_REDACTED]' },   // OpenAI/DeepSeek style
  { regex: /sk-or-v\d-[a-f0-9]{40,}/g, label: '[OPENROUTER_REDACTED]' },
  { regex: /xai-[a-zA-Z0-9]{40,}/g, label: '[XAI_REDACTED]' },
  { regex: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, label: '[PRIVATE_KEY_REDACTED]' },
];

function isSecretKey(key) {
  return SECRET_KEY_PATTERNS.some(re => re.test(String(key)));
}

function redactValue(val) {
  if (typeof val !== 'string') return val;
  let out = val;
  for (const { regex, label, cond } of SECRET_VALUE_PATTERNS) {
    if (cond && !cond(out)) continue;
    out = out.replace(regex, label);
  }
  return out;
}

export function redact(input) {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactValue(input);
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (isSecretKey(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      out[k] = redactValue(v);
    } else if (v && typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function hashPayload(payload) {
  try {
    const str = JSON.stringify(payload, Object.keys(payload || {}).sort());
    return crypto.createHash('sha256').update(str).digest('hex');
  } catch { return null; }
}

/**
 * Persiste um evento. Fire-and-forget por padrao (nao aguarda DB).
 */
export function logEvent(ev) {
  try {
    const payload = ev.payload || {};
    const redacted = redact(payload);
    const hash = hashPayload(payload);

    query(
      `INSERT INTO activity_log
         (actor_type, actor_id, actor_name, event_type, action,
          entity_type, entity_id, payload, payload_hash, source,
          ip_address, user_agent, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::inet,$12,$13)`,
      [
        ev.actor_type || 'system',
        ev.actor_id || null,
        ev.actor_name || null,
        ev.event_type || 'unknown',
        ev.action || 'unknown',
        ev.entity_type || null,
        ev.entity_id || null,
        JSON.stringify(redacted),
        hash,
        ev.source || null,
        ev.ip_address || null,
        ev.user_agent || null,
        ev.severity || 'info',
      ]
    ).catch(err => console.error('[activity-log] falha ao gravar:', err.message));
  } catch (err) {
    console.error('[activity-log] erro inesperado:', err.message);
  }
}

/**
 * Versao sincrona para quando precisa garantir gravacao antes de responder
 * (ex: mudanca de estado critica que o cliente vai ler em seguida).
 */
export async function logEventSync(ev) {
  const payload = ev.payload || {};
  const redacted = redact(payload);
  const hash = hashPayload(payload);
  await query(
    `INSERT INTO activity_log
       (actor_type, actor_id, actor_name, event_type, action,
        entity_type, entity_id, payload, payload_hash, source,
        ip_address, user_agent, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::inet,$12,$13)`,
    [
      ev.actor_type || 'system', ev.actor_id || null, ev.actor_name || null,
      ev.event_type || 'unknown', ev.action || 'unknown',
      ev.entity_type || null, ev.entity_id || null,
      JSON.stringify(redacted), hash,
      ev.source || null, ev.ip_address || null, ev.user_agent || null,
      ev.severity || 'info',
    ]
  );
}

/** Helper: extrai contexto da request Express */
export function ctxFromRequest(req) {
  return {
    ip_address: req?.ip || req?.headers?.['x-forwarded-for'] || null,
    user_agent: req?.headers?.['user-agent'] || null,
    source: 'api',
  };
}

/** Lista eventos com filtros */
export async function listEvents(filters = {}) {
  const where = [];
  const params = [];
  let i = 0;
  if (filters.actor_type)  { where.push(`actor_type = $${++i}`);  params.push(filters.actor_type); }
  if (filters.actor_id)    { where.push(`actor_id = $${++i}`);    params.push(filters.actor_id); }
  if (filters.event_type)  { where.push(`event_type = $${++i}`);  params.push(filters.event_type); }
  if (filters.entity_type) { where.push(`entity_type = $${++i}`); params.push(filters.entity_type); }
  if (filters.entity_id)   { where.push(`entity_id = $${++i}`);   params.push(filters.entity_id); }
  if (filters.severity)    { where.push(`severity = $${++i}`);    params.push(filters.severity); }
  if (filters.since)       { where.push(`ts >= $${++i}::timestamptz`); params.push(filters.since); }
  if (filters.q)           { where.push(`(payload::text ILIKE '%'||$${++i}||'%' OR event_type ILIKE '%'||$${i}||'%')`); params.push(filters.q); }

  const limit = Math.min(parseInt(filters.limit) || 100, 500);
  const sql = `SELECT * FROM v_activity_recent ${where.length ? 'WHERE ' + where.join(' AND ') : ''} LIMIT ${limit}`;
  const { rows } = await query(sql, params);
  return rows;
}

/** Sumario de atividade por tipo de evento (ultimas 24h) */
export async function summary24h() {
  const { rows } = await query(
    `SELECT event_type, severity, COUNT(*) AS total,
            MAX(ts) AS last_seen,
            MIN(ts) AS first_seen
       FROM activity_log
      WHERE ts >= NOW() - INTERVAL '24 hours'
   GROUP BY event_type, severity
   ORDER BY total DESC, last_seen DESC`
  );
  return rows;
}
