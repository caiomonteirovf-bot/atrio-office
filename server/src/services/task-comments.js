// services/task-comments.js
// Canal único de coordenação na task. @mention dispara wake do agente.

import { query } from '../db/pool.js';
import { logEvent } from './activity-log.js';

const AGENT_NAMES = ['Rodrigo', 'Campelo', 'Sneijder', 'Luna', 'Saldanha', 'André', 'Andre', 'Auditor'];

/** Extrai nomes de agentes mencionados (@Nome). Normaliza "André" sem acento. */
export function extractMentions(content) {
  if (!content) return [];
  const matches = [...String(content).matchAll(/@(\w+)/g)].map(m => m[1]);
  const found = new Set();
  for (const token of matches) {
    const normalized = token.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (const name of AGENT_NAMES) {
      const nameNormalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (nameNormalized === normalized) {
        // devolve o nome canonico (com acento correto) do DB
        found.add(name === 'Andre' ? 'André' : name);
        break;
      }
    }
  }
  return [...found];
}

export async function addComment({ task_id, author_type, author_id, author_name, content, metadata }) {
  const mentions = extractMentions(content);
  const { rows } = await query(
    `INSERT INTO task_comments (task_id, author_type, author_id, author_name, content, mentions, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [task_id, author_type || 'user', author_id || null, author_name, content, mentions, JSON.stringify(metadata || {})]
  );
  const comment = rows[0];

  logEvent({
    actor_type: author_type, actor_id: author_id, actor_name: author_name,
    event_type: 'task.comment', action: 'create',
    entity_type: 'task_comment', entity_id: comment.id,
    payload: { task_id, mentions, content_preview: content.slice(0, 120) },
  });

  // Se há @mention de agente, dispara wake (cria task de reply se não existe)
  if (mentions.length > 0) {
    await triggerAgentWakes(task_id, comment, mentions);
  }

  return comment;
}

async function triggerAgentWakes(task_id, comment, mentions) {
  for (const agentName of mentions) {
    try {
      const { rows: agents } = await query(
        `SELECT * FROM agents WHERE name = $1 AND status = 'online' LIMIT 1`,
        [agentName]
      );
      if (!agents.length) continue;
      const agent = agents[0];

      // Marca flag no comment original
      await query(
        `UPDATE task_comments SET triggered_wake = true WHERE id = $1`,
        [comment.id]
      );

      logEvent({
        actor_type: 'system', actor_id: 'task-comments',
        event_type: 'agent.wake', action: 'trigger',
        entity_type: 'agent', entity_id: agent.id, actor_name: 'Wake-trigger',
        payload: { task_id, comment_id: comment.id, mentioned: agentName, trigger_content: comment.content.slice(0, 200) },
      });

      // Cria resposta do agente via orchestrator (async)
      import('./orchestrator.js').then(async m => {
        try {
          await m.replyToComment?.({ task_id, agent, trigger_comment: comment }).catch(() => {});
        } catch {}
      });
    } catch (e) {
      console.error('[task-comments] wake falhou:', e.message);
    }
  }
}

export async function listComments(task_id) {
  const { rows } = await query(
    `SELECT * FROM v_task_comments_enriched WHERE task_id = $1 ORDER BY created_at ASC`,
    [task_id]
  );
  return rows;
}
