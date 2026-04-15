#!/usr/bin/env node
// Smoke tests da Luna — executa cenarios ponta-a-ponta contra a instancia rodando
// Uso: docker exec -i atrio-office-server-1 node /tmp/luna_smoke.mjs
// Cada cenario usa um phone isolado, limpa conversa+buffer antes, roda N turnos,
// inspeciona mensagens/intake/tasks pra validar comportamento esperado.

import { handleWhatsAppMessage } from './src/services/whatsapp/webhook-handler.mjs';
import { query } from './src/db/pool.js';

const RESULTS = [];
const now = Date.now();

function mockMsg(phone, body) {
  return {
    from: `${phone}@c.us`,
    to: 'bot@c.us',
    body,
    id: { _serialized: `smoke-${now}-${Math.random()}` },
    timestamp: Math.floor(Date.now() / 1000),
    type: 'chat',
  };
}

function mockClient(phone) {
  return { phone, nome_fantasia: 'Teste Smoke', cnpj: null, cliente_id: null };
}

async function cleanup(phone) {
  await query(`DELETE FROM luna_v2.inbound_buffer WHERE phone = $1`, [phone]);
  const { rows } = await query(`SELECT id FROM luna_v2.conversations WHERE phone = $1`, [phone]);
  for (const r of rows) {
    await query(`DELETE FROM luna_v2.messages WHERE conversation_id = $1`, [r.id]);
    await query(`DELETE FROM luna_v2.conversations WHERE id = $1`, [r.id]);
  }
  await query(`DELETE FROM public.tasks WHERE result->>'phone' = $1 AND created_at > NOW() - INTERVAL '10 minutes'`, [phone]);
}

async function ask(phone, body) {
  const msg = mockMsg(phone, body);
  const res = await handleWhatsAppMessage(msg, mockClient(phone), { phone });
  return { res, reply: res?.message || res?.reply || '' };
}

async function getIntake(phone) {
  const { rows } = await query(`
    SELECT nfse_intake FROM luna_v2.conversations WHERE phone = $1 ORDER BY last_message_at DESC LIMIT 1
  `, [phone]);
  return rows[0]?.nfse_intake || {};
}

async function getTasks(phone) {
  const { rows } = await query(`
    SELECT title, result FROM public.tasks
    WHERE result->>'phone' = $1 AND created_at > NOW() - INTERVAL '10 minutes'
    ORDER BY created_at DESC
  `, [phone]);
  return rows;
}

function assertOne(label, cond, detail = '') {
  RESULTS.push({ label, pass: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'} · ${label}${detail ? ' → ' + detail : ''}`);
}

// ============================================
// Cenarios
// ============================================
async function scn_prospect() {
  console.log('\n[1] PROSPECT novo (quer abrir CNPJ)');
  const phone = '5511900000001';
  await cleanup(phone);
  const { reply } = await ask(phone, 'Oi, queria abrir uma empresa');
  assertOne('responde acolhedor', /claro|posso|ajudar|legal/i.test(reply), reply.slice(0, 60));
  assertOne('nao promete preco/prazo', !/R\$|dias|prazo|preco/i.test(reply));
}

async function scn_nfse_completo() {
  console.log('\n[2] NFS-e fluxo completo (tudo de uma vez)');
  const phone = '5511900000002';
  await cleanup(phone);

  const r1 = await ask(phone, 'Quero emitir uma nota');
  assertOne('pede dados da nota', /CNPJ|CPF|tomador|valor/i.test(r1.reply), r1.reply.slice(0, 80));

  const r2 = await ask(phone, 'CNPJ: 12345678000190, Nome: Cliente Teste LTDA, Valor: 500, Servico: Consultoria');
  const intake = await getIntake(phone);
  assertOne('intake salvou tomador_doc', intake.tomador_doc?.includes('12345678'), JSON.stringify(intake).slice(0, 100));
  assertOne('intake salvou valor', String(intake.valor || '').includes('500'));
  assertOne('apresenta resumo/confirmacao', /confirm|resumo|est[áa] certo|ok\?|pode emitir/i.test(r2.reply), r2.reply.slice(0, 80));
}

async function scn_nfse_incompleto() {
  console.log('\n[3] NFS-e incompleto (falta valor)');
  const phone = '5511900000003';
  await cleanup(phone);
  await ask(phone, 'Quero emitir uma nota');
  const r = await ask(phone, 'Tomador: 12345678000190, servico de consultoria');
  const intake = await getIntake(phone);
  assertOne('pede so o que falta (valor)', /valor/i.test(r.reply) && !/tomador|cnpj/i.test(r.reply.toLowerCase().replace(/tomador[^.!?]*/, '')), r.reply.slice(0, 80));
  assertOne('nao confirmou ainda', !intake.confirmed);
}

async function scn_frustracao() {
  console.log('\n[4] Frustracao (palavras de alarme)');
  const phone = '5511900000004';
  await cleanup(phone);
  const { reply } = await ask(phone, 'Isso é um absurdo, descaso total, vou cancelar o contrato');
  // Deve reconhecer frustracao + escalar
  assertOne('reconhece frustracao', /desculp|entendo|frustra|lament/i.test(reply), reply.slice(0, 80));
  // Aguarda inserts async
  await new Promise(r => setTimeout(r, 1500));
  const tasks = await getTasks(phone);
  assertOne('criou task/alerta', tasks.length > 0, tasks.map(t => t.title).join(' | '));
}

async function scn_rejeicao_ia() {
  console.log('\n[5] Rejeicao a IA');
  const phone = '5511900000005';
  await cleanup(phone);
  const { reply } = await ask(phone, 'Não quero falar com robô, quero uma pessoa');
  assertOne('responde cordial', /claro|sem problema|encaminh|aten/i.test(reply), reply.slice(0, 80));
  assertOne('nao insiste em resolver sozinha', !/posso ajudar|deixa comigo/i.test(reply));
}

async function scn_guard_nfse() {
  console.log('\n[6] Guard: rotear_para_rodrigo NFS-e sem intake confirmado deve falhar');
  const phone = '5511900000006';
  await cleanup(phone);
  // Cria conversa sem intake
  await query(`INSERT INTO luna_v2.conversations (phone, last_message_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING`, [phone]);
  const { rows } = await query(`SELECT id FROM luna_v2.conversations WHERE phone = $1`, [phone]);
  const conversationId = rows[0].id;
  // Importa e chama direto a tool
  const { makeLunaExecutor } = await import('./src/services/luna-tools.js');
  const exec = makeLunaExecutor({ conversationId, phone });
  const result = await exec('rotear_para_rodrigo', { tipo: 'fiscal_nfse', descricao: 'teste' });
  assertOne('guard bloqueia roteamento', result.ok === false, JSON.stringify(result).slice(0, 120));
  assertOne('erro menciona intake', /intake/i.test(result.erro || ''), result.erro);
}

// ============================================
async function main() {
  console.log('=== LUNA SMOKE TESTS ===');
  const t0 = Date.now();
  try {
    await scn_prospect();
    await scn_nfse_completo();
    await scn_nfse_incompleto();
    await scn_frustracao();
    await scn_rejeicao_ia();
    await scn_guard_nfse();
  } catch (e) {
    console.error('\nFATAL:', e.message, e.stack);
  }
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  console.log(`\n=== RESUMO: ${passed}/${RESULTS.length} passou, ${failed} falhou, ${took}s ===`);
  if (failed > 0) {
    console.log('\nFalhas:');
    RESULTS.filter(r => !r.pass).forEach(r => console.log(`  · ${r.label}${r.detail ? ' → ' + r.detail : ''}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
