// services/adapters/openai-compat.js — Adapter genérico pra APIs OpenAI-compatíveis.
// Usado por: xAI (Grok), DeepSeek, MiniMax, Together, Groq, etc.

import OpenAI from 'openai';
import { LLMAdapter } from './base.js';

export class OpenAICompatAdapter extends LLMAdapter {
  /**
   * @param {Object} cfg
   * @param {string} cfg.name        — identificador (grok, deepseek, etc)
   * @param {string} cfg.apiKey
   * @param {string} cfg.baseURL
   */
  constructor(cfg) {
    super();
    this.name = cfg.name;
    this.client = cfg.apiKey
      ? new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })
      : null;
  }

  isReady() { return !!this.client; }

  async generate({ model, messages, temperature = 0.3, maxTokens = 1024, tools }) {
    if (!this.client) return { success: false, error: `${this.name.toUpperCase()}_API_KEY ausente`, provider: this.name, model };

    const formatted = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    }));

    const payload = { model, messages: formatted, temperature, max_tokens: maxTokens };
    if (tools?.length) payload.tools = tools;

    try {
      const res = await this.client.chat.completions.create(payload);
      const choice = res.choices[0];
      const msg = choice.message;

      const usage = {
        input_tokens: res.usage?.prompt_tokens || 0,
        output_tokens: res.usage?.completion_tokens || 0,
        cached_tokens: res.usage?.prompt_tokens_details?.cached_tokens || 0,
        cost_usd: 0, // providers compat não retornam custo — calculado no orchestrator
      };

      // Normaliza tool_calls pro formato do contrato: { id, name, arguments }
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
