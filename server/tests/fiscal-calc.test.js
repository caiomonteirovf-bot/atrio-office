// tests/fiscal-calc.test.js
// Unit tests das logicas fiscais puras.
// Run: npm test
//
// Cobertura:
//   - calcularAliquotaEfetiva: 1a faixa, faixas intermediarias, ultima faixa, anexo invalido
//   - calcularFatorR: rounding, edge cases (folha 0, receita invalida)
//   - apurarSimples: cenarios reais (cliente pequeno, medio, fronteira Fator R)
//   - apurarPresumido: comercio vs servico
//   - apurarReal: lucro positivo vs prejuizo
//   - calcularRetencoesFederais: abaixo do minimo, PJ vs PF, Simples optante

import { describe, it, expect } from 'vitest';
import {
  calcularAliquotaEfetiva,
  calcularFatorR,
  apurarSimples,
  apurarPresumido,
  apurarReal,
  calcularRetencoesFederais,
  RETENCAO_VALOR_MINIMO,
  SIMPLES_ANEXOS,
} from '../src/services/fiscal-calc.js';

describe('calcularAliquotaEfetiva', () => {
  it('Anexo I 1a faixa: rbt12 R$ 100k → aliquota nominal (sem deducao)', () => {
    const { aliqEfetiva, faixa, deducao } = calcularAliquotaEfetiva(100_000, 'I');
    expect(faixa).toBe(4.0);
    expect(deducao).toBe(0);
    expect(aliqEfetiva).toBeCloseTo(4.0, 2);
  });

  it('Anexo III 3a faixa: rbt12 R$ 500k → aliquota efetiva < nominal por causa da deducao', () => {
    const { aliqEfetiva, faixa, deducao } = calcularAliquotaEfetiva(500_000, 'III');
    expect(faixa).toBe(13.5);
    expect(deducao).toBe(17640);
    // (500000 * 13.5/100 - 17640) / 500000 * 100 = (67500 - 17640) / 500000 * 100 = 9.972
    expect(aliqEfetiva).toBeCloseTo(9.972, 2);
  });

  it('Anexo V na ultima faixa: rbt12 R$ 4M → aliquota alta', () => {
    const { aliqEfetiva } = calcularAliquotaEfetiva(4_000_000, 'V');
    // (4M * 30.5/100 - 540000) / 4M * 100 = (1.22M - 540k) / 4M * 100 = 17.0
    expect(aliqEfetiva).toBeCloseTo(17.0, 1);
  });

  it('anexo invalido cai no default (III)', () => {
    const x = calcularAliquotaEfetiva(500_000, 'INEXISTENTE');
    expect(x.faixa).toBe(13.5); // faixa Anexo III 3a
  });

  it('rbt12 acima da ultima faixa usa a ultima faixa', () => {
    const { faixa } = calcularAliquotaEfetiva(10_000_000, 'I');
    expect(faixa).toBe(19.0);
  });

  it('rbt12 <= 0 lanca erro', () => {
    expect(() => calcularAliquotaEfetiva(0, 'I')).toThrow();
    expect(() => calcularAliquotaEfetiva(-100, 'I')).toThrow();
  });

  it('tabela esta congelada (imutavel)', () => {
    expect(() => { SIMPLES_ANEXOS.I.push({ ate: 1, aliq: 1, ded: 1 }); }).toThrow();
  });
});

