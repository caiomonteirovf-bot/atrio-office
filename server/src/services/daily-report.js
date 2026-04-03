import { chatWithAgent } from './claude.js';
import { executeToolCall } from '../tools/registry.js';
import { query } from '../db/pool.js';
import * as telegram from './telegram.js';

const RODRIGO_AGENT_ID = 'a0000001-0000-0000-0000-000000000001';

// Armazena análises do dia para o relatório
const dailyAnalyses = [];

export function addAnalysis(analysis, clientName, phone) {
  dailyAnalyses.push({
    ...analysis,
    clientName,
    phone,
    timestamp: new Date().toISOString(),
  });
}

export function getDailyAnalyses() {
  return [...dailyAnalyses];
}

/**
 * Gera relatório diário e envia para Rodrigo via Telegram
 */
export async function generateDailyReport() {
  try {
    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [RODRIGO_AGENT_ID]);
    if (!agents.length) return;

    // Tasks do dia
    const { rows: tasks } = await query(`
      SELECT t.title, t.status, t.priority, tm.name as assigned_name
      FROM tasks t
      LEFT JOIN team_members tm ON t.assigned_to = tm.id
      WHERE DATE(t.created_at) = CURRENT_DATE OR DATE(t.updated_at) = CURRENT_DATE
    `);

    const analyses = getDailyAnalyses();

    const prompt = `Gere um relatório executivo do dia para o CEO. Seja direto e objetivo.

TASKS DO DIA:
${tasks.length > 0 ? tasks.map(t => `- [${t.status}] ${t.title} → ${t.assigned_name || '?'}`).join('\n') : 'Nenhuma task hoje'}

ANÁLISES DE ATENDIMENTO WHATSAPP (${analyses.length} conversas):
${analyses.length > 0 ? analyses.map(a =>
  `- ${a.clientName}: NPS ${a.nps_estimado}/10, Sentimento: ${a.sentimento_cliente}, Atendida: ${a.demanda_atendida ? 'Sim' : 'NÃO'}${a.motivo ? ` (${a.motivo})` : ''}`
).join('\n') : 'Nenhuma conversa analisada hoje'}

Formate o relatório com:
1. Resumo geral (1-2 frases)
2. Tasks: concluídas, pendentes, bloqueadas
3. Atendimento: NPS médio, satisfação, problemas identificados
4. Alertas e ações recomendadas`;

    const response = await chatWithAgent(
      { ...agents[0], tools: [] },
      [{ role: 'user', content: prompt }]
    );

    if (response.success && response.text) {
      // Envia no Telegram
      telegram.sendAlert(`📋 *Relatório Diário — Rodrigo*\n\n${response.text.substring(0, 4000)}`);
      console.log('[Daily Report] Relatório enviado via Telegram');

      // Limpa análises do dia
      dailyAnalyses.length = 0;

      return response.text;
    }
  } catch (err) {
    console.error('[Daily Report] Erro:', err.message);
  }
}

/**
 * Agenda relatório diário para 18h
 */
export function scheduleDailyReport() {
  function scheduleNext() {
    const now = new Date();
    const target = new Date();
    target.setHours(18, 0, 0, 0); // 18h
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target.getTime() - now.getTime();

    setTimeout(async () => {
      await generateDailyReport();
      scheduleNext(); // agenda próximo dia
    }, delay);

    console.log(`[Daily Report] Próximo relatório em ${Math.round(delay / 3600000)}h`);
  }

  scheduleNext();
}
