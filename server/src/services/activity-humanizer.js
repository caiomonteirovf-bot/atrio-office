// services/activity-humanizer.js — Traduz eventos crus do activity_log em linguagem natural.
//
// Pattern: enriquece cada row com { event_label, entity_label, summary_text }.
// NÃO muda o DB — o audit trail permanece imutável com os campos crus pra compliance.
// O frontend exibe os campos humanizados; os crus ainda estão disponíveis pra debug.

const EVENT_LABELS = {
  'memory.ingest/create':  { label: 'Documento ingerido na memória', icon: '📥' },
  'memory.approve/approve':{ label: 'Memória aprovada',              icon: '✅' },
  'memory.reject/reject':  { label: 'Memória rejeitada',             icon: '🗑️' },
  'memory.update':         { label: 'Memória atualizada',            icon: '✏️' },
  'task.comment/create':   { label: 'Novo comentário em tarefa',     icon: '💬' },
  'task.create':           { label: 'Tarefa criada',                 icon: '➕' },
  'task.done':             { label: 'Tarefa concluída',              icon: '✔️' },
  'task.blocked':          { label: 'Tarefa bloqueada',              icon: '⛔' },
  'agent.wake/trigger':    { label: 'Agente acordado por @menção',   icon: '🔔' },
  'agent.chat':            { label: 'Conversa com agente',           icon: '🗣️' },
  'gesthub.sync':          { label: 'Sincronização Gesthub',         icon: '🔄' },
  'nfse.emit':             { label: 'NFS-e emitida',                 icon: '🧾' },
};

function eventLabel(row) {
  const key = `${row.event_type}/${row.action}`;
  const exact = EVENT_LABELS[key] || EVENT_LABELS[row.event_type];
  if (exact) return exact;
  // Fallback: "event_type.action" → "Event type action" com Title Case
  const base = (row.event_type || '').replace(/[._]/g, ' ');
  const acao = row.action ? ` (${row.action})` : '';
  return { label: capitalize(base) + acao, icon: '•' };
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(0)}KB`;
  return `${(bytes/1024/1024).toFixed(1)}MB`;
}

/**
 * Produz um resumo curto em PT a partir do payload JSON cru.
 * Se não conhecer o event_type, retorna uma string vazia (melhor que chaves).
 */
function summaryText(row) {
  const p = row.payload || {};
  const et = row.event_type;
  const act = row.action;

  // memory.ingest
  if (et === 'memory.ingest') {
    const pieces = [];
    if (p.mime) {
      const kind = p.mime.includes('pdf') ? 'PDF'
                 : p.mime.includes('sheet') ? 'Planilha'
                 : p.mime.includes('word') ? 'Documento Word'
                 : p.mime.includes('image') ? 'Imagem'
                 : p.mime.split('/')[1] || 'Arquivo';
      pieces.push(kind);
    }
    if (p.size) pieces.push(fmtSize(p.size));
    if (p.chunks) pieces.push(`${p.chunks} trecho${p.chunks > 1 ? 's' : ''}`);
    return pieces.join(' • ') || 'Upload concluído';
  }

  // memory.approve / memory.reject
  if (et === 'memory.approve') {
    const n = p.approved || (Array.isArray(p.ids) ? p.ids.length : 1);
    return `${n} memória${n > 1 ? 's' : ''} aprovada${n > 1 ? 's' : ''}`;
  }
  if (et === 'memory.reject') {
    const n = p.rejected || (Array.isArray(p.ids) ? p.ids.length : 1);
    const files = p.files_removed ? ` • ${p.files_removed} arquivo${p.files_removed > 1 ? 's' : ''} removido${p.files_removed > 1 ? 's' : ''}` : '';
    return `${n} memória${n > 1 ? 's' : ''} rejeitada${n > 1 ? 's' : ''}${files}`;
  }

  // task.comment
  if (et === 'task.comment') {
    const preview = p.content_preview || p.content || '';
    const mentions = Array.isArray(p.mentions) && p.mentions.length
      ? `para ${p.mentions.join(', ')}` : '';
    const short = preview.length > 60 ? preview.slice(0, 57) + '...' : preview;
    return short ? `"${short}" ${mentions}`.trim() : mentions || 'Comentário registrado';
  }

  // agent.wake
  if (et === 'agent.wake') {
    const trigger = (p.trigger_content || '').slice(0, 60);
    return trigger ? `Gatilho: "${trigger}${(p.trigger_content || '').length > 60 ? '...' : ''}"` : 'Acordado por @menção';
  }

  // fallback: não mostrar chaves cruas
  if (p.ok === true) return 'OK';
  if (p.error) return `Erro: ${String(p.error).slice(0, 80)}`;
  return '';
}

/**
 * Produz entidade legível — nome ao invés de UUID.
 * Ex.: "memory.ingest" com entity_id='uuid' → usa p.title ou "Memória" + últimos 6 chars
 */
function entityLabel(row) {
  const p = row.payload || {};
  if (!row.entity_type && !row.entity_id) return '';

  // Prefere título/nome no payload
  if (p.title) return String(p.title).slice(0, 40);
  if (p.name) return String(p.name).slice(0, 40);
  if (p.doc_type) return capitalize(p.doc_type);

  // Fallback: tipo + últimos 6 chars do UUID
  if (row.entity_id && row.entity_type) {
    const short = String(row.entity_id).replace(/-/g, '').slice(-6);
    const typeLabel = row.entity_type === 'memory' ? 'Memória'
                    : row.entity_type === 'task' ? 'Tarefa'
                    : row.entity_type === 'task_comment' ? 'Comentário'
                    : row.entity_type === 'agent' ? 'Agente'
                    : capitalize(row.entity_type);
    return `${typeLabel} #${short}`;
  }
  return '';
}

function actorLabel(row) {
  if (row.actor_name && row.actor_name.trim()) return row.actor_name;
  if (row.actor_type === 'user') return 'Usuário';
  if (row.actor_type === 'agent') return 'Agente';
  if (row.actor_type === 'system') return 'Sistema';
  return row.actor_type || '—';
}

/**
 * Enriquece uma linha de activity_log com campos humanizados.
 * Mantém todos os campos originais.
 */
export function humanize(row) {
  const { label, icon } = eventLabel(row);
  return {
    ...row,
    event_label: label,
    event_icon: icon,
    entity_label: entityLabel(row),
    summary_text: summaryText(row),
    actor_label: actorLabel(row),
  };
}

export function humanizeMany(rows) {
  return rows.map(humanize);
}
