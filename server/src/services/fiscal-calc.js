// services/fiscal-calc.js
// Lógicas fiscais PURAS — sem I/O, sem formatação.
// Usadas por tools/campelo.js (que adiciona formatação pt-BR + UI polish).
// Estas funções são a "fonte da verdade" testável via unit tests.
//
// Referências:
//   - Simples Nacional Anexos I/III/V — tabela 2024 vigente
//   - LC 123/2006 — Fator R (folha/receita)
//   - Presumido — IN RFB 1.700/2017
//   - Retenções federais — IN SRF 459/2004 (mínimo R$ 215,05)

// ============================================================
// SIMPLES NACIONAL — tabelas de alíquota
// ============================================================

function deepFreeze(obj) {
  Object.values(obj).forEach(v => {
    if (Array.isArray(v)) { v.forEach(deepFreeze); Object.freeze(v); }
    else if (v && typeof v === 'object') deepFreeze(v);
  });
  return Object.freeze(obj);
}

export const SIMPLES_ANEXOS = deepFreeze({
  I: [
    { ate: 180000,  aliq: 4.0,  ded: 0      },
    { ate: 360000,  aliq: 7.3,  ded: 5940   },
    { ate: 720000,  aliq: 9.5,  ded: 13860  },
    { ate: 1800000, aliq: 10.7, ded: 22500  },
    { ate: 3600000, aliq: 14.3, ded: 87300  },
    { ate: 4800000, aliq: 19.0, ded: 378000 },
  ],
  III: [
    { ate: 180000,  aliq: 6.0,  ded: 0      },
    { ate: 360000,  aliq: 11.2, ded: 9360   },
    { ate: 720000,  aliq: 13.5, ded: 17640  },
    { ate: 1800000, aliq: 16.0, ded: 35640  },
    { ate: 3600000, aliq: 21.0, ded: 125640 },
    { ate: 4800000, aliq: 33.0, ded: 648000 },
  ],
  V: [
    { ate: 180000,  aliq: 15.5, ded: 0      },
    { ate: 360000,  aliq: 18.0, ded: 4500   },
    { ate: 720000,  aliq: 19.5, ded: 9900   },
    { ate: 1800000, aliq: 20.5, ded: 17100  },
    { ate: 3600000, aliq: 23.0, ded: 62100  },
    { ate: 4800000, aliq: 30.5, ded: 540000 },
  ],
});

/**
 * Calcula a alíquota efetiva do Simples Nacional.
 * @param {number} rbt12 - Receita bruta 12 meses
 * @param {'I'|'III'|'V'} anexo
 * @returns {{aliqEfetiva:number, faixa:number, deducao:number}} aliqEfetiva em percentual (0-100)
 */
export function calcularAliquotaEfetiva(rbt12, anexo) {
  if (!Number.isFinite(rbt12) || rbt12 <= 0) {
    throw new Error('rbt12 deve ser numero positivo');
  }
  const tabela = SIMPLES_ANEXOS[anexo] || SIMPLES_ANEXOS.III;
  const faixa = tabela.find(f => rbt12 <= f.ate) || tabela[tabela.length - 1];
  const aliqEfetiva = ((rbt12 * faixa.aliq / 100) - faixa.ded) / rbt12 * 100;
  return {
    aliqEfetiva: Math.max(aliqEfetiva, 0),
    faixa: faixa.aliq,
    deducao: faixa.ded,
  };
}

// ============================================================
// FATOR R — LC 123/2006 Art. 18 §5-J
// ============================================================

/**
 * Retorna o Fator R (proporção folha/receita) e anexo aplicavel.
 * @param {number} folha12m
 * @param {number} receita12m
 * @returns {{fatorR:number, anexo:'III'|'V', pct:number}}
 */
export function calcularFatorR(folha12m, receita12m) {
  if (!Number.isFinite(receita12m) || receita12m <= 0) {
    throw new Error('receita_12m deve ser maior que zero');
  }
  if (!Number.isFinite(folha12m) || folha12m < 0) {
    throw new Error('folha_12m deve ser >= 0');
  }
  const fatorR = folha12m / receita12m;
  const anexo = fatorR >= 0.28 ? 'III' : 'V';
  return { fatorR, anexo, pct: fatorR * 100 };
}

// ============================================================
// IMPOSTOS — apuracao por regime
// ============================================================

/**
 * Apuracao mensal do Simples Nacional.
 * @returns {{regime:string, rbt12:number, fatorR:number, anexo:string, aliqEfetiva:number, dasMensal:number}}
 */
