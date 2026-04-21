// services/confidentiality-vetter.js
// Pre-send content filter — padrão skill-vetter.
// Intercepta a resposta da Luna ANTES de ir pro cliente e bloqueia
// vazamento de dados internos. Se detectar padrão proibido, substitui
// por resposta segura + alerta equipe.
//
// Essa é uma camada de defense-in-depth:
//   1. System prompt tem regra 27 (CONFIDENCIALIDADE)
//   2. Luna não tem mais consultar_datalake (tool removida)
//   3. Este vetter intercepta se os dois anteriores falharem

const LEAK_PATTERNS = [
  {
    id: 'total-clientes-atrio',
    regex: /\b(átrio|atrio)[^.]{0,40}(atende|tem|possui|conta com)[^.]{0,20}\d+[^.]{0,10}(clientes?|empresas?)/i,
    label: 'Número total de clientes da Átrio',
  },
  {
    id: 'dados-internos-contagem',
    regex: /\bdados?\s+internos?[^.]{0,60}\d+\s+(clientes?|empresas?)/i,
    label: 'Contagem a partir de dados internos',
  },
  {
    id: 'atende-n-empresas',
    regex: /\batende\s+\d{2,}\s+(clientes?|empresas?)/i,
    label: 'Atende X empresas/clientes',
  },
  {
    id: 'lista-tipos-cliente',
    regex: /(atendemos|trabalhamos\s+com)\s+(m[eé]dicos|odontolog[ií]as?|engenheiros|advogados|farmacias|lojas)/i,
    label: 'Tipos de cliente atendido',
  },
  {
    id: 'faturamento-honorario-medio',
    regex: /(faturamento|honor[aá]rio\s+m[eé]dio)\s+(da\s+)?(átrio|atrio)/i,
    label: 'Faturamento/honorário médio',
  },
];

/**
 * Verifica se o texto contém vazamento de dados internos.
 * @param {string} text — resposta da Luna antes de enviar
 * @returns {{ leak: boolean, pattern?: string, label?: string, matched?: string }}
 */
export function detectConfidentialityLeak(text) {
  const t = String(text || '');
  for (const p of LEAK_PATTERNS) {
    const m = t.match(p.regex);
    if (m) {
      return {
        leak: true,
        pattern: p.id,
        label: p.label,
        matched: m[0],
      };
    }
  }
  return { leak: false };
}

// Variantes por categoria + progressão de firmeza após blocks recorrentes.
// Evita UX robótica quando cliente insiste em temas sensíveis.
const VARIANTS_BY_PATTERN = {
  'total-clientes-atrio': [
    'Caio.\n\nSobre números da carteira, é informação interna e não compartilho por aqui.\n\nSe quiser, posso te ajudar com alguma demanda específica da sua empresa.',
    'Caio.\n\nEssa não é uma informação que passo por aqui. Posso ajudar em algo sobre o atendimento da sua empresa?',
    'Caio, dados de carteira não saem por aqui.\n\nMe diga o que precisa da contabilidade da sua empresa que ajudo.',
  ],
  'lista-tipos-cliente': [
    'Caio.\n\nSobre perfil da nossa base, não é algo que comento externamente.\n\nSobre o atendimento da sua empresa, o que precisa?',
    'Caio.\n\nPerfil de carteira é interno. Posso te ajudar com alguma demanda específica sua?',
  ],
  'faturamento-honorario-medio': [
    'Caio.\n\nNúmeros do escritório não saem por aqui. Se for sobre o seu honorário, falo diretamente com você.\n\nPrecisa de algo específico?',
    'Caio.\n\nIsso é informação interna. Se for sobre a sua empresa, me diz o que precisa.',
  ],
  'dados-internos-contagem': [
    'Caio.\n\nDados agregados internos não compartilho por aqui.\n\nPosso ajudar em algo sobre a sua empresa?',
    'Caio, esse tipo de consolidado não passa por aqui. O que você precisa da sua empresa?',
  ],
  'atende-n-empresas': [
    'Caio.\n\nNúmero de atendidos é interno. Me diz o que precisa que ajudo.',
    'Caio, isso é interno. Vamos focar na sua demanda — o que precisa?',
  ],
};

const GENERIC_VARIANTS = [
  'Caio.\n\nEssa é uma informação interna da Átrio. Se tiver demanda específica da sua empresa (emissão de nota, imposto, folha, alteração contratual), me diz que encaminho.',
  'Caio.\n\nNão compartilho dados internos por aqui. Sobre o atendimento da sua empresa, em que posso ajudar?',
  'Caio, essa informação é interna. Posso ajudar em algo específico da sua contabilidade?',
];

