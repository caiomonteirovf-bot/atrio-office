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
  const { scope_type, scope_id, extraMeta } = resolveScope(meta);

  const metadata_base = {
    source_type: 'document',
    document_type: docType,
    filename,
    pages,
    file_path: persisted?.relative || null,
    ingested_at: new Date().toISOString(),
    ...extraMeta,
    ...(meta.metadata || {}),
  };

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
               'document'::memory_source, $7, 'draft'::memory_status, $8, $9::jsonb,
               $10::vector, false)
       RETURNING id`,
      [
        scope_type, scope_id, meta.agent_id || null,
        chunkTitle, chunk, summary,
        filename, meta.tags || [], JSON.stringify(metadata),
        vec ? toVector(vec) : null,
      ]
    );
    memory_ids.push(rows[0].id);
  }

  return { ok: true, memory_ids, chunks: chunks.length, pages, preview: text.slice(0, 400), title };
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

export async function ingestPdf(buffer, meta = {}) {
  const persisted = await persistBuffer(buffer, meta.filename || 'documento.pdf');
  const { text, pages } = await extractPdfText(buffer);
  const result = await ingestDocumentFromText(text, pages, 'pdf', meta, persisted);
  // Passada adicional: classificar o PDF via LLM (doc_type + structured.cnpj etc)
  if (result.ok) {
    try {
      const classification = await classifyPdfText(text);
      if (classification) {
        result.doc_type = classification.doc_type || result.doc_type;
        result.structured = classification.structured || {};
        result.summary = classification.summary || result.preview;
      }
    } catch (e) { console.error('[ingestPdf] classify falhou:', e.message); }
  }
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
    ...extraMeta,
    ...(meta.metadata || {}),
  };

  let vec = null;
  try { vec = await embed(content); }
  catch (e) { console.error('[ingest-image] embedding falhou:', e.message); }

  const { rows } = await query(
    `INSERT INTO memories
       (scope_type, scope_id, agent_id, category, title, content, summary,
        source_type, source_ref, status, tags, metadata, structured_facts,
        embedding, is_rag_enabled, confidence_score)
     VALUES ($1::memory_scope, $2, $3, 'general'::memory_category, $4, $5, $6,
             'document'::memory_source, $7, 'draft'::memory_status, $8, $9::jsonb,
             $10::jsonb, $11::vector, false, $12)
     RETURNING id`,
    [
      scope_type, scope_id, meta.agent_id || null,
      title, content, analysis.summary || content.slice(0, 300),
      filename, meta.tags || [], JSON.stringify(metadata),
      JSON.stringify(analysis.structured || {}),
      vec ? toVector(vec) : null,
      analysis.confidence || 0.8,
    ]
  );

  return { ok: true, memory_id: rows[0].id, doc_type: analysis.doc_type, structured: analysis.structured,
           summary: analysis.summary, confidence: analysis.confidence };
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
