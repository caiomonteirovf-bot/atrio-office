/**
 * Web Push notifications service.
 *
 * Uso:
 *   import { sendPushToUser, sendPushToAll, registerSubscription, removeSubscription } from './services/push.js'
 *   await sendPushToUser('caio', { title: 'Nova mensagem', body: 'Raphael disse...', url: '/atendimento/abc' })
 *
 * Depende de:
 *   - env VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *   - tabela push_subscriptions
 */
import webpush from 'web-push';
import { query } from '../db/pool.js';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@atrio.local';

let configured = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
} else {
  console.warn('[push] VAPID keys ausentes — push notifications desabilitadas');
}

export function isConfigured() {
  return configured;
}

export function getPublicKey() {
  return VAPID_PUBLIC || null;
}

export async function registerSubscription({ userId, endpoint, p256dh, auth, userAgent }) {
  if (!endpoint || !p256dh || !auth) throw new Error('subscription incompleta');
  const { rows } = await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_used_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent, last_used_at = NOW()
     RETURNING id`,
    [userId || 'anonymous', endpoint, p256dh, auth, userAgent || null]
  );
  return rows[0];
}

export async function removeSubscription(endpoint) {
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

/**
 * Envia push pra todas as subs de um usuario.
 * Payload: { title, body, url?, tag?, icon? }
 */
export async function sendPushToUser(userId, payload) {
  if (!configured) return { sent: 0, skipped: 'not_configured' };
  const { rows } = await query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  return _sendTo(rows, payload);
}

export async function sendPushToAll(payload) {
  if (!configured) return { sent: 0, skipped: 'not_configured' };
  const { rows } = await query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions');
  return _sendTo(rows, payload);
}

async function _sendTo(subs, payload) {
  let sent = 0, failed = 0, removed = 0;
  const body = JSON.stringify({
    title: payload.title || 'Átrio Office',
    body: payload.body || '',
    url: payload.url || '/',
    tag: payload.tag || null,
    icon: payload.icon || '/pwa-icon-192.png',
  });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 60 * 60 * 24 } // 24h
      );
      sent++;
    } catch (e) {
      failed++;
      // 404/410 = subscription morreu no browser, apaga
      if (e.statusCode === 404 || e.statusCode === 410) {
        await query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
        removed++;
      } else {
        console.warn('[push] send falhou:', e.statusCode, e.body || e.message);
      }
    }
  }
  return { sent, failed, removed };
}
