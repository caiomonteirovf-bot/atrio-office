// Luna conversation reflector (Passo 4):
// Le uma conversa encerrada/inativa, extrai regras/erros/preferencias/oportunidades via LLM
// e cria memory_suggestions (pending) para Caio aprovar em Memoria > Sugestoes.
// Aprovacao promove para public.memories com embedding automatico (RAG-ready).
import { query } from '../db/pool.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.LUNA_REFLECTOR_MODEL || 'x-ai/grok-4-fast';

const SYSTEM = `Voce e um revisor senior de atendimento contabil (escritorio Atrio).
Le o transcript de uma conversa WhatsApp entre Luna (analista virtual) e um cliente/contato e extrai APRENDIZADOS estruturados para alimentar a memoria da IA.

Retorne ESTRITAMENTE JSON valido:
{
  "resumo": "<1 frase sobre o que aconteceu na conversa>",
  "sentimento_cliente": "positivo|neutro|negativo|alarmante",
  "aprendizados": [
    {
      "tipo": "regra|preferencia|erro|servico|dado_cadastral",
      "area": "atendimento|fiscal|financeiro|contabil|societario|cadastral|geral",
      "titulo": "<titulo curto max 80 chars>",
      "conteudo": "<descricao 1-2 frases do que aprender>",
      "prioridade": <1-10>,
      "justificativa": "<por que salvar isso>"
    }
  ],
  "melhorias_luna": [ "<pontos onde Luna poderia ter sido melhor, 1 frase cada>" ],
  "acoes_pendentes": [ "<demandas nao resolvidas que precisam follow-up>" ]
}

REGRAS:
- So crie aprendizados quando houver sinal claro. Conversa curta sem padrao = lista vazia.
- tipo=erro/prioridade>=9 quando cliente reclamou ou usou palavras alarmantes (absurdo, processar, cancelar).
- tipo=preferencia quando cliente pediu tratamento especifico ("me chame de X", "prefiro humano").
- tipo=regra quando cliente definiu algo recorrente ("emita DAS dia 10").
- NAO duplique aprendizados obvios do cadastro (nome/empresa ja no Gesthub).`;

// Mapeamento tipo LLM -> memory_category enum
const CATEGORY_MAP = {
  regra: 'process_rule',
  preferencia: 'preference',
  erro: 'correction',
  servico: 'learned_pattern',
  dado_cadastral: 'client_fact',
};
// Area-specific override para regras fiscais
function mapCategory(tipo, area) {
  const t = String(tipo || '').toLowerCase();
  const a = String(area || '').toLowerCase();
  if (t === 'regra' && a === 'fiscal') return 'fiscal_rule';
  return CATEGORY_MAP[t] || 'general';
}

async function callLLM(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY ausente');
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://atrio-office.local',
      'X-Title': 'Atrio Luna Reflector',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1200,
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(content); }
  catch { return { resumo: 'parse fail', aprendizados: [], melhorias_luna: [], acoes_pendentes: [] }; }
}

let _lunaAgentId = null;
async function getLunaAgentId() {
  if (_lunaAgentId) return _lunaAgentId;
  const { rows } = await query(`SELECT id FROM agents WHERE name ILIKE 'Luna' LIMIT 1`).catch(() => ({ rows: [] }));
  _lunaAgentId = rows[0]?.id || null;
  return _lunaAgentId;
}

