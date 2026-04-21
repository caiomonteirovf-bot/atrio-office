import { query } from '../db/pool.js';
import { humanizeErrorShort } from './error-humanizer.js';
import { logEvent } from './activity-log.js';
import { chatWithAgent } from './claude.js';
import { executeToolCall } from '../tools/registry.js';
import { sendNfseToGroup, sendAlertToGroup, sendMessage } from './whatsapp.js';
import * as telegram from './telegram.js';
import { createNotification } from './notifications.js';

let broadcastFn = null;
let logChatFn = null;
const taskStates = new Map(); // taskId → 'processing' | 'done' (atomic check-and-set)
const recentlyNotifiedClients = new Set(); // Evita mensagem duplicada ao mesmo cliente

export function setBroadcast(fn) {
  broadcastFn = fn;
}

export function setLogChat(fn) {
  logChatFn = fn;
}

function chat(msg) {
  logChatFn?.(msg);
}

// ============================================
// PROCESSA TASK → AGENTE IA
// ============================================
export async function processTask(taskId) {
  if (taskStates.has(taskId)) return;
  taskStates.set(taskId, 'processing');
  setTimeout(() => taskStates.delete(taskId), 5 * 60 * 1000);

  try {
    const { rows: tasks } = await query(`
      SELECT t.*, tm.agent_id, tm.type as member_type, tm.name as assigned_name
      FROM tasks t
      JOIN team_members tm ON t.assigned_to = tm.id
      WHERE t.id = $1
    `, [taskId]);

    if (!tasks.length) return;
    const task = tasks[0];

    if (task.member_type !== 'ai' || !task.agent_id) {
      console.log(`[Orchestrator] Task ${taskId} → humano (${task.assigned_name})`);
      return;
    }

    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [task.agent_id]);
    if (!agents.length) {
      console.log(`[Orchestrator] Task ${taskId}: agente id=${task.agent_id} não encontrado no banco`);
      await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
        [JSON.stringify({ error: `Agente IA (id=${task.agent_id}) não encontrado no banco de dados` }), taskId]);
      broadcastFn?.({ type: 'task_blocked', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'blocked' } });
      await notifyTeamFailure({ title: task.title, assigned_name: task.assigned_name || 'N/A' }, `Agente IA (id=${task.agent_id}) não encontrado no banco de dados. Task ficará bloqueada até correção.`);
      return;
    }
    const agent = agents[0];

    // Preserva metadata original (chatId do cliente)
    let originalMeta = null;
    try {
      if (task.result) originalMeta = typeof task.result === 'string' ? JSON.parse(task.result) : task.result;
    } catch {}

    // Guard de aprovacao humana: se a task foi criada com esse flag,
    // nao processa ate humano aprovar (ex: cobranca via Luna).
    if (originalMeta?.aguardando_aprovacao_humana === true) {
      console.log(`[Orchestrator] Task ${taskId} aguardando aprovacao humana — skip`);
      taskStates.delete(taskId);
      return;
    }

    console.log(`[Orchestrator] Processando "${task.title}" → ${agent.name}`);
    // Atomic checkout — garante que somente um worker processa
    // Permite claim a partir de 'pending' OU 'in_progress' (recovery de crash)
    const claim = await query(
      `UPDATE tasks
          SET status = 'in_progress', updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'in_progress')
      RETURNING id, status`,
      [taskId]
    );
    if (!claim.rows.length) {
      console.log(`[Orchestrator] Task ${taskId} ja foi processada ou cancelada — skip`);
      taskStates.delete(taskId);
      return;
    }
    broadcastFn?.({ type: 'task_updated', task: { id: taskId, status: 'in_progress', assigned_name: task.assigned_name } });

    // Chat: Rodrigo delega para o agente — extrai info da metadata para mensagem rica
    const clienteName = originalMeta?.cliente_nome || extractClientName(task, originalMeta);
    // Estrito: só é NFS-e se tag explícita [NFSE] OU tiver 'nota' + 'emitir/emissão' juntos.
    // Tag [FISCAL] NÃO é suficiente — é categoria ampla (imposto, guia, declaração, etc).
    const t = task.title || '';
    const hasNfseTag = t.includes('[NFSE]');
    const hasNotaEmit = /(emitir|emiss[aã]o)/i.test(t) && /(nota|nfs.?-?e)/i.test(t);
    const isNfseTask = hasNfseTag || hasNotaEmit;
    const parsedFields = originalMeta?.parsed_fields || {};

    // Notificação no chat: sistema informa que task foi delegada
    chat({ from: agent.name, text: `📋 Recebi a task: ${task.title.replace(/^\[.*?\]\s*/, '')}. Processando...`, tag: isNfseTask ? 'nfs-e' : 'task' });

    // Monta prompt com dados estruturados para NFS-e
    let taskPrompt;
    if (isNfseTask && Object.keys(parsedFields).length > 0) {
      const pf = parsedFields;
      const clientePhoneCtx = originalMeta?.cliente_phone || '';
      taskPrompt = `Voce recebeu uma tarefa de emissao de NFS-e.

TAREFA: ${task.title}
PRIORIDADE: ${task.priority}

DADOS ESTRUTURADOS (use EXATAMENTE estes valores na tool emitir_nfse):
- prestador_cnpj: ${pf.prestador_cnpj || 'NAO INFORMADO - passe cliente_phone como fallback'}
- prestador_nome: ${pf.prestador_nome || 'NAO INFORMADO'}
- tomador_cpf_cnpj: ${pf.tomador_cpf_cnpj || 'NAO INFORMADO'}
- tomador_tipo_doc: ${pf.tomador_tipo_doc || 'NAO INFORMADO'}
- valor: ${pf.valor || 'NAO INFORMADO'}
- descricao: ${pf.descricao || 'NAO INFORMADA'}
- cep_tomador: ${pf.cep_tomador || 'NAO INFORMADO'}
- cliente_phone (solicitante WhatsApp): ${clientePhoneCtx || 'NAO INFORMADO'}

REGRA: prestador = cliente da carteira que solicitou via WhatsApp, identificado pelo telefone.
SE prestador_cnpj acima estiver NAO INFORMADO mas cliente_phone existir, passe cliente_phone na tool emitir_nfse - ela resolve via Gesthub automaticamente.

IMPORTANTE: tomador_cpf_cnpj e ${pf.tomador_cpf_cnpj || '?'} (NAO confunda com CEP ou outros numeros).
${task.description ? `\nCONTEXTO: ${task.description}` : ''}

Execute a emissao usando a tool emitir_nfse.`;
    } else {
      taskPrompt = `Você recebeu uma tarefa delegada por Rodrigo (Diretor de Operações).

TAREFA: ${task.title}
${task.description ? `DESCRIÇÃO: ${task.description}` : ''}
PRIORIDADE: ${task.priority}
${task.due_date ? `PRAZO: ${new Date(task.due_date).toLocaleDateString('pt-BR')}` : ''}

Execute a tarefa usando suas ferramentas disponíveis e retorne o resultado.`;
    }

    // Wrapper do tool executor: auto-injeta cliente_phone, prestador_cnpj,
    // tomador_cpf_cnpj e task_id em chamadas emitir_nfse. Essa e a fonte de
    // verdade da task — LLM nao precisa lembrar de preencher.
    const taskToolExecutor = async (name, args) => {
      if (name === 'emitir_nfse' && isNfseTask) {
        const pf = parsedFields || {};
        const phone = originalMeta?.cliente_phone || '';
        const enriched = { ...(args || {}) };
        if (!enriched.prestador_cnpj && pf.prestador_cnpj) enriched.prestador_cnpj = pf.prestador_cnpj;
        if (!enriched.cliente_phone && phone) enriched.cliente_phone = String(phone).replace(/\D/g, '');
        if (!enriched.tomador_cpf_cnpj && pf.tomador_cpf_cnpj) enriched.tomador_cpf_cnpj = pf.tomador_cpf_cnpj;
        if (!enriched.tomador_nome && pf.tomador_nome) enriched.tomador_nome = pf.tomador_nome;
        if (!enriched.valor && pf.valor) enriched.valor = pf.valor;
        if (!enriched.descricao && pf.descricao) enriched.descricao = pf.descricao;
        if (!enriched.task_id) enriched.task_id = taskId;
        const added = Object.keys(enriched).filter(k => !(k in (args || {})));
        if (added.length) console.log('[Orchestrator] emitir_nfse auto-inject:', added.join(','));
        return executeToolCall(name, enriched);
      }
      return executeToolCall(name, args);
    };

    let response = await chatWithAgent(agent, [
      { role: 'user', content: taskPrompt },
    ], taskToolExecutor);

    // Post-flight fallback: se e task NFSe e LLM nao fez chamada bem-sucedida
    // de emitir_nfse mas temos todos os dados, chama a tool diretamente.
    // Defesa contra instrucao-nao-seguida do LLM (Grok as vezes "desiste").
    if (response.success && isNfseTask) {
      const calls = response.toolCallTrace || [];
      const successfulEmit = calls.some(c => c.name === 'emitir_nfse' && c.ok);
      const pf = parsedFields || {};
      const phone = originalMeta?.cliente_phone || '';
      const canAutoEmit = (pf.prestador_cnpj || phone) && pf.tomador_cpf_cnpj && pf.valor && pf.descricao;
      if (!successfulEmit && canAutoEmit) {
        console.log('[Orchestrator] LLM nao emitiu NFSe mas dados estao completos — fallback deterministico');
        const enriched = {
          prestador_cnpj: pf.prestador_cnpj || undefined,
          cliente_phone: phone ? String(phone).replace(/\D/g, '') : undefined,
          tomador_cpf_cnpj: pf.tomador_cpf_cnpj,
          tomador_nome: pf.tomador_nome || undefined,
          valor: pf.valor,
          descricao: pf.descricao,
          codigo_servico: pf.codigo_servico || undefined,
          aliquota_iss: pf.aliquota_iss || undefined,
          task_id: taskId,
        };
        const fallbackResult = await executeToolCall('emitir_nfse', enriched);
        const fallbackCall = {
          name: 'emitir_nfse',
          args: enriched,
          ok: fallbackResult?.sucesso === true,
          summary: fallbackResult?.sucesso
            ? 'nfse=' + (fallbackResult.numero_nfse || '?') + ' status=' + (fallbackResult.status_nfse || '?')
            : 'erro: ' + String(fallbackResult?.erro || 'falha').slice(0, 100),
          ms: 0,
          iteration: -1,
          via: 'orchestrator-fallback',
        };
        response = {
          ...response,
          text: (response.text || '') + '\n\n---\n[Orchestrator fallback] emitir_nfse chamada diretamente: ' + fallbackCall.summary,
          toolCallTrace: [...calls, fallbackCall],
        };
      }
    }

    // Inspeciona resultados das tools — detecta falha mesmo com response.success=true
    // (ex: emitir_nfse retornou sucesso:false mas o agente nao bloqueou sozinho)
    const toolCalls = response.toolCallTrace || [];
    const toolFailures = toolCalls.filter(c => c?.ok === false || /sucesso.{0,5}false|"ok"\s*:\s*false|\berro[":\s]/i.test(String(c?.summary || '')));
    const hasToolFailure = toolFailures.length > 0;
    const taskActuallyFailed = !response.success || hasToolFailure;

    if (!taskActuallyFailed) {
      await query(`
        UPDATE tasks SET status = 'done', result = $1, completed_at = NOW() WHERE id = $2
      `, [JSON.stringify({ text: response.text, usage: response.usage, tool_calls: toolCalls }), taskId]);

      console.log(`[Orchestrator] "${task.title}" concluída por ${agent.name}`);
      broadcastFn?.({ type: 'task_completed', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'done' } });

      // Notification: task concluída
      createNotification({
        type: 'task_complete',
        title: 'Tarefa concluída',
        message: `${task.title} — concluída por ${agent.name}`,
        severity: 'success',
        agentId: agent.id,
        taskId,
      }).catch(() => {});

      // Chat: agente reporta conclusão com detalhes acionáveis
      let chatResult;
      let statusEmoji = '✅';
      if (isNfseTask) {
        // Detecção ampla de sucesso: JSON, texto Markdown, ou toolCall ok
        const sucessoJson = response.text?.match(/"sucesso"\s*:\s*true/);
        const sucessoMd = response.text?.match(/NFS-?e\s+(criada|emitida|autorizada)\s+com\s+sucesso/i)
                       || response.text?.match(/ATR\d{6,}/)
                       || response.text?.match(/N[úu]mero\s+da\s+NFS-?e\s*[:\s]*\*?\*?\s*\d+/i);
        const emitirOk = toolCalls.some(c => /emitir_nfse/.test(c?.name || '') && c?.ok === true);
        const sucesso = sucessoJson || sucessoMd || emitirOk;
        if (sucesso) {
          // Extrai número pra mostrar no chat
          const numMatch = response.text?.match(/ATR\d+/)
                        || response.text?.match(/N[úu]mero[^:]{0,30}[:\s]+\*?\*?\s*(\d+)/i);
          const numTxt = numMatch ? (numMatch[0].match(/ATR\d+/)?.[0] || ('nº ' + numMatch[1])) : '';
          chatResult = `NFS-e de ${clienteName} emitida com sucesso${numTxt ? ' (' + numTxt + ')' : ''}!`;
        } else {
          statusEmoji = '⚠️';

          // 1) Tenta extrair motivo explícito da resposta
          const erroApi = response.text?.match(/`([^`]*(?:CPF|CNPJ|campo|inválido|obrigatório)[^`]*)`/i);
          const bloqueado = response.text?.match(/BLOQUEADO[^—]*—\s*(.+?)(?:\n|$)/);
          const acao = response.text?.match(/[Aa][çc][ãa]o [Nn]ecess[áa]ria[:\s]*\*?\*?\s*(.+?)(?:\n|$)/);
          const divergencia = response.text?.match(/(?:diverg[êe]ncia|n[ãa]o\s+bate)[^.]{0,200}/i);

          // 2) Identifica campos faltantes a partir do parsedFields da task
          const camposObrigatorios = {
            tomador_cpf_cnpj: 'CPF ou CNPJ do tomador',
            tomador_nome: 'Nome/razão social do tomador',
            valor: 'Valor do serviço',
            descricao: 'Descrição do serviço',
          };
          const faltando = [];
          for (const [campo, label] of Object.entries(camposObrigatorios)) {
            const v = parsedFields?.[campo];
            if (!v || String(v).trim() === '' || String(v).trim() === 'null') {
              faltando.push(label);
            }
          }

          // 3) Extrai tool_failures (erros das tools do Campelo)
          const toolErrs = (response.tool_calls || response.toolCalls || [])
            .filter(tc => tc && tc.error)
            .map(tc => String(tc.error).slice(0, 120))
            .join(' | ');

          // 4) Monta motivo final — específico e acionável
          let motivo;
          if (faltando.length > 0) {
            motivo = 'faltam: ' + faltando.join(', ');
          } else if (divergencia) {
            motivo = divergencia[0].trim();
          } else if (erroApi) {
            motivo = erroApi[1];
          } else if (bloqueado) {
            motivo = bloqueado[1].trim();
          } else if (acao) {
            motivo = acao[1].replace(/\*/g, '').trim();
          } else if (toolErrs) {
            motivo = 'erro de tool: ' + toolErrs;
          } else {
            motivo = 'causa não identificada no retorno do agente — revisar o texto completo na task';
          }

          // 5) Monta resumo de dados COLETADOS pra equipe ver o que chegou
          const dadosColetados = [];
          if (parsedFields?.tomador_cpf_cnpj) dadosColetados.push('CNPJ/CPF: ' + parsedFields.tomador_cpf_cnpj);
          if (parsedFields?.tomador_nome) dadosColetados.push('Tomador: ' + parsedFields.tomador_nome);
          if (parsedFields?.valor) dadosColetados.push('Valor: ' + parsedFields.valor);
          if (parsedFields?.descricao) dadosColetados.push('Descrição: ' + String(parsedFields.descricao).slice(0, 60));
          const resumoDados = dadosColetados.length ? '\nDados recebidos: ' + dadosColetados.join(' | ') : '';

          chatResult = 'NFS-e de ' + clienteName + ' pendente.\nMotivo: ' + motivo + '.' + resumoDados + '\nEquipe: verifiquem e reenviem.';
        }
      } else {
        // Task não-NFSe: titulo + preview dos clientes/detalhes do description + resposta do agente
        const cleanTitle = (task.title || 'Tarefa').replace(/^\[[^\]]+\]\s*/, '').slice(0, 100);

        // 1) Pega as primeiras linhas úteis do DESCRIPTION da task (onde a lista de clientes vive)
        const descLines = String(task.description || '')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && !l.startsWith('Classificação:') && !l.startsWith('Prioridade:') && !l.startsWith('Responsável humano:'));
        // Prioriza linhas que começam com "-" (itens de lista — clientes)
        const listItems = descLines.filter(l => l.startsWith('-'));
        let detalheDesc = '';
        if (listItems.length > 0) {
          const preview = listItems.slice(0, 5).join('\n');
          const restante = listItems.length - 5;
          detalheDesc = preview + (restante > 0 ? `\n... e mais ${restante} item(ns). Ver task #${String(task.id).substring(0, 8)} no painel.` : '');
        } else if (descLines.length > 0) {
          detalheDesc = descLines.slice(0, 3).join(' — ').slice(0, 400);
        }

        // 2) Resposta do agente (o que ele FEZ) — primeira linha significativa
        const agentLine = String(response.text || '')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#') && !l.startsWith('```') && l.length > 15)[0] || '';
        const acaoAgente = agentLine ? '\n📝 ' + agentLine.slice(0, 200) + (agentLine.length > 200 ? '...' : '') : '';

        const clientePart = clienteName ? ` — ${clienteName}` : '';
        chatResult = `${cleanTitle}${clientePart}${detalheDesc ? '\n\n' + detalheDesc : ''}${acaoAgente}`;
      }
      chat({ from: agent.name, text: `${statusEmoji} ${chatResult}`, tag: isNfseTask ? 'nfs-e' : 'concluído' });

      // Responde ao cliente se for NFS-e/fiscal
      await notifyClientIfNfse(task, response.text, originalMeta, toolCalls);
    } else {
      const blockReason = response.error
        || (toolFailures.length ? `tool ${toolFailures[0].name || 'desconhecida'} falhou: ${toolFailures[0].summary || 'sem detalhe'}` : 'sem detalhe');
      await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
        [JSON.stringify({ error: blockReason, tool_failures: toolFailures, tool_calls: toolCalls, text: response.text }), taskId]);
      console.log(`[Orchestrator] "${task.title}" bloqueada: ${blockReason}`);
      broadcastFn?.({ type: 'task_blocked', task: { id: taskId, title: task.title, assigned_name: task.assigned_name, status: 'blocked' } });

      // Chat: avisa equipe com motivo REAL da falha (nao so 'erro generico')
      const motivoHumano = humanizeErrorShort(blockReason);
      const chatMsg = isNfseTask
        ? `NFS-e de ${clienteName || 'cliente'} não foi emitida: ${motivoHumano} Equipe, revisem no NFS-e System.`
        : `Tarefa de ${clienteName || 'cliente'} ficou bloqueada: ${motivoHumano}`;
      chat({ from: agent.name, text: `⚠️ ${chatMsg}`, tag: isNfseTask ? 'nfs-e' : 'bloqueado' });
      // continua com o fluxo original (createNotification abaixo)

      // Notification: escalation / task bloqueada
      createNotification({
        type: 'escalation',
        title: 'Escalation — tarefa bloqueada',
        message: `${task.title} bloqueada: ${(response.error || 'Erro desconhecido').substring(0, 200)}`,
        severity: 'warning',
        agentId: agent.id,
        taskId,
      }).catch(() => {});

      // (mensagem de bloqueio já emitida acima — evita duplicata no chat)
      await notifyTeamFailure(task, blockReason || response.error);
    }
  } catch (err) {
    console.error(`[Orchestrator] Erro task ${taskId}:`, err.message);
    await query(`UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
      [JSON.stringify({ error: err.message }), taskId]).catch(() => {});
    await notifyTeamFailure({ title: `Task ${taskId}`, assigned_name: 'sistema' }, err.message);
  }
}

// ============================================
// PROCESSA TASKS PENDENTES (loop periódico)
// ============================================
export async function processPendingTasks() {
  const { rows } = await query(`
    SELECT t.id FROM tasks t
    JOIN team_members tm ON t.assigned_to = tm.id
    WHERE t.status = 'pending' AND tm.type = 'ai' AND tm.agent_id IS NOT NULL
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at ASC
    LIMIT 3
  `);

  let processed = 0;
  for (const task of rows) {
    if (!taskStates.has(task.id)) {
      await processTask(task.id);
      processed++;
    }
  }
  return processed;
}

// ============================================
// NOTIFICA CLIENTE VIA WHATSAPP (Luna responde)
// ============================================
async function notifyClientIfNfse(task, agentText, originalMeta, toolCalls) {
  const isNfse = task.title?.includes('[NFSE]') || task.title?.includes('[FISCAL]');
  if (!isNfse) return;

  const clientName = extractClientName(task, originalMeta);
  const firstName = (clientName || 'Cliente').split(' ')[0];

  console.log(`[NFS-e] Resultado do Campelo para ${clientName}`);

  // Verifica status do resultado do Campelo — aceita formato JSON e Markdown
  const sucessoJson = agentText?.match(/"sucesso"\s*:\s*true/);
  const sucessoMd = agentText?.match(/NFS-?e\s+(criada|emitida)\s+com\s+sucesso/i)
                 || agentText?.match(/(ATR\d{6,}|N[úu]mero\s+da\s+NFS-?e)/i);
  // Fallback via tool result — mais confiavel que regex quando agent retorna so JSON puro
  const emitirToolOk = (toolCalls || []).some(c =>
    /emitir_nfse/.test(c && c.name || "") && (c && c.ok === true || /sucesso["\'\s:]*true/i.test(String((c && c.summary) || "")))
  );
  const sucessoMatch = sucessoJson || sucessoMd || emitirToolOk;
  const processandoMatch = agentText?.match(/"status_nfse"\s*:\s*"processando"/)
                        || agentText?.match(/status[^\n]{0,20}processando/i)
                        || agentText?.match(/(?:enviada|processando)\s+(?:para|pela)\s+(nuvem\s+fiscal|prefeitura)/i);

  // Extrai motivos de pendência do resultado do Campelo (JSON ou Markdown)
  const erroMatch = agentText?.match(/"erro"\s*:\s*"([^"]+)"/);
  const actionMatch = agentText?.match(/"action_required"\s*:\s*"([^"]+)"/);
  // Fallback: extrai do Markdown — bloco "Informação necessária" ou "Ação requerida"
  const infoMatch = agentText?.match(/[Ii]nforma[çc][ãa]o necess[áa]ria[:\s]*\n([\s\S]*?)(?:\n---|\n\n\*\*)/);
  const acaoMatch = agentText?.match(/[Aa][çc][ãa]o requerida[:\s]*\*?\*?\s*(.+)/);
  const bloqueadoMatch = agentText?.match(/BLOQUEADO[^—]*—\s*(.+)/);
  const pendencia = erroMatch?.[1]
    || actionMatch?.[1]
    || bloqueadoMatch?.[1]?.trim()
    || acaoMatch?.[1]?.replace(/\*/g, '').trim()
    || '';

  let alertMsg;
  let chatStatus;

  // Se sucesso, tenta extrair numero e buscar detalhes no NFS-e System
  let nfseDetails = null;
  if (sucessoMatch) {
    // Extrai numero — formato ATR12345678 OU "Número da NFS-e: 30" OU outros padrões
    const numMatch = agentText?.match(/(?:ATR\d{6,})/)
                  || agentText?.match(/N[úu]mero[^:]*NFS-?e[:\s]*\*?\*?\s*(\d+)/i)
                  || agentText?.match(/NFS-?e[:\s]+n[º°]?\s*(\d+)/i);
    const numero = numMatch ? (numMatch[0].match(/ATR\d+/) ? numMatch[0].match(/ATR\d+/)[0] : numMatch[1]) : null;
    if (numero) {
      try {
        const NFSE_URL = process.env.NFSE_SYSTEM_URL || 'http://localhost:3020';
        const resp = await fetch(`${NFSE_URL}/api/nfses?numero=${encodeURIComponent(numero)}`);
        const data = await resp.json();
        if (data?.ok && data.data?.length) {
          nfseDetails = data.data[0];
        } else {
          // Fallback: lista recentes e pega a mais nova pro mesmo prestador
          const resp2 = await fetch(`${NFSE_URL}/api/nfses?limit=5`);
          const data2 = await resp2.json();
          if (data2?.ok && data2.data?.length) nfseDetails = data2.data[0];
        }
      } catch (e) { console.error('[orchestrator] fetch NFS-e details falhou:', e.message); }
    }
  }

  if (sucessoMatch && !processandoMatch) {
    // SUCESSO — notifica equipe com DETALHES completos + link da prefeitura
    const valorFmt = nfseDetails?.valorServicos
      ? 'R$ ' + Number(nfseDetails.valorServicos).toFixed(2).replace('.', ',')
      : '';
    const detalhes = nfseDetails
      ? `\nNota nº *${nfseDetails.numero}* (série ${nfseDetails.serie || '1'})`
        + `\nPrestador: ${nfseDetails.prestadorRazaoSocial || clientName}`
        + `\nTomador: ${nfseDetails.tomadorRazaoSocial || nfseDetails.tomadorNome || '—'} (${nfseDetails.tomadorCpfCnpj || '—'})`
        + `\nValor: ${valorFmt}`
        + (nfseDetails.descricaoServico ? `\nDescrição: ${nfseDetails.descricaoServico}` : '')
        + (nfseDetails.linkUrl ? `\n\nConsulta pública:\n${nfseDetails.linkUrl}` : '')
      : `\nCliente: ${clientName}`;
    alertMsg = `📄 *NFS-e emitida com sucesso*${detalhes}\n\n_Equipe: nota disponível no sistema._`;
    chatStatus = `NFS-e de ${firstName} emitida com sucesso${nfseDetails?.numero ? ' (nº ' + nfseDetails.numero + ')' : ''}. Equipe notificada.`;

    // Envia também via sendNfseToGroup (formato dedicado, com link)
    try {
      await sendNfseToGroup({
        pdfBase64: null, // NFS-e System não gera PDF — usa fallback (só caption)
        clienteNome: nfseDetails?.prestadorRazaoSocial || clientName,
        tomadorNome: nfseDetails?.tomadorRazaoSocial || nfseDetails?.tomadorNome || '—',
        tomadorDoc: nfseDetails?.tomadorCpfCnpj || '—',
        valor: nfseDetails?.valorServicos || 0,
        numeroNfse: nfseDetails?.numero || null,
        taskId: task.id,
      });
    } catch (e) { console.error('[orchestrator] sendNfseToGroup falhou:', e.message); }
  } else if (sucessoMatch && processandoMatch) {
    // PROCESSANDO na prefeitura — notifica equipe
    const detalhes = nfseDetails
      ? `\nNota nº *${nfseDetails.numero}*\nTomador: ${nfseDetails.tomadorRazaoSocial || nfseDetails.tomadorNome || '—'}\nValor: R$ ${Number(nfseDetails.valorServicos || 0).toFixed(2).replace('.', ',')}`
      : `\nCliente: ${clientName}`;
    alertMsg = `⏳ *NFS-e processando na prefeitura*${detalhes}\n\n_Aguardando autorização. Equipe acompanhar._`;
    chatStatus = `NFS-e de ${firstName} enviada para a prefeitura. Equipe notificada.`;
  } else {
    // FALHA — notifica equipe com detalhes acionáveis
    // Identifica campos faltantes no parsed_fields da task (usa mesma lógica do chat do orchestrator)
    const parsedFields = originalMeta?.parsed_fields || {};
    const camposObrigatorios = {
      tomador_cpf_cnpj: 'CPF/CNPJ do tomador',
      tomador_nome: 'Nome/razão social do tomador',
      valor: 'Valor do serviço',
      descricao: 'Descrição do serviço',
    };
    const faltando = [];
    for (const [campo, label] of Object.entries(camposObrigatorios)) {
      const v = parsedFields?.[campo];
      if (!v || String(v).trim() === '' || String(v).trim() === 'null') faltando.push(label);
    }

    // Motivo final — lista específica > pendencia LLM > fallback
    let detalhes;
    if (faltando.length > 0) {
      detalhes = 'Faltam: ' + faltando.join(', ');
    } else if (pendencia) {
      detalhes = pendencia;
    } else {
      detalhes = 'Causa não identificada no retorno do Campelo — revisar a task no banco';
    }

    // Extrai erros específicos da API do resultado
    const erroApiMatch = agentText?.match(/`([^`]{10,150})`/g)?.map(s => s.replace(/`/g, '')).filter(s => /CPF|CNPJ|campo|inválido|obrigat|DPS|série|valor|alíquota|código|tributação/i.test(s));
    const errosApi = erroApiMatch?.length ? `\nErros API: ${erroApiMatch.slice(0, 3).join(' | ')}` : '';

    // Identifica onde corrigir
    let ondeCorrigir = '';
    if (faltando.length > 0) {
      ondeCorrigir = '\nOnde corrigir: Luna não coletou todos os dados — revisar fluxo de intake com o cliente';
    } else if (/CPF|CNPJ/i.test(detalhes + (errosApi || ''))) {
      ondeCorrigir = '\nOnde corrigir: Cadastro do tomador ou pedir dado correto ao cliente';
    } else if (/série|DPS/i.test(detalhes)) {
      ondeCorrigir = '\nOnde corrigir: Configuração da série DPS no NFS-e System';
    } else if (/código|tributação/i.test(detalhes)) {
      ondeCorrigir = '\nOnde corrigir: Código de tributação no cadastro do prestador';
    } else if (/valor|alíquota/i.test(detalhes)) {
      ondeCorrigir = '\nOnde corrigir: Dados de valor/alíquota informados pelo cliente';
    }

    // Resumo dos dados que CHEGARAM (pra equipe não precisar abrir a task)
    const dadosColetados = [];
    if (parsedFields?.tomador_cpf_cnpj) dadosColetados.push('CNPJ/CPF: ' + parsedFields.tomador_cpf_cnpj);
    if (parsedFields?.tomador_nome) dadosColetados.push('Tomador: ' + parsedFields.tomador_nome);
    if (parsedFields?.valor) dadosColetados.push('Valor: ' + parsedFields.valor);
    if (parsedFields?.descricao) dadosColetados.push('Descrição: ' + String(parsedFields.descricao).slice(0, 60));
    if (parsedFields?.prestador_cnpj) dadosColetados.push('Prestador: ' + parsedFields.prestador_cnpj);
    const resumoDados = dadosColetados.length ? '\nDados recebidos: ' + dadosColetados.join(' | ') : '';

    alertMsg = `⚠️ *NFS-e pendente*\nCliente: ${clientName}\nMotivo: ${detalhes}${errosApi}${ondeCorrigir}${resumoDados}\n\n_Equipe: corrigir e reemitir._`;
    chatStatus = `NFS-e de ${firstName} pendente. Motivo: ${detalhes}. Equipe notificada.`;
  }

  // Notifica EQUIPE (nunca o cliente direto)
  try {
    await sendAlertToGroup(alertMsg);
    console.log(`[NFS-e] Equipe notificada sobre NFS-e de ${clientName}`);
  } catch (err) {
    console.error(`[NFS-e] ERRO ao notificar equipe: ${err.message}`);
  }
  telegram.sendAlert(alertMsg.replace(/\*/g, '').replace(/_/g, ''));
  // Status da NFS-e notificado via grupo WhatsApp + Telegram (não injeta no chat da equipe)
}

// ============================================
// ENCONTRA CHATID DO CLIENTE
// ============================================
async function findClientChatId(task, originalMeta) {
  // 1. Da metadata original (Luna criou a task com chatId)
  if (originalMeta?.cliente_chatId) return originalMeta.cliente_chatId;

  // 2. Extrai identificador da description e busca no banco
  const idMatch = task.description?.match(/\((\d{10,20})\)/);
  if (idMatch) {
    const { rows } = await query(
      'SELECT chat_id FROM whatsapp_conversations WHERE phone = $1 ORDER BY last_message_at DESC LIMIT 1',
      [idMatch[1]]
    );
    if (rows.length) return rows[0].chat_id;
  }

  // 3. Busca pelo nome do cliente na conversa mais recente
  const clientName = extractClientName(task, originalMeta);
  if (clientName) {
    const { rows } = await query(
      'SELECT chat_id FROM whatsapp_conversations WHERE client_name ILIKE $1 ORDER BY last_message_at DESC LIMIT 1',
      [`%${clientName}%`]
    );
    if (rows.length) return rows[0].chat_id;
  }

  return null;
}

function extractClientName(task, originalMeta) {
  if (originalMeta?.cliente_nome) return originalMeta.cliente_nome;
  if (originalMeta?.prestador_nome) return originalMeta.prestador_nome;
  // task.result pode ter client_id com nome
  try {
    const r = typeof task.result === 'string' ? JSON.parse(task.result) : task.result;
    if (r?.cliente_nome) return r.cliente_nome;
    if (r?.prestador_nome) return r.prestador_nome;
  } catch {}
  // Extrai do título: "[FISCAL] ... — Nome" (padrão antigo)
  const matchDash = task.title?.match(/—\s*(.+)$/);
  if (matchDash) return matchDash[1].trim();
  // Sem cliente claro — retorna null (caller decide como mostrar)
  return null;
}

// ============================================
// NOTIFICA EQUIPE SOBRE FALHA
// ============================================
async function notifyTeamFailure(task, errorMsg) {
  const isNfse = task.title?.includes('[NFSE]') || task.title?.includes('[FISCAL]');
  const icon = isNfse ? '🚫' : '⚠️';

  // Extrai detalhes acionáveis do erro
  let onde = 'Átrio Office → Orchestrator';
  let acao = 'Verificar logs do servidor';
  if (errorMsg?.includes('fetch') || errorMsg?.includes('ECONNREFUSED')) {
    onde = 'API externa (Nuvem Fiscal / Gesthub)';
    acao = 'Verificar se a API está acessível e credenciais estão corretas';
  } else if (errorMsg?.includes('CPF') || errorMsg?.includes('CNPJ') || errorMsg?.includes('inválido')) {
    onde = 'Dados do cliente/tomador';
    acao = 'Corrigir CPF/CNPJ no cadastro ou pedir ao cliente novamente';
  } else if (errorMsg?.includes('agent') || errorMsg?.includes('agente')) {
    onde = 'Banco de dados → agents/team_members';
    acao = 'Verificar se o agente existe e está disponível no seed';
  } else if (errorMsg?.includes('tool') || errorMsg?.includes('emitir_nfse')) {
    onde = 'Tool do agente';
    acao = 'Verificar configuração da tool e parâmetros enviados';
  }

  const alertMsg = `${icon} *Task BLOQUEADA*\n\n*Task:* ${task.title}\n*Agente:* ${task.assigned_name || 'N/A'}\n*Erro:* ${errorMsg || 'Desconhecido'}\n*Onde:* ${onde}\n*Ação:* ${acao}`;

  telegram.sendAlert(alertMsg.replace(/\*/g, ''));
  try { await sendAlertToGroup(alertMsg); } catch {}
}


// ============================================
// RECOVERY DE TASKS ORFAS (stranded-work)
// Detecta tasks in_progress ha muito tempo — ninguem tocou.
// 1a tentativa: volta para pending, deixa orquestrador re-pegar
// 2a tentativa: bloqueia e notifica equipe
// Inspirado no padrao heartbeat_runs + stranded-assigned-work do paperclipai/paperclip.
// ============================================
const STRANDED_AFTER_MINUTES = parseInt(process.env.STRANDED_AFTER_MINUTES || '15', 10);
const STRANDED_MAX_RETRIES = parseInt(process.env.STRANDED_MAX_RETRIES || '1', 10);

export async function recoverStrandedTasks({ maxAgeMinutes = STRANDED_AFTER_MINUTES } = {}) {
  try {
    const { rows } = await query(
      `SELECT id, title, result,
              EXTRACT(EPOCH FROM (NOW() - updated_at))/60 AS age_minutes
         FROM tasks
        WHERE status = 'in_progress'
          AND updated_at < NOW() - ($1 || ' minutes')::interval
        LIMIT 20`,
      [String(maxAgeMinutes)]
    );
    if (!rows.length) return { scanned: 0, retried: 0, blocked: 0 };

    let retried = 0, blocked = 0;
    for (const t of rows) {
      // In-memory lock: se a task estiver sendo processada agora, ignora
      if (taskStates.has(t.id)) continue;

      let meta = {};
      try { meta = typeof t.result === 'string' ? JSON.parse(t.result) : (t.result || {}); } catch {}
      const retries = parseInt(meta.stranded_retries || 0, 10);

      if (retries < STRANDED_MAX_RETRIES) {
        meta.stranded_retries = retries + 1;
        meta.last_stranded_at = new Date().toISOString();
        meta.last_stranded_age_min = Math.round(parseFloat(t.age_minutes));
        await query(
          `UPDATE tasks SET status = 'pending', result = $1 WHERE id = $2`,
          [JSON.stringify(meta), t.id]
        );
        retried++;
        logEvent({
          actor_type: 'system', actor_id: 'recovery',
          event_type: 'task.recovery', action: 'retry',
          entity_type: 'task', entity_id: t.id,
          payload: { title: t.title, age_min: Math.round(parseFloat(t.age_minutes)), attempt: retries + 1 },
          severity: 'warn',
        });
        console.log(`[Recovery] Task ${t.id} ("${t.title}") retomada (tentativa ${retries + 1}/${STRANDED_MAX_RETRIES}, idade ${Math.round(parseFloat(t.age_minutes))}min)`);
      } else {
        meta.stranded_blocked_at = new Date().toISOString();
        meta.error = 'task orfa: excedeu tentativas de recovery (processo pode ter crashado)';
        await query(
          `UPDATE tasks SET status = 'blocked', result = $1 WHERE id = $2`,
          [JSON.stringify(meta), t.id]
        );
        blocked++;
        logEvent({
          actor_type: 'system', actor_id: 'recovery',
          event_type: 'task.recovery', action: 'block',
          entity_type: 'task', entity_id: t.id,
          payload: { title: t.title, retries_exhausted: retries },
          severity: 'critical',
        });
        console.warn(`[Recovery] Task ${t.id} ("${t.title}") BLOQUEADA apos ${retries} retries`);
        // Notifica equipe
        try { await notifyTeamFailure({ title: t.title, assigned_name: 'sistema' }, `Task orfa apos ${retries} retries — requer revisao manual`); } catch {}
      }
    }
    return { scanned: rows.length, retried, blocked };
  } catch (err) {
    console.error('[Recovery] erro:', err.message);
    return { scanned: 0, retried: 0, blocked: 0, error: err.message };
  }
}

// ============================================
// REPLY TO COMMENT — quando agente é mencionado em task_comment,
// orchestrator carrega contexto + comment e pede resposta.
// O texto retornado pelo agente vira um novo comment no thread.
// ============================================
export async function replyToComment({ task_id, agent, trigger_comment }) {
  try {
    // Carrega histórico da task + comments (últimos 10)
    const { rows: taskRows } = await query('SELECT * FROM tasks WHERE id = $1', [task_id]);
    if (!taskRows.length) return null;
    const task = taskRows[0];

    const { rows: comments } = await query(
      `SELECT author_name, content, created_at FROM task_comments
        WHERE task_id = $1 ORDER BY created_at ASC LIMIT 10`,
      [task_id]
    );

    const transcript = comments.map(c => `${c.author_name}: ${c.content}`).join('\n');
    const prompt = `Você foi mencionado em uma task do escritório Átrio.

Task: ${task.title}
Status atual: ${task.status}

HISTÓRICO DE COMENTÁRIOS:
${transcript}

ÚLTIMO COMENTÁRIO (que te mencionou):
${trigger_comment.author_name}: ${trigger_comment.content}

Responda de forma direta, concisa (2-4 frases). Se precisar de mais informação, peça. Se houver alguma ação que depende de outro agente, use @NomeDoAgente.`;

    const { chatWithAgent } = await import('./claude.js');
    const { executeToolCall } = await import('../tools/registry.js');

    const response = await chatWithAgent(agent, [{ role: 'user', content: prompt }], executeToolCall);
    if (!response.success) {
      console.error('[replyToComment]', agent.name, 'falhou:', response.error);
      return null;
    }

    // Posta resposta como comment
    const { addComment } = await import('./task-comments.js');
    await addComment({
      task_id,
      author_type: 'agent',
      author_id: agent.id,
      author_name: agent.name,
      content: response.text || 'Processado.',
      metadata: { trigger_comment_id: trigger_comment.id, model: response.provider },
    });

    broadcastFn?.({ type: 'task_comment', task_id });
    return response.text;
  } catch (err) {
    console.error('[replyToComment] erro:', err.message);
    return null;
  }
}

