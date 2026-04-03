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
  const maxIterations = 5;

  while (iterations < maxIterations) {
    const response = await sendToAgent(agentForRequest, currentMessages);

    if (!response.success) return response;

    // Se não tem tool calls ou não tem executor, retorna a resposta final
    if (!response.toolCalls?.length || !toolExecutor) {
      return {
        success: true,
        text: extractText(response.content),
        usage: response.usage,
      };
    }

    // Adiciona resposta do assistant ao histórico
    currentMessages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls,
    });

    // Executa cada tool call e adiciona resultado
    for (const toolCall of response.toolCalls) {
      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments || '{}');
      const result = await toolExecutor(fnName, fnArgs);

      currentMessages.push({
        role: 'tool',
        content: typeof result === 'string' ? result : JSON.stringify(result),
        tool_call_id: toolCall.id,
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
