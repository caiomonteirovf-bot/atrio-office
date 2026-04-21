// services/impact-metrics.js
// Agrega os 4 KPIs de impacto do escritório.
// Cada métrica roda em sua própria query — falha em uma não derruba as outras.

import { query } from '../db/pool.js';

const NFSE_SYSTEM_URL = process.env.NFSE_SYSTEM_URL || 'http://nfse-system:3020';
const GESTHUB_URL = process.env.GESTHUB_API_URL || 'http://gesthub-app:8000';

// Tempo manual estimado (minutos) por tipo de tarefa — heurística ajustável
const MANUAL_TIME_BY_TOOL = {
  emitir_nfse: 10,              // emitir NFS-e manual no portal
  conciliar_extrato: 45,        // abrir extrato, categorizar linha por linha
  consultar_tomador: 3,         // buscar no Gesthub
  consultar_cliente: 3,
  consultar_cnpj: 2,
  calcular_fator_r: 5,
  calcular_impostos: 15,
  whatsapp_enviar: 5,           // redigir e enviar msg cliente
  coletar_documento: 8,         // pedir + validar doc
  auditoria_rodar: 120,         // cruzar 6 sistemas manualmente
  auditoria_dashboard: 10,
  conciliar: 45,
  onboarding_cliente: 30,
  escritorio_relatorio_dre: 25,
  escritorio_conciliar_extrato: 45,
  finance_dre_cliente: 20,
  escritorio_fluxo_caixa: 20,
  checklist_abertura: 15,
  gerar_contrato: 30,
};

const DEFAULT_MANUAL_MINUTES = 5;  // task simples sem tool conhecida

/**
 * Soma os minutos manuais economizados por tasks done no período.
 */
async function horasEconomizadas(startDate) {
  const { rows } = await query(
    `SELECT result FROM tasks
      WHERE status = 'done'
        AND completed_at >= $1
        AND result IS NOT NULL`,
    [startDate]
  );
  let totalMin = 0;
  let tasksContadas = 0;
  for (const r of rows) {
    const raw = r.result;
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { continue; }
    }
    const toolCalls = parsed?.tool_calls || [];
    if (!toolCalls.length) {
      totalMin += DEFAULT_MANUAL_MINUTES;
      tasksContadas++;
      continue;
    }
    for (const tc of toolCalls) {
      if (tc.ok === false) continue;          // tool falhou — não conta
      const min = MANUAL_TIME_BY_TOOL[tc.name] ?? DEFAULT_MANUAL_MINUTES;
      totalMin += min;
    }
    tasksContadas++;
  }
  return {
    minutos: totalMin,
    horas: Math.round(totalMin / 60 * 10) / 10,
    tasks: tasksContadas,
  };
}

/**
 * Consulta o NFS-e System e conta NFS-e emitidas no período.
 */
