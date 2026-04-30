// services/ingest.js v2
// Pipeline unificado de ingestao — PDF, DOCX, XLSX, imagens.
//
// v2 adiciona:
//   - Persistencia do arquivo original em /app/storage/ingest/<uuid>.<ext>
//   - Suporte a DOCX (mammoth) e XLSX (xlsx)
//   - metadata.file_path para servir o arquivo pela UI
//
// Entra com status='draft' — equipe aprova/rejeita na aba Documentos.

import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { query } from '../db/pool.js';
import { embed, toVector } from './embeddings.js';

const STORAGE_DIR = process.env.INGEST_STORAGE_DIR || '/app/storage/ingest';

// URL do Atrio Finance (banking-system) — roteamento de extratos PDF
// Padrao usa o nome do servico na rede docker `atrio_finance` (external)
const FINANCE_URL = process.env.ATRIO_FINANCE_URL
  || process.env.FINANCE_URL
  || 'http://atrio-banking-system-1:3000';

async function ensureStorage() {
  try { await fs.mkdir(STORAGE_DIR, { recursive: true }); } catch {}
}

async function persistBuffer(buffer, originalName) {
  await ensureStorage();
  const ext = path.extname(originalName || '') || '';
  const storedName = `${randomUUID()}${ext}`;
  const fullPath = path.join(STORAGE_DIR, storedName);
  await fs.writeFile(fullPath, buffer);
  return { path: fullPath, relative: storedName };
}

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const openrouter = process.env.OPENROUTER_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: { 'HTTP-Referer': 'https://atrio.local', 'X-Title': 'Atrio Office' },
    })
  : null;

const VISION_MODEL_OPENROUTER = process.env.VISION_MODEL || 'anthropic/claude-sonnet-4.5';

// ============================================================
// Helpers
// ============================================================

function resolveScope(meta) {
  const cid = meta.client_id;
  if (!cid) {
    return { scope_type: meta.scope_type || 'global', scope_id: meta.scope_id || null, extraMeta: {} };
  }
  const str = String(cid);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  if (isUuid) return { scope_type: 'client', scope_id: str, extraMeta: {} };
  return { scope_type: 'global', scope_id: null, extraMeta: { gesthub_client_id: parseInt(str, 10) } };
}

/**
 * Tenta descobrir cliente automaticamente pelo filename ou pelo conteudo inicial.
 * Busca em datalake_gesthub.clients (FDW) por:
 *   - CNPJ presente no filename/content (14 digitos)
 *   - Match de razao_social/nome_fantasia em tokens do filename
 * Retorna { gesthub_client_id, nome, matched_by } ou null.
 */
async function autoDetectCliente({ filename, sampleText, phone }) {
  try {
    const { query } = await import('../db/pool.js');
    const hay = `${filename || ''} ${sampleText || ''}`;
    const hayLower = hay.toLowerCase();

    // 0. CNPJ FORMATADO no texto (padrao XX.XXX.XXX/XXXX-XX ou variantes)
    // E a forma mais confiavel — escopada pra texto, nao digito-a-digito.
    // Evita falsos positivos do scan de substrings em filenames com UUID.
    const cnpjsFormatados = [];
    const rxCnpjFmt = /\b(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/g;
    let m;
    while ((m = rxCnpjFmt.exec(hay)) !== null) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length === 14 && !cnpjsFormatados.includes(digits)) {
        cnpjsFormatados.push(digits);
      }
    }
    for (const cnpj of cnpjsFormatados) {
      const { rows } = await query(
        `SELECT id, legal_name, trade_name, document
           FROM datalake_gesthub.clients
          WHERE regexp_replace(COALESCE(document,''),'\\D','','g') = $1
          LIMIT 1`, [cnpj]
      );
      if (rows[0]) {
        return {
          gesthub_client_id: rows[0].id,
          nome: rows[0].legal_name || rows[0].trade_name,
          matched_by: 'cnpj_formatado',
          confidence: 1.0,
        };
      }
    }

    // 0.1. CPF formatado (contadores podem encaminhar recibos de PF)
    const rxCpfFmt = /\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b/g;
    const cpfsFormatados = [];
    while ((m = rxCpfFmt.exec(hay)) !== null) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length === 11 && !cpfsFormatados.includes(digits)) {
        cpfsFormatados.push(digits);
      }
    }
    for (const cpf of cpfsFormatados) {
      const { rows } = await query(
        `SELECT id, legal_name, trade_name, document
           FROM datalake_gesthub.clients
          WHERE regexp_replace(COALESCE(document,''),'\\D','','g') = $1
          LIMIT 1`, [cpf]
      );
      if (rows[0]) {
        return {
          gesthub_client_id: rows[0].id,
          nome: rows[0].legal_name || rows[0].trade_name,
          matched_by: 'cpf_formatado',
          confidence: 1.0,
        };
      }
    }

    // 1. CNPJ no filename/conteudo (fallback digit-scan — menos confiavel)
    const hayDigits = hayLower.replace(/\D/g, '');
    if (hayDigits.length >= 14) {
      const tentados = new Set();
      for (let i = 0; i <= hayDigits.length - 14; i++) {
        const cnpj = hayDigits.slice(i, i + 14);
        if (tentados.has(cnpj)) continue;
        tentados.add(cnpj);
        const { rows } = await query(
          `SELECT id, legal_name, trade_name, document
             FROM datalake_gesthub.clients
            WHERE regexp_replace(COALESCE(document,''),'\\D','','g') = $1
            LIMIT 1`, [cnpj]
        );
        if (rows[0]) {
          return {
            gesthub_client_id: rows[0].id,
            nome: rows[0].legal_name || rows[0].trade_name,
            matched_by: 'cnpj_digit_scan',
            confidence: 0.85,  // menos confiante que formatado
          };
        }
      }
    }

    // 2. Match por tokens do nome (razao social ou fantasia)
    // Extrai tokens uteis do filename: >= 4 chars, nao-numericos, nao-hashes (mix letra+digito curto)
    const isHash = (t) => /^[a-f0-9]{6,}$/i.test(t) && /\d/.test(t) && /[a-f]/i.test(t);
    const tokens = (filename || '')
      .toLowerCase()
      .replace(/\.(pdf|docx|xlsx|jpg|jpeg|png|csv|ofx)$/i, '')
      .split(/[\s_\-.,()\[\]]+/)
      .filter(t => t.length >= 4 && !/^\d+$/.test(t) && !isHash(t));

    if (tokens.length === 0) return null;

    // Procura cliente cujo legal_name/trade_name contenha os tokens mais discriminantes
    // Estrategia: pega ate 3 tokens mais longos (mais especificos) e monta ILIKE %token%
    const bestTokens = tokens.sort((a, b) => b.length - a.length).slice(0, 3);
    const patterns = bestTokens.map(t => `%${t}%`);

    const { rows } = await query(
      `SELECT id, legal_name, trade_name, document,
              (CASE WHEN lower(legal_name) ILIKE ANY($1::text[]) THEN 1 ELSE 0 END +
               CASE WHEN lower(trade_name) ILIKE ANY($1::text[]) THEN 1 ELSE 0 END) AS score
         FROM datalake_gesthub.clients
        WHERE lower(legal_name) ILIKE ANY($1::text[]) OR lower(trade_name) ILIKE ANY($1::text[])
        ORDER BY score DESC, length(COALESCE(legal_name, trade_name, '')) ASC
        LIMIT 3`, [patterns]
    );

    if (rows[0]) {
      // Confidence proporcional a quantos tokens casam
      const nome = (rows[0].legal_name || rows[0].trade_name || '').toLowerCase();
      const hitTokens = bestTokens.filter(t => nome.includes(t)).length;
      const conf = hitTokens / bestTokens.length;
      if (conf >= 0.5) {  // pelo menos metade dos tokens bate
        return {
          gesthub_client_id: rows[0].id,
          nome: rows[0].legal_name || rows[0].trade_name,
          matched_by: 'name_tokens',
          confidence: conf,
          candidates: rows.length,
        };
      }
    }

    // 3. Fallback: telefone do remetente bate com UM UNICO cliente via contatos
    // (regra feedback_phone_contatos: so contatos, nunca campo phone direto).
    // Se o telefone esta em contatos de multiplas empresas, nao resolve automaticamente.
    if (phone) {
      const digits11 = String(phone).replace(/\D/g, '').replace(/^55/, '').slice(-11);
      if (digits11.length >= 10) {
        const variantes = [digits11];
        // Variante sem "9" do celular (BR, 9 apos DDD)
        if (digits11.length === 11 && digits11[2] === '9') {
          variantes.push(digits11.slice(0, 2) + digits11.slice(3));
        }
        const { rows: phRows } = await query(
          `SELECT DISTINCT c.id, c.legal_name, c.trade_name
             FROM datalake_gesthub.clients c
             JOIN datalake_gesthub.cliente_contatos ct ON ct.cliente_id = c.id
            WHERE regexp_replace(COALESCE(ct.telefone,''),'\\D','','g') = ANY($1::text[])
              AND c.status = 'ATIVO'
            LIMIT 3`, [variantes]
        ).catch(() => ({ rows: [] }));
        if (phRows.length === 1) {
          return {
            gesthub_client_id: phRows[0].id,
            nome: phRows[0].legal_name || phRows[0].trade_name,
            matched_by: 'phone_contato',
            confidence: 0.9,
          };
        }
        // Multiplas empresas no mesmo telefone → nao auto-resolve (Sneijder decide)
      }
    }

    return null;
  } catch (e) {
    console.warn('[ingest] autoDetectCliente falhou:', e.message);
    return null;
  }
}

