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
// Helpers
const normCnpj = (v) => String(v || '').replace(/\D/g, '');
const toNumber = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const TOOL_RULES = {
  consultar_tomador: (args, result) => {
    if (!result || result.erro || !result.tomador) return null;
    const t = result.tomador;
    const cnpj = normCnpj(t.cnpj || t.cpf_cnpj);
    return {
      category: 'client_fact',
      confidence: 0.95,
      title: `Tomador: ${(t.razao_social || t.nome || 'sem nome').slice(0, 200)}`,
      summary: `CNPJ ${t.cnpj || t.cpf_cnpj || '-'} | ${t.municipio || '-'}`,
      content: JSON.stringify({ tool: 'consultar_tomador', args, tomador: t }).slice(0, 4000),
      tags: ['tomador', 'cadastro'],
      metadata: {
        source_type: 'cadastro',
        tool_origin: 'consultar_tomador',
        entity_type: 'tomador',
        cnpj_normalizado: cnpj || null,
      },
      structured_facts: {
        tomador: {
          razao_social: t.razao_social || t.nome || null,
          cnpj: cnpj || null,
          municipio: t.municipio || null,
          uf: t.uf || null,
          inscricao_municipal: t.inscricao_municipal || null,
          email: t.email || null,
        },
      },
    };
  },
  emitir_nfse: (args, result) => {
    if (!result || result.erro) return null;
    const numero = result.numero_nfse || result.numero || result.nfse?.numero;
    if (!numero) return null;
    const valor = toNumber(args.valor ?? result.valor ?? result.nfse?.valor);
    const cnpjTom = normCnpj(args.tomador_cnpj || args.cnpj_tomador);
    return {
      category: 'tool_result',
      confidence: 1.0,
      title: `NFS-e ${numero} emitida`,
      summary: `Valor R$ ${valor != null ? valor.toFixed(2) : '-'} | Tomador: ${args.tomador_razao || args.tomador_cnpj || '-'}`,
      content: JSON.stringify({ tool: 'emitir_nfse', args, result }).slice(0, 4000),
      tags: ['nfse', 'emissao'],
      metadata: {
        source_type: 'nfse',
        tool_origin: 'emitir_nfse',
        entity_type: 'nfse',
        numero: String(numero),
        cnpj_normalizado: cnpjTom || null,
      },
      structured_facts: {
        nfse: {
          numero: String(numero),
          valor: valor,
          descricao: args.descricao || null,
          tomador_cnpj: cnpjTom || null,
          tomador_razao: args.tomador_razao || null,
          emitida_em: result.emitida_em || new Date().toISOString(),
        },
      },
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
      tags: ['classificacao', String(result.categoria).toLowerCase()],
      metadata: {
        source_type: 'conversa',
        tool_origin: 'classificar_demanda',
        entity_type: 'classificacao',
        categoria: String(result.categoria),
        urgencia: result.urgencia || 'media',
      },
      structured_facts: {
        demanda: {
          categoria: String(result.categoria),
          urgencia: result.urgencia || null,
          mensagem_original: (args.mensagem || '').slice(0, 500),
        },
      },
    };
  },
  analisar_sentimento: (args, result) => {
    if (!result || result.erro) return null;
    const sent = Number(result.sentimento ?? result.score ?? 0);
    if (sent > -0.5) return null;
    return {
      category: 'client_fact',
      confidence: 0.85,
      title: `Frustracao detectada (sentimento ${sent.toFixed(2)})`,
      summary: (args.mensagem || '').slice(0, 400),
      content: JSON.stringify({ tool: 'analisar_sentimento', args, result }).slice(0, 4000),
      tags: ['alert', 'frustracao', 'sentimento'],
      metadata: {
        source_type: 'conversa',
        tool_origin: 'analisar_sentimento',
        entity_type: 'alerta_sentimento',
        severity: sent <= -0.8 ? 'alta' : 'media',
      },
      structured_facts: {
        sentimento: {
          score: sent,
          tags: result.tags || [],
          mensagem_trecho: (args.mensagem || '').slice(0, 300),
          detectado_em: new Date().toISOString(),
        },
      },
    };
  },
  rotear_demanda: (args, result) => {
    if (!result?.sucesso) return null;
    const agente = (result.agente || args.agente || '-').toLowerCase();
    return {
      category: 'learned_pattern',
      confidence: 0.6,
      title: `Demanda roteada -> ${agente.slice(0, 100)}`,
      summary: (args.resumo || args.mensagem || '').slice(0, 400),
      content: JSON.stringify({ tool: 'rotear_demanda', args, result }).slice(0, 4000),
      tags: ['roteamento', agente],
      metadata: {
        source_type: 'conversa',
        tool_origin: 'rotear_demanda',
        entity_type: 'roteamento',
        agente_destino: agente,
      },
      structured_facts: {
        roteamento: {
          agente_destino: agente,
          resumo: args.resumo || null,
          task_id: result.task_id || result.tarefa?.id || null,
        },
      },
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
       confidence_score, status, source_type, source_ref, tags, is_rag_enabled,
       metadata, structured_facts)
     VALUES ($1, $2::memory_scope, $3, $4::memory_category, $5, $6, $7, $8,
             'approved'::memory_status, 'tool_result'::memory_source, $9, $10, true,
             $11::jsonb, $12::jsonb)
     RETURNING id`,
    [
      agentId, scope_type, scope_id, fact.category,
      fact.title, fact.summary, fact.content,
      fact.confidence, source_ref, fact.tags || [],
      JSON.stringify(fact.metadata || {}),
      JSON.stringify(fact.structured_facts || {}),
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