describe('calcularFatorR', () => {
  it('folha 30% da receita → Fator R = 0.30, Anexo III', () => {
    const r = calcularFatorR(300_000, 1_000_000);
    expect(r.fatorR).toBe(0.3);
    expect(r.anexo).toBe('III');
    expect(r.pct).toBe(30);
  });

  it('folha 27.99% → Fator R abaixo do limite, Anexo V', () => {
    const r = calcularFatorR(279_900, 1_000_000);
    expect(r.anexo).toBe('V');
  });

  it('folha EXATAMENTE 28% → Anexo III (limiar inclusivo)', () => {
    const r = calcularFatorR(280_000, 1_000_000);
    expect(r.fatorR).toBe(0.28);
    expect(r.anexo).toBe('III');
  });

  it('folha zero → Anexo V', () => {
    const r = calcularFatorR(0, 100_000);
    expect(r.fatorR).toBe(0);
    expect(r.anexo).toBe('V');
  });

  it('receita zero ou negativa → erro', () => {
    expect(() => calcularFatorR(100, 0)).toThrow();
    expect(() => calcularFatorR(100, -1)).toThrow();
  });

  it('folha negativa → erro', () => {
    expect(() => calcularFatorR(-1, 1000)).toThrow();
  });
});

describe('apurarSimples', () => {
  it('empresa pequena: R$ 20k/mes, folha 6k/mes → Fator R 30%, Anexo III', () => {
    const r = apurarSimples({ faturamento_mensal: 20000, folha_mensal: 6000 });
    expect(r.anexo).toBe('III');
    expect(r.rbt12).toBe(240000);
    expect(r.aliqEfetiva).toBeGreaterThan(5);
    expect(r.aliqEfetiva).toBeLessThan(12);
    expect(r.dasMensal).toBeCloseTo(20000 * r.aliqEfetiva / 100, 2);
  });

  it('servico sem folha: Anexo V (alíquota muito maior)', () => {
    const comFolha = apurarSimples({ faturamento_mensal: 30000, folha_mensal: 10000 });
    const semFolha = apurarSimples({ faturamento_mensal: 30000, folha_mensal: 0 });
    expect(comFolha.anexo).toBe('III');
    expect(semFolha.anexo).toBe('V');
    expect(semFolha.dasMensal).toBeGreaterThan(comFolha.dasMensal);
  });

  it('faturamento zero → das zero, sem crash', () => {
    const r = apurarSimples({ faturamento_mensal: 0, folha_mensal: 0 });
    expect(r.dasMensal).toBe(0);
  });

  it('WeGo-like: R$ 200k/mes → Anexo I equivalente muito maior DAS', () => {
    const r = apurarSimples({ faturamento_mensal: 200000, folha_mensal: 60000 });
    // 200k * 12 = 2.4M → 5a faixa Anexo III (21% nominal)
    expect(r.rbt12).toBe(2_400_000);
    expect(r.anexo).toBe('III');
    expect(r.aliqEfetiva).toBeGreaterThan(15);
  });
});

describe('apurarPresumido', () => {
  it('servico: PIS 0.65% + COFINS 3% + ISS 5% + IRPJ/CSLL sobre presuncao', () => {
    const r = apurarPresumido({ faturamento_mensal: 100000, atividade: 'servico' });
    expect(r.tipo).toBe('servico');
    expect(r.impostos.pis).toBeCloseTo(650, 2);
    expect(r.impostos.cofins).toBeCloseTo(3000, 2);
    expect(r.impostos.iss).toBeCloseTo(5000, 2);
    // IRPJ servico: 100000 * 32% * 15% = 4800
    expect(r.impostos.irpj).toBeCloseTo(4800, 2);
  });

  it('comercio: sem ISS, presuncao IRPJ 8%', () => {
    const r = apurarPresumido({ faturamento_mensal: 100000, atividade: 'comercio' });
    expect(r.tipo).toBe('comercio');
    expect(r.impostos.iss).toBe(0);
    // IRPJ comercio: 100000 * 8% * 15% = 1200
    expect(r.impostos.irpj).toBeCloseTo(1200, 2);
  });

  it('faturamento zero retorna carga 0', () => {
    const r = apurarPresumido({ faturamento_mensal: 0, atividade: 'servico' });
    expect(r.total).toBe(0);
    expect(r.cargaPct).toBe(0);
  });

  it('atividade omitida assume servico', () => {
    const r = apurarPresumido({ faturamento_mensal: 10000 });
    expect(r.tipo).toBe('servico');
  });
});