// Threshold pra auto-approve (env: AUTO_APPROVE_CONFIDENCE, default 0.92 — mais rigoroso)
const AUTO_APPROVE_CONFIDENCE = Number(process.env.AUTO_APPROVE_CONFIDENCE || 0.92);

// Padroes de titulo que sao LIXO (nome de arquivo cru, sem conceito extraido)
const JUNK_TITLE_PATTERNS = [
  /^whatsapp_\d+(\.[a-z]+)?$/i,       // whatsapp_1776860747567.jpg
  /^PGDASD[-_]?DAS[-_]/i,             // PGDASD-DAS-6172...pdf (boleto imposto)
  /^DAS[-_]\d{6,}/i,                  // DAS-6172...
  /^IMG[-_]?\d{8,}/i,                 // IMG-20240101... (foto de celular)
  /^(boleto|comprovante|extrato|nfse|nfe)[-_]?\d+/i,
  /^[\w-]+\.(jpg|jpeg|png|pdf|heic|webp)$/i, // qualquer "xpto.jpg"
  /^\[SMOKE\]/i,                      // fixtures de teste
  /^\s*$/,                            // vazio
];

function isJunkTitle(title, filename) {
  if (!title) return true;
  const t = String(title).trim();
  if (t.length < 10) return true;                  // titulo muito curto
  if (filename && t === filename) return true;     // titulo == filename
  return JUNK_TITLE_PATTERNS.some(p => p.test(t));
}

function shouldAutoApprove(analysisConfidence, clienteDetectado, extras = {}) {
  const conf = Number(analysisConfidence || 0);
  if (conf < AUTO_APPROVE_CONFIDENCE) return false;

  // Gate de qualidade: titulo lixo (filename cru) NUNCA auto-aprova
  if (isJunkTitle(extras.title, extras.filename)) return false;

  // Conteudo muito pobre (< 200 chars uteis) NUNCA auto-aprova
  if (extras.contentLength != null && extras.contentLength < 200) return false;

  // Origem WhatsApp SEMPRE vai pra draft — midia de cliente e uncurated
  if (extras.sourceChannel === 'whatsapp') return false;

  // Imagens (fotos, prints) precisam de revisao humana (OCR e fragil pra RAG)
  if (extras.docKind === 'image') return false;

  // Se nao detectou cliente, ainda pode auto-approve se conf alta (doc global)
  // Mas se tem ambiguidade no cliente (candidates>1, matched_by=name_tokens com conf baixa), exige revisao
  if (clienteDetectado && clienteDetectado.matched_by === 'name_tokens' && clienteDetectado.confidence < 0.8) {
    return false;
  }
  return true;
}

export function chunkText(text, maxChars = 2500, overlap = 250) {
  if (!text || text.length <= maxChars) return [text].filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + maxChars, text.length);
    let cut = end;
    if (end < text.length) {
      const win = text.slice(Math.max(end - 200, i), end);
      const br = win.lastIndexOf('\n\n');
      if (br > 0) cut = Math.max(end - 200, i) + br;
    }
    chunks.push(text.slice(i, cut).trim());
    if (cut >= text.length) break;
    i = Math.max(cut - overlap, i + 1);
  }
  return chunks.filter(c => c && c.length > 20);
}

