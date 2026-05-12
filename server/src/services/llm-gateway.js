// services/llm-gateway.js — Gateway com fallback chain + circuit breaker.
//
// Por que existe: claude.js tem caminho legacy de tool-use loop. Este gateway
// serve novos call sites e o caminho moderno do chatWithAgent (feature flag).
//
// Uso simples (1 provider):
//   import { generate } from './services/llm-gateway.js';
//   const res = await generate({ provider: 'openrouter', model: '...', messages, ... });
//
// Uso com fallback (recomendado):
//   import { generateWithFallback } from './services/llm-gateway.js';
//   const res = await generateWithFallback({
//     chain: [
//       { provider: 'anthropic', model: 'claude-sonnet-4.5' },
//       { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
//       { provider: 'openrouter', model: 'openai/gpt-4o' },
//     ],
//     messages, maxTokens, ...
//   });

import { registry } from './adapters/registry.js';

// ─── Cost tracking legacy (lazy) ───────────────────────────────────────
let _recordTokenUsage = null;
async function _loadRecorder() {
  if (_recordTokenUsage !== null) return _recordTokenUsage;
  try {
    const m = await import('./claude.js');
    _recordTokenUsage = typeof m.recordTokenUsage === 'function' ? m.recordTokenUsage : () => {};
  } catch { _recordTokenUsage = () => {}; }
  return _recordTokenUsage;
}

async function _trackUsage(opts, res) {
  if (!res.success || !res.usage) return;
  try {
    const recorder = await _loadRecorder();
    recorder(opts.agentId || null, null, opts.model, {
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
      prompt_tokens_details: { cached_tokens: res.usage.cached_tokens },
    });
  } catch { /* cost tracking nunca quebra a chamada */ }
}

// ─── Circuit breaker in-memory ─────────────────────────────────────────
// Provider+modelo que falhou >= FAILURE_THRESHOLD vezes em WINDOW_MS
// fica em cooldown COOLDOWN_MS antes de ser tentado novamente.
const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 60_000;       // 1 min
const COOLDOWN_MS = 5 * 60_000; // 5 min
const _circuit = new Map(); // key -> { failures: [ts...], openUntil: ts }

function _circuitKey(provider, model) { return `${provider}:${model}`; }

function _isOpen(provider, model) {
  const e = _circuit.get(_circuitKey(provider, model));
  if (!e) return false;
  if (e.openUntil && Date.now() < e.openUntil) return true;
  if (e.openUntil && Date.now() >= e.openUntil) {
    // half-open: resetar contador, deixar próxima tentativa decidir
    _circuit.set(_circuitKey(provider, model), { failures: [], openUntil: 0 });
    return false;
  }
  return false;
}

function _recordFailure(provider, model) {
  const key = _circuitKey(provider, model);
  const now = Date.now();
  const entry = _circuit.get(key) || { failures: [], openUntil: 0 };
  entry.failures = entry.failures.filter(ts => now - ts < WINDOW_MS);
  entry.failures.push(now);
  if (entry.failures.length >= FAILURE_THRESHOLD) {
    entry.openUntil = now + COOLDOWN_MS;
    console.warn(`[llm-gateway] circuit OPEN ${key} (${entry.failures.length} falhas em ${WINDOW_MS}ms, cooldown ${COOLDOWN_MS}ms)`);
  }
  _circuit.set(key, entry);
}

function _recordSuccess(provider, model) {
  const key = _circuitKey(provider, model);
  if (_circuit.has(key)) _circuit.set(key, { failures: [], openUntil: 0 });
}

// ─── Classifier de erros retryable ─────────────────────────────────────
const RETRYABLE_PATTERNS = [
  /credit balance is too low/i,
  /insufficient[_ ]quota/i,
  /quota exceeded/i,
  /rate[_ ]limit/i,
  /\b402\b/, /\b429\b/, /\b500\b/, /\b502\b/, /\b503\b/, /\b504\b/,
  /timeout/i, /timed out/i,
  /econnreset|enotfound|econnrefused|etimedout/i,
  /service unavailable/i,
  /overloaded/i,
  /sem credenciais/i,        // adapter sem API key — também trata como retryable pra ir pro próximo
  /api key/i,
];

export function isRetryableError(errMsg) {
  if (!errMsg) return false;
  const s = String(errMsg);
  return RETRYABLE_PATTERNS.some(rx => rx.test(s));
}

