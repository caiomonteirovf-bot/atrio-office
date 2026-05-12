// services/team-chat.js — Helpers pra separar canal técnico do canal humano.
//
// REGRA (frente 2 da revisão maio/2026):
//   - Erros técnicos (DB, network, FK, stack traces) NUNCA aparecem crus em
//     "Comunicação da Equipe". Vão pra error_log + notifications (canal técnico).
//   - O canal humano recebe APENAS uma frase humanizada via humanizeError(),
//     suficiente pra equipe saber que algo travou sem precisar ler stack.
//
// Uso típico em whatsapp.js / agentes:
//   try { ... } catch (e) {
//     await postTechnicalError(e, { source: 'whatsapp_ingest', who, filename });
//     chat({ from: 'Luna', text: humanFollowup(e, who, filename), tag: 'ingest' });
//   }

import { captureException } from './error-collector.js';
import { createNotification } from './notifications.js';
import { humanizeError, humanizeErrorShort } from './error-humanizer.js';

/**
 * Registra erro técnico no canal técnico (error_log + notifications).
 * NÃO posta no canal humano — caller decide se quer adicionar follow-up humanizado.
 *
 * @param {Error|string} err
 * @param {Object}  ctx
 * @param {string}  ctx.source       - identificador da origem (ex: 'whatsapp_ingest', 'luna_reply')
 * @param {string}  [ctx.title]      - título da notification (default: derivado do source)
 * @param {string}  [ctx.actor_id]   - UUID do agente/usuario envolvido
 * @param {string}  [ctx.actor_type] - 'agent' | 'user'
 * @param {Object}  [ctx.metadata]   - dados adicionais (filename, phone, client_id, etc)
 * @returns {Promise<{notification_created:boolean}>}
 */
export async function postTechnicalError(err, ctx = {}) {
  const source = ctx.source || 'unknown';
  const human = humanizeErrorShort(err);

  // 1) error_log (stack completo, fingerprint, tudo) — para painel /errors
  try {
    await captureException(err, {
      kind: source,
      level: ctx.level || 'error',
      actor_type: ctx.actor_type || 'agent',
      actor_id: ctx.actor_id || null,
      context: {
        source,
        humanized: human,
        ...(ctx.metadata || {}),
      },
    });
  } catch { /* nunca propagar erro do collector */ }

  // 2) notifications (mensagem humanizada, severity=error) — para painel /alerts
  let notif_ok = false;
  try {
    await createNotification({
      type: ctx.notification_type || 'technical_error',
      severity: 'error',
      title: ctx.title || `Erro técnico — ${source}`,
      message: human,
      agentId: ctx.actor_type === 'agent' ? ctx.actor_id : null,
      taskId: ctx.task_id || null,
      metadata: {
        source,
        raw_error: String(err?.message || err || '').slice(0, 500),
        ...(ctx.metadata || {}),
      },
    });
    notif_ok = true;
  } catch (notifErr) {
    console.error('[team-chat] falha ao criar notification:', notifErr.message);
  }

  return { notification_created: notif_ok };
}

/**
 * Helper pra montar texto humanizado curto pro canal humano após erro técnico.
 * Não posta — caller usa o retorno em chat({text: ...}).
 *
 * @param {Error|string} err
 * @param {string} [prefix] - ex: '📎 Caio enviou NU_xxx.pdf'
 * @returns {string}
 */
export function humanFollowup(err, prefix = '') {
  const human = humanizeErrorShort(err);
  const head = prefix ? `${prefix}\n` : '';
  return `${head}⚠️ ${human}\n→ Equipe técnica notificada`;
}

export { humanizeError, humanizeErrorShort };