// ============================================================
// EXTRATORES DE TEXTO
// ============================================================

export async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return { text: (data.text || '').trim(), pages: data.numpages, info: data.info || {} };
}

export async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return { text: (result.value || '').trim(), pages: null, info: { messages: result.messages?.length || 0 } };
}

export async function extractXlsxText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  let totalRows = 0;
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const rows = csv.split('\n').length;
    totalRows += rows;
    parts.push(`# Planilha: ${sheetName}\n${csv}`);
  }
  return { text: parts.join('\n\n').trim(), pages: wb.SheetNames.length, info: { sheets: wb.SheetNames, rows: totalRows } };
}

// ============================================================
// PIPELINE DE DOCUMENTO (PDF / DOCX / XLSX)
// ============================================================

async function ingestDocumentFromText(text, pages, docType, meta, persisted) {
  if (!text || text.length < 30) {
    return { ok: false, error: `${docType.toUpperCase()} sem texto extraivel (pode ser scan)` };
  }

  const filename = meta.filename || `documento.${docType}`;
  const title = meta.title || filename.replace(new RegExp(`\\.${docType}$`, 'i'), '');
  const chunks = chunkText(text);

  // Auto-detecta cliente se nao veio informado
  let cliente_auto = null;
  if (!meta.client_id) {
    cliente_auto = await autoDetectCliente({ filename, sampleText: text.slice(0, 2000), phone: meta.phone || meta.client_phone });
    if (cliente_auto) {
      meta = { ...meta, client_id: cliente_auto.gesthub_client_id };
      console.log(`[ingest] cliente auto-detectado: ${cliente_auto.nome} (#${cliente_auto.gesthub_client_id}, via ${cliente_auto.matched_by} conf=${cliente_auto.confidence})`);
    }
  }

  const { scope_type, scope_id, extraMeta } = resolveScope(meta);

  const metadata_base = {
    source_type: 'document',
    document_type: docType,
    filename,
    pages,
    file_path: persisted?.relative || null,
    ingested_at: new Date().toISOString(),
    ...(cliente_auto ? { cliente_auto_detectado: cliente_auto } : {}),
    ...extraMeta,
    ...(meta.metadata || {}),
  };

  // Analise de confianca preliminar (sera atualizada depois se docType=imagem)
  const analysisConfidence = meta.analysisConfidence || 0.9; // PDFs/DOCX tem alta confianca extrativa
  const autoApprove = shouldAutoApprove(analysisConfidence, cliente_auto, {
    title,
    filename,
    contentLength: (text || '').length,
    sourceChannel: meta.source_channel || null,
    docKind: docType,
  }) && !meta.forceDraft;
  const targetStatus = autoApprove ? 'approved' : 'draft';

  const memory_ids = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkTitle = chunks.length > 1 ? `${title} — parte ${i + 1}/${chunks.length}` : title;
    const summary = chunk.slice(0, 300);
    const metadata = { ...metadata_base, chunk_index: i, chunk_total: chunks.length };

    let vec = null;
    try { vec = await embed(chunk); }
    catch (e) { console.error(`[ingest-${docType}] embedding chunk`, i, 'falhou:', e.message); }

    const { rows } = await query(
      `INSERT INTO memories
         (scope_type, scope_id, agent_id, category, title, content, summary,
          source_type, source_ref, status, tags, metadata, embedding, is_rag_enabled)
       VALUES ($1::memory_scope, $2, $3, 'general'::memory_category, $4, $5, $6,
               'document'::memory_source, $7, $11::memory_status, $8, $9::jsonb,
               $10::vector, false)
       RETURNING id`,
      [
        scope_type, scope_id, meta.agent_id || null,
        chunkTitle, chunk, summary,
        filename, meta.tags || [], JSON.stringify(metadata),
        vec ? toVector(vec) : null,
        targetStatus,
      ]
    );
    memory_ids.push(rows[0].id);
  }

  return {
    ok: true, memory_ids, chunks: chunks.length, pages,
    preview: text.slice(0, 400), title,
    status: targetStatus,
    auto_approved: autoApprove,
    cliente_detectado: cliente_auto,
  };
}

// Extrai estrutura (doc_type, cnpj, banco, valor, periodo) do texto do PDF via LLM.
// Usa anthropic se disponivel, senao openrouter (que e o padrao do sistema).
// Retorna { doc_type, structured, summary } ou null se falhar.
export async function classifyPdfText(text) {
  if (!text || text.length < 50) return null;
  const snippet = text.slice(0, 8000);
  const prompt = `Analise este texto extraido de um PDF recebido por contabilidade brasileira e retorne APENAS JSON valido (sem markdown):
{
  "doc_type": "boleto" | "comprovante" | "nota_fiscal" | "contrato" | "extrato" | "documento_pessoal" | "outro",
  "structured": {
    "cnpj": "se encontrar",
    "cpf": "se encontrar",
    "razao_social": "titular/empresa do documento",
    "banco": "se for extrato/comprovante",
    "agencia_conta": "se for extrato",
    "periodo_inicial": "YYYY-MM-DD se for extrato",
    "periodo_final": "YYYY-MM-DD se for extrato",
    "valor": "R$ X,XX para boleto/comprovante",
    "vencimento": "YYYY-MM-DD para boleto"
  },
  "summary": "1-2 frases"
}
Omita campos vazios. Heuristica: se tem "Saldo inicial", "Movimentacoes", "Transferencia", "Pix recebido/enviado" = EXTRATO. Se tem "Codigo de barras" ou "Linha digitavel" = BOLETO.

TEXTO:
${snippet}`;

  const parseJson = (raw) => {
    if (!raw) return null;
    const cleaned = String(raw).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  };

  try {
    if (anthropic) {
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });
      const parsed = parseJson(resp.content?.[0]?.text);
      if (parsed) return parsed;
    }
  } catch (e) {
    console.error('[classifyPdfText] anthropic falhou:', e.message);
  }

  try {
    if (openrouter) {
      const resp = await openrouter.chat.completions.create({
        model: VISION_MODEL_OPENROUTER,
        max_tokens: 800,
        messages: [
          { role: 'system', content: 'Voce e um extrator JSON. Responda SOMENTE com JSON valido.' },
          { role: 'user', content: prompt },
        ],
      });
      const parsed = parseJson(resp.choices?.[0]?.message?.content);
      if (parsed) {
        console.log('[classifyPdfText] openrouter classificou:', parsed.doc_type);
        return parsed;
      }
    }
  } catch (e) {
    console.error('[classifyPdfText] openrouter falhou:', e.message);
  }

  console.log('[classifyPdfText] nenhum provider disponivel, retornando null');
  return null;
}

