/**
 * Backfill: detecta conversas que sao de COLABORADORES (membros do time Atrio)
 * batendo telefone com a tabela colaboradores.ativo=true do Gesthub.
 *
 * Marca contact_type='equipe' + contact_label com nome+areas+cargo.
 * Nao sobrescreve vinculos existentes (cliente, parceiro, fornecedor, etc).
 */
import { query } from './src/db/pool.js';
import { getColaboradores } from './src/services/gesthub.js';

/**
 * Normaliza telefone BR pra forma canonica "DDD + 8 digitos" (sem o 9 mobile extra).
 * Isso evita mismatch entre:
 *   - 81997140391 (11 digits: DDD 81 + mobile 9 + 7140391)
 *   - 558197140391 (12 digits: 55 + DDD 81 + 97140391)
 *   - 558197140391@c.us (variantes com sufixo)
 * Todos viram "8197140391" (10 chars).
 */
function toDigits11(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (!d) return null;
  // Strip DDI 55 se presente (13 ou 12 digits)
  if ((d.length === 13 || d.length === 12) && d.startsWith('55')) d = d.slice(2);
  // Strip mobile "9" prefix: 11 digits com posicao 2 = '9' -> remove
  if (d.length === 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3);
  return d;
}

async function main() {
  console.log('[backfill-team] buscando conversas nao identificadas...');
  const { rows: convs } = await query(`
    SELECT id, phone, real_phone, display_phone, client_name
    FROM whatsapp_conversations
    WHERE gesthub_client_id IS NULL AND contact_type IS NULL
    ORDER BY last_message_at DESC
  `);
  console.log(`[backfill-team] ${convs.length} conversas sem categorizacao`);

  const colabs = await getColaboradores();
  const ativos = (colabs || []).filter(c => c.ativo && c.telefone);
  console.log(`[backfill-team] ${ativos.length} colaboradores ativos com telefone`);

  // Indice phone digits11 -> colaborador
  const idx = new Map();
  for (const c of ativos) {
    const d = toDigits11(c.telefone);
    if (d && d.length >= 10) idx.set(d, c);
  }

  let matched = 0, nomatch = 0;
  for (const conv of convs) {
    const digits = [conv.phone, conv.real_phone, conv.display_phone].map(toDigits11).filter(d => d && d.length >= 10);
    let hit = null;
    for (const d of digits) {
      if (idx.has(d)) { hit = idx.get(d); break; }
    }
    if (hit) {
      const areas = hit.areas || hit.area || '';
      const cargo = hit.cargo || '';
      const label = [hit.nome, areas, cargo].filter(Boolean).join(' — ').slice(0, 200);
      await query(
        `UPDATE whatsapp_conversations
         SET contact_type = 'equipe', contact_label = $1
         WHERE id = $2`,
        [label, conv.id]
      );
      matched++;
      console.log(`  ✓ ${conv.client_name} -> ${hit.nome} (${hit.areas || hit.cargo || 'equipe'})`);
    } else {
      nomatch++;
    }
  }

  console.log(`\n[backfill-team] matched=${matched} nomatch=${nomatch}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill-team] ERRO:', err);
  process.exit(1);
});
