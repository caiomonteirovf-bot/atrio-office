import { query } from '../db/pool.js';

/**
 * Creates a notification in the database (fire-and-forget).
 * @param {Object} opts
 * @param {string} opts.type - e.g. task_created, task_complete, escalation, whatsapp_message, erro_servico
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {'info'|'warning'|'error'|'success'} [opts.severity='info']
 * @param {string|null} [opts.agentId=null]
 * @param {string|null} [opts.taskId=null]
 * @param {Object} [opts.metadata={}]
 */
export async function createNotification({ type, title, message, severity = 'info', agentId = null, taskId = null, metadata = {} }) {
  try {
    await query(
      `INSERT INTO notifications (type, title, message, severity, agent_id, task_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [type, title, message, severity, agentId, taskId, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('[Notifications] Failed to create notification:', err.message);
  }
}
