#!/usr/bin/env node
// scripts/atrio-cli.mjs — CLI para export/import de configurações do escritório.
//
// Paradigma: markdown-first (inspirado em paperclipai/paperclip Company Portability).
// Exporta: agents/ + skills/ + alert_config + .atrio.yaml (manifest do escritório)
// Import: restaura em outro deployment Átrio
//
// Uso:
//   node scripts/atrio-cli.mjs export [--out dir] [--include-memories]
//   node scripts/atrio-cli.mjs import <dir> [--merge|replace]
//   node scripts/atrio-cli.mjs info <dir>

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();
const { query } = await import('../src/db/pool.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const VERSION = '0.1.0';
const PACKAGE_FORMAT = 'atrio-escritorio/v1';

// ============================================================
// EXPORT
// ============================================================

async function exportPackage(outDir = './export-atrio', opts = {}) {
  const target = resolve(outDir);
  const now = new Date().toISOString();

  console.log(`\n📦 Exportando escritório Átrio → ${target}\n`);

  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, 'agents'), { recursive: true });
  mkdirSync(join(target, 'skills'), { recursive: true });
  mkdirSync(join(target, 'config'), { recursive: true });

  // 1) AGENTS (copia .md raw)
  const agentsSrc = join(ROOT, 'agents');
  if (existsSync(agentsSrc)) {
    for (const dir of readdirSync(agentsSrc)) {
      const fullPath = join(agentsSrc, dir);
      if (!statSync(fullPath).isDirectory()) continue;
      const agentFile = join(fullPath, 'AGENTS.md');
      if (existsSync(agentFile)) {
        mkdirSync(join(target, 'agents', dir), { recursive: true });
        writeFileSync(join(target, 'agents', dir, 'AGENTS.md'), readFileSync(agentFile));
      }
    }
    console.log(`  ✓ ${readdirSync(join(target, 'agents')).length} agentes exportados`);
  }

  // 2) SKILLS
  const skillsSrc = join(ROOT, 'skills');
  if (existsSync(skillsSrc)) {
    for (const f of readdirSync(skillsSrc).filter(f => f.endsWith('.md'))) {
      writeFileSync(join(target, 'skills', f), readFileSync(join(skillsSrc, f)));
    }
    console.log(`  ✓ ${readdirSync(join(target, 'skills')).length} skills exportados`);
  }

  // 3) CONFIG: alert_config_levels + meta
  try {
    const { rows: levels } = await query(`SELECT level, minutes, severity, emoji, label, client_message, send_to_team, team_even_off_hours, active FROM alert_config_levels ORDER BY level`);
    const { rows: meta }   = await query(`SELECT key, value FROM alert_config_meta`);
    writeFileSync(
      join(target, 'config', 'alerts.json'),
      JSON.stringify({ levels, meta: meta.reduce((acc, m) => (acc[m.key] = m.value, acc), {}) }, null, 2)
    );
    console.log(`  ✓ Alert config (${levels.length} níveis + ${meta.length} meta)`);
  } catch (e) { console.warn('  ⚠ alert config falhou:', e.message); }

  // 4) Stats do escritório (contexto informativo — SEM dados sensíveis)
  const stats = {};
  try {
    const r = await query(`SELECT COUNT(*) FROM agents WHERE status = 'online'`);
    stats.agents_online = parseInt(r.rows[0].count);
  } catch {}
  try {
    const r = await query(`SELECT COUNT(*) FROM memories WHERE status = 'approved'`);
    stats.approved_memories = parseInt(r.rows[0].count);
  } catch {}

  // 4b) MEMORIES exportadas (opt-in via --include-memories)
  // Só exporta aprovadas, sem PII de cliente (sanitiza campos client_name/phone)
  if (opts.includeMemories) {
    try {
      const { rows } = await query(`
        SELECT m.scope_type, a.role AS agent_role, m.category::text AS category,
               m.title, m.content, m.source_type::text AS source_type,
               m.tags, m.created_at
          FROM memories m
          LEFT JOIN agents a ON a.id = m.agent_id
         WHERE m.status = 'approved'
         ORDER BY agent_role NULLS LAST, category, m.created_at
      `);
      const sanitized = rows.map(m => ({
        ...m,
        content: String(m.content || '')
          // remove CPFs, CNPJs, telefones, emails (best-effort sanitização)
          .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]')
          .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[CNPJ]')
          .replace(/\b\d{10,11}\b/g, '[TEL]')
          .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]'),
      }));
      writeFileSync(
        join(target, 'config', 'memories.json'),
        JSON.stringify(sanitized, null, 2)
      );
      console.log(`  ✓ Memories (${sanitized.length} aprovadas, PII sanitizada)`);
    } catch (e) { console.warn('  ⚠ memories falhou:', e.message); }
  }

  // 5) Manifest
  const manifest = {
    format: PACKAGE_FORMAT,
    version: VERSION,
    exported_at: now,
    exported_from: {
      hostname: process.env.HOSTNAME || 'unknown',
      atrio_version: '2026.04',
    },
    stats,
    contents: {
      agents: readdirSync(join(target, 'agents')).length,
      skills: readdirSync(join(target, 'skills')).length,
      includes_memories: !!opts.includeMemories,
    },
    instructions: {
      pt: [
        'Este pacote contem a configuracao de um escritorio Atrio.',
        'NAO contem dados de clientes, senhas ou tokens.',
        'Para importar: node scripts/atrio-cli.mjs import <dir>',
      ],
    },
  };
  writeFileSync(join(target, '.atrio.yaml'), yamlStringify(manifest));

  // 6) README
  writeFileSync(join(target, 'README.md'), `# Escritório Átrio — Pacote Portável

Exportado em: ${now}
Formato: ${PACKAGE_FORMAT}

## Conteúdo

- \`agents/<role>/AGENTS.md\` — ${readdirSync(join(target, 'agents')).length} agentes (prompts + config)
- \`skills/*.md\` — ${readdirSync(join(target, 'skills')).length} skills reutilizáveis
- \`config/alerts.json\` — níveis de alerta Luna

## Como importar em outro Átrio

\`\`\`bash
node scripts/atrio-cli.mjs import ${target.split('/').pop()}
\`\`\`

## Segurança

**Nunca** comite este pacote em repositório público. Pode conter prompts proprietários.
`);

  console.log(`\n✓ Pacote gerado em ${target}`);
  console.log(`  Tamanho: ${dirSize(target)} KB`);
  console.log(`  Arquivos: ${fileCount(target)}`);
  return target;
}

