// Sneijder — Analista Financeiro do Átrio.
// Opera em DOIS contextos:
//   - escritorio_* → finanças da propria Atrio (Omie)
//   - finance_*    → BPO para clientes (Atrio Finance, porta 3000)
// Reporta para Luna — ela pede aprovacao humana e executa cobranca via WhatsApp.
import { query } from '../db/pool.js';
import * as gesthub from '../services/gesthub.js';
import * as omie from '../services/omie.js';
import { createNotification } from '../services/notifications.js';
import { consultarCliente, listarClientes } from './shared.js';

const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// URL do Átrio Finance (BPO clientes). Default aponta pro container local.
const FINANCE_URL = process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000';

async function financeGet(path, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = qs ? `${FINANCE_URL}${path}?${qs}` : `${FINANCE_URL}${path}`;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { _httpError: true, status: r.status, url, body: body.slice(0, 300) };
    }
    return await r.json();
  } catch (err) {
    return { _httpError: true, url, erro: err.message };
  }
}

function httpErrorToToolResponse(resp) {
  return {
    erro: `Átrio Finance indisponível: ${resp.status || '?'} ${resp.erro || ''}`.trim(),
    detalhe: resp.body || null,
    acao_necessaria: 'Verificar se o container atrio-banking-system esta rodando na porta 3000.',
  };
}

