// services/adapters/base.js — Interface base para adapters de LLM.
//
// Paradigma: cada provider implementa o contrato `LLMAdapter`.
// Benefícios:
//  - Trocar provider sem mexer no orchestrator
//  - Plugar agentes externos (ex.: OpenClaw, Cursor CLI) com mesmo contrato
//  - Testes podem usar MockAdapter
//
// Inspirado em paperclipai/paperclip (adapter pattern pra múltiplos agentes-CLI).

/**
 * @typedef {Object} LLMMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string|Array} content
 * @property {Array} [tool_calls]
 * @property {string} [tool_call_id]
 */

/**
 * @typedef {Object} LLMUsage
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} cached_tokens
 * @property {number} cost_usd
 */

/**
 * @typedef {Object} LLMResponse
 * @property {boolean} success
 * @property {string} [content]
 * @property {Array}  [tool_calls]
 * @property {string} [stop_reason]
 * @property {LLMUsage} [usage]
 * @property {string} provider
 * @property {string} model
 * @property {string} [error]
 */

/**
 * Contrato base. Todo adapter implementa `generate(request) → LLMResponse`.
 */
export class LLMAdapter {
  /** @type {string} */
  name = 'base';

  /** Retorna true se o adapter está pronto (credenciais OK). */
  isReady() { return false; }

  /**
   * @param {Object} request
   * @param {string} request.model
   * @param {LLMMessage[]} request.messages
   * @param {number} [request.temperature]
   * @param {number} [request.maxTokens]
   * @param {Array}  [request.tools]
   * @param {number} [request.thinkingBudget]
   * @param {boolean} [request.cache]
   * @returns {Promise<LLMResponse>}
   */
  async generate(_request) {
    throw new Error(`${this.name}.generate() not implemented`);
  }
}
