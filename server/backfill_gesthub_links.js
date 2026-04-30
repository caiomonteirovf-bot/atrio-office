/**
 * Backfill: para conversas whatsapp_conversations sem gesthub_client_id,
 * tenta casar telefone (phone/real_phone/display_phone — digits) com os contatos
 * dos clientes Gesthub (campo contatos[].telefone) e grava o vinculo.
 *
 * Usa normalizacao de digits (remove DDI 55 quando presente, extrai os 11 digitos finais).
 * NAO sobrescreve vinculos existentes.
 *
 * Uso: node backfill_gesthub_links.js
 */
import { query } from './src/db/pool.js';
import { getClients } from './src/services/gesthub.js';

function toDigits11(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (!d) return null;
  // Brasil: numero mobile tem 11 digitos. Remove DDI 55 se presente.
  if (d.length === 13 && d.startsWith('55')) return d.slice(2);
  if (d.length === 12 && d.startsWith('55')) return d.slice(2);
  if (d.length === 11) return d;
  if (d.length === 10) return d;
  // LIDs (15 digitos) ficam como estao — nao case
  return d;
}

async function main() {
  console.log('[backfill] buscando conversas nao linkadas...');
  const { rows: convs } = await query(`
    SELECT id, phone, real_phone, display_phone, client_name
    FROM whatsapp_conversations
    WHERE gesthub_client_id IS NULL
    ORDER BY last_message_at DESC
  `);
  console.log(`[backfill] ${convs.length} conversas pra analisar`);

  const clients = await getClients();
  console.log(`[backfill] ${clients.length} clientes no Gesthub`);

  // Index por digits11 dos contatos
  const phoneIndex = new Map();
  for (const c of clients) {
    const phones = [];
    // contatos[] e o campo rico
    if (Array.isArray(c.contatos)) {
      for (const ct of c.contatos) phones.push(ct.telefone);
    }
    // tb campo phone raw
    if (c.phone) phones.push(c.phone);

    for (const p of phones) {
      const d = toDigits11(p);
      if (!d || d.length < 10) continue;
      if (!phoneIndex.has(d)) phoneIndex.set(d, []);
      phoneIndex.get(d).push({ id: c.id, name: c.legalName || c.tradeName });
    }
  }
  console.log(`[backfill] indice construido com ${phoneIndex.size} telefones unicos`);

  let matched = 0, ambig = 0, nomatch = 0;
  for (const conv of convs) {
    const candidates = [conv.phone, conv.real_phone, conv.display_phone]
      .map(toDigits11)
      .filter(d => d && d.length >= 10);

    let hit = null;
    for (const d of candidates) {
      const list = phoneIndex.get(d);
      if (list && list.length === 1) {
        hit = list[0];
        break;
      } else if (list && list.length > 1) {
        ambig++;
        console.log(`  #${conv.id}: AMBIGUO ${conv.client_name} (${d}) -> ${list.length} candidatos`);
        break;
      }
    }

    if (hit) {
      await query(
        `UPDATE whatsapp_conversations SET gesthub_client_id = $1 WHERE id = $2`,
        [hit.id, conv.id]
      );
      matched++;
      console.log(`  ✓ ${conv.client_name} -> ${hit.name} (#${hit.id})`);
    } else if (!candidates.length) {
      nomatch++;
    } else if (!candidates.some(d => phoneIndex.has(d))) {
      nomatch++;
    }
  }

  console.log(`\n[backfill] resultado: matched=${matched} ambig=${ambig} nomatch=${nomatch}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill] ERRO:', err);
  process.exit(1);
});
