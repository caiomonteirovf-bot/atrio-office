// server/src/services/embeddings.js
import { query } from '../db/pool.js';

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_URL = 'https://api.openai.com/v1/embeddings';

export async function embed(text) {
  if (!text || !text.trim()) return null;
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY nao configurada');
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

export function toVector(arr) {
  return '[' + arr.join(',') + ']';
}

export async function embedMemory(memoryId) {
  const { rows } = await query(`SELECT id, title, summary, content FROM memories WHERE id = $1`, [memoryId]);
  if (!rows.length) return { ok: false, error: 'memory not found' };
  const m = rows[0];
  const text = `${m.title}\n${m.summary || ''}\n${m.content}`.trim();
  const vec = await embed(text);
  if (!vec) return { ok: false, error: 'empty embedding' };
  await query(`UPDATE memories SET embedding = $1::vector WHERE id = $2`, [toVector(vec), memoryId]);
  return { ok: true };
}

export async function searchMemories(queryText, filter = {}) {
  const vec = await embed(queryText);
  if (!vec) return [];
  const vecLit = toVector(vec);

  const where = ['embedding IS NOT NULL', `status = 'approved'::memory_status`];
  const params = [];
  let idx = 0;

  if (filter.agent_id) { where.push(`agent_id = $${++idx}`); params.push(filter.agent_id); }
  if (filter.scope_type) { where.push(`scope_type = $${++idx}::memory_scope`); params.push(filter.scope_type); }
  if (filter.scope_id) { where.push(`scope_id = $${++idx}`); params.push(filter.scope_id); }
  if (filter.category) { where.push(`category = $${++idx}::memory_category`); params.push(filter.category); }

  // 3.5c — filtros adicionais para uso Atrio Office
  if (filter.client_id) {
    where.push(`scope_id = $${++idx}::uuid AND scope_type = 'client'::memory_scope`);
    params.push(filter.client_id);
  }
  if (filter.source_type) {
    where.push(`metadata->>'source_type' = $${++idx}`);
    params.push(filter.source_type);
  }
  if (filter.tool_origin) {
    where.push(`metadata->>'tool_origin' = $${++idx}`);
    params.push(filter.tool_origin);
  }
  if (filter.entity_type) {
    where.push(`metadata->>'entity_type' = $${++idx}`);
    params.push(filter.entity_type);
  }
  if (filter.metadata && typeof filter.metadata === 'object') {
    where.push(`metadata @> $${++idx}::jsonb`);
    params.push(JSON.stringify(filter.metadata));
  }

  const limit = Math.min(filter.limit || 5, 20);
  params.push(vecLit);
  const vecParam = ++idx;

  const sql = `
    SELECT id, title, summary, content, category, agent_id, scope_type, scope_id, metadata, structured_facts,
      confidence_score, use_count, (embedding <=> $${vecParam}::vector) AS distance
    FROM memories WHERE ${where.join(' AND ')}
    ORDER BY embedding <=> $${vecParam}::vector LIMIT ${limit}`;
  const { rows } = await query(sql, params);

  if (rows.length) {
    const ids = rows.map(r => r.id);
    await query(`UPDATE memories SET last_semantic_hit = NOW(), semantic_hits = semantic_hits + 1 WHERE id = ANY($1::uuid[])`, [ids]);
  }
  return rows.map(r => ({ ...r, similarity: 1 - parseFloat(r.distance) }));
}

export async function backfillEmbeddings({ limit = 50 } = {}) {
  const { rows } = await query(`SELECT id FROM memories WHERE embedding IS NULL ORDER BY created_at DESC LIMIT $1`, [limit]);
  let ok = 0, fail = 0;
  for (const r of rows) {
    try { await embedMemory(r.id); ok++; await new Promise(res => setTimeout(res, 50)); }
    catch (e) { console.error('[embeddings backfill] fail id=' + r.id + ':', e.message); fail++; }
  }
  return { processed: rows.length, ok, fail };
}
