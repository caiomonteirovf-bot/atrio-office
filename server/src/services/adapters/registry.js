// services/adapters/registry.js — Registry central de adapters.
//
// Uso:
//   import { registry } from './adapters/registry.js';
//   const adapter = registry.get('anthropic');
//   const res = await adapter.generate({ model, messages, ... });
//
// Para adicionar um provider novo: criar arquivo em adapters/ e registrar aqui.

import { AnthropicAdapter } from './anthropic.js';
import { OpenRouterAdapter } from './openrouter.js';
import { OpenAICompatAdapter } from './openai-compat.js';

class Registry {
  constructor() {
    /** @type {Map<string, import('./base.js').LLMAdapter>} */
    this._adapters = new Map();
  }

  register(name, adapter) {
    this._adapters.set(name, adapter);
  }

  get(name) {
    const a = this._adapters.get(name);
    if (!a) throw new Error(`Adapter '${name}' não registrado. Registrados: ${[...this._adapters.keys()].join(', ')}`);
    return a;
  }

  has(name) { return this._adapters.has(name); }

  list() { return [...this._adapters.keys()]; }

  /** Lista adapters prontos (credenciais válidas). */
  listReady() {
    return [...this._adapters.entries()]
      .filter(([, a]) => a.isReady())
      .map(([k]) => k);
  }
}

export const registry = new Registry();

// Registro default — providers suportados hoje.
registry.register('anthropic',  new AnthropicAdapter());
registry.register('openrouter', new OpenRouterAdapter());

// OpenAI-compat: grok, deepseek, minimax usam mesmo wire format via baseURL diferente.
registry.register('grok',     new OpenAICompatAdapter({
  name: 'grok',
  apiKey: process.env.GROK_API_KEY || process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
}));
registry.register('deepseek', new OpenAICompatAdapter({
  name: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
}));
registry.register('minimax',  new OpenAICompatAdapter({
  name: 'minimax',
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.chat/v1',
}));