export const tools = {
  // Compartilhadas (identificacao de cliente pela base Gesthub)
  consultar_cliente: consultarCliente,
  listar_clientes: listarClientes,

  // ========================================================================
  // CONTEXTO: ESCRITORIO ATRIO (Omie) — finanças da própria contabilidade
  // ========================================================================
  async escritorio_contas_pagar() {
    if (!omie.isConfigured()) {
      return { disponivel: false, erro: 'Omie não configurado. Adicione OMIE_APP_KEY e OMIE_APP_SECRET no .env' };
    }
    const titulos = await omie.listarContasPagar({ status: 'ABERTO' });
    const vencidos = titulos.filter(t => {
      const venc = t.data_vencimento?.split('/');
      if (!venc || venc.length !== 3) return false;
      return new Date(venc[2], venc[1] - 1, venc[0]) < new Date();
    });
    const totalAberto = titulos.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
    const totalVencido = vencidos.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
    const proximos = await omie.contasVencendoProximosDias(7);
    return {
      contexto: 'escritorio_atrio',
      resumo: {
        total_aberto: fmt(totalAberto),
        total_vencido: fmt(totalVencido),
        qtd_aberto: titulos.length,
        qtd_vencido: vencidos.length,
      },
      vencendo_7dias: proximos.slice(0, 15).map(t => ({
        fornecedor_id: t.codigo_cliente_fornecedor,
        valor: fmt(t.valor_documento),
        vencimento: t.data_vencimento,
        categoria: t.codigo_categoria,
      })),
      fonte: 'Omie ERP (finanças da Átrio)',
    };
  },

  async escritorio_contas_receber() {
    if (!omie.isConfigured()) {
      const clients = await gesthub.getClients();
      const ativos = clients.filter(c => c.status === 'ATIVO');
      const comHonorario = ativos.filter(c => c.monthlyFee > 0);
      const totalMensal = comHonorario.reduce((sum, c) => sum + (c.monthlyFee || 0), 0);
      return {
        contexto: 'escritorio_atrio',
        fonte: 'Gesthub (sem Omie) - somente honorarios estimados',
        resumo: { clientes_ativos: ativos.length, receita_mensal: fmt(totalMensal) },
      };
    }
    const resumo = await omie.resumoContasReceber();
    const vencidos = await omie.listarContasReceber({ apenasVencidos: true });
    return {
      contexto: 'escritorio_atrio',
      resumo: {
        total_aberto: resumo.formatado.total_aberto,
        total_vencido: resumo.formatado.total_vencido,
        total_a_vencer: resumo.formatado.total_a_vencer,
        vencendo_7dias: resumo.formatado.vencendo_7dias,
        qtd_titulos: resumo.qtd_titulos,
      },
      inadimplentes: vencidos.slice(0, 15).map(t => ({
        cliente_id: t.codigo_cliente_fornecedor,
        valor: fmt(t.valor_documento),
        vencimento: t.data_vencimento,
        documento: t.numero_documento,
      })),
      fonte: 'Omie ERP (finanças da Átrio)',
    };
  },

  async escritorio_alertas_cobranca() {
    const alertas = [];
    const clients = await gesthub.getClients();
    const semHonorario = clients
      .filter(c => c.status === 'ATIVO' && (!c.monthlyFee || c.monthlyFee === 0))
      .slice(0, 20)
      .map(c => ({
        cliente: c.legalName?.substring(0, 50),
        cnpj: c.document,
        regime: c.taxRegime,
        alerta: 'Honorário não definido',
        severidade: 'amarelo',
      }));
    alertas.push(...semHonorario);

    if (omie.isConfigured()) {
      const vencidos = await omie.listarContasReceber({ apenasVencidos: true });
      const hoje = new Date();
      for (const t of vencidos.slice(0, 20)) {
        const venc = t.data_vencimento?.split('/');
        if (!venc || venc.length !== 3) continue;
        const dataVenc = new Date(venc[2], venc[1] - 1, venc[0]);
        const diasAtraso = Math.floor((hoje - dataVenc) / (1000 * 60 * 60 * 24));
        alertas.push({
          cliente_id: t.codigo_cliente_fornecedor,
          valor: fmt(t.valor_documento),
          vencimento: t.data_vencimento,
          dias_atraso: diasAtraso,
          severidade: diasAtraso > 30 ? 'vermelho' : diasAtraso > 15 ? 'laranja' : 'amarelo',
          documento: t.numero_documento,
        });
      }
    }
    return {
      contexto: 'escritorio_atrio',
      total_alertas: alertas.length,
      alertas: alertas.sort((a, b) => (b.dias_atraso || 0) - (a.dias_atraso || 0)),
      fonte: omie.isConfigured() ? 'Omie + Gesthub' : 'Gesthub (sem Omie)',
    };
  },

  async escritorio_fluxo_caixa({ meses } = {}) {
    const periodo = meses || 3;
    if (!omie.isConfigured()) {
      const clients = await gesthub.getClients();
      const ativos = clients.filter(c => c.status === 'ATIVO');
      const receitaMensal = ativos.reduce((sum, c) => sum + (c.monthlyFee || 0), 0);
      const projecao = [];
      const now = new Date();
      for (let i = 0; i < periodo; i++) {
        const mes = new Date(now.getFullYear(), now.getMonth() + i, 1);
        projecao.push({ mes: mes.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }), receita_prevista: fmt(receitaMensal) });
      }
      return { contexto: 'escritorio_atrio', fonte: 'Gesthub (estimativa)', receita_mensal_base: fmt(receitaMensal), projecao };
    }
    const [receber, pagar] = await Promise.all([
      omie.resumoContasReceber(),
      omie.listarContasPagar({ status: 'ABERTO' }),
    ]);
    const totalPagar = pagar.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
    return {
      contexto: 'escritorio_atrio',
      posicao_atual: {
        a_receber: receber.formatado.total_aberto,
        a_pagar: fmt(totalPagar),
        saldo_projetado: fmt(receber.total_aberto - totalPagar),
      },
      receber_vencido: receber.formatado.total_vencido,
      receber_7dias: receber.formatado.vencendo_7dias,
      fonte: 'Omie ERP (finanças da Átrio)',
    };
  },

  async escritorio_relatorio_dre({ periodo } = {}) {
    if (!omie.isConfigured()) {
      return { disponivel: false, mensagem: 'DRE do escritorio requer Omie. Configure OMIE_APP_KEY no .env.' };
    }
    const [receber, pagar] = await Promise.all([
      omie.listarContasReceber(),
      omie.listarContasPagar(),
    ]);
    const recebidos = receber.filter(t => t.status_titulo === 'RECEBIDO');
    const pagos = pagar.filter(t => t.status_titulo === 'PAGO');
    const receita = recebidos.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
    const despesa = pagos.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
    const resultado = receita - despesa;
    return {
      contexto: 'escritorio_atrio',
      periodo: periodo || 'Acumulado',
      dre: {
        receita_bruta: fmt(receita),
        despesas_totais: fmt(despesa),
        resultado: fmt(resultado),
        margem: receita > 0 ? (resultado / receita * 100).toFixed(1) + '%' : '0%',
      },
      qtd_recebimentos: recebidos.length,
      qtd_pagamentos: pagos.length,
      fonte: 'Omie ERP (finanças da Átrio)',
    };
  },

  async escritorio_conciliar_extrato({ conta_corrente_id } = {}) {
    if (!omie.isConfigured()) {
      return { disponivel: false, mensagem: 'Conciliação do escritorio requer Omie configurado.' };
    }
    if (!conta_corrente_id) {
      const contas = await omie.listarContasCorrentes();
      return {
        contexto: 'escritorio_atrio',
        mensagem: 'Informe o ID da conta corrente para extrato.',
        contas_disponiveis: contas.map(c => ({
          id: c.nCodCC,
          descricao: c.descricao,
          tipo: c.tipo === 'CX' ? 'Caixa' : 'Conta Corrente',
          banco: c.codigo_banco,
        })),
      };
    }
    const extrato = await omie.extratoConta(conta_corrente_id);
    return { contexto: 'escritorio_atrio', conta_corrente_id, extrato, fonte: 'Omie ERP' };
  },

  // ========================================================================
  // CONTEXTO: BPO DE CLIENTES (Átrio Finance, porta 3000)
  // ========================================================================
  async finance_listar_clientes({ search } = {}) {
    const r = await financeGet('/api/clientes', search ? { search } : {});
    if (r._httpError) return httpErrorToToolResponse(r);
    const lista = r.data || r.clientes || r || [];
    return {
      contexto: 'bpo_clientes',
      total: Array.isArray(lista) ? lista.length : 0,
      clientes: (Array.isArray(lista) ? lista : []).slice(0, 40).map(c => ({
        id: c.id,
        razao_social: c.legalName || c.razao_social || c.nome || c.tradeName || '',
        nome_fantasia: c.tradeName || '',
        cnpj: c.document || c.cnpj || '',
        regime: c.taxRegime || c.regime || '',
        cidade: c.city || '',
        uf: c.state || '',
        responsavel: c.analyst || c.officeOwner || '',
      })),
      fonte: 'Átrio Finance (BPO) /api/clientes',
    };
  },

  async finance_dre_cliente({ cliente_id, ano, mes } = {}) {
    if (!cliente_id) return { erro: 'Parâmetro obrigatório: cliente_id. Use finance_listar_clientes para descobrir o ID.' };
    const anoRef = ano || new Date().getFullYear();
    const [simples, comparativo] = await Promise.all([
      financeGet('/api/transacoes/dre', { cliente_id, ano: anoRef, mes }),
      financeGet('/api/transacoes/dre-comparativo', { cliente_id, ano: anoRef }),
    ]);
    if (simples._httpError && comparativo._httpError) return httpErrorToToolResponse(simples);
    return {
      contexto: 'bpo_clientes',
      cliente_id,
      ano: anoRef,
      mes: mes || null,
      dre: simples._httpError ? null : (simples.data || simples),
      dre_comparativo: comparativo._httpError ? null : (comparativo.data || comparativo),
      fonte: 'Átrio Finance /api/transacoes/dre[-comparativo]',
    };
  },

  async finance_resumo_cliente({ cliente_id, ano, mes } = {}) {
    if (!cliente_id) return { erro: 'Parâmetro obrigatório: cliente_id.' };
    const r = await financeGet('/api/transacoes/resumo', { cliente_id, ano, mes });
    if (r._httpError) return httpErrorToToolResponse(r);
    return { contexto: 'bpo_clientes', cliente_id, ano: ano || null, mes: mes || null, resumo: r.data || r, fonte: 'Átrio Finance /api/transacoes/resumo' };
  },

  async finance_conciliacao_status({ cliente_id, ano, mes } = {}) {
    if (!cliente_id) return { erro: 'Parâmetro obrigatório: cliente_id.' };
    const r = await financeGet('/api/conciliacao/resumo', { cliente_id, ano, mes });
    if (r._httpError) return httpErrorToToolResponse(r);
    return { contexto: 'bpo_clientes', cliente_id, ano: ano || null, mes: mes || null, conciliacao: r.data || r, fonte: 'Átrio Finance /api/conciliacao/resumo' };
  },

  async finance_extratos_pendentes({ ano, mes } = {}) {
    // Identifica clientes BPO que NÃO enviaram extrato no mês/ano de referência.
    // Base: cruzamento de /api/clientes com /api/uploads filtrado por periodo.
    const hoje = new Date();
    const anoRef = ano || hoje.getFullYear();
    const mesRef = mes || (hoje.getMonth() + 1); // mes atual por default
    const [clientesResp, uploadsResp] = await Promise.all([
      financeGet('/api/clientes'),
      financeGet('/api/uploads', { ano: anoRef, mes: mesRef }),
    ]);
    if (clientesResp._httpError) return httpErrorToToolResponse(clientesResp);
    if (uploadsResp._httpError) return httpErrorToToolResponse(uploadsResp);

    const clientes = Array.isArray(clientesResp) ? clientesResp : (clientesResp.data || clientesResp.clientes || []);
    const uploads = Array.isArray(uploadsResp) ? uploadsResp : (uploadsResp.data || uploadsResp.uploads || []);
    // Banking model usa cliente_gesthub_id (snake_case na DB, serializado como clienteGesthubId).
    const clientesComUpload = new Set(
      uploads.map(u => u.clienteGesthubId ?? u.cliente_gesthub_id ?? u.cliente_id).filter(v => v !== null && v !== undefined)
    );
    const pendentes = clientes.filter(c => !clientesComUpload.has(c.id));

    return {
      contexto: 'bpo_clientes',
      periodo: `${String(mesRef).padStart(2,'0')}/${anoRef}`,
      total_clientes_bpo: clientes.length,
      total_com_upload: clientesComUpload.size,
      total_pendentes: pendentes.length,
      pct_pendencia: clientes.length ? ((pendentes.length / clientes.length) * 100).toFixed(1) + '%' : '0%',
      pendentes: pendentes.slice(0, 50).map(c => ({
        id: c.id,
        razao_social: c.legalName || c.razao_social || c.nome || '',
        cnpj: c.document || c.cnpj || '',
        responsavel: c.analyst || c.officeOwner || '',
      })),
      fonte: 'Átrio Finance /api/clientes + /api/uploads',
      nota: 'Lista de clientes que ainda nao enviaram extrato no periodo. Reporte a Luna para acionar cobranca.',
    };
  },

  async finance_transacoes_cliente({ cliente_id, ano, mes, tipo, limit } = {}) {
    if (!cliente_id) return { erro: 'Parâmetro obrigatório: cliente_id.' };
    const r = await financeGet('/api/transacoes', { cliente_id, ano, mes, tipo, limit: limit || 50 });
    if (r._httpError) return httpErrorToToolResponse(r);
    const lista = Array.isArray(r) ? r : (r.data || r.transacoes || []);
    return {
      contexto: 'bpo_clientes',
      cliente_id,
      ano: ano || null,
      mes: mes || null,
      tipo: tipo || 'todos',
      total: lista.length,
      transacoes: lista.slice(0, 50).map(t => ({
        id: t.id,
        data: t.data || t.data_transacao,
        descricao: t.descricao,
        valor: fmt(t.valor),
        tipo: t.tipo,
        categoria_id: t.categoria_id,
        conta_id: t.conta_id,
      })),
      fonte: 'Átrio Finance /api/transacoes',
    };
  },

  // ========================================================================
  // DELEGACAO: Sneijder -> Luna (aprovacao humana + execucao de cobranca)
  // ========================================================================
  // Cria task para Luna com flag `aguardando_aprovacao_humana=true`. O
  // orchestrator tem guard que NAO processa enquanto a flag estiver true.
  // Aprovacao muda a flag para false (API dedicada ou update manual no DB)
  // e dispara a execucao: Luna usa whatsapp_enviar em cada cliente pendente.
  async solicitar_cobranca_luna({ clientes_pendentes, periodo, mensagem_sugerida, tipo } = {}) {
    if (!Array.isArray(clientes_pendentes) || clientes_pendentes.length === 0) {
      return { erro: 'Parâmetro obrigatório: clientes_pendentes (array com id/nome/telefone).' };
    }
    const tipoReq = tipo || 'cobranca_extrato_bpo';
    // Valida periodo: deve ser YYYY-MM (2026-04). Se veio algo como "definicao_honorario", cai pro mes atual.
    const periodoValido = periodo && /^\d{4}-\d{2}$/.test(String(periodo));
    const ref = periodoValido ? periodo : new Date().toISOString().slice(0, 7); // YYYY-MM

    // Resolve team_members IDs (Sneijder = solicitante, Luna = executor).
    const { rows: sneiRows } = await query(
      `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Sneijder'`
    );
    const { rows: lunaRows } = await query(
      `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Luna'`
    );
    if (!lunaRows.length) return { erro: 'Luna não encontrada em team_members — execução impossível.' };

    const mensagemDefault = `Olá! Identificamos que ainda não recebemos seu extrato bancário referente a ${ref}. Para manter sua contabilidade em dia, por favor nos envie o extrato quando possível. — Átrio Contabilidade`;
    const mensagem = mensagem_sugerida || mensagemDefault;

    const title = `[COBRANCA_EXTRATO] ${clientes_pendentes.length} cliente(s) BPO pendente(s) — ${ref}`;
    const description = `Solicitação de cobrança de extratos do BPO.\nPeríodo: ${ref}\nTotal: ${clientes_pendentes.length} clientes.\nAguardando aprovação humana antes da execução via WhatsApp.`;
    const payload = {
      aguardando_aprovacao_humana: true,
      tipo: tipoReq,
      solicitante: 'Sneijder',
      periodo: ref,
      clientes_pendentes,
      mensagem_sugerida: mensagem,
      criado_em: new Date().toISOString(),
    };

    const { rows } = await query(
      `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING id`,
      [title, description, lunaRows[0].id, sneiRows[0]?.id || null, 'medium', JSON.stringify(payload)]
    );
    const taskId = rows[0].id;

    // Notificação de aprovação (UI pode exibir botão "aprovar")
    try {
      await createNotification({
        type: 'approval_request',
        title: `Aprovar cobrança de ${clientes_pendentes.length} extrato(s)`,
        message: `Sneijder identificou ${clientes_pendentes.length} cliente(s) BPO sem extrato em ${ref}. Luna aguarda aprovação para disparar cobrança via WhatsApp.`,
        severity: 'info',
        taskId,
      });
    } catch (e) { console.log('[sneijder] createNotification falhou (nao critico):', e.message); }

    return {
      sucesso: true,
      contexto: 'bpo_clientes',
      task_id: taskId,
      delegado_para: 'Luna (aguardando aprovação humana)',
      periodo: ref,
      total_clientes: clientes_pendentes.length,
      status: 'pending_human_approval',
      mensagem_sugerida: mensagem,
      nota: 'Task criada em status pending com aguardando_aprovacao_humana=true. Orchestrator nao executa ate a flag ser resetada. Humano aprova via UI ou atualizando result.aguardando_aprovacao_humana=false.',
    };
  },
};