export function apurarSimples({ faturamento_mensal, folha_mensal = 0 }) {
  if (!Number.isFinite(faturamento_mensal) || faturamento_mensal < 0) {
    throw new Error('faturamento_mensal invalido');
  }
  if (faturamento_mensal === 0) {
    return { regime: 'simples', rbt12: 0, fatorR: 0, anexo: 'V', aliqEfetiva: 0, dasMensal: 0 };
  }
  const rbt12 = faturamento_mensal * 12;
  const folha12 = folha_mensal * 12;
  const { fatorR, anexo } = calcularFatorR(folha12, rbt12);
  const { aliqEfetiva } = calcularAliquotaEfetiva(rbt12, anexo);
  const dasMensal = faturamento_mensal * (aliqEfetiva / 100);
  return {
    regime: 'simples',
    rbt12, fatorR, anexo, aliqEfetiva,
    dasMensal,
  };
}

/**
 * Apuracao mensal do Lucro Presumido (simplificada).
 */
export function apurarPresumido({ faturamento_mensal, atividade = 'servico' }) {
  if (!Number.isFinite(faturamento_mensal) || faturamento_mensal < 0) {
    throw new Error('faturamento_mensal invalido');
  }
  const tipo = String(atividade).toLowerCase().includes('com') ? 'comercio' : 'servico';
  const presuncaoIR = tipo === 'comercio' ? 0.08 : 0.32;
  const presuncaoCSLL = tipo === 'comercio' ? 0.12 : 0.32;

  const irpj   = faturamento_mensal * presuncaoIR * 0.15;
  const csll   = faturamento_mensal * presuncaoCSLL * 0.09;
  const pis    = faturamento_mensal * 0.0065;
  const cofins = faturamento_mensal * 0.03;
  const iss    = tipo === 'servico' ? faturamento_mensal * 0.05 : 0;
  const total  = irpj + csll + pis + cofins + iss;

  return {
    regime: 'presumido',
    tipo,
    impostos: { irpj, csll, pis, cofins, iss },
    total,
    cargaPct: faturamento_mensal > 0 ? (total / faturamento_mensal) * 100 : 0,
  };
}

/**
 * Apuracao mensal simplificada do Lucro Real.
 * Assume despesas = folha + 30% do faturamento (estimativa).
 */
export function apurarReal({ faturamento_mensal, folha_mensal = 0 }) {
  if (!Number.isFinite(faturamento_mensal) || faturamento_mensal < 0) {
    throw new Error('faturamento_mensal invalido');
  }
  const despesas = folha_mensal + faturamento_mensal * 0.3;
  const lucro = faturamento_mensal - despesas;
  const irpj   = Math.max(lucro, 0) * 0.15;
  const csll   = Math.max(lucro, 0) * 0.09;
  const pis    = faturamento_mensal * 0.0165;
  const cofins = faturamento_mensal * 0.076;
  const total  = irpj + csll + pis + cofins;
  return {
    regime: 'real',
    despesas, lucro,
    impostos: { irpj, csll, pis, cofins },
    total,
    cargaPct: faturamento_mensal > 0 ? (total / faturamento_mensal) * 100 : 0,
  };
}

// ============================================================
// RETENCOES FEDERAIS (IN SRF 459/2004)
// Aplicaveis quando pagador eh PJ e valor > R$ 215,05
// ============================================================

/** Valor minimo acima do qual ha retencao (IN SRF 459/2004 + ajustes). */
export const RETENCAO_VALOR_MINIMO = 215.05;

/**
 * Calcula retencoes federais sobre servico prestado para PJ.
 * @param {object} params
 * @param {number} params.valor - valor bruto do servico
 * @param {boolean} [params.tomadorPJ=true] - tomador eh pessoa juridica
 * @param {boolean} [params.simplesOptante=false] - prestador eh optante do Simples (nao retem PIS/COFINS)
 * @returns {{aplica:boolean, irrf:number, csll:number, pis:number, cofins:number, total:number, liquido:number}}
 */
export function calcularRetencoesFederais({ valor, tomadorPJ = true, simplesOptante = false }) {
  const zero = { aplica: false, irrf: 0, csll: 0, pis: 0, cofins: 0, total: 0, liquido: valor };
  if (!Number.isFinite(valor) || valor <= 0) return zero;
  if (!tomadorPJ) return zero;
  if (valor < RETENCAO_VALOR_MINIMO) return zero;

  const irrf   = valor * 0.015;  // 1,5%
  const csll   = valor * 0.01;   // 1%
  const pis    = simplesOptante ? 0 : valor * 0.0065;
  const cofins = simplesOptante ? 0 : valor * 0.03;
  const total  = irrf + csll + pis + cofins;
  return {
    aplica: true,
    irrf, csll, pis, cofins, total,
    liquido: valor - total,
  };
}
