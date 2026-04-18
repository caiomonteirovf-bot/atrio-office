// services/auditor-daily.js
// Agenda o relatorio diario do agente Auditor (9h todo dia util).
// Usa as tools via executeToolCall do registry existente.

import { chatWithAgent } from './claude.js';
import { query } from '../db/pool.js';

const AUDITOR_AGENT_ID = 'a0000001-0000-0000-0000-000000000099';

export async function generateAuditorReport(logChat = null) {
  try {
    // Chama a tool direto — o texto ja vem formatado pronto para chat.
    // LLM e overkill aqui; dados ja sao deterministicos.
    const { executeToolCall } = await import('../tools/registry.js');
    const result = await executeToolCall('auditoria_relatorio_diario', {});

    let texto;
    if (result?.erro) {
      texto = `⚠️ Auditor: falha ao consultar Gesthub — ${result.erro}`;
    } else if (result?.texto) {
      texto = result.texto;
    } else {
      texto = 'Auditor: nenhum dado retornado.';
    }

    if (typeof logChat === 'function') {
      logChat({ from: 'Auditor', text: texto, tag: 'auditoria' });
    }
    console.log('[AuditorDaily] relatorio gerado,', texto.length, 'chars');
    return texto;
  } catch (err) {
    console.error('[AuditorDaily] erro:', err.message);
    const fallback = `Falha no relatorio do Auditor: ${err.message}`;
    if (typeof logChat === 'function') {
      logChat({ from: 'Auditor', text: fallback, tag: 'erro' });
    }
    return fallback;
  }
}

/**
 * Agenda execucao diaria as 9h (horario Sao Paulo).
 * Dias uteis apenas (seg-sex).
 */
export function scheduleAuditorDaily(logChat = null) {
  const scheduleNext = () => {
    const now = new Date();
    const target = new Date(now);
    // 9h horario local do server; se ja passou, marca para amanha
    target.setHours(9, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    // Pula fim de semana
    while (target.getDay() === 0 || target.getDay() === 6) {
      target.setDate(target.getDate() + 1);
    }
    const ms = target - now;
    console.log(`[AuditorDaily] proximo relatorio em ${Math.round(ms / 60000)}min (${target.toLocaleString('pt-BR')})`);
    setTimeout(async () => {
      console.log('[AuditorDaily] disparando relatorio...');
      await generateAuditorReport(logChat);
      scheduleNext();
    }, ms);
  };
  scheduleNext();
}