// ============================================================
// CLASSIFICADOR: Extrato bancario -> roteia pro Atrio Finance
// ============================================================

/**
 * Heuristica rapida: o PDF parece extrato bancario?
 * Verifica filename + primeiras linhas do texto.
 * Retorna { isStatement: bool, bankHint: 'cora'|'bb'|'inter'|'bradesco'|'itau'|null, reasons: [] }
 */
export function looksLikeBankStatement(filename, firstPageText) {
  // Normaliza filename: troca separadores (`_`, `-`, `.`) por espaco pra \b funcionar
  const rawFn = (filename || '').toLowerCase();
  const fn = rawFn.replace(/[_\-.]+/g, ' ');
  const tx = (firstPageText || '').toLowerCase().slice(0, 5000);
  const reasons = [];
  let bankHint = null;

  // 1. Filename signals
  if (/\bextrato\b/.test(fn)) reasons.push('filename:extrato');
  if (/\bconta\s+corrente\b/.test(fn)) reasons.push('filename:conta-corrente');

  // Bank name in filename
  if (/\bcora\b/.test(fn)) { bankHint = 'cora'; reasons.push('filename:cora'); }
  else if (/\binter\b/.test(fn)) { bankHint = 'inter'; reasons.push('filename:inter'); }
  else if (/\bbradesco\b/.test(fn)) { bankHint = 'bradesco'; reasons.push('filename:bradesco'); }
  else if (/\bitau\b/.test(fn) || /\bita[uú]\b/.test(fn)) { bankHint = 'itau'; reasons.push('filename:itau'); }
  else if (/\bbb\b|banco\s+do\s+brasil/.test(fn)) { bankHint = 'bb'; reasons.push('filename:bb'); }
  else if (/\bnubank\b/.test(fn) || /\bnu\s+\d{6,}/.test(fn)) { bankHint = 'nubank'; reasons.push('filename:nubank'); }
  else if (/\bsicoob\b/.test(fn)) { bankHint = 'sicoob'; reasons.push('filename:sicoob'); }
  else if (/\bsantander\b/.test(fn)) { bankHint = 'santander'; reasons.push('filename:santander'); }
  else if (/\bc6\b/.test(fn)) { bankHint = 'c6'; reasons.push('filename:c6'); }

  // Padrao de nome "NU_<conta>_<DDmesYYYY>_<DDmesYYYY>" tipico Nubank
  if (/\bnu\s+\d{6,}\s+\d{2}[a-z]{3}\d{4}/.test(fn)) {
    reasons.push('filename:nubank-pattern');
    if (!bankHint) bankHint = 'nubank';
  }

  // 2. Text signals (multiple phrases that only appear in statements)
  const textSignals = [
    /saldo\s+anterior/i,
    /saldo\s+inicial/i,
    /saldo\s+do\s+dia/i,
    /saldo\s+final/i,
    /total\s+de\s+entradas/i,
    /total\s+de\s+sa[ií]das/i,
    /extrato\s+de\s+conta\s+corrente/i,
    /extrato\s+da\s+conta/i,
    /movimenta[çc][õo]es/i,
    /pix\s+(recebido|enviado)/i,
    /lan[çc]amentos\s+do\s+per[ií]odo/i,
  ];
  let textHits = 0;
  for (const rx of textSignals) {
    if (rx.test(tx)) { textHits++; reasons.push(`text:${rx.source.slice(0, 20)}`); }
  }

  // Bank identification via CNPJ or nome proprio in text
  if (!bankHint) {
    if (/37\.880\.206\/0001/.test(tx) || /\bcora\s+(scfi|scd|sociedade)/i.test(tx)) { bankHint = 'cora'; reasons.push('text:cora'); }
    else if (/00\.416\.968\/0001/.test(tx) || /\bbanco\s+inter\b/i.test(tx)) { bankHint = 'inter'; reasons.push('text:inter'); }
    else if (/60\.746\.948\/0001/.test(tx) || /\bbanco\s+bradesco\b/i.test(tx)) { bankHint = 'bradesco'; reasons.push('text:bradesco'); }
    else if (/60\.701\.190\/0001/.test(tx) || /\bbanco\s+ita[uú]\b/i.test(tx)) { bankHint = 'itau'; reasons.push('text:itau'); }
    else if (/00\.000\.000\/0001-91/.test(tx) || /\bbanco\s+do\s+brasil\b/i.test(tx)) { bankHint = 'bb'; reasons.push('text:bb'); }
    else if (/\bnubank\b/i.test(tx) || /nu\s+pagamentos/i.test(tx)) { bankHint = 'nubank'; reasons.push('text:nubank'); }
  }

  // Decisao: precisa de sinais convincentes
  const fileHit = reasons.some(r => r.startsWith('filename:'));
  const hasStrongFilePattern = reasons.some(r =>
    r === 'filename:nubank-pattern' || r === 'filename:extrato' || r === 'filename:conta-corrente'
  );
  const isStatement = Boolean(
    hasStrongFilePattern            // nome claramente indica extrato ("extrato_*.pdf", "NU_conta_DDMMMYYYY...")
    || (fileHit && textHits >= 1)   // banco no nome + 1 sinal de texto
    || textHits >= 3                // 3+ sinais apenas no texto
    || (bankHint && textHits >= 1)  // banco identificado + 1 sinal de texto
  );

  return { isStatement, bankHint, reasons, textHits };
}

/**
 * Tenta extrair ano/mes de competencia do filename ou texto do extrato.
 * Retorna { ano, mes } — fallback pro mes corrente se nao achar.
 */
/**
 * Detecta se o documento e uma guia/comprovante de imposto (DAS, DARF, GPS, INSS, etc).
 * Tipos retornados:
 *   das | darf | gps | inss | fgts | iss_pmpe | dctf | sped | nf | folha | comprovante | outro
 * Retorna { isTaxDoc, tipo, valor?, banco?, reasons }.
 */
