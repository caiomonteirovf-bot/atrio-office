// services/llm-gateway.js — Gateway fino que usa o adapter registry.
//
// Por que existe: claude.js (662 linhas) tem lógica legacy de budget/retry/fallback/token-recording
// que não vale a pena refatorar ainda. Este gateway serve novos call sites (testes, novos agentes,
// scripts) com o contrato adapter limpo, sem tocar o hot path em produção.
//
// Uso:
//   import { generate } from './services/llm-gateway.js';
//   const res = await generate({
//     provider: 'openrouter',
//     model: 'anthropic/claude-sonnet-4.5',
//     messages: [{ role: 'system', content: '...' }, { role: 'user', content: '...' }],
//     maxTokens: 1024,
//     thinkingBudget: 2000,
//     cache: true,
//   });

import { registry } from './adapters/registry.js';

// Cost tracking legacy — lazy import para evitar falha se export não existir.
let _recordTokenUsage = null;
async function _loadRecorder() {
  if (_recordTokenUsage !== null) return _recordTokenUsage;
  try {
    const m = await import('./claude.js');
    _recordTokenUsage = typeof m.recordTokenUsage === 'function' ? m.recordTokenUsage : () => {};
  } catch { _recordTokenUsage = () => {}; }
  return _recordTokenUsage;
}

/**
 * Gera uma completion via adapter + grava uso de tokens.
 * @param {Object} opts
 * @param {string} opts.provider    - 'anthropic' | 'openrouter' | 'grok' | 'deepseek' | 'minimax'
 * @param {string} opts.model
 * @param {Array}  opts.messages
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.maxTokens=1024]
 * @param {Array}  [opts.tools]
 * @param {number} [opts.thinkingBudget]
 * @param {boolean}[opts.cache=true]
 * @param {string} [opts.agentId]   - opcional: pra rastrear custo por agente
 * @returns {Promise<import('./adapters/base.js').LLMResponse>}
 */
export async function generate(opts) {
  if (!opts.provider) throw new Error('llm-gateway: provider obrigatório');
  const adapter = registry.get(opts.provider);
  if (!adapter.isReady()) {
    return { success: false, error: `${opts.provider} sem credenciais`, provider: opts.provider, model: opts.model };
  }

  const res = await adapter.generate(opts);

  // Integração com sistema legado de cost tracking (opt-in, best-effort)
  if (res.success && res.usage) {
    try {
      const recorder = await _loadRecorder();
      recorder(opts.agentId || null, null, opts.model, {
        prompt_tokens: res.usage.input_tokens,
        completion_tokens: res.usage.output_tokens,
        prompt_tokens_details: { cached_tokens: res.usage.cached_tokens },
      });
    } catch { /* silenciar — cost tracking não deve quebrar chamada */ }
  }

  return res;
}

/**
 * Lista providers disponíveis e seu estado.
 * Usar pra health-check endpoint.
 */
export function health() {
  return {
    registered: registry.list(),
    ready: registry.listReady(),
  };
}
