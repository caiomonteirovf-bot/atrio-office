/**
 * Átrio Office — Atendimento API wrappers.
 *
 * Modulo isolado. NAO depende de components/hooks externos (salvo fetch nativo)
 * pra facilitar extracao futura em app standalone (ex: atendimento.atrio.local).
 */

export async function fetchConversations({ history = true } = {}) {
  const qs = new URLSearchParams(history ? { history: 'true' } : {});
  const r = await fetch(`/api/whatsapp/conversations?${qs}`);
  if (!r.ok) throw new Error(`Falha ao listar conversas (${r.status})`);
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchMessages(conversationId) {
  const r = await fetch(`/api/whatsapp/conversations/${conversationId}/messages`);
  if (!r.ok) throw new Error(`Falha ao buscar mensagens (${r.status})`);
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

export async function sendWhatsApp(phone, message) {
  const r = await fetch('/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) {
    throw new Error(data.error || `Falha ao enviar (${r.status})`);
  }
  return data;
}

export async function markResolved(phone) {
  const encoded = encodeURIComponent(String(phone).replace(/\D/g, ''));
  const r = await fetch(`/api/whatsapp/conversations/${encoded}/resolve`, { method: 'POST' });
  if (!r.ok) throw new Error(`Falha ao resolver (${r.status})`);
  return r.json().catch(() => ({}));
}

export async function markReplied(phone) {
  const encoded = encodeURIComponent(String(phone).replace(/\D/g, ''));
  const r = await fetch(`/api/whatsapp/mark-replied/${encoded}`, { method: 'POST' });
  if (!r.ok) throw new Error(`Falha ao marcar respondido (${r.status})`);
  return r.json().catch(() => ({}));
}

/**
 * Analisa uma mensagem enviada procurando compromissos com data.
 * Retorna { commitments: [{date_iso, title, phrase}] }.
 */
export async function detectCommitment(text, conversationId) {
  try {
    const r = await fetch('/api/atendimento/detect-commitment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, conversation_id: conversationId }),
    })
    if (!r.ok) return { commitments: [] }
    return await r.json()
  } catch { return { commitments: [] } }
}

/**
 * Cria evento no calendario.
 */
export async function createCalendarEvent({ title, description, startTime, endTime, category, clientId, metadata }) {
  const r = await fetch('/api/calendar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title, description,
      type: 'compromisso',
      category: category || 'atendimento',
      start_time: startTime,
      end_time: endTime || startTime,
      client_id: clientId || null,
      metadata: metadata || {},
    }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.error || `Falha (${r.status})`)
  return data
}

/**
 * Pergunta ao Copilot IA sobre a conversa atual.
 * Retorna { answer, model, latency_ms, context_used }.
 */
export async function askCopilot(conversationId, question) {
  const r = await fetch('/api/atendimento/copilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, question }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data?.error || `Copilot falhou (${r.status})`);
  return data;
}

/**
 * Busca contexto do cliente vinculado a uma conversa (dados Gesthub + badges datalake).
 * Retorna { linked: bool, client?, badges?, legalizacoes?, onboardings?, conversation }.
 */
export async function fetchClientContext(conversationId) {
  const r = await fetch(`/api/atendimento/conversation/${conversationId}/client-context`);
  if (!r.ok) throw new Error(`Falha ao buscar contexto (${r.status})`);
  return r.json();
}

/**
 * Retorna todos clientes Gesthub cujo telefone bate com o da conversa.
 * Util pra detectar quando um numero pertence a multiplas empresas.
 */
export async function fetchPhoneCandidates(conversationId) {
  const r = await fetch(`/api/atendimento/conversation/${conversationId}/candidates`)
  if (!r.ok) return { data: [], current_id: null }
  return r.json()
}

export async function searchGesthubClients(q) {
  if (!q || q.trim().length < 2) return [];
  const r = await fetch(`/api/atendimento/clientes/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j?.data) ? j.data : [];
}

export async function linkConversationToClient(conversationId, clientId) {
  const r = await fetch(`/api/atendimento/conversation/${conversationId}/link-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Falha ao vincular (${r.status})`);
  return data;
}

/**
 * Salva a conversa como um contato NAO-cliente (parceiro, fornecedor, prospect, pessoal, spam).
 * Remove qualquer vinculo com cliente Gesthub.
 */
export async function saveAsContact(conversationId, type, label, details) {
  const r = await fetch(`/api/atendimento/conversation/${conversationId}/save-as-contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, label, details }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data?.error || `Falha (${r.status})`);
  return data;
}

