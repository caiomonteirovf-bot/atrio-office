// services/error-humanizer.js — Traduz erros técnicos para linguagem natural em PT.
//
// Usado em: mensagens de chat da equipe, notifications, logs de erro visíveis.
// Mantém o erro cru em `metadata/result` pra debug; só apresenta versão limpa ao usuário.

const PATTERNS = [
  // --- API providers ---
  { match: /ANTHROPIC_API_KEY|OPENAI_API_KEY|GROK_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY/i,
    msg: 'Credencial de IA não configurada — fale com o TI (André).' },
  { match: /rate[\s_-]?limit|429|too many requests/i,
    msg: 'Limite de uso da IA atingido. Aguardando janela e tentarei novamente.' },
  { match: /timeout|ETIMEDOUT|ECONNREFUSED|ENETUNREACH/i,
    msg: 'Sem conexão com o serviço externo. Vamos tentar novamente em instantes.' },
  { match: /401|unauthorized|invalid[\s_-]?token/i,
    msg: 'Credencial expirada ou inválida. Precisa renovar o token.' },
  { match: /403|forbidden/i,
    msg: 'Sem permissão pra essa operação.' },
  { match: /404|not[\s_-]?found/i,
    msg: 'Recurso não encontrado — pode ter sido movido ou excluído.' },
  { match: /500|internal[\s_-]?server[\s_-]?error/i,
    msg: 'Erro no servidor externo. Já registrei e vou tentar de novo.' },
  { match: /503|service[\s_-]?unavailable/i,
    msg: 'Serviço externo fora do ar no momento.' },

  // --- DB ---
  { match: /SASL|password must be a string|authentication failed/i,
    msg: 'Problema de autenticação no banco — TI precisa verificar.' },
  { match: /duplicate key|unique[\s_-]?violation/i,
    msg: 'Registro já existe. Verifiquem se não foi cadastrado antes.' },
  { match: /foreign key|violates.*constraint/i,
    msg: 'Dados inconsistentes — há referência a um item que não existe.' },
  { match: /connection terminated|connection lost/i,
    msg: 'Perda temporária de conexão com o banco.' },

  // --- tool-specific ---
  { match: /tool ["']?(\w+)["']? (?:falhou|failed|não implementada)/i,
    fn: (m) => `A ferramenta "${m[1]}" ainda não está implementada ou retornou erro.` },
  { match: /cnpj.*inválid|invalid[\s_-]?cnpj/i,
    msg: 'CNPJ inválido ou mal formatado.' },
  { match: /cpf.*inválid|invalid[\s_-]?cpf/i,
    msg: 'CPF inválido ou mal formatado.' },
  { match: /campo.*obrigatóri|missing[\s_-]?required/i,
    msg: 'Faltou preencher um campo obrigatório.' },

  // --- budget ---
  { match: /budget|orçamento.*excedido/i,
    msg: 'Orçamento mensal do agente excedido. Caio precisa revisar o limite.' },

  // --- prompt injection / sanitização ---
  { match: /prompt[\s_-]?injection|sanitize/i,
    msg: 'A mensagem contém padrão suspeito e foi filtrada.' },
];

/**
 * Converte erro técnico em PT natural, preservando fallback.
 * @param {string|Error} err
 * @param {Object} [opts]
 * @param {string} [opts.fallback]  mensagem padrão se não reconhecer
 * @param {number} [opts.maxLen]    truncagem (default 200)
 * @returns {string}
 */
export function humanizeError(err, opts = {}) {
  const raw = typeof err === 'string' ? err : (err?.message || String(err || ''));
  if (!raw) return opts.fallback || 'Erro desconhecido.';

  for (const p of PATTERNS) {
    const m = raw.match(p.match);
    if (m) return p.fn ? p.fn(m) : p.msg;
  }

  // fallback: limpa prefixos técnicos e limita tamanho
  let clean = raw
    .replace(/^Error:\s*/i, '')
    .replace(/^TypeError:\s*/i, '')
    .replace(/^ReferenceError:\s*/i, '')
    .replace(/at [\w/.\-:]+:\d+:\d+/g, '')  // stack traces
    .replace(/\s+/g, ' ')
    .trim();

  const maxLen = opts.maxLen || 200;
  if (clean.length > maxLen) clean = clean.slice(0, maxLen - 1) + '…';

  return clean || opts.fallback || 'Erro desconhecido.';
}

/**
 * Versão curta (<=80 chars) pra chat/UI compacta.
 */
export function humanizeErrorShort(err) {
  return humanizeError(err, { maxLen: 80 });
}
