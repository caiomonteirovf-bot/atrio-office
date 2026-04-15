import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { query } from '../db/pool.js';

dotenv.config();

// ============================================
// TOKEN USAGE TRACKING
// ============================================

// Cost per 1K tokens (USD) — rough estimates per provider
const MODEL_PRICING = {
  // Anthropic
  'claude-sonnet-4-6':      { input: 0.003, output: 0.015 },
  // xAI Grok
  'grok-4-1-fast':          { input: 0.002, output: 0.010 },
  // DeepSeek
  'deepseek-chat':          { input: 0.0005, output: 0.001 },
  // MiniMax (legacy)
  'MiniMax-Text-01':        { input: 0.001, output: 0.002 },
  // Default fallback
  _default:                 { input: 0.001, output: 0.002 },
};

/**
 * Record token usage to the database (non-blocking, fire-and-forget).
 * @param {string|null} agentId - UUID of the agent
 * @param {string|null} conversationId - UUID of the conversation
 * @param {string} model - Model name used
 * @param {object} usage - { prompt_tokens, completion_tokens } (OpenAI) or { input_tokens, output_tokens } (Anthropic)
 */
function recordTokenUsage(agentId, conversationId, model, usage) {
  if (!usage) return;

  try {
    // Normalize token counts across providers
    const tokensInput = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const tokensOutput = usage.completion_tokens ?? usage.output_tokens ?? 0;

    if (tokensInput === 0 && tokensOutput === 0) return;

    const pricing = MODEL_PRICING[model] || MODEL_PRICING._default;
    const costUsd = (tokensInput / 1000) * pricing.input + (tokensOutput / 1000) * pricing.output;

    query(
      `INSERT INTO token_usage (agent_id, conversation_id, tokens_input, tokens_output, model, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agentId || null, conversationId || null, tokensInput, tokensOutput, model, costUsd]
    ).catch(err => {
      console.error('[TokenUsage] Erro ao gravar:', err.message);
    });
  } catch (err) {
    console.error('[TokenUsage] Erro inesperado:', err.message);
  }
}

// ============================================
// MULTI-MODEL PROVIDERS
// ============================================

// Anthropic (Campelo — NFS-e, precisão fiscal)
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// xAI Grok (Rodrigo, Sneijder, Sofia — velocidade)
const grok = process.env.XAI_API_KEY
  ? new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' })
  : null;

// DeepSeek (Luna, Fallback — alto volume, barato)
const deepseek = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null;

// MiniMax (legado — manter durante transição de 14 dias)
const minimax = process.env.MINIMAX_API_KEY
  ? new OpenAI({ apiKey: process.env.MINIMAX_API_KEY, baseURL: 'https://api.minimax.io/v1' })
  : null;

// ============================================
// AGENT → PROVIDER CONFIG
// ============================================
const AGENT_CONFIG = {
  'Campelo':   { provider: 'grok',      model: 'grok-4-1-fast',      temperature: 0.1, maxTokens: 2048 },
  'Rodrigo':   { provider: 'grok',      model: 'grok-4-1-fast',      temperature: 0.1, maxTokens: 1024 },
  'Sneijder':  { provider: 'grok',      model: 'grok-4-1-fast',      temperature: 0.2, maxTokens: 1024 },
  'Sofia':     { provider: 'grok',      model: 'grok-4-1-fast',      temperature: 0.2, maxTokens: 1024 },
  'Luna':      { provider: 'deepseek',  model: 'deepseek-chat',      temperature: 0.5, maxTokens: 512  },
  'Valência':  { provider: 'grok',      model: 'grok-4-1-fast',      temperature: 0.2, maxTokens: 1024 },
  'Maia':      { provider: 'grok',      model: 'grok-4-1-fast',      temperature: 0.2, maxTokens: 1024 },
  'Dara':      { provider: 'deepseek',  model: 'deepseek-chat',      temperature: 0.3, maxTokens: 512  },
};

const FALLBACK_CONFIG = { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.3, maxTokens: 512 };

function getAgentConfig(agentName) {
  return AGENT_CONFIG[agentName] || FALLBACK_CONFIG;
}

function getOpenAIClient(provider) {
  if (provider === 'grok' && grok) return grok;
  if (provider === 'deepseek' && deepseek) return deepseek;
  if (provider === 'minimax' && minimax) return minimax;
  // Fallback chain: grok → deepseek → minimax
  return grok || deepseek || minimax;
}

// Log de inicialização
const providers = [];
if (anthropic) providers.push('Anthropic (Campelo)');
if (grok) providers.push('xAI Grok (Campelo/Rodrigo/Sneijder/Sofia)');
if (deepseek) providers.push('DeepSeek (Luna/Fallback)');
if (minimax) providers.push('MiniMax (legado)');
console.log(`[LLM] Provedores: ${providers.join(', ') || 'NENHUM!'}`);

// ============================================
// ANTHROPIC — Campelo (SDK nativo, cache ephemeral)
// ============================================
async function sendToAnthropic(agent, messages, options = {}) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY não configurada');

  const config = getAgentConfig(agent.name);
  const { maxTokens = config.maxTokens, temperature = config.temperature } = options;

  const tools = (agent.tools || []).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema || tool.parameters || {
      type: 'object', properties: {}, required: [],
    },
  }));

  const formattedMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  try {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      temperature,
      system: [{
        type: 'text',
        text: agent.system_prompt,
        cache_control: { type: 'ephemeral' },
      }],
      messages: formattedMessages,
      ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto' } } : {}),
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    // Track token usage (fire-and-forget)
    recordTokenUsage(agent.id || null, null, config.model, response.usage);

    return {
      success: true,
      content: textBlocks.map(b => b.text).join('\n') || '',
      toolCalls: toolBlocks,
      stopReason: response.stop_reason,
      usage: response.usage,
      provider: 'anthropic',
    };
  } catch (error) {
    console.error(`[Anthropic] Erro ${agent.name}:`, error.message);
    return { success: false, error: error.message, provider: 'anthropic' };
  }
}

// ============================================
// OPENAI-COMPATIBLE — Grok, DeepSeek, MiniMax
// ============================================
async function sendToOpenAI(agent, messages, options = {}) {
  const config = getAgentConfig(agent.name);
  const { maxTokens = config.maxTokens, temperature = config.temperature } = options;

  const client = getOpenAIClient(config.provider);
  if (!client) throw new Error(`Nenhum provedor disponível para ${agent.name}`);

  const tools = (agent.tools || []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || tool.parameters || {
        type: 'object', properties: {}, required: [],
      },
    },
  }));

  const formattedMessages = [
    { role: 'system', content: agent.system_prompt },
    ...messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : (m.role === 'tool' ? 'tool' : 'user'),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
  ];

  try {
    const response = await client.chat.completions.create({
      model: config.model,
      messages: formattedMessages,
      max_completion_tokens: maxTokens,
      temperature,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    });

    const choice = response.choices[0];

    // Track token usage (fire-and-forget)
    recordTokenUsage(agent.id || null, null, config.model, response.usage);

    return {
      success: true,
      content: choice.message.content || '',
      toolCalls: choice.message.tool_calls || [],
      finishReason: choice.finish_reason,
      usage: response.usage,
      provider: config.provider,
    };
  } catch (error) {
    console.error(`[${config.provider}] Erro ${agent.name}:`, error.message);

    // Fallback silencioso: Grok → DeepSeek (NUNCA para Campelo)
    if (config.provider === 'grok' && agent.name !== 'Campelo') {
      console.warn(`[Fallback] ${agent.name}: Grok falhou → DeepSeek`);
      const fbClient = deepseek || minimax;
      if (fbClient) {
        try {
          const fbResponse = await fbClient.chat.completions.create({
            model: 'deepseek-chat',
            messages: formattedMessages,
            max_completion_tokens: maxTokens,
            temperature: FALLBACK_CONFIG.temperature,
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
          });
          const fbChoice = fbResponse.choices[0];

          // Track fallback token usage (fire-and-forget)
          recordTokenUsage(agent.id || null, null, 'deepseek-chat', fbResponse.usage);

          return {
            success: true,
            content: fbChoice.message.content || '',
            toolCalls: fbChoice.message.tool_calls || [],
            finishReason: fbChoice.finish_reason,
            usage: fbResponse.usage,
            provider: 'deepseek (fallback)',
          };
        } catch (fbErr) {
          console.error(`[Fallback] DeepSeek também falhou:`, fbErr.message);
        }
      }
    }

    return { success: false, error: error.message, provider: config.provider };
  }
}

// ============================================
// ROUTER
// ============================================
export async function sendToAgent(agent, messages, options = {}) {
  const config = getAgentConfig(agent.name);
  if (config.provider === 'anthropic') return sendToAnthropic(agent, messages, options);
  return sendToOpenAI(agent, messages, options);
}

export function extractText(response) {
  if (typeof response !== 'string') return response || '';
  return response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function parseFunctionCallXml(text) {
  if (!text || !text.includes('<FunctionCall>')) return null;
  const calls = [];
  const regex = /<FunctionCall>\s*tool_name:\s*(\w+)([\s\S]*?)<\/FunctionCall>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const paramsStr = match[2];
    const args = {};
    const paramRegex = /<param\s+name="(\w+)">([\s\S]*?)<\/param>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
      const val = paramMatch[2].trim();
      if (val === 'true') args[paramMatch[1]] = true;
      else if (val === 'false') args[paramMatch[1]] = false;
      else if (/^\d+$/.test(val)) args[paramMatch[1]] = parseInt(val);
      else args[paramMatch[1]] = val;
    }
    calls.push({ name, args });
  }
  return calls.length > 0 ? calls : null;
}

// ============================================
// CHAT COM AGENTE — Tool use loop (multi-provider)
// ============================================
export async function chatWithAgent(agent, messages, toolExecutor = null) {
  const config = getAgentConfig(agent.name);
  if (config.provider === 'anthropic') {
    return chatWithAgentAnthropic(agent, messages, toolExecutor);
  }
  return chatWithAgentOpenAI(agent, messages, toolExecutor);
}

// ---- ANTHROPIC tool use loop (Campelo) ----
async function chatWithAgentAnthropic(agent, messages, toolExecutor) {
  let currentMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  const agentForRequest = toolExecutor ? agent : { ...agent, tools: [] };
  let iterations = 0;

  while (iterations < 10) {
    const response = await sendToAnthropic(agentForRequest, currentMessages);
    if (!response.success) return response;

    const hasToolUse = response.toolCalls?.length > 0 && response.stopReason === 'tool_use';

    if (!hasToolUse || !toolExecutor) {
      return {
        success: true,
        text: extractText(response.content),
        usage: response.usage,
        provider: response.provider,
      };
    }

    // Monta conteúdo do assistente (texto + tool_use blocks)
    const assistantContent = [];
    if (response.content) assistantContent.push({ type: 'text', text: response.content });
    for (const tc of response.toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    currentMessages.push({ role: 'assistant', content: assistantContent });

    // Executa tools
    const toolResults = [];
    for (const tc of response.toolCalls) {
      try {
        const result = await toolExecutor(tc.name, tc.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: JSON.stringify({ error: err.message }),
          is_error: true,
        });
      }
    }
    currentMessages.push({ role: 'user', content: toolResults });
    iterations++;
  }

  return { success: false, error: 'Max tool iterations reached', provider: 'anthropic' };
}

// ---- OPENAI-COMPATIBLE tool use loop (Grok, DeepSeek, MiniMax) ----
async function chatWithAgentOpenAI(agent, messages, toolExecutor) {
  let currentMessages = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  const agentForRequest = toolExecutor ? agent : { ...agent, tools: [] };
  let iterations = 0;

  while (iterations < 10) {
    const response = await sendToOpenAI(agentForRequest, currentMessages);
    if (!response.success) return response;

    let toolCalls = response.toolCalls?.length ? response.toolCalls : null;
    let xmlToolCalls = null;

    if (!toolCalls && toolExecutor && response.content) {
      xmlToolCalls = parseFunctionCallXml(response.content);
    }

    if (!toolCalls && !xmlToolCalls) {
      return {
        success: true,
        text: extractText(response.content),
        usage: response.usage,
        provider: response.provider,
      };
    }

    if (!toolExecutor) {
      const cleanText = response.content
        .replace(/<FunctionCall>[\s\S]*?<\/FunctionCall>/g, '').trim();
      return {
        success: true,
        text: extractText(cleanText || 'Processado.'),
        usage: response.usage,
        provider: response.provider,
      };
    }

    if (toolCalls) {
      currentMessages.push({ role: 'assistant', content: response.content, tool_calls: toolCalls });
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
    } else if (xmlToolCalls) {
      console.log(`[chatWithAgent] ${agent.name}: ${xmlToolCalls.length} <FunctionCall> XML`);
      const results = [];
      for (const call of xmlToolCalls) {
        const result = await toolExecutor(call.name, call.args);
        results.push({ tool: call.name, result });
      }
      const cleanContent = response.content.replace(/<FunctionCall>[\s\S]*?<\/FunctionCall>/g, '').trim();
      currentMessages.push({
        role: 'assistant',
        content: cleanContent || `Consultando ${xmlToolCalls.map(c => c.name).join(', ')}...`,
      });
      const toolResultsText = results.map(r =>
        `Resultado de ${r.tool}: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}`
      ).join('\n\n');
      currentMessages.push({
        role: 'user',
        content: `[RESULTADO DAS FERRAMENTAS]\n${toolResultsText}\n\nResponda a pergunta original usando esses dados.`,
      });
    }

    iterations++;
  }

  return { success: false, error: 'Max tool iterations reached', provider: 'openai-compatible' };
}

export default { sendToAgent, chatWithAgent, extractText };
