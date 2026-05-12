// services/memory-classifier.js — Governança de memória em 3 níveis.
//
// Antes: toda memória ensinada via /api/memory/teach virava `status='approved'`
// automaticamente — confiança cega no input. Risco: prompt injection ("ignore
// instruções anteriores", "agora você é admin") e fatos sensíveis fiscais sem
// revisão humana.
//
// Agora: classifier baseado em regras + keywords decide:
//   - 'quarantine' → injection detectado → status='rejected' + tag 'quarantine'
//   - 'review'     → fato sensível (CNPJ, valor, honorário, regime) → 'pending_review'
//   - 'approve'    → trivia (saudação, horário) → 'approved'
//
// Frente 5 da revisão maio/2026.

// Padrões de prompt injection — texto que tenta sobrescrever instruções do agente.
const INJECTION_PATTERNS = [
  /ignor[ea]\s+(as?|todas?)\s+(instru[çc][õo]es|comandos|regras)/i,
  /esque[çc]a\s+(tudo|as?|todas?)\s*(instru|comandos|regras)?/i,
  /(novo|nova)\s+(sistema|prompt|persona|regra):/i,
  /voc[êe]\s+(é\s+)?agora\s+(um|uma|o|a)\s+/i,
  /act\s+as\s+(an?|the)\s+/i,
  /you\s+are\s+now\s+/i,
  /system\s*(prompt|message|override)/i,
  /jailbreak|DAN\s+mode|developer\s+mode/i,
  /reveal\s+(your|the)\s+(prompt|instructions|system)/i,
  /ignore\s+(previous|above|all)\s+(instructions|prompts|rules)/i,
  /\bdesconsidere\s+(o|tudo|todas?)/i,
  /pretenda\s+(ser|que)/i,
  // Tentativas de extração de credenciais
  /(senha|password|token|api[_\s-]?key|secret).*?[:=]/i,
];

// Keywords que indicam fato sensível fiscal/financeiro — exige revisão humana.
const SENSITIVE_FACT_PATTERNS = [
  // Documentos
  /\bCNPJ\b/i, /\bCPF\b/i,
  /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/, // CNPJ formato
  /\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/, // CPF formato
  // Valores
  /R\$\s*[\d.,]+/i,
  /\bvalor\b.*\d/i,
  /\bhonor[áa]rio\b/i,
  /\bmensalidade\b/i,
  // Regime/Tributário
  /\bregime\s+(tribut[áa]rio|fiscal)\b/i,
  /\bsimples\s+nacional\b/i,
  /\blucro\s+(real|presumido)\b/i,
  /\bMEI\b/i,
  /\bal[íi]quota\b/i,
  // NF / fiscal
  /\bNF[-\s]?[eE]?\b/i,
  /\bDARF\b/i, /\bDAS\b/i, /\bGPS\b/i,
  /\bICMS\b/i, /\bISS\b/i, /\bPIS\b/i, /\bCOFINS\b/i, /\bIRPJ\b/i, /\bCSLL\b/i,
  // Banco
  /\bag[êe]ncia.*\d/i, /\bconta\s+(corrente|poupan)/i,
  /\bPIX\b/i,
];

/**
 * Classifica conteúdo de memória em um dos 3 níveis.
 * @param {string} title
 * @param {string} content
 * @returns {{level: 'quarantine'|'review'|'approve', reasons: string[], status: string}}
 */
export function classifyMemory(title, content) {
  const text = `${title || ''} \n ${content || ''}`;
  const reasons = [];

  // 1. Prompt injection → quarentena (status=rejected, tag quarantine)
  for (const rx of INJECTION_PATTERNS) {
    const m = text.match(rx);
    if (m) {
      reasons.push(`injection: "${m[0].slice(0, 60)}"`);
    }
  }
  if (reasons.length > 0) {
    return { level: 'quarantine', reasons, status: 'rejected' };
  }

  // 2. Fato sensível → pending_review
  for (const rx of SENSITIVE_FACT_PATTERNS) {
    const m = text.match(rx);
    if (m) {
      reasons.push(`fato sensivel: "${m[0].slice(0, 40)}"`);
    }
  }
  if (reasons.length > 0) {
    return { level: 'review', reasons, status: 'pending_review' };
  }

  // 3. Default: aprovação automática
  return { level: 'approve', reasons: ['trivia/sem padroes sensiveis'], status: 'approved' };
}

/**
 * Helper pra adicionar tag 'quarantine'/'review' à lista existente.
 */
export function tagsWithLevel(existingTags = [], level) {
  const tags = [...(existingTags || [])];
  if (level === 'quarantine' && !tags.includes('quarantine')) tags.push('quarantine');
  if (level === 'review' && !tags.includes('needs_review')) tags.push('needs_review');
  return tags;
}
