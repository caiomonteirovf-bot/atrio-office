// services/prompt-auditor.js
// Audita prompts de agentes contra um registry de REGRAS CRÍTICAS que DEVEM estar presentes.
// Se uma mudança de prompt remove silenciosamente uma regra crítica, o auditor detecta e bloqueia.
//
// Pattern: skill-vetter aplicado a prompts (não a outputs).
// Cada regra crítica tem assinaturas (regex) — se NENHUMA bater no prompt novo, a regra sumiu.

import { query } from '../db/pool.js';
import { logError } from './learning-log.js';

// ============================================
// REGISTRY DE REGRAS CRÍTICAS POR AGENTE
// ============================================
// Cada entrada: regras que um prompt de `agent_name` OBRIGATORIAMENTE precisa ter.
// Signatures: padrões que indicam a presença da regra. Pelo menos 1 deve bater.
export const CRITICAL_RULES = {
  Luna: [
    {
      id: 'confidencialidade',
      label: 'Não vazar dados internos (número de clientes, carteira, métricas)',
      signatures: [
        /confidencialidade/i,
        /n[ãa]o\s+vazar\s+dados?\s+internos?/i,
        /n[ãa]o\s+(compartilh[ae]|revel[ae]|menciona[r]?)[^.]{0,50}(interno|confidencial)/i,
        /n[ãa]o\s+(informe|cite|revele)[^.]{0,80}(total\s+de\s+clientes|carteira\s+de|m[eé]tricas\s+internas)/i,
      ],
      source: 'incidente Caio 20/04/2026 — Luna vazou total de clientes',
      severity: 'critical',
    },
    {
      id: 'nao-inventar',
      label: 'Não inventar informações técnicas',
      signatures: [
        /n[ãa]o\s+invent[ae]/i,
        /n[ãa]o\s+d[eê]\s+respostas?\s+t[eé]cnicas?\s+sem\s+seguran[çc]a/i,
      ],
      severity: 'critical',
    },
    {
      id: 'identidade',
      label: 'Representa Átrio direto, não se apresenta como assistente/Luna',
      signatures: [
        /n[ãa]o\s+se\s+apresente/i,
        /n[ãa]o\s+use\s+(nome\s+pr[oó]prio|emojis?)/i,
        /representa[r]?\s+diretamente\s+a\s+(átrio|atrio)/i,
      ],
      severity: 'high',
    },
    {
      id: 'dr-drª-condicional',
      label: 'Dr./Drª só pra clientes tipo MEDICINA/ODONTO',
      signatures: [
        /(medicina|odonto)[^.]{0,100}(dr\.|drª|t[ií]tulo\s+profissional)/i,
        /dr[.aª]?\s*\/\s*drª?[^.]{0,200}(medicina|odonto)/i,
      ],
      severity: 'high',
    },
    {
      id: 'no-emoji',
      label: 'Proibição de emoji em mensagens ao cliente',
      signatures: [
        /n[ãa]o\s+util(ize|izar)\s+emojis?/i,
        /sem\s+emojis?/i,
        /proibi[çc][ãa]o\s+(de\s+)?emoji/i,
      ],
      severity: 'high',
    },
    {
      id: 'coleta-estruturada',
      label: 'Coleta estruturada pra demandas estruturadas (NFS-e, abertura, etc)',
      signatures: [
        /solicit(ar|e)\s+todos\s+os\s+dados/i,
        /peça\s+tudo\s+de\s+uma\s+vez/i,
        /coleta\s+(estruturada|inteligente)/i,
      ],
      severity: 'medium',
    },
    {
      id: 'progressao',
      label: 'Progressão passo-a-passo (uma pergunta por vez, exceto estruturada)',
      signatures: [
        /progress[ãa]o/i,
        /uma\s+pergunta\s+por\s+vez/i,
        /conduza\s+em\s+etapas/i,
      ],
      severity: 'medium',
    },
    {
      id: 'memoria-contexto',
      label: 'Memória de contexto (não repetir info já dada)',
      signatures: [
        /mem[oó]ria\s+de\s+contexto/i,
        /n[ãa]o\s+(repita|reinicie)\s+a?\s*(saudação|conversa)/i,
      ],
      severity: 'medium',
    },
  ],

  // Futuro: adicionar regras críticas de outros agentes conforme incidentes surgirem
  Campelo: [
    {
      id: 'valida-cnpj',
      label: 'Valida CNPJ do tomador antes de emitir (defense in depth)',
      signatures: [
        /valid[ae]\s+cnpj/i,
        /divergência.*raz[ãa]o\s+social/i,
      ],
      severity: 'high',
    },
  ],
};