async function nfseEmitidas(startDate) {
  try {
    const url = `${NFSE_SYSTEM_URL}/api/nfses?limit=500&desde=${encodeURIComponent(startDate.toISOString())}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { total: null, emitidas: null, erros: null, pendentes: null };
    const body = await res.json();
    const lista = body.data || [];
    const emitidas = lista.filter(n => /EMITIDA|AUTORIZADA|PROCESSADA/i.test(n.status || '')).length;
    const erros = lista.filter(n => /ERRO|REJEITADA/i.test(n.status || '')).length;
    const pendentes = lista.filter(n => /PENDENTE|PROCESSANDO/i.test(n.status || '')).length;
    return { total: lista.length, emitidas, erros, pendentes };
  } catch (err) {
    return { total: null, emitidas: null, erros: null, pendentes: null, err: err.message };
  }
}

/**
 * Percentual de conversas WhatsApp resolvidas sem intervenção humana.
 * Base: whatsapp_conversations no mês, filtrando spam/grupos.
 */
async function lunaAutonomia(startDate) {
  const { rows } = await query(
    `SELECT
        COUNT(*)                                                        AS total,
        COUNT(*) FILTER (WHERE human_replied = false)                   AS sem_humano,
        COUNT(*) FILTER (WHERE human_replied = true)                    AS com_humano,
        COUNT(*) FILTER (WHERE resolved = true)                         AS resolvidas,
        COUNT(*) FILTER (WHERE resolved = true AND human_replied = false) AS resolvidas_sozinha
       FROM whatsapp_conversations
      WHERE started_at >= $1`,
    [startDate]
  );
  const r = rows[0] || {};
  const total = parseInt(r.total || 0);
  const semHumano = parseInt(r.sem_humano || 0);
  const pct = total > 0 ? Math.round((semHumano / total) * 1000) / 10 : 0;
  return {
    total_conversas: total,
    sem_intervencao_humana: semHumano,
    com_intervencao_humana: parseInt(r.com_humano || 0),
    resolvidas: parseInt(r.resolvidas || 0),
    resolvidas_sozinha: parseInt(r.resolvidas_sozinha || 0),
    autonomia_pct: pct,
  };
}

/**
 * Custo LLM no período e razão custo/receita do escritório.
 * Receita vem do Gesthub (SUM monthly_fee dos clientes ATIVOS).
 */
async function custoLLM(startDate) {
  const { rows: llmRows } = await query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total_usd,
            COALESCE(SUM(tokens_input), 0)       AS tokens_input,
            COALESCE(SUM(tokens_cache_read), 0)  AS tokens_cached,
            COALESCE(SUM(tokens_output), 0)      AS tokens_output,
            COUNT(*)                              AS calls
       FROM token_usage
      WHERE created_at >= $1`,
    [startDate]
  );
  const llm = llmRows[0] || {};
  const custoUsd = parseFloat(llm.total_usd || 0);
  const custoBrl = custoUsd * 5.3;  // cotação aproximada

  // Receita via Gesthub
  let receitaBrl = null;
  let clientesAtivos = null;
  try {
    const res = await fetch(`${GESTHUB_URL}/api/clients`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = await res.json();
      const ativos = (body.data || []).filter(c => String(c.status || '').toUpperCase() === 'ATIVO');
      clientesAtivos = ativos.length;
      receitaBrl = ativos.reduce((sum, c) => sum + (parseFloat(c.monthlyFee) || 0), 0);
    }
  } catch {}

  const ratioPct = receitaBrl && receitaBrl > 0
    ? Math.round((custoBrl / receitaBrl) * 10000) / 100
    : null;

  return {
    custo_usd: custoUsd,
    custo_brl: Math.round(custoBrl * 100) / 100,
    tokens_input: parseInt(llm.tokens_input || 0),
    tokens_cached: parseInt(llm.tokens_cached || 0),
    tokens_output: parseInt(llm.tokens_output || 0),
    cache_hit_pct: llm.tokens_input > 0
      ? Math.round(parseInt(llm.tokens_cached) / (parseInt(llm.tokens_input) + parseInt(llm.tokens_cached)) * 1000) / 10
      : 0,
    chamadas: parseInt(llm.calls || 0),
    receita_brl: receitaBrl,
    clientes_ativos: clientesAtivos,
    ratio_custo_receita_pct: ratioPct,
    custo_por_cliente_brl: (receitaBrl && clientesAtivos)
      ? Math.round((custoBrl / clientesAtivos) * 100) / 100
      : null,
  };
}

/**
 * Consolidado: 4 KPIs + delta vs mês anterior.
 */
export async function getImpactMetrics() {
  const now = new Date();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const [horas, horas_prev, nfse, nfse_prev, luna, luna_prev, custo, custo_prev] = await Promise.all([
    horasEconomizadas(startMonth),
    horasEconomizadas(startPrevMonth),
    nfseEmitidas(startMonth),
    nfseEmitidas(startPrevMonth),
    lunaAutonomia(startMonth),
    lunaAutonomia(startPrevMonth),
    custoLLM(startMonth),
    custoLLM(startPrevMonth),
  ]);

  const delta = (atual, anterior) => {
    if (atual == null || anterior == null || anterior === 0) return null;
    return Math.round(((atual - anterior) / anterior) * 1000) / 10;
  };

  return {
    periodo_atual: startMonth.toISOString().slice(0, 7),
    periodo_anterior: startPrevMonth.toISOString().slice(0, 7),
    kpis: {
      horas_economizadas: {
        atual: horas,
        anterior: horas_prev,
        delta_pct: delta(horas.horas, horas_prev.horas),
      },
      nfse: {
        atual: nfse,
        anterior: nfse_prev,
        delta_pct: delta(nfse.emitidas, nfse_prev.emitidas),
      },
      luna_autonomia: {
        atual: luna,
        anterior: luna_prev,
        delta_pct: delta(luna.autonomia_pct, luna_prev.autonomia_pct),
      },
      custo_llm: {
        atual: custo,
        anterior: custo_prev,
        delta_pct: delta(custo.custo_brl, custo_prev.custo_brl),
      },
    },
    generated_at: new Date().toISOString(),
  };
}
