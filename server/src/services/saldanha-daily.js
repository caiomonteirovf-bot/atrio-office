// services/saldanha-daily.js
// Agenda a varredura diaria do Saldanha na Legalizacao.
// Rodada 9h30 em dias uteis (logo apos o Auditor, que roda 9h).

import { executeToolCall } from '../tools/registry.js';

export async function generateSaldanhaReport(logChat = null) {
  try {
    const result = await executeToolCall('saldanha_sweep', {});

    let texto;
    if (result?.erro && !result?.texto) {
      texto = `⚠️ Saldanha: falha ao varrer Legalizacao — ${result.erro}`;
    } else if (result?.texto) {
      texto = result.texto;
    } else {
      texto = 'Saldanha: nenhum dado retornado.';
    }

    if (typeof logChat === 'function') {
      logChat({ from: 'Saldanha', text: texto, tag: 'legalizacao' });
    }
    console.log('[SaldanhaDaily] relatorio gerado,', texto.length, 'chars');
    return texto;
  } catch (err) {
    console.error('[SaldanhaDaily] erro:', err.message);
    const fallback = `Falha na varredura do Saldanha: ${err.message}`;
    if (typeof logChat === 'function') {
      logChat({ from: 'Saldanha', text: fallback, tag: 'erro' });
    }
    return fallback;
  }
}

/**
 * Agenda execucao diaria as 9h30 (horario Sao Paulo).
 * Dias uteis apenas (seg-sex), apos o Auditor (9h).
 */
export function scheduleSaldanhaDaily(logChat = null) {
  const scheduleNext = () => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(9, 30, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    while (target.getDay() === 0 || target.getDay() === 6) {
      target.setDate(target.getDate() + 1);
    }
    const ms = target - now;
    console.log(`[SaldanhaDaily] proxima varredura em ${Math.round(ms / 60000)}min (${target.toLocaleString('pt-BR')})`);
    setTimeout(async () => {
      console.log('[SaldanhaDaily] disparando varredura...');
      await generateSaldanhaReport(logChat);
      scheduleNext();
    }, ms);
  };
  scheduleNext();
}