export async function reflectConversation(conversationId) {
  // 1. Carrega conversa + metadata
  const { rows: convRows } = await query(
    `SELECT c.id, c.phone, c.client_id, c.last_message_at, c.mensagens_count,
            cl.nome_legal, cl.nome_fantasia, cl.cnpj
       FROM luna_v2.conversations c
       LEFT JOIN luna_v2.clients cl ON cl.id = c.client_id
       WHERE c.id = $1`, [conversationId]);
  if (!convRows[0]) throw new Error('conversation not found');
  const conv = convRows[0];

  // 2. Carrega mensagens
  const { rows: msgs } = await query(
    `SELECT direction, content, created_at
       FROM luna_v2.messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`, [conversationId]);
  if (msgs.length < 2) return { ok: false, motivo: 'conversa curta demais' };

  // 3. Monta transcript
  const transcript = msgs.map(m => {
    const who = m.direction === 'inbound' ? 'Cliente' : 'Luna';
    return `${who}: ${String(m.content || '').slice(0, 500)}`;
  }).join('\n');

  const clientLabel = conv.nome_fantasia || conv.nome_legal || conv.phone;
  const prompt = `CONVERSA COM ${clientLabel} (${conv.cnpj || 'sem CNPJ'}) — ${msgs.length} mensagens\n\n${transcript}\n\nExtraia os aprendizados em JSON.`;

  // 4. Chama LLM
  const result = await callLLM(prompt);

  // 5. Insere aprendizados em memory_suggestions (pending)
  const agentId = await getLunaAgentId();
  const scope_type = conv.client_id ? 'client' : 'global';
  const scope_id = conv.client_id || null;
  const trigger_ref = `conv:${conversationId}`;

  const inserted = [];
  for (const a of (result.aprendizados || [])) {
    if (!a.titulo || !a.conteudo) continue;
    try {
      const category = mapCategory(a.tipo, a.area);
      const priority = Math.max(0, Math.min(10, Number(a.prioridade) || 5)) / 10;
      const evidence = {
        conversation_id: conversationId,
        resumo: result.resumo,
        sentimento: result.sentimento_cliente,
        tipo_origem: a.tipo,
        area_origem: a.area,
        justificativa: a.justificativa,
        melhorias_luna: result.melhorias_luna || [],
        acoes_pendentes: result.acoes_pendentes || [],
      };
      const { rows } = await query(
        `INSERT INTO memory_suggestions
           (agent_id, scope_type, scope_id, category, title, proposed_content,
            proposed_summary, reason, trigger_type, trigger_ref, evidence_json,
            confidence_score, priority_score, review_status, tags)
         VALUES ($1, $2::memory_scope, $3, $4::memory_category, $5, $6, $7, $8,
                 'conversation_insight'::trigger_type, $9, $10::jsonb,
                 0.85, $11, 'pending'::suggestion_status, $12)
         RETURNING id`,
        [
          agentId, scope_type, scope_id, category,
          String(a.titulo).slice(0, 255),
          String(a.conteudo).slice(0, 2000),
          String(a.conteudo).slice(0, 500),
          a.justificativa || `Extraido de conversa (${result.sentimento_cliente || 'neutro'})`,
          trigger_ref,
          JSON.stringify(evidence),
          priority,
          [a.tipo, a.area].filter(Boolean).map(x => String(x).toLowerCase()),
        ]
      );
      inserted.push(rows[0].id);
    } catch (e) {
      console.error('[luna-reflector] insert suggestion falhou:', e.message);
    }
  }

  // 6. Audit consolidado
  if (inserted.length && agentId) {
    await query(
      `INSERT INTO memory_audit_log
         (entity_type, entity_id, action, actor_type, actor_id, reason, source_ref, after_json)
       VALUES ('conversation', $1, 'consolidated', 'agent', $2, $3, $4, $5::jsonb)`,
      [
        conversationId, agentId,
        `Reflexao extraiu ${inserted.length} aprendizado(s)`,
        trigger_ref,
        JSON.stringify({
          conversation_id: conversationId,
          resumo: result.resumo,
          sentimento: result.sentimento_cliente,
          suggestions_count: inserted.length,
          suggestion_ids: inserted,
          client_name: clientLabel,
        }),
      ]
    ).catch(err => console.error('[luna-reflector] audit fail:', err.message));
  }

  // 7. Marca reflection_at
  await query(`UPDATE luna_v2.conversations SET reflection_at = NOW() WHERE id = $1`, [conversationId]).catch(() => {});

  return {
    ok: true,
    conversation_id: conversationId,
    resumo: result.resumo,
    sentimento: result.sentimento_cliente,
    suggestions_count: inserted.length,
    suggestion_ids: inserted,
    melhorias_luna: result.melhorias_luna || [],
    acoes_pendentes: result.acoes_pendentes || [],
  };
}

// Scanner: roda periodicamente, reflete conversas inativas >30min com >=3 mensagens e sem reflection_at
export async function runReflectionScan({ maxBatch = 5 } = {}) {
  const { rows } = await query(`
    SELECT id FROM luna_v2.conversations
    WHERE reflection_at IS NULL
      AND last_message_at < NOW() - INTERVAL '10 minutes'
      AND COALESCE(mensagens_count, 0) >= 3
    ORDER BY last_message_at DESC
    LIMIT $1
  `, [maxBatch]);
  const results = [];
  for (const r of rows) {
    try {
      const out = await reflectConversation(r.id);
      results.push(out);
    } catch (e) {
      console.error('[luna-reflector] conv', r.id, ':', e.message);
      results.push({ ok: false, conversation_id: r.id, erro: e.message });
    }
  }
  return { scanned: rows.length, results };
}

export default { reflectConversation, runReflectionScan };
