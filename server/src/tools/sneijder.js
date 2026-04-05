import * as gesthub from '../services/gesthub.js';
import * as omie from '../services/omie.js';
import { consultarCliente, listarClientes } from './shared.js';

const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const tools = {
  consultar_cliente: consultarCliente,
  listar_clientes: listarClientes,
  async contas_pagar() {
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
      fonte: 'Omie ERP (dados reais)',
    };
  },

  async contas_receber() {
    if (!omie.isConfigured()) {
      // Fallback: dados do Gesthub
      const clients = await gesthub.getClients();
      const ativos = clients.filter(c => c.status === 'ATIVO');
      const comHonorario = ativos.filter(c => c.monthlyFee > 0);
      const totalMensal = comHonorario.reduce((sum, c) => sum + (c.monthlyFee || 0), 0);
      return {
        fonte: 'Gesthub (sem Omie)',
        resumo: { clientes_ativos: ativos.length, receita_mensal: fmt(totalMensal) },
      };
    }

    const resumo = await omie.resumoContasReceber();
    const vencidos = await omie.listarContasReceber({ apenasVencidos: true });

    return {
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
      fonte: 'Omie ERP (dados reais)',
    };
  },

  async alertas_cobranca() {
    const alertas = [];

    // Dados Gesthub (honorários sem definição)
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

    // Dados Omie (títulos vencidos)
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
      total_alertas: alertas.length,
      alertas: alertas.sort((a, b) => (b.dias_atraso || 0) - (a.dias_atraso || 0)),
      fonte: omie.isConfigured() ? 'Omie + Gesthub' : 'Gesthub (sem Omie)',
    };
  },

  async fluxo_caixa({ meses }) {
    const periodo = meses || 3;

    if (!omie.isConfigured()) {
      // Fallback: projeção por honorários
      const clients = await gesthub.getClients();
      const ativos = clients.filter(c => c.status === 'ATIVO');
      const receitaMensal = ativos.reduce((sum, c) => sum + (c.monthlyFee || 0), 0);
      const projecao = [];
      const now = new Date();
      for (let i = 0; i < periodo; i++) {
        const mes = new Date(now.getFullYear(), now.getMonth() + i, 1);
        projecao.push({ mes: mes.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }), receita_prevista: fmt(receitaMensal) });
      }
      return { fonte: 'Gesthub (estimativa)', receita_mensal_base: fmt(receitaMensal), projecao };
    }

    // Dados reais do Omie
    const [receber, pagar] = await Promise.all([
      omie.resumoContasReceber(),
      omie.listarContasPagar({ status: 'ABERTO' }),
    ]);

    const totalPagar = pagar.reduce((s, t) => s + Number(t.valor_documento || 0), 0);

    return {
      posicao_atual: {
        a_receber: receber.formatado.total_aberto,
        a_pagar: fmt(totalPagar),
        saldo_projetado: fmt(receber.total_aberto - totalPagar),
      },
      receber_vencido: receber.formatado.total_vencido,
      receber_7dias: receber.formatado.vencendo_7dias,
      fonte: 'Omie ERP (dados reais)',
    };
  },

  async relatorio_dre({ periodo }) {
    if (!omie.isConfigured()) {
      return { disponivel: false, mensagem: 'DRE requer integração Omie. Configure OMIE_APP_KEY no .env.' };
    }

    const [receber, pagar] = await Promise.all([
      omie.listarContasReceber(),
      omie.listarContasPagar(),
    ]);

    // Filtra recebidos e pagos (liquidados)
    const recebidos = receber.filter(t => t.status_titulo === 'RECEBIDO');
    const pagos = pagar.filter(t => t.status_titulo === 'PAGO');

    const receita = recebidos.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
    const despesa = pagos.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
    const resultado = receita - despesa;

    return {
      periodo: periodo || 'Acumulado (todos os registros)',
      dre: {
        receita_bruta: fmt(receita),
        despesas_totais: fmt(despesa),
        resultado: fmt(resultado),
        margem: receita > 0 ? (resultado / receita * 100).toFixed(1) + '%' : '0%',
      },
      qtd_recebimentos: recebidos.length,
      qtd_pagamentos: pagos.length,
      fonte: 'Omie ERP (dados reais)',
    };
  },

  async conciliar_extrato({ conta_corrente_id }) {
    if (!omie.isConfigured()) {
      return { disponivel: false, mensagem: 'Conciliação requer Omie configurado.' };
    }

    if (!conta_corrente_id) {
      // Lista contas disponíveis
      const contas = await omie.listarContasCorrentes();
      return {
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
    return { conta_corrente_id, extrato, fonte: 'Omie ERP' };
  },
};
