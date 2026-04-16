/**
 * Luna Observer - Passo 3 do RAG
 * Observa execucao de tools e extrai fatos para memoria de longo prazo.
 *
 * Fluxo:
 *   1. webhook entra -> runWithContext({ conversationId, clientId }, async () => chatWithAgent(...))
 *   2. executeToolCall em registry.js dispara observeToolCall apos a execucao
 *   3. observeToolCall extrai fatos via regras determinists e persiste em memories
 *   4. Embedding gerado em background
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { query } from '../db/pool.js';
import { embedMemory } from './embeddings.js';

const storage = new AsyncLocalStorage();

export function runWithContext(ctx, fn) {
  return storage.run(ctx, fn);
}

export function getContext() {
  return storage.getStore() || null;
}

// Cache do Luna agent_id
let _lunaAgentId = null;
async function getLunaAgentId() {
  if (_lunaAgentId) return _lunaAgentId;
  try {
    const { rows } = await query(`SELECT id FROM agents WHERE name ILIKE 'Luna' LIMIT 1`);
    _lunaAgentId = rows[0]?.id || null;
  } catch { /* ignore */ }
  return _lunaAgentId;
}

/**
 * Regras por tool: retorna { category, title, summary, content, tags, confidence } ou null.
 * Categories mapeadas para enum memory_category existente.
 */
const TOOL_RULES = {
  consultar_tomador: (args, result) => {
    if (!result || result.erro || !result.tomador) return null;
    const t = result.tomador;
    return {
      category: 'client_fact',
      confidence: 0.95,
      title: `Tomador: ${(t.razao_social || t.nome || 'sem nome').slice(0, 200)}`,
      summary: `CNPJ ${t.cnpj || t.cpf_cnpj || '-'} | ${t.municipio || '-'}`,
      content: JSON.stringify({ tool: 'consultar_tomador', args, tomador: t }).slice(0, 4000),
      tags: ['tomador', 'cadastro'],
    };
  },
  emitir_nfse: (args, result) => {
    if (!result || result.erro) return null;
    const numero = result.numero_nfse || result.numero || result.nfse?.numero;
    if (!numero) return null;
    return {
      category: 'tool_result',
      confidence: 1.0,
      title: `NFS-e ${numero} emitida`,
      summary: `Valor R$ ${args.valor || result.valor || '-'} | Tomador: ${args.tomador_razao || args.tomador_cnpj || '-'}`,
      content: JSON.stringify({ tool: 'emitir_nfse', args, result }).slice(0, 4000),
      tags: ['nfse', 'emissao'],
    };
  },
  classificar_demanda: (args, result) => {
    if (!result || result.erro || !result.categoria) return null;
    return {
      category: 'learned_pattern',
      confidence: 0.7,
      title: `Demanda classificada: ${String(result.categoria).slice(0, 200)}`,
      summary: (args.mensagem || '').slice(0, 400),
      content: JSON.stringify({ tool: 'classificar_demanda', args, result }).slice(0, 4000),
      tags: ['classificacao'],
    };
  },
  analisar_sentimento: (args, result) => {
    if (!result || result.erro) return null;
    const sent = Number(result.sentimento ?? result.score ?? 0);
    if (sent > -0.5) return null; // so registra sentimento negativo relevante
    return {
      category: 'client_fact',
      confidence: 0.85,
      title: `Frustracao detectada (sentimento ${sent.toFixed(2)})`,
      summary: (args.mensagem || '').slice(0, 400),
      content: JSON.stringify({ tool: 'analisar_sentimento', args, result }).slice(0, 4000),
      tags: ['alert', 'frustracao', 'sentimento'],
    };
  },
  rotear_demanda: (args, result) => {
    if (!result?.sucesso) return null;
    return {
      category: 'learned_pattern',
      confidence: 0.6,
      title: `Demanda roteada -> ${(result.agente || args.agente || '-').slice(0, 100)}`,
      summary: (args.resumo || args.mensagem || '').slice(0, 400),
      content: JSON.stringify({ tool: 'rotear_demanda', args, result }).slice(0, 4000),
      tags: ['roteamento'],
    };
  },
};

/**
 * Persiste memoria e agenda embedding. Dedup por title+scope nas ultimas 24h.
 */
async function persistMemory({ fact, toolName, ctx }) {
  const agentId = await getLunaAgentId();
  if (!agentId) return null;

  const scope_type = ctx.clientId ? 'client' : 'global';
  const scope_id = ctx.clientId || null;
  const source_ref = `tool:${toolName}|conv:${ctx.conversationId || '-'}`;

  // Dedup leve
  const dup = await query(
    `SELECT id FROM memories
     WHERE title = $1 AND scope_type = $2::memory_scope
       AND ($3::uuid IS NULL OR scope_id = $3::uuid)
       AND created_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [fact.title, scope_type, scope_id]
  );
  if (dup.rows[0]) return dup.rows[0].id;

  const ins = await query(
    `INSERT INTO memories
      (agent_id, scope_type, scope_id, category, title, summary, content,
       confidence_score, status, source_type, source_ref, tags, is_rag_enabled)
     VALUES ($1, $2::memory_scope, $3, $4::memory_category, $5, $6, $7, $8,
             'approved'::memory_status, 'tool_result'::memory_source, $9, $10, true)
     RETURNING id`,
    [
      agentId, scope_type, scope_id, fact.category,
      fact.title, fact.summary, fact.content,
      fact.confidence, source_ref, fact.tags || [],
    ]
  );
  const id = ins.rows[0]?.id;
  if (id) {
    embedMemory(id).catch(err =>
      console.error(`[luna-observer] embed fail ${id}:`, err.message)
    );
  }
  return id;
}

/**
 * Observa tool call. Fire-and-forget: nunca joga erro pro caller.
 */
export async function observeToolCall(toolName, args, result) {
  try {
    const rule = TOOL_RULES[toolName];
    if (!rule) return;

    const ctx = getContext();
    if (!ctx) return;

    const fact = rule(args, result);
    if (!fact) return;

    const memId = await persistMemory({ fact, toolName, ctx });
    if (memId) {
      console.log(`[luna-observer] fato extraido tool=${toolName} memory_id=${memId} category=${fact.category}`);
    }
  } catch (err) {
    console.error(`[luna-observer] erro tool=${toolName}:`, err.message);
  }
}
