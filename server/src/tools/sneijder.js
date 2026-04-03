import * as gesthub from '../services/gesthub.js';

export const tools = {
  async contas_pagar() {
    const clients = await gesthub.getClients();
    const ativos = clients.filter(c => c.status === 'ATIVO');

    // Simula contas a pagar baseado nos dados disponíveis
    const custos = [
      { descricao: 'Folha de pagamento', valor_estimado: 'Consultar RH', vencimento: 'Dia 5', status: 'recorrente' },
      { descricao: 'FGTS', valor_estimado: '8% da folha', vencimento: 'Dia 7', status: 'recorrente' },
      { descricao: 'INSS', valor_estimado: '20% da folha', vencimento: 'Dia 20', status: 'recorrente' },
      { descricao: 'Aluguel / Infraestrutura', valor_estimado: 'Consultar financeiro', vencimento: 'Variável', status: 'recorrente' },
      { descricao: 'Software / Sistemas', valor_estimado: 'Consultar contratos', vencimento: 'Variável', status: 'recorrente' },
    ];

    return {
      total_clientes_ativos: ativos.length,
      contas_fixas: custos,
      nota: 'Para contas detalhadas, é necessário integração com sistema financeiro completo. Dados acima são estimativas baseadas em obrigações recorrentes.',
    };
  },

  async contas_receber() {
    const clients = await gesthub.getClients();
    const ativos = clients.filter(c => c.status === 'ATIVO');
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    const comHonorario = ativos.filter(c => c.monthlyFee > 0);
    const semHonorario = ativos.filter(c => !c.monthlyFee || c.monthlyFee === 0);
    const totalMensal = comHonorario.reduce((sum, c) => sum + (c.monthlyFee || 0), 0);

    const maiores = [...comHonorario]
      .sort((a, b) => b.monthlyFee - a.monthlyFee)
      .slice(0, 10)
      .map(c => ({
        cliente: c.legalName?.substring(0, 50),
        honorario: fmt(c.monthlyFee),
        regime: c.taxRegime,
        responsavel: c.analyst || c.officeOwner,
      }));

    return {
      resumo: {
        clientes_ativos: ativos.length,
        com_honorario: comHonorario.length,
        sem_honorario_definido: semHonorario.length,
        receita_mensal_total: fmt(totalMensal),
        receita_anual_estimada: fmt(totalMensal * 12),
      },
      top_10_clientes: maiores,
    };
  },

  async alertas_cobranca() {
    const clients = await gesthub.getClients();
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    // Identifica clientes sem honorário definido (potencial inadimplência/descuido)
    const semHonorario = clients
      .filter(c => c.status === 'ATIVO' && (!c.monthlyFee || c.monthlyFee === 0))
      .slice(0, 20)
      .map(c => ({
        cliente: c.legalName?.substring(0, 50),
        cnpj: c.document,
        regime: c.taxRegime,
        responsavel: c.analyst || c.officeOwner,
        alerta: 'Honorário não definido',
      }));

    const inativos = clients
      .filter(c => c.status === 'INATIVO')
      .slice(0, 10)
      .map(c => ({
        cliente: c.legalName?.substring(0, 50),
        cnpj: c.document,
        motivo: c.motivoInativacao || 'Não informado',
      }));

    return {
      alertas_honorario: {
        total: semHonorario.length,
        clientes: semHonorario,
      },
      clientes_inativos: {
        total: inativos.length,
        clientes: inativos,
      },
      nota: 'Para alertas de inadimplência detalhados, integrar com sistema de cobrança.',
    };
  },

  async fluxo_caixa({ meses }) {
    const periodo = meses || 3;
    const clients = await gesthub.getClients();
    const ativos = clients.filter(c => c.status === 'ATIVO');
    const receitaMensal = ativos.reduce((sum, c) => sum + (c.monthlyFee || 0), 0);
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    const now = new Date();
    const projecao = [];
    for (let i = 0; i < periodo; i++) {
      const mes = new Date(now.getFullYear(), now.getMonth() + i, 1);
      projecao.push({
        mes: mes.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
        receita_prevista: fmt(receitaMensal),
        observacao: i === 0 ? 'Mês atual' : 'Projeção',
      });
    }

    return {
      clientes_ativos: ativos.length,
      receita_mensal_base: fmt(receitaMensal),
      projecao,
      nota: 'Projeção baseada em honorários recorrentes. Não inclui receitas variáveis ou despesas.',
    };
  },

  async relatorio_dre({ periodo }) {
    const clients = await gesthub.getClients();
    const ativos = clients.filter(c => c.status === 'ATIVO');
    const receitaBruta = ativos.reduce((sum, c) => sum + (c.monthlyFee || 0), 0);
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    // DRE simplificado com estimativas
    const impostos = receitaBruta * 0.06; // estimativa Simples
    const receitaLiquida = receitaBruta - impostos;
    const custoServicos = receitaBruta * 0.35; // estimativa
    const lucroBruto = receitaLiquida - custoServicos;
    const despesasOp = receitaBruta * 0.20; // estimativa
    const resultado = lucroBruto - despesasOp;

    return {
      periodo: periodo || 'Mês atual (estimativa)',
      dre: {
        receita_bruta: fmt(receitaBruta),
        deducoes_impostos: fmt(impostos),
        receita_liquida: fmt(receitaLiquida),
        custo_servicos_prestados: fmt(custoServicos),
        lucro_bruto: fmt(lucroBruto),
        despesas_operacionais: fmt(despesasOp),
        resultado_operacional: fmt(resultado),
        margem_liquida: receitaBruta > 0 ? (resultado / receitaBruta * 100).toFixed(1) + '%' : '0%',
      },
      nota: 'DRE simplificado baseado em honorários e estimativas de custos. Para DRE completo, integrar com sistema contábil.',
    };
  },

  async conciliar_extrato() {
    return {
      disponivel: false,
      mensagem: 'Conciliação bancária requer integração com Open Banking ou importação de extratos OFX. Funcionalidade em desenvolvimento.',
    };
  },
};
