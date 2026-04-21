// services/luna-regression-detector.js
// Roda periodicamente (cron job) scans das mensagens da Luna nas últimas 24h
// procurando regressões conhecidas (padrões que já foram corrigidos por feedback).
//
// Se achar algo, cria notification pra equipe revisar E loga em activity_log.
//
// Padrões são versionados — adicionar um novo aqui não quebra existentes.

import { query } from '../db/pool.js';
import { logLearning, findOrBumpByPattern } from './learning-log.js';

// Cada pattern é uma regressão já identificada e corrigida.
// regex: o que NÃO deveria aparecer mais
// fonte: onde foi corrigido (commit ou memória)
// severity: warning/error
const REGRESSION_PATTERNS = [
  {
    id: 'anotei-saudacao',
    label: 'Luna usou "anotei" em saudação fora de hora',
    regex: /\b(j[áa]\s+)?anot(ei|o\s+sua|ando)/i,
    fonte: 'feedback Caio 19/04/2026',
    severity: 'warning',
  },
  {
    id: 'menciona-empresa-inline',
    label: 'Luna mencionou nome da empresa na resposta ("aí na CVM…")',
    regex: /\b(a[íi]|aqui)\s+na\s+[A-ZÁÀÂÉÊÍÓÔÚÇ][A-ZÁÀÂÉÊÍÓÔÚÇa-záàâéêíóôúç]+\b/,
    fonte: 'feedback Caio 19/04/2026',
    severity: 'warning',
  },  {
    id: 'infantil-querido',
    label: 'Luna usou tratamento infantil (querido/fofa/amigo/gracinha)',
    regex: /\b(querid[oa]s?|fofa|\bamig[oa]\b|gracinha)\b/i,
    fonte: 'MEMORY.md feedback_luna_comunicacao',
    severity: 'warning',
  },
  {
    id: 'pede-desculpa',
    label: 'Luna pediu desculpas (proibido por regra de tom)',
    regex: /\b(me\s+desculp|pe[çc]o\s+desculp|desculp[ae])\b/i,
    fonte: 'MEMORY.md feedback_luna_comunicacao',
    severity: 'warning',
  },
  {
    id: 'vaza-contagem-interna',
    label: 'Luna vazou contagem/métrica interna (ex.: "105 clientes", "atende X empresas")',
    regex: /\b(átrio|atrio)\s+(atende|tem|possui|conta com)\s+\d+\s+(clientes?|empresas?)/i,
    fonte: 'incidente Caio 20/04/2026',
    severity: 'error',
  },
  {
    id: 'vaza-total-clientes',
    label: 'Luna respondeu sobre total de clientes',
    regex: /(total|todos?)\s+(?:os\s+)?clientes?.{0,30}\d+|dados?\s+internos?.{0,50}\d+\s+clientes?/i,
    fonte: 'incidente Caio 20/04/2026',
    severity: 'error',
  },
];

/**
 * Roda scan nas últimas N horas de mensagens outbound da Luna.
 * Retorna lista de ocorrências (não grava nada aqui — caller decide).
 */
export async function scanLastHours(hours = 24) {
  // Escaneia AMBAS as tabelas: luna_v2.messages (nova, audit trail) + whatsapp_messages
  // (antiga, fonte real de toda mensagem WhatsApp enviada). Dedupe via (source:id).
  const { rows } = await query(
    `SELECT id::text AS id, conversation_id::text AS conversation_id,
            content, created_at, 'luna_v2' AS source
       FROM luna_v2.messages
      WHERE (direction = 'outbound' OR agent_id = 'luna')
        AND created_at > NOW() - ($1 || ' hours')::interval
      UNION ALL
     SELECT id::text, conversation_id::text, body AS content, created_at, 'whatsapp' AS source
       FROM public.whatsapp_messages
      WHERE sender IN ('luna', 'bot')
        AND created_at > NOW() - ($1 || ' hours')::interval
      ORDER BY created_at DESC
      LIMIT 4000`,
    [String(hours)]
  );

  const findings = [];
  for (const m of rows) {
    const content = String(m.content || '');
    for (const p of REGRESSION_PATTERNS) {
      const match = content.match(p.regex);
      if (match) {
        findings.push({
          message_id: m.id,
          conversation_id: m.conversation_id,
          created_at: m.created_at,
          pattern_id: p.id,
          pattern_label: p.label,
          severity: p.severity,
          matched: match[0],
          snippet: content.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30),
          source: m.source || 'luna_v2',
        });
      }
    }
  }
  return findings;
}