export function looksLikeTaxDocument(filename, firstPageText, msgBody) {
  const fn = (filename || '').toLowerCase().replace(/[_\-.]+/g, ' ');
  const tx = (firstPageText || '').toLowerCase().slice(0, 5000);
  const body = (msgBody || '').toLowerCase();
  const all = `${fn} ${tx} ${body}`;
  const reasons = [];
  let tipo = null;
  let valor = null;

  // 1. DAS (Simples Nacional)
  if (/\bdas\b/.test(fn) || /documento de arrecadacao do simples nacional/i.test(tx) || /\bdas\b.*simples/.test(all)) {
    tipo = 'das'; reasons.push('das');
  }
  // 2. DARF (Documento de Arrecadação de Receitas Federais)
  else if (/\bdarf\b/.test(fn) || /documento de arrecadacao de receitas federais/i.test(tx)) {
    tipo = 'darf'; reasons.push('darf');
  }
  // 3. GPS (Guia da Previdência Social)
  else if (/\bgps\b/.test(fn) || /guia da previdencia social/i.test(tx)) {
    tipo = 'gps'; reasons.push('gps');
  }
  // 4. INSS
  else if (/\binss\b/.test(fn) || /\binss\b/.test(tx)) {
    tipo = 'inss'; reasons.push('inss');
  }
  // 5. FGTS
  else if (/\bfgts\b/.test(fn) || /fundo de garantia/i.test(tx) || /\bgrf\b/.test(fn)) {
    tipo = 'fgts'; reasons.push('fgts');
  }
  // 6. ISS municipal
  else if (/\biss\b/.test(fn) || /imposto sobre servicos/i.test(tx)) {
    tipo = 'iss'; reasons.push('iss');
  }
  // 7. DCTF
  else if (/\bdctf\b/.test(fn) || /declaracao de debitos/i.test(tx)) {
    tipo = 'dctf'; reasons.push('dctf');
  }
  // 8. NF (entrada/saida)
  else if (/\bnota\s+fiscal\b|\bnf-?e\b|\bnfse\b|\bnfs-e\b/.test(fn) || /nfe|nfs-e|nota fiscal eletronica/i.test(tx)) {
    tipo = 'nf'; reasons.push('nf');
  }
  // 9. Folha de pagamento
  else if (/\bfolha\b|holerite|recibo de salario/i.test(fn) || /folha de pagamento|recibo de pagamento/i.test(tx)) {
    tipo = 'folha'; reasons.push('folha');
  }
  // 10. Comprovante de pagamento
  else if (/comprovante|extrato.*pagamento|pix|transferencia/.test(fn)) {
    tipo = 'comprovante'; reasons.push('comprovante');
  }

  // Tenta extrair VALOR (formato R$ X.XXX,XX ou apenas X.XXX,XX no filename ou text)
  const valorMatch = (filename || '').match(/r\$\s*([\d.]+,\d{2})/i)
    || (filename || '').match(/\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/)
    || tx.match(/valor\s+do?\s+documento[\s:]+r?\$?\s*([\d.]+,\d{2})/i)
    || tx.match(/total\s+a\s+recolher[\s:]+r?\$?\s*([\d.]+,\d{2})/i);
  if (valorMatch) {
    valor = parseFloat(valorMatch[1].replace(/\./g, '').replace(',', '.'));
  }

  return {
    isTaxDoc: tipo !== null,
    tipo,
    valor,
    reasons,
  };
}

/**
 * Extrai URL de download do Gestta no corpo de mensagem do WhatsApp.
 * Padrao: https://api.gestta.com.br/core/public/customer/task/<id>/document/<doc_id>/download?...
 */
export function extractGesttaUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/api\.gestta\.com\.br\/[^\s]+\/download\?[^\s]+/i);
  return m ? m[0] : null;
}

/**
 * Faz download de um doc do Gestta. Retorna { ok, buffer, filename, mime } ou { ok: false, error }.
 */
