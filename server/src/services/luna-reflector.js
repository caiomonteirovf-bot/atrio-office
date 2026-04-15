// Luna conversation reflector:
// Le uma conversa encerrada/inativa, extrai regras/erros/preferencias/oportunidades
// e cria memorias com status='pending' para o Caio aprovar em Memoria > Sugestoes.
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

  // 5. Insere aprendizados como memorias pending
  const inserted = [];
  for (const a of (result.aprendizados || [])) {
    if (!a.titulo || !a.conteudo) continue;
    try {
      const { rows } = await query(
        `INSERT INTO luna_v2.memories
           (tipo, titulo, conteudo, area, agent_id, client_id, prioridade, confianca,
            status, is_rag_enabled, trigger_type, trigger_ref)
         VALUES ($1,$2,$3,$4,'luna',$5,$6,0.85,'pending',false,'reflection',$7)
         RETURNING id`,
        [
          String(a.tipo || 'preferencia').toLowerCase(),
          String(a.titulo).slice(0, 200),
          String(a.conteudo).slice(0, 2000),
          String(a.area || 'geral').toLowerCase(),
          conv.client_id, Number(a.prioridade) || 5, conversationId,
        ]);
      inserted.push(rows[0].id);
    } catch (e) {
      console.error('[luna-reflector] insert memory falhou:', e.message);
    }
  }

  // 6. Marca reflection_done na conversa
  try {
    await query(`UPDATE luna_v2.conversations SET reflection_at = NOW() WHERE id = $1`, [conversationId]);
  } catch (_) {}

  return {
    ok: true,
    conversation_id: conversationId,
    resumo: result.resumo,
    sentimento: result.sentimento_cliente,
    aprendizados_count: inserted.length,
    aprendizados_ids: inserted,
    melhorias_luna: result.melhorias_luna || [],
    acoes_pendentes: result.acoes_pendentes || [],
  };
}

// Scanner: roda periodicamente, reflete conversas inativas >30min com >=3 mensagens e sem reflection_at
export async function runReflectionScan({ maxBatch = 5 } = {}) {
  const { rows } = await query(`
    SELECT id FROM luna_v2.conversations
    WHERE reflection_at IS NULL
      AND last_message_at < NOW() - INTERVAL '30 minutes'
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
