import { tools as rodrigoTools } from './rodrigo.js';
import { tools as campeloTools } from './campelo.js';
import { tools as sneijderTools } from './sneijder.js';
import { tools as lunaTools } from './luna.js';
import { tools as sofiaTools } from './sofia.js';

// Registro central de todas as 32 tools
const registry = {
  ...rodrigoTools,
  ...campeloTools,
  ...sneijderTools,
  ...lunaTools,
  ...sofiaTools,
};

console.log(`[Tools] ${Object.keys(registry).length} tools registradas:`, Object.keys(registry).join(', '));

/**
 * Executor de tools — mapeia nome para implementação
 * Assinatura compatível com chatWithAgent(agent, messages, toolExecutor)
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
    return result;
  } catch (err) {
    console.error(`[Tools] ${toolName} → erro:`, err.message);
    return {
      erro: `Erro ao executar "${toolName}": ${err.message}`,
    };
  }
}