// ============================================
// AUDITOR
// ============================================
/**
 * Audita um prompt contra o registry de regras críticas do agente.
 * @param {string} promptText — conteúdo completo do system_prompt
 * @param {string} agentName — 'Luna', 'Campelo', etc.
 * @returns {{ ok, violations, rulesChecked }}
 */
export function auditPrompt(promptText, agentName) {
  const rules = CRITICAL_RULES[agentName] || [];
  const violations = [];
  for (const rule of rules) {
    const matchesSome = rule.signatures.some(sig => sig.test(promptText));
    if (!matchesSome) {
      violations.push({
        id: rule.id,
        label: rule.label,
        severity: rule.severity,
        source: rule.source,
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    rulesChecked: rules.length,
  };
}

/**
 * Compara prompt anterior com novo — identifica quais regras críticas SAÍRAM.
 * @returns {{ addedRules, removedRules, diffSummary }}
 */
export function diffPromptAudit(oldPrompt, newPrompt, agentName) {
  const oldAudit = auditPrompt(oldPrompt || '', agentName);
  const newAudit = auditPrompt(newPrompt || '', agentName);
  const oldPresent = new Set((CRITICAL_RULES[agentName] || [])
    .filter(r => !oldAudit.violations.find(v => v.id === r.id))
    .map(r => r.id));
  const newPresent = new Set((CRITICAL_RULES[agentName] || [])
    .filter(r => !newAudit.violations.find(v => v.id === r.id))
    .map(r => r.id));
  const removedRules = [...oldPresent].filter(id => !newPresent.has(id));
  const addedRules = [...newPresent].filter(id => !oldPresent.has(id));
  return {
    addedRules,
    removedRules,
    oldAudit,
    newAudit,
    diffSummary: {
      old_size: (oldPrompt || '').length,
      new_size: (newPrompt || '').length,
      rules_removed_count: removedRules.length,
      rules_added_count: addedRules.length,
    },
  };
}

/**
 * Grava histórico da mudança de prompt em `agents_prompt_history`.
 * Loga também notification se regras críticas sumiram.
 */
export async function recordPromptChange({ agentId, agentName, oldPrompt, newPrompt, actor = 'agent-loader' }) {
  const audit = diffPromptAudit(oldPrompt, newPrompt, agentName);

  try {
    await query(
      `INSERT INTO agents_prompt_history
         (agent_id, agent_name, old_size, new_size, rules_removed, rules_added,
          audit_violations, changed_by, changed_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7::jsonb, $8, NOW())`,
      [
        agentId, agentName,
        audit.diffSummary.old_size, audit.diffSummary.new_size,
        audit.removedRules, audit.addedRules,
        JSON.stringify(audit.newAudit.violations),
        actor,
      ]
    );
  } catch (e) { console.error('[prompt-auditor] history insert falhou:', e.message); }

  // Se removeu regra crítica → notification LOUD + learnings
  if (audit.removedRules.length > 0) {
    try {
      await logError({
        summary: agentName + ': regras críticas removidas do prompt — ' + audit.removedRules.join(', '),
        error: 'Regras ausentes no novo prompt: ' + audit.removedRules.join(', '),
        context: 'Agent: ' + agentName + ' | Actor: ' + actor + ' | Prompt tamanho: ' + audit.diffSummary.old_size + ' → ' + audit.diffSummary.new_size + ' chars',
        suggestedFix: 'Restaurar regras no AGENTS.md. Considerar promoção pra SOUL.md (camada persistente).',
        priority: 'critical',
        area: 'prompt',
        relatedFiles: ['agents/' + agentName.toLowerCase() + '/AGENTS.md'],
      });
    } catch {}
  }
  if (audit.removedRules.length > 0) {
    const removed = audit.removedRules.join(', ');
    try {
      await query(
        `INSERT INTO notifications (type, title, message, severity, metadata)
         VALUES ('prompt_regression', $1, $2, 'error', $3::jsonb)`,
        [
          `🔴 ${agentName}: regra crítica removida do prompt: ${removed}`,
          `Uma ou mais regras críticas sumiram do prompt do ${agentName} na mudança atual. Isso pode causar incidentes de segurança/compliance. Regras removidas: ${removed}. Revisar antes de manter em produção.`,
          JSON.stringify({
            agent_name: agentName,
            removed_rules: audit.removedRules,
            added_rules: audit.addedRules,
            actor,
            old_size: audit.diffSummary.old_size,
            new_size: audit.diffSummary.new_size,
          }),
        ]
      );
    } catch (e) { console.error('[prompt-auditor] notification insert falhou:', e.message); }
  }

  return audit;
}
