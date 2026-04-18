// services/alert-config.js
// Fonte dinamica da config de alertas Luna.
// Cache 60s. Fallback para defaults se DB falhar.

import { query } from '../db/pool.js';

const CACHE_TTL_MS = 60_000;
let _cache = { levels: null, meta: null, expiresAt: 0 };

// Defaults — usados se DB falhar (nunca deixa Luna muda)
const DEFAULT_LEVELS = [
  { level: 0, minutes: 10,   severity: 'normal',  emoji: '🟡', label: 'Sem resposta — 10min',
    client_message: null, send_to_team: true, team_even_off_hours: false, active: true },
  { level: 1, minutes: 30,   severity: 'atencao', emoji: '🟠', label: 'Atenção — 30min sem retorno',
    client_message: null, send_to_team: true, team_even_off_hours: false, active: true },
  { level: 2, minutes: 60,   severity: 'critico', emoji: '🔴', label: 'CRÍTICO — 1h sem retorno',
    client_message: null, send_to_team: true, team_even_off_hours: true,  active: true },
  { level: 3, minutes: 120,  severity: 'urgente', emoji: '🚨', label: 'URGENTE — 2h sem retorno',
    client_message: null, send_to_team: true, team_even_off_hours: true,  active: true },
  { level: 4, minutes: 360,  severity: 'grave',   emoji: '🚨', label: 'GRAVE — 6h sem retorno',
    client_message: null, send_to_team: true, team_even_off_hours: true,  active: true },
  { level: 5, minutes: 720,  severity: 'grave',   emoji: '🚨', label: 'GRAVE — 12h sem retorno',
    client_message: null, send_to_team: true, team_even_off_hours: true,  active: true },
  { level: 6, minutes: 1440, severity: 'grave',   emoji: '🚨', label: 'GRAVE — 24h sem retorno',
    client_message: null, send_to_team: true, team_even_off_hours: true,  active: true },
];

const DEFAULT_META = {
  auto_resolve_hours: '48',
  business_hours_start: '8',
  business_hours_end: '18',
  first_contact_alert_delayed: 'true',
  contact_phone: '(81) 9971-66091',
  notify_group_name: 'Luna_Atendimento',
};

async function _loadFromDb() {
  try {
    const [levRes, metaRes] = await Promise.all([
      query(`SELECT * FROM alert_config_levels WHERE active = true ORDER BY level`),
      query(`SELECT key, value FROM alert_config_meta`),
    ]);
    const levels = levRes.rows.length ? levRes.rows : DEFAULT_LEVELS;
    const meta = { ...DEFAULT_META };
    for (const m of metaRes.rows) meta[m.key] = m.value;
    return { levels, meta };
  } catch (err) {
    console.error('[alert-config] falha DB, usando defaults:', err.message);
    return { levels: DEFAULT_LEVELS, meta: DEFAULT_META };
  }
}

export async function getAlertConfig() {
  const now = Date.now();
  if (_cache.levels && now < _cache.expiresAt) return _cache;
  const data = await _loadFromDb();
  _cache = { ...data, expiresAt: now + CACHE_TTL_MS };
  return _cache;
}

export function invalidateAlertConfigCache() {
  _cache.expiresAt = 0;
}

/** Renderiza client_message substituindo {firstName}. */
export function renderClientMessage(template, name) {
  if (!template) return null;
  const firstName = (name || '').split(' ')[0] || 'Cliente';
  return template.replace(/\{firstName\}/g, firstName);
}

/** Update em lote dos niveis (admin UI). */
export async function updateLevels(levels = []) {
  for (const l of levels) {
    await query(
      `UPDATE alert_config_levels
          SET minutes = $1, severity = $2, emoji = $3, label = $4,
              client_message = $5, send_to_team = $6, team_even_off_hours = $7,
              active = $8, updated_at = NOW()
        WHERE level = $9`,
      [l.minutes, l.severity, l.emoji, l.label, l.client_message || null,
       !!l.send_to_team, !!l.team_even_off_hours, !!l.active, l.level]
    );
  }
  invalidateAlertConfigCache();
}

export async function updateMeta(kv = {}) {
  for (const [key, value] of Object.entries(kv)) {
    await query(
      `INSERT INTO alert_config_meta (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(value)]
    );
  }
  invalidateAlertConfigCache();
}

/**
 * Tenta auto-resolver conversas silenciosas:
 *  - Cliente sem msg ha > meta.auto_resolve_hours
 *  - Escalation ja no maximo nivel
 *  Marca resolved=true, notifica equipe.
 */
export async function findConversationsToAutoResolve() {
  const cfg = await getAlertConfig();
  const hours = parseInt(cfg.meta.auto_resolve_hours) || 48;
  const { rows } = await query(
    `SELECT phone, client_name, display_phone, escalation_level, last_message_at
       FROM whatsapp_conversations
      WHERE (resolved IS NULL OR resolved = false)
        AND last_message_at < NOW() - ($1 || ' hours')::interval
        AND COALESCE(escalation_level, 0) >= 6
      LIMIT 50`,
    [String(hours)]
  );
  return rows;
}

export async function markResolved(phone, reason = 'auto_resolve_timeout') {
  await query(
    `UPDATE whatsapp_conversations
        SET resolved = true, resolved_at = NOW(), resolution_reason = $2
      WHERE phone = $1`,
    [phone, reason]
  ).catch(async () => {
    // fallback se colunas resolved_at/resolution_reason nao existirem
    await query(`UPDATE whatsapp_conversations SET resolved = true WHERE phone = $1`, [phone]);
  });
}