export async function fetchGesttaDoc(url) {
  try {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const buffer = Buffer.from(await resp.arrayBuffer());
    const cd = resp.headers.get('content-disposition') || '';
    const fn = cd.match(/filename\*?=(?:UTF-8''|"|')?([^;"']+)/i)?.[1] || `gestta_${Date.now()}.pdf`;
    const mime = resp.headers.get('content-type') || 'application/pdf';
    return { ok: true, buffer, filename: decodeURIComponent(fn).replace(/^["']|["']$/g, ''), mime };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function extractCompetencia(filename, text) {
  const MESES = {
    janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, mar: 3, marc: 3,
    abril: 4, abr: 4, maio: 5, mai: 5, junho: 6, jun: 6,
    julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9,
    outubro: 10, out: 10, novembro: 11, nov: 11, dezembro: 12, dez: 12,
  };
  const fn = (filename || '').toLowerCase().replace(/[_\-.]+/g, ' ');
  const tx = (text || '').slice(0, 2000).toLowerCase();

  // 1. YYYY-MM ou YYYY_MM ou YYYY/MM no filename
  let m = fn.match(/\b(20\d{2})[\s\-_\/]?(0?[1-9]|1[0-2])\b/);
  if (m) return { ano: parseInt(m[1], 10), mes: parseInt(m[2], 10) };

  // 2. MM-YYYY no filename
  m = fn.match(/\b(0?[1-9]|1[0-2])[\s\-_\/](20\d{2})\b/);
  if (m) return { ano: parseInt(m[2], 10), mes: parseInt(m[1], 10) };

  // 3. Nome do mes + ano no filename
  for (const [nome, num] of Object.entries(MESES)) {
    const rx = new RegExp(`\\b${nome}\\b[\\s\\-/_]*?(20\\d{2})`);
    const hit = fn.match(rx);
    if (hit) return { ano: parseInt(hit[1], 10), mes: num };
  }

  // 4. Texto: primeira data DD/MM/YYYY
  m = tx.match(/\b(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])\/(20\d{2})\b/);
  if (m) return { ano: parseInt(m[3], 10), mes: parseInt(m[2], 10) };

  // Fallback: mes corrente
  const now = new Date();
  return { ano: now.getFullYear(), mes: now.getMonth() + 1 };
}

/**
 * Roteia um documento fiscal pra "pasta do mes" do cliente no Gesthub.
 * POSTa o PDF em /api/clients/:id/files com competencia + tipo_doc + valor.
 */
async function routeTaxDocToGesthub(buffer, filename, clientId, taxDoc, comp) {
  const GESTHUB = process.env.GESTHUB_API_URL || 'http://31.97.175.200';
  try {
    const form = new FormData();
    const blob = new Blob([buffer], { type: 'application/pdf' });
    form.append('file', blob, filename);
    form.append('categoria', 'doc_mensal');
    form.append('nome', `${taxDoc.tipo.toUpperCase()} ${String(comp.mes).padStart(2, '0')}/${comp.ano}`);
    form.append('competencia', `${comp.ano}-${String(comp.mes).padStart(2, '0')}-01`);
    form.append('tipoDoc', taxDoc.tipo);
    if (taxDoc.valor != null) form.append('valor', String(taxDoc.valor));

    const resp = await fetch(`${GESTHUB}/api/clients/${clientId}/files`, { method: 'POST', body: form });
    const raw = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, error: `Gesthub retornou ${resp.status}: ${raw?.detail || JSON.stringify(raw).slice(0, 200)}` };
    }
    return { ok: true, fileId: raw?.data?.id || null };
  } catch (e) {
    return { ok: false, error: `falha conectando em Gesthub: ${e.message}` };
  }
}

/**
 * Roteia o PDF pro Atrio Finance (banking-system).
 * POSTa o buffer em /api/uploads como multipart com cliente_id + ano + mes.
 * Retorna { ok, uploadId, destino, cliente, parseSuspeito?, aviso? } ou { ok:false, error }.
 */
export async function routeBankStatementToFinance(buffer, filename, meta, classification, pdfText) {
  const clienteId = meta.client_id || (meta.cliente_auto && meta.cliente_auto.gesthub_client_id);
  if (!clienteId) {
    return { ok: false, error: 'cliente_id nao resolvido — extrato nao pode ser roteado sem empresa' };
  }

  const { ano, mes } = meta.ano && meta.mes
    ? { ano: meta.ano, mes: meta.mes }
    : extractCompetencia(filename, pdfText);

  // Node 18+ tem FormData/Blob nativos, fetch global.
  try {
    const form = new FormData();
    const blob = new Blob([buffer], { type: 'application/pdf' });
    form.append('file', blob, filename);
    form.append('cliente_id', String(clienteId));
    form.append('ano', String(ano));
    form.append('mes', String(mes));
    if (meta.conta_id) form.append('conta_id', String(meta.conta_id));

    const resp = await fetch(`${FINANCE_URL}/api/uploads`, { method: 'POST', body: form });
    const raw = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return { ok: false, error: `Finance retornou ${resp.status}: ${raw?.error || raw?.detail || JSON.stringify(raw).slice(0, 200)}` };
    }

    // Finance retorna { ok: true, data: { upload, conta, imported, skipped, total, parseSuspeito, ... }}
    const payload = raw?.data || raw || {};
    const upload = payload.upload || {};
    const conta = payload.conta || {};

    return {
      ok: true,
      destino: 'atrio_finance',
      uploadId: upload.id || payload.upload_id || null,
      cliente_id: clienteId,
      ano, mes,
      conta: conta.id ? { id: conta.id, banco: conta.banco, conta: conta.conta, agencia: conta.agencia } : null,
      contaCriada: payload.contaCriada || false,
      imported: payload.imported ?? null,
      skipped: payload.skipped ?? null,
      transactions: payload.total ?? payload.imported ?? null,
      autoClassificadas: payload.autoClassificadas ?? 0,
      parseSuspeito: payload.parseSuspeito || false,
      aviso: payload.parseAviso || null,
      totaisImpressos: payload.totaisImpressos || null,
      totaisCalculados: payload.totaisCalculados || null,
      banco: classification?.bankHint || payload.parseBancoDetectado || conta.banco || null,
    };
  } catch (e) {
    return { ok: false, error: `falha conectando em Finance: ${e.message}` };
  }
}

export async function ingestPdf(buffer, meta = {}) {
  const persisted = await persistBuffer(buffer, meta.filename || 'documento.pdf');
  const { text, pages } = await extractPdfText(buffer);

  const filename = meta.filename || 'documento.pdf';

  // === DOC FISCAL: detecta DAS, DARF, GPS, INSS, FGTS, NF, folha, comprovante ===
  // Se for, roteia pra "pasta do mes" do cliente no Gesthub (client_files com competencia + tipo_doc)
  const taxDoc = looksLikeTaxDocument(filename, text, meta.msg_body);
  if (taxDoc.isTaxDoc && !meta.forceMemory) {
    console.log(`[ingestPdf] detectado doc fiscal: tipo=${taxDoc.tipo} valor=${taxDoc.valor} sinais=${taxDoc.reasons.join(',')}`);

    let cliente_auto = null;
    if (!meta.client_id) {
      cliente_auto = await autoDetectCliente({ filename, sampleText: text.slice(0, 2000), phone: meta.phone || meta.client_phone });
      if (cliente_auto) {
        meta = { ...meta, client_id: cliente_auto.gesthub_client_id, cliente_auto };
      }
    }

    if (meta.client_id) {
      const comp = (meta.ano && meta.mes) ? { ano: meta.ano, mes: meta.mes } : extractCompetencia(filename, text);
      const routed = await routeTaxDocToGesthub(buffer, filename, meta.client_id, taxDoc, comp);
      if (routed.ok) {
        return {
          ok: true,
          routed: 'tax_doc',
          destino: 'gesthub_pasta_mes',
          file_id: routed.fileId,
          cliente_id: meta.client_id,
          cliente_detectado: cliente_auto,
          tipo_doc: taxDoc.tipo,
          competencia: `${comp.ano}-${String(comp.mes).padStart(2, '0')}`,
          valor: taxDoc.valor,
          mensagem: `✓ ${taxDoc.tipo.toUpperCase()} ${comp.mes}/${comp.ano}${taxDoc.valor ? ` (R$ ${taxDoc.valor.toFixed(2).replace('.', ',')})` : ''} salvo na pasta do mes`,
          file_path: persisted?.relative || null,
          skipped_memory: true,
        };
      } else {
        console.warn(`[ingestPdf] tax doc routing falhou: ${routed.error} — caindo pro fluxo normal`);
      }
    } else {
      console.warn('[ingestPdf] doc fiscal sem cliente_id — nao sera salvo na pasta do mes');
    }
  }

  // === FASE 2 DO STORAGE: classificador de upload ===
  // Antes de mandar o PDF pra memoria, verifica se e extrato bancario.
  // Se for, roteia pro Atrio Finance (banking-system) em vez de virar memoria/RAG.
  const classification = looksLikeBankStatement(filename, text);

  if (classification.isStatement && !meta.forceMemory) {
    console.log(`[ingestPdf] detectado extrato bancario (${classification.bankHint || 'banco-?'}) — sinais: ${classification.reasons.join(', ')}`);

    // Resolve cliente se nao veio — o Finance precisa do cliente_id
    let cliente_auto = null;
    if (!meta.client_id) {
      cliente_auto = await autoDetectCliente({ filename, sampleText: text.slice(0, 2000), phone: meta.phone || meta.client_phone });
      if (cliente_auto) {
        meta = { ...meta, client_id: cliente_auto.gesthub_client_id, cliente_auto };
        console.log(`[ingestPdf] cliente auto-detectado pra routing: ${cliente_auto.nome} (#${cliente_auto.gesthub_client_id})`);
      }
    }

    if (meta.client_id) {
      const routed = await routeBankStatementToFinance(buffer, filename, meta, classification, text);
      if (!routed.ok) {
        // Extrato detectado + client OK mas Finance falhou.
        // NAO caimos pra memoria/RAG — extrato nao deve virar memoria.
        // Retorna erro pra caller tratar (notificar equipe, nao aprovar docs).
        console.warn(`[ingestPdf] Finance falhou pra extrato de ${meta.client_id}: ${routed.error}`);
        return {
          ok: false,
          routed: 'banking',
          destino: 'atrio_finance',
          error: routed.error,
          classification,
          cliente_id: meta.client_id,
          mensagem: `Extrato detectado mas Finance rejeitou: ${routed.error}. Revisar em Finance > Extratos ou cadastrar conta manualmente.`,
          skipped_memory: true,  // importante: NAO foi pra RAG
        };
      }
      if (routed.ok) {
        return {
          ok: true,
          routed: 'banking',
          destino: 'atrio_finance',
          upload_id: routed.uploadId,
          cliente_id: routed.cliente_id,
          cliente_detectado: cliente_auto,
          transactions: routed.transactions,
          banco: routed.banco,
          classification,
          parseSuspeito: routed.parseSuspeito,
          aviso: routed.aviso,
          totaisImpressos: routed.totaisImpressos,
          totaisCalculados: routed.totaisCalculados,
          mensagem: routed.parseSuspeito
            ? `⚠️ Extrato ${routed.banco || ''} enviado pro Atrio Finance, mas o parse divergiu dos totalizadores. Revisar em Finance > Extratos.`
            : `✓ Extrato ${routed.banco || ''} enviado pro Atrio Finance${routed.imported != null ? ` (${routed.imported} transacoes importadas${routed.skipped ? `, ${routed.skipped} duplicadas ignoradas` : ''})` : ''}${routed.contaCriada ? ' — conta criada automaticamente' : ''}.`,
          imported: routed.imported,
          skipped: routed.skipped,
          conta: routed.conta,
          file_path: persisted?.relative || null,
        };
      } else {
        console.warn(`[ingestPdf] routing pra Finance falhou: ${routed.error} — caindo pro fluxo de memoria`);
      }
    } else {
      // Extrato detectado mas nao conseguiu identificar o cliente.
      // NAO cai pra memoria/RAG — extrato sem cliente eh ambiguo, precisa acao humana.
      console.warn('[ingestPdf] extrato detectado mas sem cliente_id — retornando erro (NAO persiste em memoria)');
      return {
        ok: false,
        routed: 'banking',
        destino: 'atrio_finance',
        error: 'cliente nao identificado pelo CNPJ no extrato',
        classification,
        mensagem: `Extrato detectado (${classification.bankHint || 'banco'}) mas o cliente nao foi identificado. Vincular manualmente em Finance > Extratos.`,
        skipped_memory: true,
      };
    }
  }
  // === fim do classificador ===

  const result = await ingestDocumentFromText(text, pages, 'pdf', meta, persisted);
  // Passada adicional: classificar o PDF via LLM (doc_type + structured.cnpj etc)
  if (result.ok) {
    try {
      const llmClassif = await classifyPdfText(text);
      if (llmClassif) {
        result.doc_type = llmClassif.doc_type || result.doc_type;
        result.structured = llmClassif.structured || {};
        result.summary = llmClassif.summary || result.preview;
      }
    } catch (e) { console.error('[ingestPdf] classify falhou:', e.message); }
  }
  // Anexa classificacao heuristica de extrato (mesmo se nao roteou, pra debug)
  result.bank_statement_classification = classification;
  return result;
}

export async function ingestDocx(buffer, meta = {}) {
  const persisted = await persistBuffer(buffer, meta.filename || 'documento.docx');
  const { text } = await extractDocxText(buffer);
  return ingestDocumentFromText(text, null, 'docx', meta, persisted);
}

export async function ingestXlsx(buffer, meta = {}) {
  const persisted = await persistBuffer(buffer, meta.filename || 'planilha.xlsx');
  const { text, pages } = await extractXlsxText(buffer);
  return ingestDocumentFromText(text, pages, 'xlsx', meta, persisted);
}

// ============================================================
// IMAGEM
// ============================================================

const VISION_SYSTEM = `Voce e um analista que extrai informacao de imagens para um escritorio de contabilidade brasileiro.

Dada uma imagem, retorne APENAS JSON valido com esta estrutura:
{
  "doc_type": "boleto" | "comprovante" | "nota_fiscal" | "contrato" | "extrato" | "documento_pessoal" | "foto" | "outro",
  "title": "titulo curto descrevendo o conteudo",
  "text_content": "todo texto visivel na imagem, transcrito fielmente",
  "structured": {
    "valor": "R$ X,XX se encontrar",
    "data": "YYYY-MM-DD se encontrar",
    "cnpj": "XX.XXX.XXX/XXXX-XX se encontrar",
    "cpf": "XXX.XXX.XXX-XX se encontrar",
    "vencimento": "YYYY-MM-DD se for boleto",
    "linha_digitavel": "... se for boleto",
    "banco": "nome do banco se for comprovante/extrato",
    "outros_campos": "{qualquer coisa relevante}"
  },
  "summary": "resumo em 1-2 frases do que a imagem mostra",
  "confidence": 0.0-1.0
}

Omita campos de "structured" que nao existam. Se nao for documento, preencha doc_type="foto" e descreva.
Responda APENAS com o JSON, sem marcadores de codigo.`;

export async function analyzeImage(buffer, mimeType = 'image/jpeg') {
  const base64 = buffer.toString('base64');

  if (anthropic) {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: VISION_SYSTEM,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: 'Analise e retorne o JSON.' },
      ]}],
    });
    return parseVisionResponse(resp.content?.[0]?.text || '', resp.usage, resp.model);
  }

  if (openrouter) {
    const dataUrl = `data:${mimeType};base64,${base64}`;
    const resp = await openrouter.chat.completions.create({
      model: VISION_MODEL_OPENROUTER,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: VISION_SYSTEM },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'Analise e retorne o JSON.' },
        ]},
      ],
    });
    return parseVisionResponse(resp.choices?.[0]?.message?.content || '', resp.usage, resp.model);
  }

  throw new Error('Nenhum provider de vision configurado');
}

