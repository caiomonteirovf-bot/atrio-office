import * as gesthub from '../services/gesthub.js';
import { consultarCnpj } from './shared.js';

// Tabela Simples Nacional 2024 (Anexos I a V) — faixas simplificadas
const SIMPLES_ANEXOS = {
  I: [ // Comércio
    { ate: 180000, aliq: 4.0, ded: 0 },
    { ate: 360000, aliq: 7.3, ded: 5940 },
    { ate: 720000, aliq: 9.5, ded: 13860 },
    { ate: 1800000, aliq: 10.7, ded: 22500 },
    { ate: 3600000, aliq: 14.3, ded: 87300 },
    { ate: 4800000, aliq: 19.0, ded: 378000 },
  ],
  III: [ // Serviços (Fator R >= 28%)
    { ate: 180000, aliq: 6.0, ded: 0 },
    { ate: 360000, aliq: 11.2, ded: 9360 },
    { ate: 720000, aliq: 13.5, ded: 17640 },
    { ate: 1800000, aliq: 16.0, ded: 35640 },
    { ate: 3600000, aliq: 21.0, ded: 125640 },
    { ate: 4800000, aliq: 33.0, ded: 648000 },
  ],
  V: [ // Serviços (Fator R < 28%)
    { ate: 180000, aliq: 15.5, ded: 0 },
    { ate: 360000, aliq: 18.0, ded: 4500 },
    { ate: 720000, aliq: 19.5, ded: 9900 },
    { ate: 1800000, aliq: 20.5, ded: 17100 },
    { ate: 3600000, aliq: 23.0, ded: 62100 },
    { ate: 4800000, aliq: 30.5, ded: 540000 },
  ],
};

function calcularAliquotaEfetiva(rbt12, anexo) {
  const tabela = SIMPLES_ANEXOS[anexo] || SIMPLES_ANEXOS.III;
  const faixa = tabela.find(f => rbt12 <= f.ate) || tabela[tabela.length - 1];
  const aliqEfetiva = ((rbt12 * faixa.aliq / 100) - faixa.ded) / rbt12 * 100;
  return { aliqEfetiva: Math.max(aliqEfetiva, 0), faixa: faixa.aliq, deducao: faixa.ded };
}

// Calendário fiscal brasileiro
const CALENDARIO_FISCAL = [
  { obrigacao: 'DAS (Simples Nacional)', dia: 20, regime: 'simples', descricao: 'Guia do Simples Nacional' },
  { obrigacao: 'DARF IRPJ/CSLL (Presumido)', dia: 30, regime: 'presumido', descricao: 'Trimestral: mar, jun, set, dez', trimestral: true },
  { obrigacao: 'DARF PIS', dia: 25, regime: 'presumido', descricao: 'PIS sobre faturamento' },
  { obrigacao: 'DARF COFINS', dia: 25, regime: 'presumido', descricao: 'COFINS sobre faturamento' },
  { obrigacao: 'DARF ISS', dia: 15, regime: 'todos', descricao: 'ISS municipal (varia por município)' },
  { obrigacao: 'FGTS/GFIP', dia: 7, regime: 'todos', descricao: 'Recolhimento FGTS + GFIP' },
  { obrigacao: 'INSS (GPS)', dia: 20, regime: 'todos', descricao: 'Contribuição previdenciária' },
  { obrigacao: 'EFD-Contribuições', dia: 15, regime: 'presumido', descricao: 'Escrituração digital PIS/COFINS' },
  { obrigacao: 'DCTF', dia: 15, regime: 'presumido', descricao: 'Declaração de débitos e créditos tributários' },
  { obrigacao: 'DEFIS', dia: 31, regime: 'simples', descricao: 'Declaração anual do Simples (março)', meses: [3] },
  { obrigacao: 'DIRF', dia: 28, regime: 'todos', descricao: 'Declaração de IR retido na fonte (fevereiro)', meses: [2] },
  { obrigacao: 'RAIS', dia: 31, regime: 'todos', descricao: 'Relação anual de informações sociais (março)', meses: [3] },
];

