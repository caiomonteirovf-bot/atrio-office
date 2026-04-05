import { chatWithAgent } from './claude.js';
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

    // Tasks do dia (com resultado e tempo de execução)
    const { rows: tasks } = await query(`
      SELECT t.title, t.status, t.priority, t.result, t.created_at, t.completed_at,
             tm.name as assigned_name, d.name as delegated_name,
             EXTRACT(EPOCH FROM (COALESCE(t.completed_at, NOW()) - t.created_at)) / 60 as minutes_elapsed
      FROM tasks t
      LEFT JOIN team_members tm ON t.assigned_to = tm.id
      LEFT JOIN team_members d ON t.delegated_by = d.id
      WHERE DATE(t.created_at) = CURRENT_DATE OR DATE(t.updated_at) = CURRENT_DATE
      ORDER BY t.created_at ASC
    `);

    const done = tasks.filter(t => t.status === 'done');
    const blocked = tasks.filter(t => t.status === 'blocked');
    const pending = tasks.filter(t => t.status === 'pending');
    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const stalled = [...pending, ...inProgress].filter(t => t.minutes_elapsed > 30);

    const analyses = getDailyAnalyses();

    const prompt = `Gere um relatório executivo do dia para o CEO (Caio). Seja direto, objetivo e com tom de diretor de operações.

RESUMO NUMÉRICO:
- Total de tasks: ${tasks.length}
- Concluídas: ${done.length}
- Bloqueadas: ${blocked.length}
- Pendentes: ${pending.length}
- Em andamento: ${inProgress.length}
- Paradas há mais de 30min: ${stalled.length}

TASKS CONCLUÍDAS:
${done.length > 0 ? done.map(t => `- ✅ ${t.title} → ${t.assigned_name} (${Math.round(t.minutes_elapsed)}min)`).join('\n') : 'Nenhuma'}

TASKS BLOQUEADAS (ATENÇÃO):
${blocked.length > 0 ? blocked.map(t => {
  const result = typeof t.result === 'string' ? JSON.parse(t.result) : t.result;
  const erro = result?.error || result?.text?.substring(0, 100) || 'Motivo não registrado';
  return `- 🚫 ${t.title} → ${t.assigned_name} — Motivo: ${erro}`;
}).join('\n') : 'Nenhuma'}

TASKS PARADAS (SEM PROGRESSO > 30min):
${stalled.length > 0 ? stalled.map(t => `- ⚠️ ${t.title} → ${t.assigned_name} — Parada há ${Math.round(t.minutes_elapsed)}min`).join('\n') : 'Nenhuma'}

ANÁLISES DE ATENDIMENTO WHATSAPP (${analyses.length} conversas):
${analyses.length > 0 ? analyses.map(a =>
  `- ${a.clientName}: NPS ${a.nps_estimado}/10, Sentimento: ${a.sentimento_cliente}, Atendida: ${a.demanda_atendida ? 'Sim' : 'NÃO'}${a.motivo ? ` (${a.motivo})` : ''}`
).join('\n') : 'Nenhuma conversa analisada hoje'}

Formate o relatório com:
1. Resumo executivo (2-3 frases — o que foi bom e o que precisa de atenção)
2. Produtividade: tasks concluídas por agente, tempo médio
3. Problemas: tasks bloqueadas/paradas e por quê
4. Fluxos interrompidos: dados que não chegaram, integrações que falharam
5. Ações recomendadas para amanhã`;

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
