// services/learning-log.js
// Inspirado em https://github.com/pskoett/pskoett-ai-skills (self-improvement skill)
// Mantém `.learnings/` em markdown como fonte persistente e auditável de:
//   - ERRORS.md: falhas, incidentes, vazamentos
//   - LEARNINGS.md: correções, insights, knowledge gaps
//   - FEATURE_REQUESTS.md: capacidades pedidas
// Formato compatível com o skill original. Cada entry tem ID, status, metadata.

import fs from 'fs/promises';
import path from 'path';

const LEARNINGS_DIR = process.env.LUNA_LEARNINGS_DIR
  || '/app/storage/ingest/learnings/luna';

// ============================================
// ID GENERATOR
// ============================================
function genId(type) {
  const d = new Date();
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${type}-${yyyymmdd}-${rand}`;
}

// ============================================
// ENTRY BUILDERS
// ============================================

/**
 * Registra um ERRO/INCIDENTE. Ex.: vazamento bloqueado, regra crítica ignorada, tool falhou.
 * @param {Object} p
 * @param {string} p.summary - Descrição curta
 * @param {string} [p.error] - Mensagem/trace do erro
 * @param {string} [p.context] - Contexto (qual comando, input, etc.)
 * @param {string} [p.suggestedFix] - Como resolver (se souber)
 * @param {'critical'|'high'|'medium'|'low'} [p.priority='high']
 * @param {'backend'|'frontend'|'infra'|'tests'|'docs'|'config'|'prompt'} [p.area='prompt']
 * @param {string[]} [p.relatedFiles]
 * @param {string[]} [p.seeAlso] - IDs relacionados
 */
export async function logError(p) {
  const id = genId('ERR');
  const entry = `## [${id}] ${(p.summary || 'erro').slice(0, 80)}

**Logged**: ${new Date().toISOString()}
**Priority**: ${p.priority || 'high'}
**Status**: pending
**Area**: ${p.area || 'prompt'}

### Summary
${p.summary || ''}

### Error
\`\`\`
${(p.error || '').slice(0, 800)}
\`\`\`

### Context
${p.context || '(sem contexto adicional)'}

### Suggested Fix
${p.suggestedFix || '(a apurar)'}

### Metadata
- Reproducible: ${p.reproducible || 'unknown'}
- Related Files: ${(p.relatedFiles || []).join(', ') || '—'}
- See Also: ${(p.seeAlso || []).join(', ') || '—'}

---
`;
  await appendEntry('ERRORS.md', entry);
  return id;
}

/**
 * Registra um LEARNING (correção, insight, knowledge_gap, best_practice).
 */
export async function logLearning(p) {
  const id = genId('LRN');
  const entry = `## [${id}] ${p.category || 'correction'}

**Logged**: ${new Date().toISOString()}
**Priority**: ${p.priority || 'medium'}
**Status**: pending
**Area**: ${p.area || 'prompt'}

### Summary
${p.summary || ''}

### Details
${p.details || ''}

### Suggested Action
${p.suggestedAction || ''}

### Metadata
- Source: ${p.source || 'auto-detected'}
- Related Files: ${(p.relatedFiles || []).join(', ') || '—'}
- Tags: ${(p.tags || []).join(', ') || '—'}
- See Also: ${(p.seeAlso || []).join(', ') || '—'}
- Pattern-Key: ${p.patternKey || '—'}
- Recurrence-Count: ${p.recurrenceCount || 1}
- First-Seen: ${p.firstSeen || new Date().toISOString().slice(0,10)}
- Last-Seen: ${new Date().toISOString().slice(0,10)}

---
`;
  await appendEntry('LEARNINGS.md', entry);
  return id;
}

/**
 * Registra um FEATURE REQUEST.
 */
export async function logFeatureRequest(p) {
  const id = genId('FEAT');
  const entry = `## [${id}] ${(p.capability || 'feature').slice(0, 60)}

**Logged**: ${new Date().toISOString()}
**Priority**: ${p.priority || 'medium'}
**Status**: pending
**Area**: ${p.area || 'prompt'}

### Requested Capability
${p.capability || ''}

### User Context
${p.userContext || ''}

### Complexity Estimate
${p.complexity || 'medium'}

### Suggested Implementation
${p.suggestedImpl || '(a apurar)'}

### Metadata
- Frequency: ${p.frequency || 'first_time'}
- Related Features: ${(p.relatedFeatures || []).join(', ') || '—'}

---
`;
  await appendEntry('FEATURE_REQUESTS.md', entry);
  return id;
}

// ============================================
// SEARCH / RECURRENCE
// ============================================

/**
 * Procura entry existente por pattern-key. Se achar, incrementa Recurrence-Count.
 * Retorna { found: bool, id, newRecurrence }
 */
export async function findOrBumpByPattern(patternKey) {
  const file = path.join(LEARNINGS_DIR, 'LEARNINGS.md');
  const content = await fs.readFile(file, 'utf-8').catch(() => '');
  const re = new RegExp(`^## \\[(LRN-\\d+-\\w+)\\].*?Pattern-Key: ${patternKey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}.*?Recurrence-Count: (\\d+)`, 'ms');
  const m = content.match(re);
  if (!m) return { found: false };
  const id = m[1];
  const oldCount = parseInt(m[2], 10);
  const newCount = oldCount + 1;
  // Atualiza in-place
  const updated = content.replace(
    new RegExp(`(${id}[\\s\\S]*?Recurrence-Count: )${oldCount}`, 'm'),
    `$1${newCount}`
  ).replace(
    new RegExp(`(${id}[\\s\\S]*?Last-Seen: )\\d{4}-\\d{2}-\\d{2}`, 'm'),
    `$1${new Date().toISOString().slice(0,10)}`
  );
  await fs.writeFile(file, updated);
  return { found: true, id, newRecurrence: newCount };
}

// ============================================
// PROMOTION
// ============================================

/**
 * Lista entries pending pra uso no buildContext ou revisão.
 * Retorna as N mais recentes.
 */
export async function listPending({ file = 'LEARNINGS.md', limit = 10 }) {
  const fpath = path.join(LEARNINGS_DIR, file);
  const content = await fs.readFile(fpath, 'utf-8').catch(() => '');
  const entries = content.split(/(?=^## \[)/m).filter(e => e.includes('**Status**: pending'));
  return entries.slice(-limit).map(e => {
    const idMatch = e.match(/## \[([^\]]+)\]/);
    const summary = (e.match(/### Summary\n([^\n]+)/) || [])[1] || '';
    const priority = (e.match(/Priority\*\*: (\w+)/) || [])[1] || 'medium';
    return { id: idMatch?.[1], summary, priority, raw: e };
  });
}

// ============================================
// INTERNAL
// ============================================
async function appendEntry(filename, entry) {
  const fpath = path.join(LEARNINGS_DIR, filename);
  try {
    await fs.mkdir(LEARNINGS_DIR, { recursive: true });
    await fs.appendFile(fpath, '\n' + entry);
  } catch (e) {
    console.error('[learning-log]', filename, 'falhou:', e.message);
  }
}
