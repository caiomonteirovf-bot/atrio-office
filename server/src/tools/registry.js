import { tools as rodrigoTools } from './rodrigo.js';
import { tools as campeloTools } from './campelo.js';
import { tools as sneijderTools } from './sneijder.js';
import { tools as lunaTools } from './luna.js';
import { tools as sofiaTools } from './sofia.js';
import { tools as datalakeTools } from './datalake.js';
import { observeToolCall } from '../services/luna-observer.js';

// Registro central de todas as 32 tools
const registry = {
  ...rodrigoTools,
  ...campeloTools,
  ...sneijderTools,
  ...lunaTools,
  ...sofiaTools,
  ...datalakeTools,
};

// Tools que criam tasks para agentes IA — disparam orquestração
const TASK_CREATING_TOOLS = new Set(['delegar_tarefa', 'rotear_demanda', 'rotear_para_rodrigo']);

// Callback para orquestração (setado pelo index.js)
let onTaskCreated = null;
export function setOnTaskCreated(fn) { onTaskCreated = fn; }

console.log(`[Tools] ${Object.keys(registry).length} tools registradas:`, Object.keys(registry).join(', '));

/**
 * Executor de tools — mapeia nome para implementação
 */
export async function executeToolCall(toolName, args) {
  const handler = registry[toolName];

  if (!handler) {
    console.log(`[Tools] Tool "${toolName}" não implementada`);
    return {
      erro: `A ferramenta "${toolName}" ainda não está implementada.`,
      disponivel_em_breve: true,
    };
  }

  console.log(`[Tools] Executando: ${toolName}`, JSON.stringify(args).substring(0, 200));

  try {
    const result = await handler(args || {});
    console.log(`[Tools] ${toolName} → sucesso`);
    observeToolCall(toolName, args || {}, result).catch(() => {});

    // Se a tool criou uma task, dispara orquestração assíncrona
    if (TASK_CREATING_TOOLS.has(toolName) && result?.sucesso && result?.tarefa?.id) {
      console.log(`[Tools] Task criada → disparando orquestração para ${result.tarefa.id}`);
      setTimeout(() => onTaskCreated?.(result.tarefa.id), 100);
    }
    if (TASK_CREATING_TOOLS.has(toolName) && result?.sucesso && result?.task_id) {
      console.log(`[Tools] Task criada → disparando orquestração para ${result.task_id}`);
      setTimeout(() => onTaskCreated?.(result.task_id), 100);
    }

    return result;
  } catch (err) {
    console.error(`[Tools] ${toolName} → erro:`, err.message);
    return {
      erro: `Erro ao executar "${toolName}": ${err.message}`,
    };
  }
}