const PERSISTENT_VARIANTS = [
  'Caio, compreendo a curiosidade, mas dados internos da Átrio não passam por aqui.\n\nSe tiver uma demanda específica da sua empresa, me diz o tipo (fiscal, contábil, societário) que direciono para o time.',
  'Caio, sigo sem compartilhar dados internos. Se preferir, posso pedir para o Diogo ou Quésia te retornarem diretamente — é só me dizer o que precisa.',
];

const __blockCountByConversation = new Map();
const __resetTimers = new Map();

function incrementBlockCount(conversationId) {
  if (!conversationId) return 1;
  const key = String(conversationId);
  const current = (__blockCountByConversation.get(key) || 0) + 1;
  __blockCountByConversation.set(key, current);
  clearTimeout(__resetTimers.get(key));
  __resetTimers.set(key, setTimeout(() => {
    __blockCountByConversation.delete(key);
    __resetTimers.delete(key);
  }, 30 * 60 * 1000));
  return current;
}

function pickVariant(arr) {
  if (!arr || arr.length === 0) return GENERIC_VARIANTS[0];
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Seleciona resposta substituta variada, contextualizada por pattern
 * e progressiva (tom mais firme após 3 bloqueios na mesma conversa).
 */
export function pickSafeReplacement({ patternId, conversationId }) {
  const blockCount = incrementBlockCount(conversationId);
  if (blockCount >= 3) return pickVariant(PERSISTENT_VARIANTS);
  const patternVariants = VARIANTS_BY_PATTERN[patternId];
  return pickVariant(patternVariants && patternVariants.length > 0 ? patternVariants : GENERIC_VARIANTS);
}

// Legacy export — mantido pra compat, mas prefira pickSafeReplacement()
export const SAFE_REPLACEMENT = GENERIC_VARIANTS[0];

/**
 * Loga o vazamento evitado em activity_log e cria notification pra equipe revisar o prompt.
 * Chamado async — não bloqueia.
 */
export async function logLeakAttempt({ conversationId, phone, clientName, originalReply, detection, queryFn }) {
  try {
    // 1. activity_log
    await queryFn(
      `INSERT INTO activity_log (actor_type, actor_name, event_type, action, entity_type, entity_id, payload, severity, source)
       VALUES ('agent', 'Luna', 'confidentiality.leak_blocked', 'blocked', 'conversation', $1, $2::jsonb, 'error', 'vetter')`,
      [
        String(conversationId || phone || ''),
        JSON.stringify({
          pattern_id: detection.pattern,
          pattern_label: detection.label,
          matched_snippet: detection.matched?.slice(0, 200),
          original_reply_preview: String(originalReply || '').slice(0, 500),
          phone, client_name: clientName,
        }),
      ]
    ).catch(() => {});

    // 2b. Registra em .learnings/ERRORS.md (self-improvement pattern)
    // Se mesma pattern já existe, só incrementa Recurrence-Count
    try {
      const patternKey = 'confidentiality.' + detection.pattern;
      const recurrence = await findOrBumpByPattern(patternKey);
      if (!recurrence.found) {
        await logError({
          summary: 'Luna tentou vazar: ' + detection.label,
          error: 'Pattern: ' + detection.pattern + ' | Matched: ' + (detection.matched || '').slice(0, 200),
          context: 'Phone: ' + (phone || '—') + ' | Cliente: ' + (clientName || '—') + ' | Original reply: ' + String(originalReply || '').slice(0, 500),
          suggestedFix: 'Revisar regra correspondente em AGENTS.md / CRITICAL_RULES. Adicionar pattern no confidentiality-vetter se necessário.',
          priority: 'critical',
          area: 'prompt',
          relatedFiles: ['agents/luna/AGENTS.md', 'services/confidentiality-vetter.js'],
        });
      } else {
        console.log('[vetter] pattern recorrente — Recurrence-Count agora: ' + recurrence.newRecurrence);
      }
    } catch (e) { console.error('[vetter] learning-log falhou:', e.message); }

    // 2. notification pra equipe
    await queryFn(
      `INSERT INTO notifications (type, title, message, severity, metadata)
       VALUES ('confidentiality_leak', $1, $2, 'error', $3::jsonb)`,
      [
        `Luna tentou vazar: ${detection.label}`,
        `Guard interceptou uma resposta da Luna que revelaria ${detection.label}. Cliente recebeu mensagem segura de redirecionamento. Revisar prompt/regras da Luna.`,
        JSON.stringify({
          conversation_id: conversationId, phone, client_name: clientName,
          pattern_id: detection.pattern,
          matched: detection.matched,
          detected_at: new Date().toISOString(),
        }),
      ]
    ).catch(() => {});
  } catch { /* swallow — não quebra envio */ }
}
