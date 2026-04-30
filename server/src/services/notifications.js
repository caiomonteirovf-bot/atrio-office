import { query } from '../db/pool.js';
import * as pushSvc from './push.js';

/**
 * Cria notification no banco (fire-and-forget) e opcionalmente dispara push.
 *
 * @param {Object} opts
 * @param {string} opts.type - e.g. task_created, escalation, whatsapp_message, erro_servico
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {'info'|'warning'|'error'|'success'} [opts.severity='info']
 * @param {string|null} [opts.agentId]
 * @param {string|null} [opts.taskId]
 * @param {Object} [opts.metadata={}]
 * @param {Object|false} [opts.push=false] - Se objeto { userId?, url?, tag? }, dispara push.
 *   Sem userId, envia pra 'caio' (owner).
 */
export async function createNotification({
  type, title, message, severity = 'info',
  agentId = null, taskId = null, metadata = {},
  push = false,
}) {
  try {
    await query(
      `INSERT INTO notifications (type, title, message, severity, agent_id, task_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [type, title, message, severity, agentId, taskId, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('[Notifications] Failed to create notification:', err.message);
  }

  // Push opcional — só quando o chamador pede explicitamente
  if (push && pushSvc.isConfigured()) {
    try {
      const userId = push.userId || 'caio';
      await pushSvc.sendPushToUser(userId, {
        title,
        body: message?.slice(0, 140) || '',
        url: push.url || '/',
        tag: push.tag || type,
      });
    } catch (e) {
      console.warn('[Notifications] push falhou:', e.message);
    }
  }
}