// ─── Normalização de tools entre formatos ──────────────────────────────
// OpenAI/OpenRouter/Grok/DeepSeek: { type:'function', function:{ name, description, parameters } }
// Anthropic native:                 { name, description, input_schema }
function _normalizeToolsForProvider(tools, provider) {
  if (!tools?.length) return tools;
  if (provider !== 'anthropic') return tools; // OpenAI-compat e OpenRouter aceitam formato OpenAI
  // Converter pra formato Anthropic
  return tools.map(t => {
    if (t.type === 'function' && t.function) {
      return {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      };
    }
    return t; // já está em formato Anthropic
  });
}

// ─── Generate single (compat antigo) ───────────────────────────────────
export async function generate(opts) {
  if (!opts.provider) throw new Error('llm-gateway: provider obrigatório');
  const adapter = registry.get(opts.provider);
  if (!adapter.isReady()) {
    return { success: false, error: `${opts.provider} sem credenciais`, provider: opts.provider, model: opts.model };
  }
  const res = await adapter.generate(opts);
  await _trackUsage(opts, res);
  return res;
}

// ─── Generate with fallback chain (NOVO) ───────────────────────────────
/**
 * @param {Object} opts
 * @param {Array<{provider:string, model:string}>} opts.chain - ordem de tentativa
 * @param {Array} opts.messages
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {Array}  [opts.tools]
 * @param {number} [opts.thinkingBudget]
 * @param {boolean}[opts.cache]
 * @param {string} [opts.agentId]
 * @returns {Promise<import('./adapters/base.js').LLMResponse & {attempts?:Array}>}
 */
export async function generateWithFallback(opts) {
  const chain = (opts.chain || []).filter(Boolean);
  if (chain.length === 0) throw new Error('llm-gateway: chain vazia');

  const attempts = [];
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const { provider, model } = chain[i];

    if (_isOpen(provider, model)) {
      attempts.push({ provider, model, skipped: 'circuit_open' });
      continue;
    }

    let adapter;
    try { adapter = registry.get(provider); }
    catch (e) {
      attempts.push({ provider, model, skipped: 'adapter_missing', error: e.message });
      continue;
    }

    if (!adapter.isReady()) {
      attempts.push({ provider, model, skipped: 'no_credentials' });
      continue;
    }

    const t0 = Date.now();
    const adapterOpts = { ...opts, provider, model };
    if (opts.tools?.length) adapterOpts.tools = _normalizeToolsForProvider(opts.tools, provider);
    const res = await adapter.generate(adapterOpts);
    const ms = Date.now() - t0;

    if (res.success) {
      _recordSuccess(provider, model);
      attempts.push({ provider, model, ms, ok: true, cost: res.usage?.cost_usd });
      await _trackUsage({ ...opts, provider, model }, res);
      if (i > 0) {
        console.warn(`[llm-gateway] fallback OK: usado ${provider}/${model} após ${i} falha(s). Chain: ${chain.map(c => c.provider+'/'+c.model).join(' → ')}`);
      }
      return { ...res, attempts };
    }

    // Falhou
    lastError = res.error;
    const retryable = isRetryableError(res.error);
    attempts.push({ provider, model, ms, ok: false, error: res.error, retryable });

    if (retryable) {
      _recordFailure(provider, model);
      console.warn(`[llm-gateway] ${provider}/${model} falhou (retryable): ${res.error} — tentando próximo`);
      continue;
    }

    // Erro não-retryable (ex: input inválido, modelo inexistente) — não faz sentido tentar próximo
    console.warn(`[llm-gateway] ${provider}/${model} falhou (não-retryable): ${res.error}`);
    return { success: false, error: res.error, provider, model, attempts };
  }

  // Toda a chain falhou
  console.error(`[llm-gateway] CHAIN EXAURIDA: ${chain.length} provedores falharam. Último erro: ${lastError}`);
  return {
    success: false,
    error: lastError || 'todos provedores indisponíveis',
    friendly: 'Estou com instabilidade técnica nos modelos de IA. Equipe técnica notificada.',
    provider: 'fallback',
    model: chain.map(c => c.model).join(','),
    chain_exhausted: true,
    attempts,
  };
}

// ─── Health/observabilidade ────────────────────────────────────────────
export function health() {
  const circuit = {};
  for (const [key, val] of _circuit.entries()) {
    circuit[key] = {
      failures_in_window: val.failures.length,
      open: val.openUntil > Date.now(),
      open_until: val.openUntil ? new Date(val.openUntil).toISOString() : null,
    };
  }
  return {
    registered: registry.list(),
    ready: registry.listReady(),
    circuit,
    config: { FAILURE_THRESHOLD, WINDOW_MS, COOLDOWN_MS },
  };
}

// Reset manual do circuit (pra debug/admin)
export function resetCircuit(provider, model) {
  if (provider && model) _circuit.delete(_circuitKey(provider, model));
  else _circuit.clear();
}
