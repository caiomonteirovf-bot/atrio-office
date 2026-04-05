import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// Minimax API via OpenAI-compatible SDK
const client = new OpenAI({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.io/v1',
});

const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.5';

/**
 * Envia mensagem para um agente específico via Minimax API
 */
export async function sendToAgent(agent, messages, options = {}) {
  const { maxTokens = 4096, temperature = 0.7 } = options;

  // Monta tools no formato OpenAI (compatível com Minimax)
  const tools = (agent.tools || []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || tool.parameters || {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  }));

  // Formata mensagens: system prompt separado
  const formattedMessages = [
    { role: 'system', content: agent.system_prompt },
    ...messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  ];

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: formattedMessages,
      max_completion_tokens: maxTokens,
      temperature,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    });

    const choice = response.choices[0];

    return {
      success: true,
      content: choice.message.content || '',
      toolCalls: choice.message.tool_calls || [],
      finishReason: choice.finish_reason,
      usage: response.usage,
    };
  } catch (error) {
    console.error(`[Minimax] Erro ao chamar agente ${agent.name}:`, error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Extrai texto da resposta, removendo tags <think> do Minimax
 */
export function extractText(response) {
  if (typeof response !== 'string') return response || '';
  // Remove blocos <think>...</think> do reasoning interno
  return response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Parseia <FunctionCall> XML do Minimax quando ele usa texto em vez de tool_calls formal
 * Retorna array de { name, args } ou null se não encontrou
 */
function parseFunctionCallXml(text) {
  if (!text || !text.includes('<FunctionCall>')) return null;

  const calls = [];
  const regex = /<FunctionCall>\s*tool_name:\s*(\w+)([\s\S]*?)<\/FunctionCall>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const paramsStr = match[2];
    const args = {};

    // Parse <param name="key">value</param>
    const paramRegex = /<param\s+name="(\w+)">([\s\S]*?)<\/param>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
      const val = paramMatch[2].trim();
      // Try to parse as number/boolean
      if (val === 'true') args[paramMatch[1]] = true;
      else if (val === 'false') args[paramMatch[1]] = false;
      else if (/^\d+$/.test(val)) args[paramMatch[1]] = parseInt(val);
      else args[paramMatch[1]] = val;
    }

    calls.push({ name, args });
  }

  return calls.length > 0 ? calls : null;
}

/**
 * Chat completo com agente (com suporte a tool use loop)
 */
export async function chatWithAgent(agent, messages, toolExecutor = null) {
  // Formata histórico para o formato OpenAI
  let currentMessages = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  // Se não temos executor de tools, envia sem tools para evitar respostas vazias
  const agentForRequest = toolExecutor ? agent : { ...agent, tools: [] };

  let iterations = 0;
  const maxIterations = 10;

  while (iterations < maxIterations) {
    const response = await sendToAgent(agentForRequest, currentMessages);

    if (!response.success) return response;

    // Verifica tool calls formais (API) OU <FunctionCall> XML no texto (fallback Minimax)
    let toolCalls = response.toolCalls?.length ? response.toolCalls : null;
    let xmlToolCalls = null;

    if (!toolCalls && toolExecutor && response.content) {
      xmlToolCalls = parseFunctionCallXml(response.content);
    }

    // Se não tem tool calls de nenhum tipo, retorna a resposta final
    if (!toolCalls && !xmlToolCalls) {
      return {
        success: true,
        text: extractText(response.content),
        usage: response.usage,
      };
    }

    if (!toolExecutor) {
      // Sem executor: limpa XML do texto e retorna
      const cleanText = response.content
        .replace(/<FunctionCall>[\s\S]*?<\/FunctionCall>/g, '')
        .trim();
      return {
        success: true,
        text: extractText(cleanText || 'Processado.'),
        usage: response.usage,
      };
    }

    // Executa tool calls formais (API OpenAI)
    if (toolCalls) {
      currentMessages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments || '{}');
        const result = await toolExecutor(fnName, fnArgs);

        currentMessages.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }
    }
    // Executa tool calls XML (fallback Minimax)
    else if (xmlToolCalls) {
      console.log(`[chatWithAgent] Detectado ${xmlToolCalls.length} <FunctionCall> XML — executando como fallback`);

      const results = [];
      for (const call of xmlToolCalls) {
        const result = await toolExecutor(call.name, call.args);
        results.push({ tool: call.name, result });
      }

      // Limpa o XML do texto original e adiciona ao histórico
      const cleanContent = response.content
        .replace(/<FunctionCall>[\s\S]*?<\/FunctionCall>/g, '')
        .trim();

      currentMessages.push({
        role: 'assistant',
        content: cleanContent || `Vou consultar usando ${xmlToolCalls.map(c => c.name).join(', ')}...`,
      });

      // Adiciona resultados como mensagem do usuário (sem tool_call_id formal)
      const toolResultsText = results.map(r =>
        `Resultado de ${r.tool}: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}`
      ).join('\n\n');

      currentMessages.push({
        role: 'user',
        content: `[RESULTADO DAS FERRAMENTAS]\n${toolResultsText}\n\nAgora responda a pergunta original usando esses dados. Responda de forma direta e útil, sem mencionar as ferramentas.`,
      });
    }

    iterations++;
  }

  return {
    success: false,
    error: 'Max tool iterations reached',
  };
}

export default client;
