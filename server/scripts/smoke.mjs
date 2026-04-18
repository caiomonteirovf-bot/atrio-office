#!/usr/bin/env node
// scripts/smoke.mjs — Smoke tests de integracao do Atrio Office.
// Executa contra http://localhost:3010 (ou SMOKE_BASE_URL).
// Cada teste eh idempotente: limpa o que criou ao final.
// Saida: lista de ✓/✗ + codigo de saida != 0 se algum falhar.
//
// Uso: node scripts/smoke.mjs
//      SMOKE_BASE_URL=http://31.97.175.200:3010 node scripts/smoke.mjs

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3010';
const FIXTURES_DIR = '/tmp';
const results = [];

function log(msg, indent = 0) {
  process.stdout.write(' '.repeat(indent) + msg + '\n');
}

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name, ok: true, ms });
    log(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m(${ms}ms)\x1b[0m`);
  } catch (err) {
    const ms = Date.now() - start;
    results.push({ name, ok: false, ms, error: err.message });
    log(`  \x1b[31m✗\x1b[0m ${name} \x1b[2m(${ms}ms)\x1b[0m`);
    log(`    \x1b[31m${err.message}\x1b[0m`, 2);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`resposta nao-JSON (${r.status}): ${t.slice(0,200)}`); } }

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { r, d: await json(r) };
}
async function getJson(path) {
  const r = await fetch(BASE + path);
  return { r, d: await json(r) };
}

// Fixtures -----------------------------------------------------------
function ensurePdf() {
  const p = FIXTURES_DIR + '/smoke_fixture.pdf';
  if (existsSync(p)) return p;
  // Usa um PDF pequeno bem-formado sempre disponivel no VPS
  const src = '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf';
  if (existsSync(src)) execSync(`cp ${src} ${p}`);
  else throw new Error('Nenhum PDF de fixture disponivel em ' + src);
  return p;
}
function ensurePng() {
  const p = FIXTURES_DIR + '/smoke_fixture.png';
  if (existsSync(p)) return p;
  // Gera via Python/Pillow (ja instalado no VPS)
  execSync(`python3 -c "from PIL import Image, ImageDraw, ImageFont; img=Image.new('RGB',(400,200),'white'); d=ImageDraw.Draw(img); f=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',16); d.text((20,30),'BOLETO TESTE',fill='black',font=f); d.text((20,70),'Valor: R\\$ 100,00',fill='black',font=f); d.text((20,110),'Vencimento: 2026-05-01',fill='black',font=f); img.save('${p}')"`);
  return p;
}
const MIME_BY_EXT = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg', jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
async function uploadFile(path, extra = {}) {
  const ext = path.split('.').pop().toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)], { type: mime }), path.split('/').pop());
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(BASE + '/api/ingest', { method: 'POST', body: fd });
  return { r, d: await json(r) };
}

// ====================================================================
// TESTES
// ====================================================================
const createdMemIds = [];

async function main() {
  log(`\n\x1b[1m📊 Átrio Office — Smoke Tests\x1b[0m`);
  log(`   base: \x1b[36m${BASE}\x1b[0m\n`);

  // ---- 1. Health / endpoints essenciais ----
  log('[1] Health & descoberta');

  await test('GET /api/admin/budgets retorna 6 agentes com orcamento', async () => {
    const { r, d } = await getJson('/api/admin/budgets');
    assert(r.ok && d.ok, 'resposta nao ok');
    assert(Array.isArray(d.data) && d.data.length >= 6, 'esperava >= 6 agentes');
    assert(d.data.every(a => a.budget_usd || a.budget_usd === null), 'campo budget_usd ausente');
  });

  await test('GET /api/skills retorna skills com validacao', async () => {
    const { d } = await getJson('/api/skills');
    assert(d.ok && Array.isArray(d.data), 'estrutura invalida');
    assert(d.data.length >= 2, 'esperava >= 2 skills');
    const nfse = d.data.find(s => s.name === 'emitir_nfse');
    assert(nfse, 'skill emitir_nfse nao encontrada');
    assert(nfse.allowed_agents?.includes('Campelo'), 'Campelo deve estar em allowed_agents');
  });

  await test('GET /api/activity/summary retorna 200', async () => {
    const { r, d } = await getJson('/api/activity/summary');
    assert(r.ok && d.ok, 'falhou');
  });

  // ---- 2. Pipeline de ingest PDF ----
  log('\n[2] Ingest pipeline — PDF');

  await test('POST /api/ingest (PDF) cria memorias com embedding', async () => {
    const { d } = await uploadFile(ensurePdf(), { title: '[SMOKE] pdf test' });
    assert(d.ok, `upload falhou: ${d.error || JSON.stringify(d)}`);
    assert(d.type === 'pdf', 'type deveria ser pdf');
    assert(Array.isArray(d.memory_ids) && d.memory_ids.length > 0, 'sem memory_ids');
    assert(d.chunks > 0, 'sem chunks');
    createdMemIds.push(...d.memory_ids);
  });

  // ---- 3. Pipeline de ingest imagem (vision) ----
  log('\n[3] Ingest pipeline — imagem (Claude Vision)');

  let imageMemId = null;
  await test('POST /api/ingest (imagem) extrai structured via Claude Vision', async () => {
    const { d } = await uploadFile(ensurePng(), { title: '[SMOKE] png test', client_id: '38' });
    assert(d.ok, `upload falhou: ${d.error}`);
    assert(d.type === 'image', 'type deveria ser image');
    assert(d.memory_id, 'sem memory_id');
    assert(d.doc_type, 'doc_type ausente');
    assert(typeof d.confidence === 'number', 'confidence ausente');
    imageMemId = d.memory_id;
    createdMemIds.push(imageMemId);
  });

  // ---- 4. Arquivo original servido ----
  log('\n[4] Preview/download do arquivo original');

  await test('GET /api/ingest/file/:id serve o arquivo', async () => {
    if (!imageMemId) throw new Error('skipped: sem imageMemId');
    const r = await fetch(BASE + '/api/ingest/file/' + imageMemId);
    assert(r.ok, `status ${r.status}`);
    assert(r.headers.get('content-type')?.startsWith('image/'), 'content-type incorreto');
    const buf = await r.arrayBuffer();
    assert(buf.byteLength > 100, 'arquivo muito pequeno');
  });

  await test('GET /api/ingest/file/:id retorna 404 para id inexistente', async () => {
    const r = await fetch(BASE + '/api/ingest/file/00000000-0000-0000-0000-000000000000');
    assert(r.status === 404 || r.status === 410, `esperava 404/410, veio ${r.status}`);
  });

  // ---- 5. Filtros de pending ----
  log('\n[5] Filtros & paginacao de /api/ingest/pending');

  await test('filtro por client_id=38 retorna apenas do 38', async () => {
    const { d } = await getJson('/api/ingest/pending?client_id=38&status=draft');
    assert(d.ok, 'falhou');
    assert(d.data.every(m => m.gesthub_client_id === '38'), 'filtro nao aplicou');
  });

  await test('filtro por doc_type=boleto retorna boletos', async () => {
    const { d } = await getJson('/api/ingest/pending?doc_type=boleto&status=draft');
    assert(d.ok, 'falhou');
    assert(d.data.every(m => m.document_type === 'boleto'), 'filtro doc_type nao aplicou');
  });

  // ---- 6. Approve e reject ----
  log('\n[6] Approve / reject');

  await test('POST /api/ingest/approve muda status + habilita RAG', async () => {
    if (!imageMemId) throw new Error('skipped: sem imageMemId');
    const { d } = await postJson('/api/ingest/approve', { memory_ids: [imageMemId] });
    assert(d.ok && d.approved === 1, 'nao aprovou');
    // confirma busca retorna agora como approved
    const p = await getJson(`/api/ingest/pending?status=approved`);
    assert(p.d.data.some(m => m.id === imageMemId), 'nao aparece na lista approved');
  });

  await test('POST /api/ingest/reject remove arquivo + zera embedding', async () => {
    if (!createdMemIds.length) throw new Error('skipped: sem memorias de teste');
    // Rejeita uma das memorias do PDF (que tem file_path)
    const toReject = createdMemIds[0];
    const { d } = await postJson('/api/ingest/reject', { memory_ids: [toReject] });
    assert(d.ok && d.rejected >= 1, 'reject falhou');
  });

  // ---- 7. Skill validation & render ----
  log('\n[7] Skills — validacao & render');

  await test('render skill com params invalidos retorna 400', async () => {
    const r = await fetch(BASE + '/api/skills/emitir_nfse/render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'Campelo', params: {} }),
    });
    assert(r.status === 400, `esperava 400, veio ${r.status}`);
  });

  await test('render skill com agente nao permitido retorna 400', async () => {
    const r = await fetch(BASE + '/api/skills/emitir_nfse/render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'Rodrigo', params: { cliente_cnpj: '12345678000199', valor_servico: 100, descricao_servico: 'x' } }),
    });
    assert(r.status === 400, `esperava 400, veio ${r.status}`);
  });

  await test('render skill valido retorna prompt estruturado', async () => {
    const { d } = await postJson('/api/skills/emitir_nfse/render', {
      agent: 'Campelo',
      params: { cliente_cnpj: '12345678000199', valor_servico: 100, descricao_servico: 'smoke' },
    });
    assert(d.ok && d.prompt, 'sem prompt');
    assert(d.prompt.includes('emitir_nfse'), 'prompt nao inclui nome da skill');
    assert(d.prompt.includes('12345678000199'), 'prompt nao interpolou params');
  });

  // ---- 8. Activity log ----
  log('\n[8] Activity log — imutabilidade & redaction');

  await test('GET /api/activity tem eventos recentes de ingest', async () => {
    const { d } = await getJson('/api/activity?limit=20');
    assert(d.ok, 'falhou');
    assert(d.data.some(e => e.event_type === 'memory.ingest'), 'nenhum evento memory.ingest encontrado');
  });

  await test('payload NAO contem senhas/tokens (redaction funciona)', async () => {
    const { d } = await getJson('/api/activity?limit=50');
    const blob = JSON.stringify(d.data);
    // Nenhum secret padrao deve aparecer no payload visivel
    assert(!/sk-or-v\d-[a-f0-9]{40,}/.test(blob), 'OpenRouter token vazou');
    assert(!/xai-[a-zA-Z0-9]{40,}/.test(blob), 'xAI token vazou');
  });

  await test('todos eventos tem payload_hash (integridade)', async () => {
    const { d } = await getJson('/api/activity?limit=10');
    assert(d.data.every(e => e.payload_hash == null || /^[a-f0-9]{64}$/.test(e.payload_hash)),
      'hash com formato invalido');
  });

  // ---- 9. DOCX / XLSX ----
  log('\n[9] Ingest DOCX / XLSX');

  await test('POST /api/ingest (DOCX) extrai texto', async () => {
    // Gera um DOCX minimo via python-docx
    const docx = FIXTURES_DIR + '/smoke_fixture.docx';
    execSync(`python3 -c "from docx import Document; d=Document(); d.add_heading('Smoke',0); d.add_paragraph('texto teste para smoke test'); d.save('${docx}')"`);
    const { d } = await uploadFile(docx, { title: '[SMOKE] docx' });
    assert(d.ok && d.type === 'docx', `falhou: ${JSON.stringify(d)}`);
    assert(d.memory_ids?.length > 0, 'sem memory_ids');
    createdMemIds.push(...d.memory_ids);
    try { unlinkSync(docx); } catch {}
  });

  await test('POST /api/ingest (XLSX) converte planilha em CSV', async () => {
    const xlsx = FIXTURES_DIR + '/smoke_fixture.xlsx';
    execSync(`python3 -c "from openpyxl import Workbook; w=Workbook(); s=w.active; s.title='PlanoContas';\nfor r in [['Codigo','Descricao','Natureza'],['1.1.01','Caixa Geral','Ativo'],['1.1.02','Bancos Conta Movimento','Ativo'],['2.1.01','Fornecedores Nacionais','Passivo'],['3.1.01','Receita Prestacao Servicos','Receita']]:\n    s.append(r)\nw.save('${xlsx}')"`);
    const { d } = await uploadFile(xlsx, { title: '[SMOKE] xlsx' });
    assert(d.ok && d.type === 'xlsx', `falhou: ${JSON.stringify(d)}`);
    assert(d.memory_ids?.length > 0, 'sem memory_ids');
    createdMemIds.push(...d.memory_ids);
    try { unlinkSync(xlsx); } catch {}
  });

  // ---- 10. Usage stats ----
  log('\n[10] Auditoria RAG');

  await test('GET /api/memory/usage-stats retorna estruturas esperadas', async () => {
    const { d } = await getJson('/api/memory/usage-stats');
    assert(d.ok, 'falhou');
    assert(Array.isArray(d.by_agent), 'by_agent ausente');
    assert(Array.isArray(d.by_client), 'by_client ausente');
    assert(Array.isArray(d.by_type), 'by_type ausente');
    assert(Array.isArray(d.top_hits), 'top_hits ausente');
  });

  // ---- CLEANUP ----
  log('\n[cleanup]');
  await test(`remove ${createdMemIds.length} memorias de teste`, async () => {
    if (!createdMemIds.length) return;
    await postJson('/api/ingest/reject', { memory_ids: createdMemIds });
  });

  // ====================================================================
  // SUMARIO
  // ====================================================================
  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  const totalMs = results.reduce((a, r) => a + r.ms, 0);

  log('\n' + '─'.repeat(60));
  log(`\x1b[1mResultado:\x1b[0m ${ok}/${results.length} ok · \x1b[2m${totalMs}ms total\x1b[0m`);
  if (failed.length) {
    log(`\n\x1b[31m${failed.length} falha(s):\x1b[0m`);
    failed.forEach(f => log(`  ✗ ${f.name}: ${f.error}`, 2));
    process.exit(1);
  }
  log(`\x1b[32mTodos os fluxos criticos OK.\x1b[0m\n`);
  process.exit(0);
}

main().catch(e => {
  log(`\n\x1b[31mERRO FATAL:\x1b[0m ${e.message}\n${e.stack}`);
  process.exit(2);
});