function parseVisionResponse(textOut, usage, model) {
  const cleaned = String(textOut).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return { ...JSON.parse(cleaned), _usage: usage, _model: model };
  } catch (e) {
    return { doc_type: 'outro', title: 'imagem', text_content: textOut, structured: {},
             summary: 'Extracao bruta (JSON invalido)', confidence: 0.3, _usage: usage, _parse_error: e.message };
  }
}

export async function ingestImage(buffer, mimeType, meta = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('buffer invalido');
  const persisted = await persistBuffer(buffer, meta.filename || 'imagem.jpg');
  const analysis = await analyzeImage(buffer, mimeType);

  const filename = meta.filename || 'imagem.jpg';
  const title = meta.title || analysis.title || filename;
  const content = [
    analysis.summary && `RESUMO: ${analysis.summary}`,
    analysis.text_content && `TEXTO EXTRAIDO:\n${analysis.text_content}`,
    analysis.structured && Object.keys(analysis.structured).length
      ? `CAMPOS:\n${JSON.stringify(analysis.structured, null, 2)}`
      : null,
  ].filter(Boolean).join('\n\n');

  if (!content || content.length < 20) return { ok: false, error: 'imagem sem conteudo extraivel' };

  // Auto-detecta cliente se nao veio informado
  let cliente_auto = null;
  if (!meta.client_id) {
    cliente_auto = await autoDetectCliente({
      filename,
      sampleText: `${analysis.title || ''} ${analysis.summary || ''} ${analysis.text_content || ''}`.slice(0, 2000),
      phone: meta.phone || meta.client_phone,
    });
    if (cliente_auto) {
      meta = { ...meta, client_id: cliente_auto.gesthub_client_id };
      console.log(`[ingest-image] cliente auto-detectado: ${cliente_auto.nome} (#${cliente_auto.gesthub_client_id}, via ${cliente_auto.matched_by} conf=${cliente_auto.confidence})`);
    }
  }

  const { scope_type, scope_id, extraMeta } = resolveScope(meta);
  const metadata = {
    source_type: 'image',
    document_type: analysis.doc_type || 'foto',
    filename,
    mime_type: mimeType,
    file_path: persisted?.relative || null,
    confidence: analysis.confidence,
    vision_model: analysis._model,
    ingested_at: new Date().toISOString(),
    ...(cliente_auto ? { cliente_auto_detectado: cliente_auto } : {}),
    ...extraMeta,
    ...(meta.metadata || {}),
  };

  const autoApprove = shouldAutoApprove(analysis.confidence || 0.8, cliente_auto, {
    title,
    filename,
    contentLength: (content || '').length,
    sourceChannel: meta.source_channel || null,
    docKind: 'image',
  }) && !meta.forceDraft;
  const targetStatus = autoApprove ? 'approved' : 'draft';

  let vec = null;
  try { vec = await embed(content); }
  catch (e) { console.error('[ingest-image] embedding falhou:', e.message); }

  const { rows } = await query(
    `INSERT INTO memories
       (scope_type, scope_id, agent_id, category, title, content, summary,
        source_type, source_ref, status, tags, metadata, structured_facts,
        embedding, is_rag_enabled, confidence_score)
     VALUES ($1::memory_scope, $2, $3, 'general'::memory_category, $4, $5, $6,
             'document'::memory_source, $7, $13::memory_status, $8, $9::jsonb,
             $10::jsonb, $11::vector, false, $12)
     RETURNING id`,
    [
      scope_type, scope_id, meta.agent_id || null,
      title, content, analysis.summary || content.slice(0, 300),
      filename, meta.tags || [], JSON.stringify(metadata),
      JSON.stringify(analysis.structured || {}),
      vec ? toVector(vec) : null,
      analysis.confidence || 0.8,
      targetStatus,
    ]
  );

  return {
    ok: true, memory_id: rows[0].id, doc_type: analysis.doc_type, structured: analysis.structured,
    summary: analysis.summary, confidence: analysis.confidence,
    status: targetStatus, auto_approved: autoApprove,
    cliente_detectado: cliente_auto,
  };
}

// ============================================================
// DISPATCHER
// ============================================================

const MIME_MAP = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
};

export async function ingestFile(buffer, mime, meta = {}) {
  const m = (mime || '').toLowerCase();
  const fn = (meta.filename || '').toLowerCase();

  const detected = MIME_MAP[m]
    || (fn.endsWith('.pdf')  ? 'pdf'
    :   fn.endsWith('.docx') ? 'docx'
    :   fn.endsWith('.xlsx') ? 'xlsx'
    :   null);

  if (detected === 'pdf')  return { type: 'pdf',  ...(await ingestPdf(buffer, meta)) };
  if (detected === 'docx') return { type: 'docx', ...(await ingestDocx(buffer, meta)) };
  if (detected === 'xlsx') return { type: 'xlsx', ...(await ingestXlsx(buffer, meta)) };

  if (m.startsWith('image/')) {
    return { type: 'image', ...(await ingestImage(buffer, m || 'image/jpeg', meta)) };
  }

  return { ok: false, error: `MIME nao suportado: ${mime || '(desconhecido)'}` };
}
