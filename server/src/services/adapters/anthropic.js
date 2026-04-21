// services/adapters/anthropic.js — Adapter Anthropic SDK nativo.
// Suporta: prompt caching (cache_control), extended thinking, tool use.

import Anthropic from '@anthropic-ai/sdk';
import { LLMAdapter } from './base.js';

const COST_PER_1K = {
  // Sonnet 4.5 (abr/2026) — valores estimados
  'claude-sonnet-4.5':        { input: 0.003, output: 0.015, cached_read: 0.0003, cache_write: 0.00375 },
  'claude-3-5-sonnet-latest': { input: 0.003, output: 0.015, cached_read: 0.0003, cache_write: 0.00375 },
  'claude-haiku-4':           { input: 0.0008, output: 0.004, cached_read: 0.00008, cache_write: 0.001 },
};

export class AnthropicAdapter extends LLMAdapter {
  name = 'anthropic';

  constructor() {
    super();
    this.client = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;
  }

  isReady() { return !!this.client; }

  async generate({ model, messages, temperature = 0.3, maxTokens = 1024, tools, thinkingBudget, cache = true }) {
    if (!this.client) return { success: false, error: 'ANTHROPIC_API_KEY ausente', provider: this.name, model };

    // Split system/messages (Anthropic separa system)
    const systemMsgs = messages.filter(m => m.role === 'system');
    const convMsgs = messages.filter(m => m.role !== 'system');

    const system = systemMsgs.length > 0
      ? systemMsgs.map((m, i) => {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          const block = { type: 'text', text };
          // cache no último system block (pattern padrão Anthropic)
          if (cache && i === systemMsgs.length - 1) block.cache_control = { type: 'ephemeral' };
          return block;
        })
      : undefined;

    const payload = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: convMsgs.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content,
      })),
    };
    if (system) payload.system = system;
    if (tools?.length) payload.tools = tools;
    if (thinkingBudget) payload.thinking = { type: 'enabled', budget_tokens: thinkingBudget };

    try {
      const res = await this.client.messages.create(payload);
      const textBlock = res.content.find(b => b.type === 'text');
      const toolBlocks = res.content.filter(b => b.type === 'tool_use');

      const pricing = COST_PER_1K[model] || COST_PER_1K['claude-sonnet-4.5'];
      const usage = {
        input_tokens: res.usage.input_tokens || 0,
        output_tokens: res.usage.output_tokens || 0,
        cached_tokens: res.usage.cache_read_input_tokens || 0,
        cost_usd:
          (res.usage.input_tokens || 0) / 1000 * pricing.input +
          (res.usage.output_tokens || 0) / 1000 * pricing.output +
          (res.usage.cache_read_input_tokens || 0) / 1000 * pricing.cached_read +
          (res.usage.cache_creation_input_tokens || 0) / 1000 * pricing.cache_write,
      };

      return {
        success: true,
        content: textBlock?.text || '',
        tool_calls: toolBlocks.length ? toolBlocks.map(t => ({
          id: t.id, name: t.name, arguments: t.input,
        })) : undefined,
        stop_reason: res.stop_reason,
        usage,
        provider: this.name,
        model,
      };
    } catch (e) {
      return { success: false, error: e.message, provider: this.name, model };
    }
  }
}
