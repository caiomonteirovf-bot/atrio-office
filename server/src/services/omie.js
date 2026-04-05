/**
 * Omie API Client — Integração Financeira
 * Portado do Python validado (548 receber + 438 pagar + 149 clientes)
 * Single-tenant: credenciais do escritório WeGo/Átrio
 *
 * IMPORTANTE: API Omie NÃO aceita filtro de status como parâmetro
 * em contareceber e contapagar — filtra em memória.
 * Paginação usa 'pagina' e 'registros_por_pagina' (máx 50).
 * Rate limit: 60 req/min por app_key.
 */
import dotenv from 'dotenv';
dotenv.config();

const OMIE_APP_KEY = process.env.OMIE_APP_KEY;
const OMIE_APP_SECRET = process.env.OMIE_APP_SECRET;
const OMIE_URL = 'https://app.omie.com.br/api/v1';

// Cache simples em memória (evita bater rate limit)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

export function clearCache() {
  cache.clear();
}

export function isConfigured() {
  return !!(OMIE_APP_KEY && OMIE_APP_SECRET);
}

// ============================================
// CHAMADA BASE
// ============================================
async function call(endpoint, method, params = {}) {
  if (!isConfigured()) throw new Error('Omie não configurado (falta OMIE_APP_KEY e OMIE_APP_SECRET no .env)');

  const url = `${OMIE_URL}/${endpoint}/`;
  const payload = {
    call: method,
    app_key: OMIE_APP_KEY,
    app_secret: OMIE_APP_SECRET,
    param: [params],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (data.faultstring) {
    throw new Error(`Omie API: ${data.faultstring} (${data.faultcode || 'sem código'})`);
  }

  return data;
}

// ============================================
// PAGINAÇÃO AUTOMÁTICA
// ============================================
async function paginate(endpoint, method, params, listKey, pageSize = 50) {
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const allRecords = [];
  let page = 1;

  while (true) {
    const data = await call(endpoint, method, {
      ...params,
      pagina: page,
      registros_por_pagina: pageSize,
    });

    const records = data[listKey] || [];
    allRecords.push(...records);

    const totalPages = data.total_de_paginas || 1;
    console.log(`[Omie] ${method} — página ${page}/${totalPages} (${records.length} registros)`);

    if (page >= totalPages) break;
    page++;

    // Respeita rate limit: pequeno delay entre páginas
    await new Promise(r => setTimeout(r, 200));
  }

  setCache(cacheKey, allRecords);
  return allRecords;
}

// ============================================
// UTILS
// ============================================
function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  return new Date(parts[2], parts[1] - 1, parts[0]);
}

function today() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Recife' }));
}

