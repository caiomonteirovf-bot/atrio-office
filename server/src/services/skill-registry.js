// services/skill-registry.js
// Carrega skills (server/skills/*.md) e expoe API para listar, ver e renderizar.
// Inspirado no padrao skills do paperclipai + companies.
//
// Skill = workflow markdown com frontmatter YAML.
// - Versionavel no git
// - Reutilizavel entre agentes
// - Body descreve o passo-a-passo; agente executa via LLM usando o texto como guia
//
// Uso tipico:
//   const skill = getSkill('emitir_nfse');
//   const rendered = renderSkill('emitir_nfse', { cliente_cnpj: '...', valor_servico: 1200 });
//   // Agente recebe `rendered.prompt` como parte do contexto

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

let _cache = null;

function parseYaml(src) {
  // Mesmo parser minimal usado em agent-loader.js (poderia ser extraido, mas
  // replicado para evitar circular + manter skill-registry auto-contido).
  const lines = src.split('\n');
  const root = {};
  const stack = [{ indent: -1, obj: root, isList: false }];

  const coerce = (v) => {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    if (t === '' || t === 'null' || t === '~') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    if (t.startsWith('[') && t.endsWith(']')) {
      // lista inline [a, b, c]
      return t.slice(1, -1).split(',').map(s => coerce(s));
    }
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      try { return JSON.parse(t.replace(/^'|'$/g, '"')); } catch { return t.slice(1, -1); }
    }
    return t;
  };

  const popTo = (ind) => { while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop(); };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].replace(/\r$/, '');
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const content = rawLine.slice(indent);

    if (content.startsWith('- ')) {
      popTo(indent);
      const host = stack[stack.length - 1];
      if (host.isList && Array.isArray(host.obj)) host.obj.push(coerce(content.slice(2)));
      continue;
    }

    const m = content.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    popTo(indent);
    const target = stack[stack.length - 1].obj;

    if (rest === '') {
      // olhar proxima linha para decidir array vs object
      const next = lines.slice(i + 1).find(l => l.trim() && !l.trim().startsWith('#'));
      if (next && next.trim().startsWith('- ')) {
        target[key] = [];
        stack.push({ indent, obj: target[key], isList: true });
      } else {
        target[key] = {};
        stack.push({ indent, obj: target[key], isList: false });
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
  return {
    fm: parseYaml(raw.slice(3, end).replace(/^\n/, '')),
    body: raw.slice(end + 4).replace(/^\n+/, ''),
  };
}

export async function loadSkills(force = false) {
  if (_cache && !force) return _cache;
  const index = new Map();
  try {
    const entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const file = path.join(SKILLS_ROOT, e.name);
      const raw = await fs.readFile(file, 'utf-8');
      const { fm, body } = splitFrontmatter(raw);
      if (!fm.name) continue;
      index.set(fm.name, {
        name: fm.name,
        version: fm.version || '0.1.0',
        category: fm.category || 'general',
        description: fm.description || '',
        allowed_agents: fm.allowed_agents || [],
        inputs: fm.inputs || {},
        outputs: fm.outputs || {},
        success_criteria: fm.success_criteria || [],
        body,
        file,
      });
    }
  } catch (e) {
    console.warn('[skill-registry] pasta skills/ nao encontrada:', SKILLS_ROOT);
  }
  _cache = index;
  return _cache;
}

export async function listSkills() {
  const idx = await loadSkills();
  return Array.from(idx.values()).map(({ body, file, ...meta }) => meta);
}

export async function getSkill(name) {
  const idx = await loadSkills();
  return idx.get(name) || null;
}

/**
 * Valida params contra o schema de inputs.
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateParams(skill, params) {
  const errors = [];
  for (const [key, spec] of Object.entries(skill.inputs || {})) {
    if (spec.required && (params[key] === undefined || params[key] === null || params[key] === '')) {
      errors.push(`input "${key}" e obrigatorio`);
      continue;
    }
    if (params[key] !== undefined && spec.type) {
      const expected = spec.type;
      const actual = typeof params[key];
      if (expected === 'integer' && !Number.isInteger(Number(params[key]))) errors.push(`"${key}" deve ser integer`);
      else if (expected === 'number' && isNaN(Number(params[key]))) errors.push(`"${key}" deve ser number`);
      else if (expected === 'string' && actual !== 'string') errors.push(`"${key}" deve ser string`);
      else if (expected === 'boolean' && actual !== 'boolean') errors.push(`"${key}" deve ser boolean`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Renderiza a skill em um prompt pronto para enviar ao LLM.
 * Inclui metadata + passos + params interpolados no inicio.
 */
export async function renderSkill(name, params = {}, agentName = null) {
  const skill = await getSkill(name);
  if (!skill) throw new Error(`skill "${name}" nao encontrada`);

  if (skill.allowed_agents?.length && agentName && !skill.allowed_agents.includes(agentName)) {
    throw new Error(`skill "${name}" nao permitida para agente "${agentName}"`);
  }

  const validation = validateParams(skill, params);
  if (!validation.ok) {
    throw new Error(`params invalidos para "${name}": ${validation.errors.join('; ')}`);
  }

  const paramsBlock = Object.entries(params)
    .map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');

  const prompt = [
    `# Executar skill: ${skill.name} (v${skill.version})`,
    '',
    `**Categoria:** ${skill.category}`,
    `**Descrição:** ${skill.description}`,
    '',
    '## Parâmetros recebidos',
    paramsBlock || '(nenhum)',
    '',
    '## Instruções da skill',
    '',
    skill.body,
    '',
    '## Resposta',
    '',
    'Execute os passos acima e retorne APENAS o JSON especificado em "Retorno esperado" no final. Nao inclua texto fora do JSON.',
  ].join('\n');

  return { skill: { name: skill.name, version: skill.version, category: skill.category }, prompt, params };
}
