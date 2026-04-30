// services/feriados.js
// Fonte unica de feriados nacionais brasileiros (fixos + moveis calculados da Pascoa).
// Usado por business-hours.js, whatsapp.js e exposto via API /api/feriados.

const FERIADOS_FIXOS = [
  { mmdd: '01-01', nome: 'Confraternização Universal' },
  { mmdd: '04-21', nome: 'Tiradentes' },
  { mmdd: '05-01', nome: 'Dia do Trabalho' },
  { mmdd: '09-07', nome: 'Independência do Brasil' },
  { mmdd: '10-12', nome: 'Nossa Senhora Aparecida' },
  { mmdd: '11-02', nome: 'Finados' },
  { mmdd: '11-15', nome: 'Proclamação da República' },
  { mmdd: '11-20', nome: 'Dia da Consciência Negra' }, // lei 14.759/2024
  { mmdd: '12-25', nome: 'Natal' },
];

/**
 * Calcula a data da Pascoa pelo algoritmo de Meeus/Jones/Butcher.
 * Retorna Date (meio-dia UTC pra evitar drift de timezone).
 */
function calcularPascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia, 12));
}

function addDias(date, dias) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
}

function toMMDD(date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function toYMD(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Retorna lista de feriados nacionais pro ano com nome e tipo.
 * Inclui fixos + moveis (Carnaval, Sexta Santa, Corpus Christi).
 */
export function feriadosDoAno(ano) {
  const pascoa = calcularPascoa(ano);
  const lista = [];

  // Fixos
  for (const f of FERIADOS_FIXOS) {
    lista.push({
      data: `${ano}-${f.mmdd}`,
      nome: f.nome,
      tipo: 'nacional_fixo',
    });
  }

  // Moveis (baseados na Pascoa)
  const moveis = [
    { offset: -48, nome: 'Carnaval (segunda)', tipo: 'nacional_movel' },
    { offset: -47, nome: 'Carnaval (terça)', tipo: 'nacional_movel' },
    { offset: -46, nome: 'Quarta-feira de Cinzas (meio-dia)', tipo: 'facultativo' },
    { offset: -2,  nome: 'Sexta-feira Santa', tipo: 'nacional_movel' },
    { offset: 0,   nome: 'Páscoa', tipo: 'nacional_movel' },
    { offset: 60,  nome: 'Corpus Christi', tipo: 'nacional_movel' },
  ];

  for (const m of moveis) {
    const d = addDias(pascoa, m.offset);
    lista.push({
      data: toYMD(d),
      nome: m.nome,
      tipo: m.tipo,
    });
  }

  // Ordena por data
  lista.sort((a, b) => a.data.localeCompare(b.data));
  return lista;
}

/**
 * Verifica se uma data (Date ou YYYY-MM-DD) eh feriado nacional.
 * Retorna { isHoliday, nome, tipo } | { isHoliday: false }.
 */
export function checarFeriado(date) {
  const d = date instanceof Date ? date : new Date(date);
  const ano = d.getFullYear();
  const ymd = `${ano}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const feriados = feriadosDoAno(ano);
  const match = feriados.find(f => f.data === ymd && f.tipo !== 'facultativo');
  if (match) return { isHoliday: true, nome: match.nome, tipo: match.tipo };
  return { isHoliday: false };
}

/**
 * Set rapido de MM-DD dos feriados FIXOS (compat com codigo legado que so checa mmdd).
 */
export const FERIADOS_MMDD_FIXOS = FERIADOS_FIXOS.map(f => f.mmdd);

/**
 * Set rapido de YYYY-MM-DD dos feriados (fixos + moveis) de um ano.
 */
export function feriadosSetYMD(ano) {
  return new Set(feriadosDoAno(ano).filter(f => f.tipo !== 'facultativo').map(f => f.data));
}