/**
 * Roda scan + grava findings novos como notifications.
 * De-dup: usa a combinação (message_id, pattern_id) como chave lógica.
 */
export async function runDetector({ hours = 24 } = {}) {
  const findings = await scanLastHours(hours);
  if (!findings.length) {
    return { scanned_hours: hours, findings: 0, new_notifications: 0 };
  }

  let inserted = 0;
  for (const f of findings) {
    // De-dup: já existe notification pra este msg + pattern?
    const dupKey = (f.source || 'luna_v2') + ':' + f.message_id;
    const dup = await query(
      `SELECT 1 FROM notifications
        WHERE type = 'regression_detector'
          AND metadata->>'dup_key' = $1
          AND metadata->>'pattern_id' = $2
        LIMIT 1`,
      [dupKey, f.pattern_id]
    ).catch(() => ({ rows: [] }));
    if (dup.rows.length) continue;

    const title = `Luna regrediu: ${f.pattern_label}`;
    const message = `Detectado em mensagem de ${new Date(f.created_at).toLocaleString('pt-BR')}. Trecho: "…${f.snippet}…". A equipe deve revisar o system_prompt da Luna ou re-ingerir a memória correspondente.`;
    await query(
      `INSERT INTO notifications (type, title, message, severity, metadata)
       VALUES ('regression_detector', $1, $2, $3, $4::jsonb)`,
      [title, message, f.severity, JSON.stringify({
        message_id: f.message_id,
        conversation_id: f.conversation_id,
        pattern_id: f.pattern_id,
        source: f.source,
        dup_key: (f.source || 'luna_v2') + ':' + f.message_id,
        matched: f.matched,
        fonte: REGRESSION_PATTERNS.find(p => p.id === f.pattern_id)?.fonte,
        detected_at: new Date().toISOString(),
      })]
    ).catch(() => {});
    inserted++;

    // Espelha em .learnings/LEARNINGS.md (self-improvement)
    try {
      const patternKey = 'regression.' + f.pattern_id;
      const recurrence = await findOrBumpByPattern(patternKey);
      if (!recurrence.found) {
        await logLearning({
          category: 'correction',
          priority: 'high',
          area: 'prompt',
          summary: 'Detector pegou: ' + f.pattern_label,
          details: 'Snippet: "…' + f.snippet + '…" (message_id=' + f.message_id + ')',
          suggestedAction: 'Revisar regra correspondente no AGENTS.md. Reforçar ou adicionar ao CRITICAL_RULES.',
          source: 'regression-detector',
          patternKey,
          tags: ['detector', f.pattern_id],
        });
      }
    } catch (e) { console.error('[detector] learning-log falhou:', e.message); }
  }

  return { scanned_hours: hours, findings: findings.length, new_notifications: inserted };
}

/**
 * Inicia o cron. Roda a cada N minutos (default 60).
 */
export function startRegressionDetector(intervalMinutes = 60) {
  const ms = intervalMinutes * 60 * 1000;
  console.log(`[luna-regression-detector] iniciado — scan a cada ${intervalMinutes}min`);

  // Scan inicial após 60s (dá tempo do server estabilizar)
  setTimeout(() => {
    runDetector().then(r => {
      console.log(`[luna-regression-detector] scan inicial: ${r.findings} findings, ${r.new_notifications} novas notifications`);
    }).catch(e => console.error('[luna-regression-detector] erro:', e.message));
  }, 60 * 1000);

  setInterval(() => {
    runDetector().then(r => {
      if (r.findings > 0) {
        console.log(`[luna-regression-detector] ${r.findings} findings, ${r.new_notifications} novas notifications`);
      }
    }).catch(e => console.error('[luna-regression-detector] erro:', e.message));
  }, ms);
}

export const PATTERNS = REGRESSION_PATTERNS;
