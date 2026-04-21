/**
 * Task Enricher — executa enriquecimento automático de CNPJs listados no
 * description de uma task, via Gesthub /enriquecer-cnpj (que usa Receita Federal).
 *
 * Usado por:
 *   1) Scheduler — ao criar task "dados incompletos", roda automático
 *      e só mantém a task pendente pros CNPJs que a RF rejeitou
 *   2) Endpoint POST /api/tasks/:id/enrich — acionamento manual
 */
import { query } from '../db/pool.js';
import * as gesthub from './gesthub.js';

const RATE_LIMIT_MS = 1200; // 1.2s entre calls (RF e publica.cnpj.ws limitam)

export function extractCnpjsFromText(text) {
  const set = new Set();
  const rx = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g;
  let m;
  while ((m = rx.exec(String(text || ''))) !== null) {
    const clean = m[0].replace(/\D/g, '');
    if (clean.length === 14) set.add(clean);
  }
  return Array.from(set);
}

/**
 * Roda enriquecimento para a task. Retorna sumário { sucesso, falha, naoEncontrado, ranAt }.
 *
 * @param {string} taskId  UUID da task
 * @param {object} opts
 *   - rewriteDescription (bool): se true, sobrescreve description pra manter só
 *     os CNPJs que FALHARAM (limpa o que já foi resolvido)
 *   - completeIfAllOk (bool): se true e TODAS enriqueceram, marca task como 'done'
 *   - logToChat (fn): callback(msg) opcional pra registrar no chat da equipe
 */
export async function enrichTaskById(taskId, opts = {}) {
  const { rows } = await query('SELECT id, title, description, result FROM tasks WHERE id = $1', [taskId]);
  if (!rows.length) throw new Error('Task não encontrada');
  const task = rows[0];

  const cnpjs = extractCnpjsFromText(task.description);
  if (cnpjs.length === 0) {
    return { skipped: true, reason: 'Nenhum CNPJ no description' };
  }

  const clients = await gesthub.getClients();
  const sucesso = [];
  const falha = [];
  const naoEncontrado = [];

  for (const cnpj of cnpjs) {
    const cli = clients.find(c => (c.document || '').replace(/\D/g, '') === cnpj);
    if (!cli) { naoEncontrado.push({ cnpj }); continue; }
    try {
      await gesthub.enrichClientCnpj(cli.id);
      sucesso.push({ cnpj, nome: cli.legalName, id: cli.id });
    } catch (e) {
      falha.push({ cnpj, nome: cli.legalName, id: cli.id, erro: e.message });
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  const ranAt = new Date().toISOString();
  const summary = { sucesso, falha, naoEncontrado, ranAt, total: cnpjs.length };

  // Rewrite description: manter só os que falharam/não encontrados (esses precisam ação humana)
  if (opts.rewriteDescription) {
    const pendentes = [...falha, ...naoEncontrado];
    if (pendentes.length === 0) {
      // Nada sobrou
      await query(
        `UPDATE tasks
         SET description = $1,
             result = COALESCE(result,'{}'::jsonb) || $2::jsonb,
             status = CASE WHEN $3::boolean THEN 'done' ELSE status END,
             completed_at = CASE WHEN $3::boolean THEN NOW() ELSE completed_at END,
             updated_at = NOW()
         WHERE id = $4`,
        [
          `Enriquecimento automático concluiu ${sucesso.length} CNPJ(s) via Receita Federal em ${ranAt}. Nenhuma pendência restante.`,
          JSON.stringify({ enrich: summary }),
          !!opts.completeIfAllOk,
          taskId,
        ]
      );
    } else {
      const lista = pendentes.map(p =>
        `- ${p.nome || 'cliente'} (${p.cnpj}) — ${p.erro ? 'RF rejeitou: ' + String(p.erro).slice(0, 80) : 'não encontrado no Gesthub'}`
      ).join('\n');
      const novoDesc =
        `Enriquecimento automático: ${sucesso.length} OK via RF, ${pendentes.length} precisam de ação humana.\n\n` +
        `Clientes que requerem revisão manual:\n\n${lista}\n\n` +
        `Ação sugerida: confirmar CNPJ junto ao cliente ou dar baixa no cadastro.`;
      await query(
        `UPDATE tasks
         SET description = $1,
             result = COALESCE(result,'{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE id = $3`,
        [novoDesc, JSON.stringify({ enrich: summary }), taskId]
      );
    }
  } else {
    // Só persiste o summary
    await query(
      `UPDATE tasks SET result = COALESCE(result,'{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({ enrich: summary }), taskId]
    );
  }

  // Log no chat — resumo compacto
  if (typeof opts.logToChat === 'function') {
    try {
      const pend = falha.length + naoEncontrado.length;
      const linha = pend === 0
        ? `✅ Enriquecimento concluído: ${sucesso.length} cliente(s) atualizados via Receita Federal. Task "${task.title}" resolvida sem necessidade humana.`
        : `⚠️ Enriquecimento parcial: ${sucesso.length} OK via RF, ${pend} requer ação humana. Task "${task.title}" atualizada com lista reduzida.`;
      await opts.logToChat(linha);
    } catch {}
  }

  return summary;
}