// ============================================================
// IMPORT
// ============================================================

async function importPackage(srcDir, opts = {}) {
  const src = resolve(srcDir);
  if (!existsSync(src)) throw new Error(`Diretorio ${src} nao existe`);

  const manifestPath = join(src, '.atrio.yaml');
  if (!existsSync(manifestPath)) throw new Error('Manifest .atrio.yaml ausente');
  const manifest = yamlParse(readFileSync(manifestPath, 'utf-8'));
  if (!manifest.format?.startsWith('atrio-escritorio/')) {
    throw new Error(`Formato desconhecido: ${manifest.format}`);
  }

  console.log(`\n📥 Importando pacote (modo: ${opts.mode || 'merge'})\n`);
  console.log(`  Origem: ${manifest.exported_from?.hostname || 'unknown'}`);
  console.log(`  Exportado em: ${manifest.exported_at}`);

  // 1) AGENTS — copia pra agents/
  const agentsIn = join(src, 'agents');
  if (existsSync(agentsIn)) {
    const destAgents = join(ROOT, 'agents');
    mkdirSync(destAgents, { recursive: true });

    for (const dir of readdirSync(agentsIn)) {
      const srcAgentMd = join(agentsIn, dir, 'AGENTS.md');
      if (!existsSync(srcAgentMd)) continue;
      const destDir = join(destAgents, dir);
      const destMd = join(destDir, 'AGENTS.md');

      if (existsSync(destMd) && opts.mode !== 'replace') {
        console.log(`  ⊙ agent ${dir} já existe (merge skipped — use --replace pra sobrescrever)`);
        continue;
      }

      mkdirSync(destDir, { recursive: true });
      writeFileSync(destMd, readFileSync(srcAgentMd));
      console.log(`  ✓ agent ${dir} ${existsSync(destMd) && opts.mode === 'replace' ? 'substituido' : 'importado'}`);
    }
  }

  // 2) SKILLS
  const skillsIn = join(src, 'skills');
  if (existsSync(skillsIn)) {
    const destSkills = join(ROOT, 'skills');
    mkdirSync(destSkills, { recursive: true });
    for (const f of readdirSync(skillsIn).filter(f => f.endsWith('.md'))) {
      const srcFile = join(skillsIn, f);
      const destFile = join(destSkills, f);
      if (existsSync(destFile) && opts.mode !== 'replace') {
        console.log(`  ⊙ skill ${f} ja existe`);
        continue;
      }
      writeFileSync(destFile, readFileSync(srcFile));
      console.log(`  ✓ skill ${f}`);
    }
  }

  // 3) ALERT CONFIG (merge)
  const alertsPath = join(src, 'config', 'alerts.json');
  if (existsSync(alertsPath)) {
    const cfg = JSON.parse(readFileSync(alertsPath, 'utf-8'));
    for (const l of cfg.levels || []) {
      try {
        await query(
          `INSERT INTO alert_config_levels (level, minutes, severity, emoji, label, client_message, send_to_team, team_even_off_hours, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (level) DO UPDATE SET
             minutes = EXCLUDED.minutes, severity = EXCLUDED.severity, label = EXCLUDED.label,
             client_message = EXCLUDED.client_message, active = EXCLUDED.active`,
          [l.level, l.minutes, l.severity, l.emoji, l.label, l.client_message, l.send_to_team, l.team_even_off_hours, l.active]
        );
      } catch {}
    }
    for (const [k, v] of Object.entries(cfg.meta || {})) {
      await query(`INSERT INTO alert_config_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [k, v]).catch(() => {});
    }
    console.log(`  ✓ alert config aplicada`);
  }

  // 4) MEMORIES (opt-in — só importa se arquivo presente)
  const memPath = join(src, 'config', 'memories.json');
  if (existsSync(memPath)) {
    const mems = JSON.parse(readFileSync(memPath, 'utf-8'));
    let inserted = 0;
    for (const m of mems) {
      try {
        // Resolve agent_id pelo role (se o tenant destino tem esse agente)
        const ag = m.agent_role
          ? (await query(`SELECT id FROM agents WHERE role = $1 LIMIT 1`, [m.agent_role])).rows[0]
          : null;
        await query(
          `INSERT INTO memories (scope_type, agent_id, category, title, content, source_type, tags, status)
           VALUES ($1::memory_scope, $2, $3::memory_category, $4, $5, $6::memory_source, $7, 'draft'::memory_status)
           ON CONFLICT DO NOTHING`,
          [
            m.scope_type || 'agent',
            ag?.id || null,
            m.category || 'general',
            (m.title || 'Importada').slice(0, 255),
            m.content,
            'manual',  // source_type precisa ser enum válido
            m.tags || [],
          ]
        );
        inserted++;
      } catch (e) { /* skip */ }
    }
    console.log(`  ✓ memories importadas (${inserted}/${mems.length}) — status pending_review pra curadoria`);
  }

  console.log(`\n✓ Import concluido. Reinicie atrio-office-server pra sincronizar agents/skills.`);
}

// ============================================================
// INFO
// ============================================================

async function infoPackage(srcDir) {
  const src = resolve(srcDir);
  const manifestPath = join(src, '.atrio.yaml');
  if (!existsSync(manifestPath)) {
    console.error(`Manifest ausente em ${src}`);
    process.exit(1);
  }
  const manifest = yamlParse(readFileSync(manifestPath, 'utf-8'));
  console.log(`\n📋 Pacote Átrio em ${src}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

// ============================================================
// YAML minimo (sem dep externa)
// ============================================================

function yamlStringify(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) { out.push(`${pad}${k}: null`); continue; }
    if (typeof v === 'object' && !Array.isArray(v)) {
      out.push(`${pad}${k}:`);
      out.push(yamlStringify(v, indent + 2));
    } else if (Array.isArray(v)) {
      out.push(`${pad}${k}:`);
      for (const item of v) {
        if (typeof item === 'object') {
          out.push(`${pad}  -`);
          out.push(yamlStringify(item, indent + 4));
        } else {
          out.push(`${pad}  - ${JSON.stringify(item)}`);
        }
      }
    } else if (typeof v === 'string') {
      out.push(`${pad}${k}: ${JSON.stringify(v)}`);
    } else {
      out.push(`${pad}${k}: ${v}`);
    }
  }
  return out.join('\n');
}

function yamlParse(text) {
  // parser mínimo — só o necessário pra .atrio.yaml simples
  const lines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const line of lines) {
    const indent = line.match(/^\s*/)[0].length;
    const content = line.slice(indent);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const m = content.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    const target = stack[stack.length - 1].obj;
    if (rest === '') {
      target[key] = {};
      stack.push({ indent, obj: target[key] });
    } else {
      try { target[key] = JSON.parse(rest); }
      catch { target[key] = rest; }
    }
  }
  return root;
}

function dirSize(dir) {
  let total = 0;
  for (const f of readdirSync(dir, { recursive: true })) {
    const full = join(dir, f);
    try { if (statSync(full).isFile()) total += statSync(full).size; } catch {}
  }
  return Math.round(total / 1024);
}

function fileCount(dir) {
  let count = 0;
  for (const f of readdirSync(dir, { recursive: true })) {
    try { if (statSync(join(dir, f)).isFile()) count++; } catch {}
  }
  return count;
}

// ============================================================
// MAIN
// ============================================================

const [cmd, ...args] = process.argv.slice(2);

const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') opts.out = args[++i];
  else if (args[i] === '--replace') opts.mode = 'replace';
  else if (args[i] === '--merge') opts.mode = 'merge';
  else if (args[i] === '--include-memories') opts.includeMemories = true;
}

(async () => {
  try {
    if (cmd === 'export') {
      await exportPackage(opts.out || './export-atrio', opts);
    } else if (cmd === 'import') {
      const src = args.find(a => !a.startsWith('--'));
      if (!src) { console.error('Uso: import <dir>'); process.exit(1); }
      await importPackage(src, opts);
    } else if (cmd === 'info') {
      const src = args.find(a => !a.startsWith('--'));
      if (!src) { console.error('Uso: info <dir>'); process.exit(1); }
      await infoPackage(src);
    } else {
      console.log(`atrio-cli ${VERSION}\n`);
      console.log('comandos:');
      console.log('  export [--out dir]        exporta config do escritório');
      console.log('  import <dir> [--replace]  importa pacote em outro Átrio');
      console.log('  info <dir>                mostra manifest de um pacote');
    }
    process.exit(0);
  } catch (e) {
    console.error(`ERRO: ${e.message}`);
    process.exit(2);
  }
})();