function formatBRL(value) {
  return `R$ ${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ============================================
// CLIENTES
// ============================================
export async function listarClientes() {
  return paginate('geral/clientes', 'ListarClientes', {}, 'clientes_cadastro');
}

// ============================================
// CONTAS CORRENTES
// ============================================
export async function listarContasCorrentes() {
  return paginate('geral/contacorrente', 'ListarContasCorrentes', {}, 'conta_corrente_lista');
}

// ============================================
// CONTAS A RECEBER
// ============================================
export async function listarContasReceber({ status, apenasVencidos } = {}) {
  // API NÃO aceita filtro de status — busca tudo e filtra em memória
  const titulos = await paginate('financas/contareceber', 'ListarContasReceber', {}, 'conta_receber_cadastro');

  if (apenasVencidos) {
    return titulos.filter(t => t.status_titulo === 'ATRASADO');
  }

  if (status) {
    return titulos.filter(t => t.status_titulo === status);
  }

  return titulos;
}

export async function resumoContasReceber() {
  // Omie usa 'ATRASADO' e 'A VENCER' (não 'ABERTO')
  const todos = await listarContasReceber();
  const titulos = todos.filter(t => ['ATRASADO', 'A VENCER', 'VENCE HOJE'].includes(t.status_titulo));
  const hoje = today();

  let totalAberto = 0, totalVencido = 0, totalAVencer = 0, vencendo7dias = 0;

  for (const t of titulos) {
    const valor = Number(t.valor_documento || 0);
    const venc = parseDate(t.data_vencimento);
    if (!venc) continue;

    totalAberto += valor;
    if (venc < hoje) {
      totalVencido += valor;
    } else {
      totalAVencer += valor;
      const diff = (venc - hoje) / (1000 * 60 * 60 * 24);
      if (diff <= 7) vencendo7dias += valor;
    }
  }

  return {
    total_aberto: Math.round(totalAberto * 100) / 100,
    total_vencido: Math.round(totalVencido * 100) / 100,
    total_a_vencer: Math.round(totalAVencer * 100) / 100,
    vencendo_proximos_7dias: Math.round(vencendo7dias * 100) / 100,
    qtd_titulos: titulos.length,
    formatado: {
      total_aberto: formatBRL(totalAberto),
      total_vencido: formatBRL(totalVencido),
      total_a_vencer: formatBRL(totalAVencer),
      vencendo_7dias: formatBRL(vencendo7dias),
    },
  };
}

// ============================================
// CONTAS A PAGAR
// ============================================
export async function listarContasPagar({ status, apenasVencidos } = {}) {
  const titulos = await paginate('financas/contapagar', 'ListarContasPagar', {}, 'conta_pagar_cadastro');

  if (apenasVencidos) {
    return titulos.filter(t => t.status_titulo === 'ATRASADO');
  }

  if (status) {
    return titulos.filter(t => t.status_titulo === status);
  }

  return titulos;
}

export async function contasVencendoProximosDias(dias = 3) {
  const todos = await listarContasPagar();
  const titulos = todos.filter(t => ['A VENCER', 'VENCE HOJE', 'ATRASADO'].includes(t.status_titulo));
  const hoje = today();
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() + dias);

  return titulos.filter(t => {
    const venc = parseDate(t.data_vencimento);
    return venc && venc >= hoje && venc <= limite;
  });
}

// ============================================
// DIAGNÓSTICO FINANCEIRO (para Sneijder/Rodrigo)
// ============================================
export async function diagnosticoFinanceiro() {
  const resultado = {
    data_consulta: new Date().toISOString(),
    contas_receber: {},
    contas_pagar: {},
    alertas: [],
  };

  // Contas a receber
  try {
    resultado.contas_receber = await resumoContasReceber();
    if (resultado.contas_receber.total_vencido > 0) {
      resultado.alertas.push({
        tipo: 'INADIMPLENCIA',
        severidade: 'ALTO',
        mensagem: `${resultado.contas_receber.formatado.total_vencido} em títulos vencidos`,
      });
    }
  } catch (err) {
    console.error('[Omie] Erro contas a receber:', err.message);
  }

  // Contas a pagar (próximos 3 dias)
  try {
    const vencendo = await contasVencendoProximosDias(3);
    const totalVencendo = vencendo.reduce((sum, t) => sum + Number(t.valor_documento || 0), 0);
    resultado.contas_pagar = {
      vencendo_3dias: Math.round(totalVencendo * 100) / 100,
      qtd_titulos: vencendo.length,
      formatado: formatBRL(totalVencendo),
      detalhes: vencendo.slice(0, 10).map(t => ({
        fornecedor_id: t.codigo_cliente_fornecedor,
        valor: Number(t.valor_documento || 0),
        vencimento: t.data_vencimento,
      })),
    };
    if (totalVencendo > 0) {
      resultado.alertas.push({
        tipo: 'VENCIMENTO_PROXIMO',
        severidade: 'MEDIO',
        mensagem: `${formatBRL(totalVencendo)} vencendo nos próximos 3 dias (${vencendo.length} títulos)`,
      });
    }
  } catch (err) {
    console.error('[Omie] Erro contas a pagar:', err.message);
  }

  return resultado;
}

// ============================================
// NFS-e
// ============================================
export async function listarNfse(dataInicial, dataFinal) {
  const hoje = today();
  const params = {
    dDtInicial: dataInicial || `01/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`,
    dDtFinal: dataFinal || `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`,
  };
  return paginate('servicos/osdocs', 'ListarDocumentos', params, 'osdoc_cadastro');
}

// ============================================
// CONTRATOS
// ============================================
export async function listarContratos(apenasAtivos = true) {
  const params = apenasAtivos ? { cStatus: 'ATIVO' } : {};
  return paginate('servicos/contrato', 'ListarContratos', params, 'contrato_cadastro');
}

// ============================================
// EXTRATO
// ============================================
export async function extratoConta(contaCorrenteId, dataInicial, dataFinal) {
  const hoje = today();
  const d30 = new Date(hoje);
  d30.setDate(d30.getDate() - 30);

  return call('financas/extrato', 'ListarExtrato', {
    nCodCC: contaCorrenteId,
    dDtDe: dataInicial || `${String(d30.getDate()).padStart(2, '0')}/${String(d30.getMonth() + 1).padStart(2, '0')}/${d30.getFullYear()}`,
    dDtAte: dataFinal || `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`,
  });
}