export async function unlinkConversationFromClient(conversationId) {
  const r = await fetch(`/api/atendimento/conversation/${conversationId}/unlink-client`, { method: 'POST' });
  if (!r.ok) throw new Error(`Falha ao desvincular (${r.status})`);
  return r.json().catch(() => ({}));
}

/**
 * Envia um anexo (PDF/imagem/audio) via WhatsApp. Recebe file (File ou Blob), converte
 * pra base64 e faz POST /api/whatsapp/send-media.
 */
export async function sendAttachment(phone, file, caption = '') {
  // Converte File -> base64 (sem o prefixo data:...)
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result || ''
      const comma = String(result).indexOf(',')
      resolve(comma >= 0 ? String(result).slice(comma + 1) : String(result))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

  const r = await fetch('/api/whatsapp/send-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      file_base64: base64,
      file_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      caption,
    }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || data.ok === false) throw new Error(data?.error || `Falha ao enviar anexo (${r.status})`)
  return data
}

/**
 * Apaga uma mensagem (para todos via WhatsApp se ainda estiver na janela; sempre local).
 * @param {string} messageId - UUID da whatsapp_messages
 * @returns {Promise<{ok:boolean, whatsapp_deleted:boolean, warning?:string}>}
 */
export async function deleteMessage(messageId) {
  const r = await fetch(`/api/whatsapp/messages/${messageId}/delete`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Falha ao apagar (${r.status})`);
  return data;
}

/**
 * Ensina Luna — cria uma memory RAG-enabled com a regra aprendida do caso.
 * @param {object} opts
 *  - title: resumo curto (ex: "Cliente MEDGEINES: emissao NFS-e direta")
 *  - content: regra detalhada (ex: "Quando MEDGEINES pedir NFS-e, emitir direto sem confirmar valor.")
 *  - tags: array, ex: ['cliente:medgeines', 'assunto:nfse']
 *  - category: general | client_fact | process_rule | correction | preference | fiscal
 *  - scope_context: objeto opcional com cliente_id, phone, conversation_id pra metadata
 */
export async function ensinarLuna({ title, content, tags = [], category = 'process_rule', scope_context = {} }) {
  // Busca o agent_id da Luna primeiro (nao e obrigatorio — null vira team-scope)
  let lunaAgentId = null;
  try {
    const r = await fetch('/api/agents');
    const list = await r.json().catch(() => []);
    const arr = Array.isArray(list) ? list : (list?.agents || []);
    const luna = arr.find(a => (a.name || '').toLowerCase() === 'luna');
    lunaAgentId = luna?.id || null;
  } catch { /* segue sem agent_id */ }

  const summary = String(content || '').slice(0, 300);
  const body = {
    agent_id: lunaAgentId,
    category,
    title,
    content,
    summary,
    tags,
  };
  const r = await fetch('/api/memory/teach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Falha ao ensinar Luna (${r.status})`);
  return data;
}

/** Formata telefone BR pra exibicao (5581... -> (81) 9...) */
export function formatPhone(num) {
  const d = String(num || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) return `(${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55')) return `(${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return num || '';
}

/** Retorna data relativa humanizada: "agora", "12min", "3h", "ontem", "12/04" */
export function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'agora';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}min`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 172800) return 'ontem';
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Classifica sender pra estilo de bubble */
export function classifySender(msg) {
  // Aceita formatos: {sender: 'client'|'team'|'bot'|'luna'} ou {direction: 'inbound'|'outbound'}
  const s = String(msg?.sender || msg?.direction || '').toLowerCase();
  if (s === 'client' || s === 'inbound') return 'client';
  if (s === 'luna' || s === 'bot') return 'bot';
  return 'team'; // team/outbound/default
}
