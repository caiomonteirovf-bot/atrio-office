// services/adapters/openrouter.js — Adapter via OpenRouter.
// Gateway pra múltiplos modelos (Claude, GPT, Gemini, Grok, etc) com mesmo wire format OpenAI.

import OpenAI from 'openai';
import { LLMAdapter } from './base.js';

export class OpenRouterAdapter extends LLMAdapter {
  name = 'openrouter';

  constructor() {
    super();
    this.client = process.env.OPENROUTER_API_KEY
      ? new OpenAI({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: 'https://openrouter.ai/api/v1',
          defaultHeaders: {
            'HTTP-Referer': 'https://atrio.dev',
            'X-Title': 'Atrio Office',
          },
        })
      : null;
  }

  isReady() { return !!this.client; }

  async generate({ model, messages, temperature = 0.3, maxTokens = 1024, tools, thinkingBudget, cache = true }) {
    if (!this.client) return { success: false, error: 'OPENROUTER_API_KEY ausente', provider: this.name, model };

    // Modelos que suportam cache_control (Claude via OpenRouter, Gemini 2.5+)
    const supportsCache = cache && (
      model.startsWith('anthropic/') ||
      model.startsWith('google/gemini-2.5')
    );

    const formatted = messages.map((m, i) => {
      if (supportsCache && m.role === 'system') {
        // transformar em array content block com cache_control
        return {
          role: m.role,
          content: [{
            type: 'text',
            text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            cache_control: { type: 'ephemeral' },
          }],
        };
      }
      return {
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      };
    });

    const payload = {
      model,
      messages: formatted,
      temperature,
      max_tokens: maxTokens,
    };
    if (tools?.length) payload.tools = tools;
    if (thinkingBudget) payload.reasoning = { max_tokens: thinkingBudget };

    try {
      const res = await this.client.chat.completions.create(payload);
      const choice = res.choices[0];
      const msg = choice.message;

      const usage = {
        input_tokens: res.usage?.prompt_tokens || 0,
        output_tokens: res.usage?.completion_tokens || 0,
        cached_tokens: res.usage?.prompt_tokens_details?.cached_tokens || 0,
        cost_usd: res.usage?.cost || 0, // OpenRouter retorna custo calculado
      };

      const normalizedToolCalls = msg.tool_calls?.length
        ? msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: (() => {
              const a = tc.function?.arguments;
              if (!a) return {};
              if (typeof a === 'object') return a;
              try { return JSON.parse(a); } catch { return {}; }
            })(),
          }))
        : undefined;

      return {
        success: true,
        content: msg.content || '',
        tool_calls: normalizedToolCalls,
        stop_reason: choice.finish_reason,
        usage,
        provider: this.name,
        model,
      };
    } catch (e) {
      return { success: false, error: e.message, provider: this.name, model };
    }
  }
}