export const tools = {
  consultar_cnpj: consultarCnpj,

  async calcular_fator_r({ folha_12m, receita_12m }) {
    if (!folha_12m || !receita_12m) {
      return { erro: 'Parâmetros obrigatórios: folha_12m e receita_12m' };
    }
    if (receita_12m <= 0) return { erro: 'Receita bruta deve ser maior que zero' };

    const fatorR = folha_12m / receita_12m;
    const percentual = (fatorR * 100).toFixed(2);
    const anexo = fatorR >= 0.28 ? 'III' : 'V';

    const { aliqEfetiva } = calcularAliquotaEfetiva(receita_12m, anexo);

    return {
      folha_12m: folha_12m.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      receita_12m: receita_12m.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      fator_r: percentual + '%',
      anexo_aplicavel: `Anexo ${anexo}`,
      regra: fatorR >= 0.28
        ? 'Fator R >= 28% → Anexo III (alíquota MENOR)'
        : 'Fator R < 28% → Anexo V (alíquota MAIOR)',
      aliquota_efetiva_estimada: aliqEfetiva.toFixed(2) + '%',
      recomendacao: fatorR < 0.28
        ? 'Considere aumentar a folha de pagamento (pró-labore) para atingir 28% e migrar para o Anexo III.'
        : 'Fator R favorável. Empresa enquadrada no Anexo III com alíquota reduzida.',
    };
  },

  async calcular_impostos({ regime, faturamento_mensal, folha_mensal, atividade }) {
    if (!regime || !faturamento_mensal) {
      return { erro: 'Parâmetros obrigatórios: regime e faturamento_mensal' };
    }

    const fat = faturamento_mensal;
    const folha = folha_mensal || 0;
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    if (regime === 'simples') {
      const rbt12 = fat * 12;
      const fatorR = folha > 0 ? (folha * 12) / rbt12 : 0;
      const anexo = fatorR >= 0.28 ? 'III' : 'V';
      const { aliqEfetiva } = calcularAliquotaEfetiva(rbt12, anexo);
      const imposto = fat * (aliqEfetiva / 100);

      return {
        regime: 'Simples Nacional',
        faturamento: fmt(fat),
        rbt_12m_estimada: fmt(rbt12),
        fator_r: (fatorR * 100).toFixed(2) + '%',
        anexo,
        aliquota_efetiva: aliqEfetiva.toFixed(2) + '%',
        das_mensal: fmt(imposto),
      };
    }

    if (regime === 'presumido') {
      const tipo = (atividade || 'servico').toLowerCase().includes('com') ? 'comercio' : 'servico';
      const presuncao = tipo === 'comercio' ? 0.08 : 0.32;
      const baseIR = fat * presuncao;
      const irpj = baseIR * 0.15;
      const csll = fat * (tipo === 'comercio' ? 0.12 : 0.32) * 0.09;
      const pis = fat * 0.0065;
      const cofins = fat * 0.03;
      const iss = tipo === 'servico' ? fat * 0.05 : 0;
      const total = irpj + csll + pis + cofins + iss;

      return {
        regime: 'Lucro Presumido',
        faturamento: fmt(fat),
        tipo_atividade: tipo,
        impostos: {
          irpj: fmt(irpj),
          csll: fmt(csll),
          pis: fmt(pis),
          cofins: fmt(cofins),
          iss: tipo === 'servico' ? fmt(iss) : 'N/A',
        },
        total_mensal: fmt(total),
        carga_tributaria: (total / fat * 100).toFixed(2) + '%',
      };
    }

    if (regime === 'real') {
      const despesas = folha + (fat * 0.3); // estimativa simplificada
      const lucro = fat - despesas;
      const irpj = Math.max(lucro, 0) * 0.15;
      const csll = Math.max(lucro, 0) * 0.09;
      const pis = fat * 0.0165;
      const cofins = fat * 0.076;
      const total = irpj + csll + pis + cofins;

      return {
        regime: 'Lucro Real',
        faturamento: fmt(fat),
        despesas_estimadas: fmt(despesas),
        lucro_estimado: fmt(lucro),
        impostos: { irpj: fmt(irpj), csll: fmt(csll), pis: fmt(pis), cofins: fmt(cofins) },
        total_mensal: fmt(total),
        carga_tributaria: fat > 0 ? (total / fat * 100).toFixed(2) + '%' : '0%',
        nota: 'Lucro Real permite dedução de PIS/COFINS na modalidade não-cumulativa.',
      };
    }

    return { erro: `Regime "${regime}" não reconhecido. Use: simples, presumido ou real.` };
  },

  async simular_regime({ faturamento_anual, folha_anual, atividade }) {
    if (!faturamento_anual) return { erro: 'Parâmetro obrigatório: faturamento_anual' };

    const fat_mensal = faturamento_anual / 12;
    const folha_mensal = (folha_anual || 0) / 12;

    const simples = await tools.calcular_impostos({ regime: 'simples', faturamento_mensal: fat_mensal, folha_mensal, atividade });
    const presumido = await tools.calcular_impostos({ regime: 'presumido', faturamento_mensal: fat_mensal, folha_mensal, atividade });
    const real = await tools.calcular_impostos({ regime: 'real', faturamento_mensal: fat_mensal, folha_mensal, atividade });

    const cenarios = [
      { regime: 'Simples Nacional', mensal: simples.das_mensal, carga: simples.aliquota_efetiva },
      { regime: 'Lucro Presumido', mensal: presumido.total_mensal, carga: presumido.carga_tributaria },
      { regime: 'Lucro Real', mensal: real.total_mensal, carga: real.carga_tributaria },
    ];

    return {
      faturamento_anual: faturamento_anual.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      comparativo: cenarios,
      detalhes: { simples, presumido, real },
      nota: 'Simulação simplificada. Consulte para análise detalhada com dados reais do cliente.',
    };
  },

  async alertas_prazos({ mes }) {
    const now = new Date();
    const mesRef = mes || (now.getMonth() + 1);
    const anoRef = now.getFullYear();

    const alertas = CALENDARIO_FISCAL
      .filter(o => {
        if (o.meses && !o.meses.includes(mesRef)) return false;
        return true;
      })
      .map(o => {
        const diaVenc = Math.min(o.dia, 28);
        const vencimento = new Date(anoRef, mesRef - 1, diaVenc);
        const diasRestantes = Math.ceil((vencimento - now) / (1000 * 60 * 60 * 24));
        return {
          obrigacao: o.obrigacao,
          vencimento: vencimento.toLocaleDateString('pt-BR'),
          dias_restantes: diasRestantes,
          regime: o.regime,
          descricao: o.descricao,
          status: diasRestantes < 0 ? 'VENCIDO' : diasRestantes <= 3 ? 'URGENTE' : diasRestantes <= 7 ? 'ATENÇÃO' : 'OK',
        };
      })
      .sort((a, b) => a.dias_restantes - b.dias_restantes);

    return {
      mes_referencia: `${String(mesRef).padStart(2, '0')}/${anoRef}`,
      total_obrigacoes: alertas.length,
      alertas,
    };
  },

  async gerar_guia_das({ receita_bruta_12m, receita_bruta_mensal, anexo }) {
    if (!receita_bruta_12m || !receita_bruta_mensal || !anexo) {
      return { erro: 'Parâmetros obrigatórios: receita_bruta_12m, receita_bruta_mensal, anexo' };
    }

    const { aliqEfetiva, faixa, deducao } = calcularAliquotaEfetiva(receita_bruta_12m, anexo);
    const valorDAS = receita_bruta_mensal * (aliqEfetiva / 100);
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    return {
      anexo: `Anexo ${anexo}`,
      rbt_12m: fmt(receita_bruta_12m),
      receita_mensal: fmt(receita_bruta_mensal),
      faixa_aliquota: faixa + '%',
      deducao: fmt(deducao),
      aliquota_efetiva: aliqEfetiva.toFixed(2) + '%',
      valor_das: fmt(valorDAS),
      vencimento: `Dia 20 do mês seguinte`,
    };
  },

  async emitir_nfse() {
    return {
      disponivel: false,
      mensagem: 'Integração com Nuvem Fiscal / Focus NFe em desenvolvimento. Em breve será possível emitir NFS-e diretamente pelo sistema.',
    };
  },
};