describe('apurarReal', () => {
  it('faturamento alto com lucro positivo paga IRPJ + CSLL', () => {
    const r = apurarReal({ faturamento_mensal: 100000, folha_mensal: 10000 });
    // despesas = 10000 + 30000 = 40000; lucro = 60000
    expect(r.despesas).toBe(40000);
    expect(r.lucro).toBe(60000);
    expect(r.impostos.irpj).toBeCloseTo(9000, 2);
    expect(r.impostos.csll).toBeCloseTo(5400, 2);
  });

  it('prejuizo: IRPJ e CSLL viram zero, PIS/COFINS continuam sobre receita', () => {
    const r = apurarReal({ faturamento_mensal: 10000, folha_mensal: 20000 });
    // despesas = 20000 + 3000 = 23000; lucro = -13000 (prejuizo)
    expect(r.lucro).toBeLessThan(0);
    expect(r.impostos.irpj).toBe(0);
    expect(r.impostos.csll).toBe(0);
    expect(r.impostos.pis).toBeGreaterThan(0);   // continua sobre receita
  });
});

describe('calcularRetencoesFederais', () => {
  it('valor abaixo do minimo: nao retem nada', () => {
    const r = calcularRetencoesFederais({ valor: 200 });
    expect(r.aplica).toBe(false);
    expect(r.total).toBe(0);
  });

  it('valor EXATAMENTE no minimo aplica retencao', () => {
    const r = calcularRetencoesFederais({ valor: RETENCAO_VALOR_MINIMO });
    expect(r.aplica).toBe(true);
    expect(r.total).toBeGreaterThan(0);
  });

  it('R$ 1850 (honorario tipico): IRRF+CSLL+PIS+COFINS', () => {
    const r = calcularRetencoesFederais({ valor: 1850 });
    expect(r.aplica).toBe(true);
    expect(r.irrf).toBeCloseTo(27.75, 2);      // 1.5%
    expect(r.csll).toBeCloseTo(18.50, 2);      // 1.0%
    expect(r.pis).toBeCloseTo(12.025, 2);      // 0.65%
    expect(r.cofins).toBeCloseTo(55.50, 2);    // 3.0%
    expect(r.total).toBeCloseTo(113.775, 2);
    expect(r.liquido).toBeCloseTo(1736.225, 2);
  });

  it('tomador PF: nao retem (Lei 9430/96)', () => {
    const r = calcularRetencoesFederais({ valor: 5000, tomadorPJ: false });
    expect(r.aplica).toBe(false);
    expect(r.total).toBe(0);
  });

  it('Simples Nacional: nao retem PIS/COFINS, mantem IRRF/CSLL', () => {
    const r = calcularRetencoesFederais({ valor: 1850, simplesOptante: true });
    expect(r.aplica).toBe(true);
    expect(r.pis).toBe(0);
    expect(r.cofins).toBe(0);
    expect(r.irrf).toBeCloseTo(27.75, 2);
    expect(r.csll).toBeCloseTo(18.50, 2);
  });

  it('valor invalido retorna zero sem crash', () => {
    expect(calcularRetencoesFederais({ valor: 0 }).aplica).toBe(false);
    expect(calcularRetencoesFederais({ valor: -100 }).aplica).toBe(false);
    expect(calcularRetencoesFederais({ valor: NaN }).aplica).toBe(false);
  });
});

describe('integracao: Fator R + aliquota efetiva', () => {
  it('cliente migra de Anexo V para III com aumento de pro-labore', () => {
    const antes = apurarSimples({ faturamento_mensal: 50000, folha_mensal: 5000 });   // Fator 10%
    const depois = apurarSimples({ faturamento_mensal: 50000, folha_mensal: 15000 }); // Fator 30%
    expect(antes.anexo).toBe('V');
    expect(depois.anexo).toBe('III');
    // economia de DAS ao migrar
    expect(depois.dasMensal).toBeLessThan(antes.dasMensal);
  });
});
