// services/agent-loader.js
// Sincroniza server/agents/<role>/AGENTS.md com a tabela `agents`.
// Fonte-de-verdade: arquivo (versionavel no git). DB e cache/runtime.
//
// No boot:
//   - Le todos os AGENTS.md
//   - Parseia frontmatter YAML + body (system prompt)
//   - UPSERT em agents (id do frontmatter e estavel)
//
// Campos atualizados: name, role, department, system_prompt, personality,
// status, budget_monthly_usd. NAO sobrescreve: tools (mantido no DB pois
// e montado dinamicamente pelo registry).

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_ROOT = path.resolve(__dirname, '..', '..', 'agents');

// ============================================================
// Parser YAML minimal (suficiente para o frontmatter que geramos).
// Suporta: chave: valor, aninhamento (2 espacos), listas com "- ", strings entre aspas, null, numeros.
// ============================================================
function parseYaml(src) {
  const lines = src.split('\n');
  const root = {};
  const stack = [{ indent: -1, obj: root, key: null, isList: false }];

  function currentContainer() {
    return stack[stack.length - 1];
  }

  function popTo(indent) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
  }

  function coerce(v) {
    if (v === undefined || v === null) return null;
    const t = v.trim();
    if (t === '' || t === 'null' || t === '~') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    // string entre aspas
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      try { return JSON.parse(t.replace(/^'|'$/g, '"')); } catch { return t.slice(1, -1); }
    }
    return t;
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const content = line.slice(indent);

    // Item de lista
    if (content.startsWith('- ')) {
      popTo(indent);
      const parent = currentContainer();
      if (!Array.isArray(parent.obj)) {
        // transforma a chave atual em array se ainda era objeto vazio
        if (parent.key !== null && parent._listBoundTo) {
          // ja foi
        }
      }
      // Adiciona ao array apontado pelo ultimo container marcado como isList
      const val = coerce(content.slice(2));
      const host = stack[stack.length - 1];
      if (host.isList && Array.isArray(host.obj)) host.obj.push(val);
      continue;
    }

    // chave: valor  ou  chave:
    const m = content.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];

    popTo(indent);
    const container = currentContainer();
    const target = container.obj;

    if (rest === '') {
      // proxima linha define (objeto ou array)
      // olhamos a proxima linha nao-vazia para decidir
      const next = lines.slice(lines.indexOf(rawLine) + 1).find(l => l.trim() && !l.trim().startsWith('#'));
      if (next && next.trim().startsWith('- ')) {
        target[key] = [];
        stack.push({ indent, obj: target[key], key, isList: true });
      } else {
        target[key] = {};
        stack.push({ indent, obj: target[key], key, isList: false });
      }
    } else {
      target[key] = coerce(rest);
    }
  }
  return root;
}

function splitFrontmatter(raw) {
  if (!raw.startsWith('---')) return { fm: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, body: raw };
  const fmSrc = raw.slice(3, end).replace(/^\n/, '');
  const body = raw.slice(end + 4).replace(/^\n+/, '');
  return { fm: parseYaml(fmSrc), body };
}

function extractSystemPrompt(body) {
  // Procura heading "## System Prompt" e retorna tudo depois
  const idx = body.search(/^##\s+System Prompt\s*$/m);
  if (idx === -1) return body.trim();
  const after = body.slice(idx).split('\n').slice(1).join('\n');
  return after.trim();
}

async function listAgentFiles() {
  try {
    const entries = await fs.readdir(AGENTS_ROOT, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(AGENTS_ROOT, e.name, 'AGENTS.md');
      try { await fs.access(p); files.push(p); } catch {}
    }
    return files;
  } catch (e) {
    console.warn('[agent-loader] pasta agents/ nao encontrada:', AGENTS_ROOT);
    return [];
  }
}

/**
 * Sincroniza todos os AGENTS.md com o DB.
 * Retorna { loaded, created, updated, skipped, errors }.
 */
export async function syncAgentsFromFiles() {
  const files = await listAgentFiles();
  const report = { loaded: 0, created: 0, updated: 0, skipped: 0, errors: [] };

  for (const f of files) {
    try {
      const raw = await fs.readFile(f, 'utf-8');
      const { fm, body } = splitFrontmatter(raw);
      if (!fm.id || !fm.name || !fm.role) {
        report.errors.push(`${f}: frontmatter incompleto (precisa id, name, role)`);
        continue;
      }
      const systemPrompt = extractSystemPrompt(body);

      const { rows: existing } = await query('SELECT id, system_prompt FROM agents WHERE id = $1', [fm.id]);
      if (!existing.length) {
        await query(
          `INSERT INTO agents (id, name, role, department, system_prompt, personality, status, config, budget_monthly_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7::agent_status,$8::jsonb,$9)`,
          [
            fm.id, fm.name, fm.role, fm.department || 'geral',
            systemPrompt, fm.personality || null,
            fm.status || 'online',
            JSON.stringify(fm.model || {}),
            fm.budget_monthly_usd || null,
          ]
        );
        report.created++;
      } else {
        await query(
          `UPDATE agents SET
             name = $2, role = $3, department = $4,
             system_prompt = $5, personality = $6,
             status = $7::agent_status,
             config = config || $8::jsonb,
             budget_monthly_usd = COALESCE($9, budget_monthly_usd),
             updated_at = NOW()
           WHERE id = $1`,
          [
            fm.id, fm.name, fm.role, fm.department || 'geral',
            systemPrompt, fm.personality || null,
            fm.status || 'online',
            JSON.stringify(fm.model || {}),
            fm.budget_monthly_usd || null,
          ]
        );
        report.updated++;
      }
      report.loaded++;
    } catch (e) {
      report.errors.push(`${f}: ${e.message}`);
    }
  }
  return report;
}
