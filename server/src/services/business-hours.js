// services/business-hours.js
// Helper compartilhado de horário comercial + contexto pro LLM.
// Evita duplicação entre whatsapp.js e webhook-handler.mjs.

const FERIADOS_FIXOS = [
  '01-01', // Ano Novo
  '04-21', // Tiradentes
  '05-01', // Dia do Trabalho
  '09-07', // Independencia
  '10-12', // N. Senhora Aparecida
  '11-02', // Finados
  '11-15', // Proclamacao da Republica
  '12-25', // Natal
];

function now() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Recife' }));
}

export function isHorarioComercial() {
  const n = now();
  const day = n.getDay();
  const hour = n.getHours();
  const mmdd = `${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;

  const isWeekend = day === 0 || day === 6;
  const isHoliday = FERIADOS_FIXOS.includes(mmdd);
  const isLunch = hour >= 12 && hour < 13;
  const open = !isWeekend && !isHoliday && hour >= 8 && hour < 18 && !isLunch;

  const reason = isWeekend ? 'final de semana'
               : isHoliday ? 'feriado'
               : isLunch   ? 'horario de almoco'
               : (hour < 8 || hour >= 18) ? 'fora do horario'
               : null;

  return { open, isLunch, reason, hour, day, isWeekend, isHoliday };
}

/**
 * Retorna o PRÓXIMO momento de retomada (data/hora) em formato legível.
 * Ex: "amanha (SEG) as 08h", "segunda-feira as 08h", "as 13h hoje"
 */
export function proximoRetorno() {
  const n = now();
  const hour = n.getHours();
  const day = n.getDay();

  // Horario de almoco: retoma hoje as 13h
  if (hour >= 12 && hour < 13) return 'hoje às 13h';

  // Antes das 8h em dia util: retoma hoje as 8h
  if (hour < 8 && day >= 1 && day <= 5) return 'hoje às 08h';

  // Depois das 18h em dia util: retoma amanha (se nao for sexta)
  if (hour >= 18 && day >= 1 && day <= 4) return 'amanhã às 08h';

  // Sexta apos 18h OU sabado: segunda 8h
  if ((day === 5 && hour >= 18) || day === 6) return 'segunda-feira às 08h';

  // Domingo: segunda 8h
  if (day === 0) return 'segunda-feira às 08h';

  return 'no próximo horário comercial (seg-sex, 08h-12h e 13h-18h)';
}

/**
 * Bloco de contexto temporal para injetar no prompt da Luna.
 * SEMPRE presente — Luna precisa saber se pode prometer resposta imediata.
 */
export function contextoTemporal() {
  const n = now();
  const { open, reason } = isHorarioComercial();
  const dataStr = n.toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (open) {
    return `⏰ HORARIO ATUAL: ${dataStr} — **DENTRO DO HORARIO** comercial (time interno disponivel).`;
  }

  const retorna = proximoRetorno();
  return [
    `⏰ HORARIO ATUAL: ${dataStr} — **FORA DO HORARIO** (${reason}).`,
    `🚫 O time interno do escritorio NAO esta disponivel agora.`,
    `🗓️ Proximo atendimento humano: **${retorna}**.`,
    `⚠️ NAO prometa retorno imediato. Avise o cliente sobre o horario e o proximo retomada. Voce pode COLETAR informacoes para o time, mas NAO invente respostas tecnicas nem faca promessas falsas de "ja vou verificar" / "passo em breve".`,
  ].join('\n');
}
