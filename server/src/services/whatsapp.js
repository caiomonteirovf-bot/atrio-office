import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import * as telegram from './telegram.js';
import { analyzeSentiment, analyzeConversation, registerNPS, classifyDemand } from './luna-analyzer.js';
import { addAnalysis } from './daily-report.js';
import { query } from '../db/pool.js';
import { findClientByPhone } from './gesthub.js';
import { detectTeamMember } from './team-member-guard.js';
import { createNotification } from './notifications.js';
import * as pushSvc from './push.js';
import { handleWhatsAppMessage } from './whatsapp/webhook-handler.mjs';
import { ingestFile } from './ingest.js';
import { logEvent } from './activity-log.js';
import { getAlertConfig, renderClientMessage, findConversationsToAutoResolve, markResolved } from './alert-config.js';

// ============================================
// ESTADO
// ============================================
let client = null;
let qrCodeData = null;
let isReady = false;
let broadcastFn = null;
let logChatFn = null;

export function setLogChat(fn) { logChatFn = fn; }
function chat(msg) { logChatFn?.(msg); }

const conversations = new Map();
let botIsSending = false; // Flag: true enquanto o bot está enviando mensagem

// ============================================
// PERSISTÊNCIA — PostgreSQL
// ============================================
async function dbSaveConversation(phone, conv) {
  try {
    const result = await query(`
      INSERT INTO whatsapp_conversations (phone, chat_id, client_name, real_phone, display_phone, escalation_level, human_replied, greeted, outside_hours, started_at, last_message_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (phone) DO UPDATE SET
        client_name = EXCLUDED.client_name,
        escalation_level = EXCLUDED.escalation_level,
        human_replied = EXCLUDED.human_replied,
        greeted = EXCLUDED.greeted,
        outside_hours = EXCLUDED.outside_hours,
        last_message_at = EXCLUDED.last_message_at
      RETURNING id
    `, [phone, conv.chatId, conv.name, conv.realPhone, conv.displayPhone, conv.escalationLevel, conv.humanReplied, conv.greeted, conv.outsideHours || false, conv.receivedAt, new Date().toISOString()]);
    conv.dbId = result.rows[0].id;
    return conv.dbId;
  } catch (err) {
    log(`DB ERRO saveConversation: ${err.message}`);
  }
}

async function dbUpdateConversation(phone, fields) {
  try {
    const sets = Object.entries(fields).map(([k, v], i) => `${k} = $${i + 2}`);
    const vals = Object.values(fields);
    await query(`UPDATE whatsapp_conversations SET ${sets.join(', ')} WHERE phone = $1 AND resolved = false`, [phone, ...vals]);
  } catch (err) {
    log(`DB ERRO updateConversation: ${err.message}`);
  }
}

/**
 * Salva midia do WhatsApp em storage local + retorna metadata {filename, mime_type, size, storage_path}.
 * Usado tanto em receive (client->equipe) como send (equipe->client) quando msg.hasMedia.
 *
 * Storage: /app/storage/whatsapp-attachments/<conv_id-or-phone>/<uuid>.<ext>
 * Retorna null se falhar.
 */
async function saveMsgAttachment(msg, convIdOrPhone) {
  try {
    if (!msg?.hasMedia) return null;
    const { default: fs } = await import('fs/promises');
    const { default: path } = await import('path');
    const { randomUUID } = await import('crypto');

    const media = await msg.downloadMedia();
    if (!media?.data) return null;

    const buf = Buffer.from(media.data, 'base64');
    if (buf.length === 0) return null;

    // Deriva extensao
    const mime = media.mimetype || 'application/octet-stream';
    const ext = mime.split(';')[0].split('/')[1]?.replace(/\W/g, '').slice(0, 10)
      || (media.filename?.match(/\.(\w+)$/)?.[1]) || 'bin';

    const STORAGE_BASE = process.env.WHATSAPP_ATTACH_DIR || '/app/storage/whatsapp-attachments';
    const dirName = String(convIdOrPhone || 'misc').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40);
    const dir = path.join(STORAGE_BASE, dirName);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});

    const uuid = randomUUID();
    const filePath = path.join(dir, `${uuid}.${ext}`);
    await fs.writeFile(filePath, buf);

    return {
      attachment: {
        filename: media.filename || msg.body || `arquivo.${ext}`,
        mime_type: mime,
        size_bytes: buf.length,
        storage_path: filePath,
        // URL relativa (endpoint servira pelo message_id)
        type: mime.startsWith('image/') ? 'image'
            : mime === 'application/pdf' ? 'pdf'
            : mime.startsWith('audio/') ? 'audio'
            : mime.startsWith('video/') ? 'video'
            : 'file',
      },
    };
  } catch (e) {
    console.error('[saveMsgAttachment] erro:', e.message);
    return null;
  }
}

async function dbSaveMessage(conv, sender, body, metadata = {}) {
  if (!conv.dbId) return;
  try {
    // Se caller nao passou wa_msg_id mas botSend acabou de rodar (sender=luna/bot),
    // usa o id do ultimo envio como hint.
    const mergedMeta = (sender === 'luna' || sender === 'bot')
      ? { wa_msg_id: _lastSentWaMsgId, ...metadata }
      : metadata;

    // DEDUPE: evita duplicatas quando whatsapp-web.js dispara message event 2x
    // (retry, ACK desorbitado ou LID-vs-c.us). Regra:
    //   1. Se tem wa_msg_id, busca mesmo wa_msg_id na conv → skip
    //   2. Senao, busca mesma body + sender nos ultimos 3 segundos → skip (burst window)
    const waMsgId = mergedMeta?.wa_msg_id || null;
    if (waMsgId) {
      const dup = await query(
        `SELECT id FROM whatsapp_messages
         WHERE conversation_id = $1 AND metadata->>'wa_msg_id' = $2
         LIMIT 1`,
        [conv.dbId, waMsgId]
      ).catch(() => ({ rows: [] }));
      if (dup.rows.length) {
        log(`[dedupe] msg wa_id=${waMsgId.slice(0, 30)} ja existe — skip`);
        return;
      }
    } else {
      // Fallback: dedupe por body+sender em 3s window
      const dup = await query(
        `SELECT id FROM whatsapp_messages
         WHERE conversation_id = $1 AND sender = $2 AND body = $3
           AND created_at > NOW() - INTERVAL '3 seconds'
         LIMIT 1`,
        [conv.dbId, sender, body]
      ).catch(() => ({ rows: [] }));
      if (dup.rows.length) {
        log(`[dedupe] msg ${sender} "${String(body).slice(0, 30)}" duplicada em 3s — skip`);
        return;
      }
    }

    await query(`INSERT INTO whatsapp_messages (conversation_id, sender, body, metadata) VALUES ($1, $2, $3, $4)`,
      [conv.dbId, sender, body, JSON.stringify(mergedMeta)]);
    await query(`UPDATE whatsapp_conversations SET last_message_at = NOW() WHERE id = $1`, [conv.dbId]);

    // Espelho em luna_v2.messages pro audit trail unificado (item 4, abr/2026)
    // Sem isso, detector de regressão e RAG só veem fração das conversas.
    // Best-effort: se falhar, não propaga (já gravamos no whatsapp_messages).
    try {
      let lunaConvId = null;
      if (conv.phone) {
        const ex = await query(`SELECT id FROM luna_v2.conversations WHERE phone = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [conv.phone]).catch(() => ({ rows: [] }));
        if (ex.rows[0]) {
          lunaConvId = ex.rows[0].id;
          await query(`UPDATE luna_v2.conversations SET last_message_at = NOW() WHERE id = $1`, [lunaConvId]).catch(() => {});
        } else {
          const ins = await query(`INSERT INTO luna_v2.conversations (phone, last_message_at) VALUES ($1, NOW()) RETURNING id`, [conv.phone]).catch(() => ({ rows: [] }));
          lunaConvId = ins.rows[0]?.id || null;
        }
      }
      if (lunaConvId) {
        const direction = sender === 'client' ? 'inbound' : 'outbound';
        const senderType = sender === 'client' ? 'user' : sender === 'team' ? 'human' : 'agent';
        const agentId = sender === 'luna' ? 'luna' : (sender === 'bot' ? 'luna' : null);
        await query(
          `INSERT INTO luna_v2.messages (conversation_id, direction, sender_type, agent_id, content)
           VALUES ($1, $2, $3, $4, $5)`,
          [lunaConvId, direction, senderType, agentId, body]
        );
      }
    } catch { /* audit não deve quebrar send */ }

    // Push notification pra owner quando cliente manda mensagem
    // (skip bot/luna/team outbound, skip groups)
    if (sender === 'client' && !conv.isGroup && pushSvc.isConfigured()) {
      try {
        const preview = String(body || '').slice(0, 120) || '[anexo]';
        const name = conv.name || conv.displayPhone || conv.phone || 'Cliente';
        pushSvc.sendPushToUser('caio', {
          title: name,
          body: preview,
          url: `/atendimento?c=${conv.dbId}`,
          tag: `conv-${conv.dbId}`, // msgs da mesma conv substituem a anterior
        }).catch(() => {});
      } catch { /* push nunca deve quebrar save */ }
    }
  } catch (err) {
    log(`DB ERRO saveMessage: ${err.message}`);
  }
}

async function dbResolveConversation(phone) {
  try {
    await query(`UPDATE whatsapp_conversations SET resolved = true, resolved_at = NOW(), closed_at = NOW() WHERE phone = $1 AND resolved = false`, [phone]);
  } catch (err) {
    log(`DB ERRO resolveConversation: ${err.message}`);
  }
}

async function dbLoadActiveConversations() {
  try {
    const { rows: convs } = await query(`SELECT * FROM whatsapp_conversations WHERE resolved = false ORDER BY started_at`);
    for (const row of convs) {
      const { rows: msgs } = await query(`SELECT sender, body, created_at FROM whatsapp_messages WHERE conversation_id = $1 ORDER BY created_at`, [row.id]);
      const conv = {
        dbId: row.id,
        name: row.client_name,
        chatId: row.chat_id,
        realPhone: row.real_phone,
        displayPhone: row.display_phone,
        messages: msgs.map(m => ({ body: m.body, from: m.sender, at: m.created_at.toISOString() })),
        receivedAt: row.started_at.toISOString(),
        escalationLevel: row.escalation_level,
        timers: [],
        greetingTimer: null,
        analysisTimer: null,
        humanReplied: row.human_replied,
        humanRepliedAt: row.human_replied_at?.toISOString(),
        resolved: false,
        greeted: row.greeted,
        outsideHours: row.outside_hours,
        analysis: row.analysis,
        classification: row.classification,
      };
      conversations.set(row.phone, conv);
    }
    if (convs.length > 0) log(`Restauradas ${convs.length} conversas ativas do banco`);
    return convs.length;
  } catch (err) {
    log(`DB ERRO loadActive: ${err.message}`);
    return 0;
  }
}

async function dbLogMetric(agentName, eventType, details = {}) {
  try {
    await query(`INSERT INTO agent_metrics (agent_name, event_type, details) VALUES ($1, $2, $3)`, [agentName, eventType, JSON.stringify(details)]);
  } catch (err) { /* silent */ }
}

// ============================================
// CONFIGURAÇÃO
// ============================================
const TIMEZONE = 'America/Recife';

const ESCALATION_LEVELS = [
  { minutes: 10, severity: 'normal', emoji: '🟡', label: 'Sem resposta — 10min' },
  { minutes: 30, severity: 'atencao', emoji: '🟠', label: 'Atenção — 30min sem retorno' },
  { minutes: 60, severity: 'critico', emoji: '🔴', label: 'CRÍTICO — 1h sem retorno' },
  { minutes: 120, severity: 'urgente', emoji: '🚨', label: 'URGENTE — 2h sem retorno' },
  { minutes: 360, severity: 'grave', emoji: '🚨', label: 'GRAVE — 6h sem retorno' },
  { minutes: 720, severity: 'grave', emoji: '🚨', label: 'GRAVE — 12h sem retorno' },
  { minutes: 1440, severity: 'grave', emoji: '🚨', label: 'GRAVE — 24h sem retorno' },
];

// Mensagens da Luna ao cliente por nível (null = não envia, só notifica equipe)
// Mensagens reescritas conforme SOUL.md — objetivas, sem "agradecemos paciência",
// sem "volume elevado", sem emojis, sem frases genéricas de call center.
const CLIENT_MESSAGES = {
  0: null,  // 10min: só alerta interno, nada pro cliente (escopo restrito — quem fala é humano)
  1: null,  // 30min: só alerta interno
  2: (name) => {
    // 1h sem retorno: única mensagem automática, objetiva
    const firstName = (name || '').split(' ')[0];
    const horario = isHorarioComercial();
    if (!horario.open) {
      return `${firstName}, registrei sua mensagem. Retomamos o atendimento às 08h do próximo dia útil.`;
    }
    return `${firstName}, sua mensagem foi recebida e está na fila. A equipe retorna em seguida.`;
  },
  3: null,  // 2h: só equipe
  4: null,  // 6h: só equipe
  5: null,  // 12h: só equipe
  6: null,  // 24h: só equipe
};

const NOTIFY_NUMBERS = ['5581997166091'];
const CONTACT_PHONE = '(81) 9971-66091';

// Grupo — desabilitado em fase de testes
const NOTIFY_GROUP_ENABLED = true;
const NOTIFY_GROUP_NAME = 'Luna_Atendimento';
let groupChatId = null;

// FERIADOS_FIXOS centralizado em services/feriados.js — usado via business-hours.js

const LUNA_HEADER = '';  // Removido: cliente não deve ver 'Luna assistente virtual' — Luna representa a Átrio diretamente (regra 19 do prompt mestre)
const GREETING_DELAY_MS = 30 * 1000; // 30 segundos
const URGENTE_KEYWORDS = ['urgente', 'urgência', 'urgencia', 'emergencia', 'emergência'];

// Detecção de solicitação de NFS-e
// Termos que sozinhos já indicam NFS-e
const NFSE_EXACT = ['nfs-e', 'nfse', 'nota fiscal', 'nota de serviço', 'nota de servico', 'nota de serviços', 'nota de servicos'];

// Siglas isoladas (match por word boundary)
const NFSE_SIGLAS = ['nf', 'nfs'];

// Variações de "nota" que o cliente pode usar
const NOTA_VARIANTS = ['nota', 'notas'];

// Verbos de ação que combinados com "nota" indicam emissão
const NFSE_VERBS = [
  'emitir', 'emite', 'emissão', 'emissao', 'gerar', 'gere',
  'fazer', 'faz', 'faça', 'faca', 'tirar', 'tira', 'tire',
  'enviar', 'envia', 'envie', 'mandar', 'manda', 'mande',
  'preciso', 'precisar', 'precisando', 'quero', 'queria',
  'solicitar', 'solicito', 'pedir', 'peço', 'peco',
  'cadê', 'cade', 'onde', 'minha', 'minhas',
];

function isNfseRequest(text) {
  const lower = (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const lowerOriginal = (text || '').toLowerCase();

  // Match exato (termos que sozinhos já indicam NFS-e)
  if (NFSE_EXACT.some(k => lowerOriginal.includes(k))) return true;

  // Siglas isoladas: "NF", "NFS" (word boundary para não pegar "informação", "conforto")
  if (NFSE_SIGLAS.some(s => new RegExp(`\\b${s}\\b`, 'i').test(lowerOriginal))) return true;

  // Match combinado: "nota" + verbo de ação (com até 5 palavras de distância)
  const hasNota = NOTA_VARIANTS.some(n => lowerOriginal.includes(n));
  if (!hasNota) return false;

  const hasVerb = NFSE_VERBS.some(v => lower.includes(v) || lowerOriginal.includes(v));
  return hasVerb;
}

// ============================================
// UTILS
// ============================================
function now() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}

function getGreeting() {
  const h = now().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

// isHorarioComercial agora centralizado em services/business-hours.js (que usa feriados.js)
import { isHorarioComercial as _isHorarioComercialCentralizada } from './business-hours.js';
function isHorarioComercial() {
  return _isHorarioComercialCentralizada();
}

// ============================================
// Buffer de inbound — agrupa mensagens do mesmo contato em 10s
// antes de enviar pra Luna (evita respostas duplicadas)
// ============================================
const __lunaInboundBuffer = new Map();
const LUNA_DEBOUNCE_MS = Number(process.env.LUNA_DEBOUNCE_MS || 1200);

async function __persistBuffer(phone, entry) {
  try {
    const flushAt = new Date(Date.now() + LUNA_DEBOUNCE_MS);
    await query(`
      INSERT INTO luna_v2.inbound_buffer (phone, msgs, latest_msg, client_info, conversation_info, flush_at)
      VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6)
      ON CONFLICT (phone) DO UPDATE SET
        msgs = EXCLUDED.msgs,
        latest_msg = EXCLUDED.latest_msg,
        client_info = EXCLUDED.client_info,
        conversation_info = EXCLUDED.conversation_info,
        flush_at = EXCLUDED.flush_at
    `, [phone, JSON.stringify(entry.msgs), JSON.stringify(entry.latestMsg || {}),
        JSON.stringify(entry.clientInfo || {}), JSON.stringify(entry.conversationInfo || {}), flushAt]);
  } catch (e) { console.error('[Buffer] persist erro:', e.message); }
}

function scheduleLunaProcess(phone, msg, clientInfo, conversationInfo, processFn) {
  const existing = __lunaInboundBuffer.get(phone);
  if (existing) {
    // Se está processando agora (Luna em flush), acumula em pendingMsgs
    // O flush vai re-scheduler ao final vendo essa fila.
    if (existing.processing) {
      existing.pendingMsgs = existing.pendingMsgs || [];
      existing.pendingMsgs.push(msg.body || '');
      existing.pendingLatestMsg = msg;
      existing.pendingClientInfo = clientInfo;
      existing.pendingConversationInfo = conversationInfo;
      log('[Buffer] msg de ' + phone + ' durante processing — acumulada (' + existing.pendingMsgs.length + ' pending)');
      return;
    }
    clearTimeout(existing.timer);
    existing.msgs.push(msg.body || '');
    existing.latestMsg = msg;
    existing.clientInfo = clientInfo;
    existing.conversationInfo = conversationInfo;
    existing.timer = setTimeout(() => __lunaFlush(phone, processFn), LUNA_DEBOUNCE_MS);
    __persistBuffer(phone, existing);
    log('[Buffer] +1 msg p/ ' + phone + ' (total: ' + existing.msgs.length + ') — timer resetado');
    return;
  }
  // Estratégia de debounce adaptativa:
  //   Saudação → flush rápido (user não digita mais após "oi")
  //   Texto pontuado → flush rápido (frase completa, auto-contida)
  //   Texto curto sem pontuação (< 40 chars) → debounce LONGO (user provavelmente está
  //     mandando DATA-POINTS em sequência: CNPJ, valor, nome — bato tudo em 1 flush)
  //   Texto longo sem pontuação → debounce normal (continuação de digitação)
  const body = (msg.body || '').trim();
  const isGreeting = /^(oi+|ola|olá|bom dia|boa tarde|boa noite|hey|hi|e ai|eai|opa)[.!?\s]*$/i.test(body);
  const hasPunct = /[.!?]$/.test(body);
  const isVeryShort = body.length < 20;  // CNPJ isolado (18-20 chars), "1 real" (6 chars), etc.
  const isShort = body.length < 40;
  const waitMs = isGreeting ? 300
               : hasPunct ? 700
               : isVeryShort ? 6000  // data-points (CNPJ, valor, nome) em burst — espera 6s
               : isShort ? 3500
               : LUNA_DEBOUNCE_MS;   // 1200ms default
  const entry = {
    msgs: [msg.body || ''],
    latestMsg: msg,
    clientInfo,
    conversationInfo,
    timer: setTimeout(() => __lunaFlush(phone, processFn), waitMs),
  };
  __lunaInboundBuffer.set(phone, entry);
  __persistBuffer(phone, entry);
  log('[Buffer] buffer iniciado p/ ' + phone + ' — aguarda ' + waitMs + 'ms' + (looksComplete ? ' (flush rapido)' : ''));
}

async function __lunaFlush(phone, processFn) {
  const entry = __lunaInboundBuffer.get(phone);
  if (!entry) return;
  if (entry.processing) {
    log('[Buffer] flush de ' + phone + ' ignorado — ja esta processando');
    return;
  }
  entry.processing = true;
  // Snapshot das mensagens que vão ser processadas agora
  const msgsSnapshot = [...entry.msgs];
  const msgSnapshot = entry.latestMsg;
  // Reseta as msgs do entry mas MANTÉM o entry no buffer (pra novas msgs caírem em pendingMsgs)
  entry.msgs = [];
  entry.pendingMsgs = [];  // fresh
  const combinedBody = msgsSnapshot.filter(Boolean).join('\n');
  const msg = msgSnapshot;
  const proxyMsg = new Proxy(msg, {
    get(t, k) { return k === 'body' ? combinedBody : t[k]; }
  });

  // REGRA: Se humano assumiu a conversa, Luna NAO responde.
  // Humano "dono" quando last_human_reply_at existe e nenhuma das condicoes de retomada bate:
  //  - cliente mandou mensagem e humano nao respondeu em > HANDOFF_REENGAGE_MIN minutos
  //  - OU a ultima resposta do humano foi muito curta/vaga (< 8 chars) E cliente voltou a escrever
  try {
    const HANDOFF_REENGAGE_MIN = Number(process.env.LUNA_REENGAGE_MIN || 30);
    const { rows } = await query(`
      SELECT c.last_human_reply_at, c.last_inbound_at, c.id,
             (SELECT content FROM luna_v2.messages m
                WHERE m.conversation_id = c.id AND m.direction='outbound'
                ORDER BY created_at DESC LIMIT 1) AS last_outbound_body
      FROM luna_v2.conversations c WHERE c.phone = $1
      ORDER BY c.last_message_at DESC LIMIT 1
    `, [phone]);
    const r = rows[0];
    if (r && r.last_human_reply_at) {
      const humanAt = new Date(r.last_human_reply_at).getTime();
      const inboundAt = r.last_inbound_at ? new Date(r.last_inbound_at).getTime() : 0;
      const minutesSinceHuman = (Date.now() - humanAt) / 60000;
      const lastOutShort = String(r.last_outbound_body || '').trim().length < 8;
      const humanOwns = humanAt > inboundAt - 1000; // humano respondeu depois (ou junto) do ultimo inbound

      // Se humano foi o ultimo a falar E resposta dele nao foi vaga E nao passou o limite — Luna fica quieta
      if (humanOwns && !lastOutShort && minutesSinceHuman < HANDOFF_REENGAGE_MIN) {
        log('[Handoff] ' + phone + ' — humano ativo (ultima resposta ha ' + Math.round(minutesSinceHuman) + 'min), Luna em pausa');
        return;
      }
      // Caso precise retomar: marca motivo e segue
      if (humanOwns && minutesSinceHuman >= HANDOFF_REENGAGE_MIN) {
        try {
          const existing = await query(
            `SELECT id FROM public.tasks
             WHERE status = 'pending'
               AND result->>'phone' = $1
               AND result->>'type' = 'handoff_inertia'
               AND created_at > NOW() - INTERVAL '6 hours'
             LIMIT 1`,
            [phone]
          );
          if (existing.rowCount === 0) {
            log('[Handoff] ' + phone + ' — humano inativo ha ' + Math.round(minutesSinceHuman) + 'min, alerta criado');
            await query(`INSERT INTO public.tasks (title, status, result, created_at)
                         VALUES ($1, 'pending', $2::jsonb, now())`,
              ['[ALERTA] Atendimento humano em inercia — ' + (cInfo?.name || phone),
               JSON.stringify({ type: 'handoff_inertia', conversation_id: r.id, phone, minutos_sem_resposta: Math.round(minutesSinceHuman) })]);
          } else {
            log('[Handoff] ' + phone + ' — alerta inercia ja aberto, skip');
          }
        } catch (_) {}
      }
      if (humanOwns && lastOutShort) {
        try {
          const existing = await query(
            `SELECT id FROM public.tasks
             WHERE status = 'pending'
               AND result->>'phone' = $1
               AND result->>'type' = 'handoff_vague'
               AND created_at > NOW() - INTERVAL '6 hours'
             LIMIT 1`,
            [phone]
          );
          if (existing.rowCount === 0) {
            log('[Handoff] ' + phone + ' — resposta humana vaga, alerta criado');
            await query(`INSERT INTO public.tasks (title, status, result, created_at)
                         VALUES ($1, 'pending', $2::jsonb, now())`,
              ['[ALERTA] Resposta humana vaga — ' + (cInfo?.name || phone),
               JSON.stringify({ type: 'handoff_vague', conversation_id: r.id, phone, ultima_resposta: r.last_outbound_body })]);
          } else {
            log('[Handoff] ' + phone + ' — alerta vaga ja aberto, skip');
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    console.error('[Handoff] check falhou:', e.message);
  }

  log('[Buffer] flush ' + phone + ' — ' + entry.msgs.length + ' msg(s) combinadas');
  // Deleta ANTES de processar — evita re-flush duplicado se servidor reiniciar no meio
  try { await query('DELETE FROM luna_v2.inbound_buffer WHERE phone = $1', [phone]); } catch (_) {}
  try { await processFn(proxyMsg, entry.clientInfo, entry.conversationInfo); }
  catch (e) { log('[Buffer] processFn erro: ' + e.message); }

  // CLEANUP MUTEX + processa pendingMsgs acumuladas durante o flush
  const liveEntry = __lunaInboundBuffer.get(phone);
  if (liveEntry) {
    liveEntry.processing = false;
    if (Array.isArray(liveEntry.pendingMsgs) && liveEntry.pendingMsgs.length > 0) {
      // Move pending → msgs e reagenda flush
      liveEntry.msgs = [...liveEntry.pendingMsgs];
      liveEntry.latestMsg = liveEntry.pendingLatestMsg || liveEntry.latestMsg;
      liveEntry.clientInfo = liveEntry.pendingClientInfo || liveEntry.clientInfo;
      liveEntry.conversationInfo = liveEntry.pendingConversationInfo || liveEntry.conversationInfo;
      liveEntry.pendingMsgs = [];
      log('[Buffer] re-flush de ' + phone + ' com ' + liveEntry.msgs.length + ' pending msgs agrupadas');
      clearTimeout(liveEntry.timer);
      liveEntry.timer = setTimeout(() => __lunaFlush(phone, processFn), 800);
    } else {
      // Nada pendente → remove o entry do buffer (libera memória)
      __lunaInboundBuffer.delete(phone);
    }
  }
}

// Rehidratacao de buffers persistidos apos restart
export async function rehydrateLunaBuffer(processFn) {
  try {
    const { rows } = await query('SELECT phone, msgs, latest_msg, client_info, conversation_info, flush_at FROM luna_v2.inbound_buffer');
    if (!rows.length) return;
    const now = Date.now();
    log('[Buffer] rehidratando ' + rows.length + ' buffer(s) do PG');
    for (const r of rows) {
      const entry = {
        msgs: r.msgs || [],
        latestMsg: r.latest_msg || {},
        clientInfo: r.client_info || {},
        conversationInfo: r.conversation_info || {},
        timer: null,
      };
      const remaining = new Date(r.flush_at).getTime() - now;
      if (remaining <= 0) {
        // flush imediato
        __lunaInboundBuffer.set(r.phone, entry);
        __lunaFlush(r.phone, processFn).catch(e => log('[Buffer] rehydrate flush erro: ' + e.message));
      } else {
        entry.timer = setTimeout(() => __lunaFlush(r.phone, processFn), remaining);
        __lunaInboundBuffer.set(r.phone, entry);
      }
    }
  } catch (e) { log('[Buffer] rehidratar erro: ' + e.message); }
}

function normalizePhone(from) {
  // Remove qualquer sufixo (@c.us, @lid, @s.whatsapp.net, etc)
  return from.replace(/@.*$/, '');
}

function isUrgent(text) {
  const lower = (text || '').toLowerCase();
  return URGENTE_KEYWORDS.some(k => lower.includes(k));
}

function formatPhone(num) {
  const digits = (num || '').replace(/\D/g, '');
  if (digits.length === 13) return `(${digits.slice(2,4)}) ${digits.slice(4,9)}-${digits.slice(9)}`;
  if (digits.length === 12) return `(${digits.slice(2,4)}) ${digits.slice(4,8)}-${digits.slice(8)}`;
  if (digits.length === 11) return `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`;
  return num;
}

// Ultimo msg.id enviado via botSend — usado pelos callers (Luna) pra gravar
// wa_msg_id no metadata da mensagem, permitindo exclusao posterior.
let _lastSentWaMsgId = null;
export function getLastSentWaMsgId() { return _lastSentWaMsgId; }

// ============================================================
// KILL-SWITCH: agentes IA NAO podem enviar mensagem pra cliente externo.
// Por default, qualquer destino @c.us (individual) e BLOQUEADO.
// Apenas @g.us (grupos internos da equipe) sao permitidos.
// Pra liberar (debug ou autorizacao explicita), defina AGENT_CLIENT_OUTBOUND=on no env.
// ============================================================
// Override em runtime — pode ser ligado/desligado pelo painel sem restart.
// Persistido em app_settings.agent_client_outbound = { enabled: bool }
let _agentOutboundOverride = null; // null = nao carregado ainda
async function getAgentOutboundOverride() {
  if (_agentOutboundOverride !== null) return _agentOutboundOverride;
  try {
    const { rows } = await query(
      "SELECT value FROM app_settings WHERE key = 'agent_client_outbound'"
    );
    _agentOutboundOverride = rows[0]?.value?.enabled === true;
  } catch { _agentOutboundOverride = false; }
  return _agentOutboundOverride;
}
export function setAgentOutboundOverride(enabled) {
  _agentOutboundOverride = !!enabled;
}

function isClientOutboundAllowed(chatId) {
  if (process.env.AGENT_CLIENT_OUTBOUND === 'on') return true;
  if (_agentOutboundOverride === true) return true;
  if (typeof chatId !== 'string') return false;
  // SOMENTE o grupo interno da equipe (Luna_Atendimento), NUNCA grupos de cliente.
  // groupChatId e cacheado por findGroupChat() na primeira chamada.
  if (!chatId.endsWith('@g.us')) return false;
  if (groupChatId && chatId === groupChatId) return true;
  return false;
}

async function botSend(chatId, text, opts = {}) {
  if (!client) throw new Error('WhatsApp não conectado');

  // NUNCA enviar para status/broadcast/stories
  if (!chatId || chatId === 'status@broadcast' || chatId.includes('@broadcast')) {
    log(`BLOQUEADO: tentativa de enviar para ${chatId}`);
    return null;
  }

  // KILL-SWITCH agente → cliente. opts.manual=true bypassa (humano enviando do painel).
  if (!opts.manual && !isClientOutboundAllowed(chatId)) {
    log(`KILL-SWITCH: agente bloqueado de enviar pra cliente ${chatId}`);
    // Audit no DB
    query(
      `INSERT INTO agent_outbound_blocks (chat_id, suggested_text, redirected_to_group)
       VALUES ($1, $2, TRUE)`,
      [chatId, String(text || '').slice(0, 1000)]
    ).catch(() => {});
    // Redireciona o que seria resposta automatica pra grupo interno
    redirectToTeamGroup(chatId, text, opts).catch(e => log(`[redirect] falha: ${e.message}`));
    return null;
  }

  botIsSending = true;
  try {
    const sent = await client.sendMessage(chatId, text);
    _lastSentWaMsgId = sent?.id?._serialized || sent?.id || null;
    // Espera o message_create processar antes de liberar
    await new Promise(r => setTimeout(r, 500));
    return sent;
  } finally {
    botIsSending = false;
  }
}

async function botSendMedia(chatId, base64Data, filename, mimetype, caption, opts = {}) {
  if (!client) throw new Error('WhatsApp não conectado');
  if (!chatId || chatId === 'status@broadcast' || chatId.includes('@broadcast')) {
    log(`BLOQUEADO: tentativa de enviar mídia para ${chatId}`);
    return null;
  }

  if (!opts.manual && !isClientOutboundAllowed(chatId)) {
    log(`KILL-SWITCH: agente bloqueado de enviar midia pra cliente ${chatId}`);
    return null;
  }

  botIsSending = true;
  try {
    const media = new MessageMedia(mimetype, base64Data, filename);
    const sent = await client.sendMessage(chatId, media, { caption });
    await new Promise(r => setTimeout(r, 500));
    return sent;
  } finally {
    botIsSending = false;
  }
}

function log(msg) {
  const time = now().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[WhatsApp ${time}] ${msg}`);
}

// ============================================
// API PÚBLICA
// ============================================
let onTaskCreatedFn = null;
export function setBroadcast(fn) { broadcastFn = fn; }
export function setOnTaskCreated(fn) { onTaskCreatedFn = fn; }

export function getStatus() {
  return {
    connected: isReady,
    hasQR: !!qrCodeData,
    phone: client?.info?.wid?.user || null,
    activeConversations: conversations.size,
  };
}

export function getQRCode() { return qrCodeData; }

export function getPendingMessages() {
  const list = [];
  conversations.forEach((conv, phone) => {
    if (!conv.resolved) {
      const level = ESCALATION_LEVELS[Math.max(conv.escalationLevel, 0)] || ESCALATION_LEVELS[0];
      list.push({
        phone, name: conv.name,
        lastMessage: conv.messages[conv.messages.length - 1]?.body || '',
        receivedAt: conv.receivedAt,
        severity: level.severity,
        label: level.label,
        humanReplied: conv.humanReplied,
      });
    }
  });
  return list.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
}

export async function markAsReplied(rawPhone) {
  const phone = normalizePhone(rawPhone);
  const conv = conversations.get(phone);
  if (conv && !conv.resolved) {
    conv.humanReplied = true;
    conv.humanRepliedAt = new Date().toISOString();
    dbUpdateConversation(phone, { human_replied: true, human_replied_at: conv.humanRepliedAt });
    dbLogMetric('Luna', 'human_replied', { phone, name: conv.name });
    log(`${conv.name} (${phone}) — humano respondeu`);
    // Cancela Luna first-touch — tenta phone principal E realPhone (WA Web manda pro realPhone)
    try {
      const ft = await import('./luna-first-touch.js');
      ft.cancelLunaFirstTouch(phone, log);
      if (conv?.realPhone && conv.realPhone !== phone) ft.cancelLunaFirstTouch(conv.realPhone, log);
      if (conv?.chatId && conv.chatId !== phone) ft.cancelLunaFirstTouch(conv.chatId, log);
    } catch {}
    // Auto-close: humano respondeu -> fecha alertas pending daquele phone
    try {
      const closed = await query(
        `UPDATE public.tasks
         SET status = 'done',
             completed_at = NOW(),
             result = COALESCE(result,'{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE status = 'pending'
           AND result->>'phone' = $1
           AND result->>'type' IN ('handoff_inertia','handoff_vague','administrativo','scope_defer')
         RETURNING id`,
        [phone, JSON.stringify({ closed_reason: 'humano respondeu', closed_at: new Date().toISOString() })]
      );
      if (closed.rowCount > 0) {
        log('[markAsReplied] ' + closed.rowCount + ' alerta(s) auto-fechado(s) pra ' + phone);
      }
    } catch (e) { log('[markAsReplied] auto-close falhou: ' + e.message); }
    return true;
  }
  return false;
}

export async function resolveConversation(rawPhone) {
  const phone = normalizePhone(rawPhone);
  // 1) Limpa estado em-memoria SE houver (so existe pra individuais ativas)
  const conv = conversations.get(phone);
  if (conv) {
    conv.timers.forEach(t => clearTimeout(t));
    conv.timers = [];
    if (conv.greetingTimer) clearTimeout(conv.greetingTimer);
    conv.resolved = true;
    dbLogMetric('Luna', 'conversation_resolved', { phone, name: conv.name, escalationLevel: conv.escalationLevel });
    log(`${conv.name} (${phone}) — conversa resolvida (in-memory + DB)`);
  }

  // 2) SEMPRE atualiza DB — funciona pra grupos, conversas inativas e qualquer caso
  // Match tolerante: phone, real_phone OU chat_id incluindo o numero
  try {
    const result = await query(
      `UPDATE whatsapp_conversations
          SET resolved = TRUE, resolved_at = NOW(), closed_at = NOW(),
              resolution_reason = COALESCE(resolution_reason, 'manual_painel')
        WHERE (regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
            OR regexp_replace(COALESCE(real_phone, ''), '\\D', '', 'g') = $1
            OR chat_id LIKE '%' || $1 || '%')
          AND resolved = FALSE
       RETURNING id, client_name, chat_id`,
      [phone]
    );
    if (result.rows.length === 0) {
      log(`[resolve] nenhuma conv encontrada/aberta pra ${phone}`);
      return { ok: false, error: 'Conversa nao encontrada ou ja resolvida' };
    }
    log(`[resolve] resolvidas ${result.rows.length} conv(s) pra ${phone}: ${result.rows.map(r => r.client_name).join(', ')}`);
    return { ok: true, count: result.rows.length, conversations: result.rows };
  } catch (e) {
    log(`[resolve] erro DB: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ============================================
// INICIALIZAÇÃO
// ============================================
export async function initialize() {
  if (client) return;
  log('Inicializando...');

  // Carrega override do kill-switch agente→cliente (DB > env)
  await getAgentOutboundOverride();
  log(`Kill-switch agente→cliente: ${_agentOutboundOverride ? 'DESATIVADO (envios liberados)' : 'ATIVO (apenas grupos)'}`);

  // Limpar lock files do Chromium que podem travar entre restarts
  const sessionDir = './whatsapp-session/session';
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(sessionDir, lockFile);
    try { fs.unlinkSync(lockPath); } catch {}
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
    },
  });

  client.on('qr', async (qr) => {
    log('QR Code gerado');
    qrCodeData = await qrcode.toDataURL(qr);
    broadcastFn?.({ type: 'whatsapp_qr', hasQR: true });
  });

  client.on('ready', async () => {
    log(`Conectado! ${client.info?.wid?.user}`);
    isReady = true;
    qrCodeData = null;
    broadcastFn?.({ type: 'whatsapp_ready', phone: client.info?.wid?.user });

    // Resolve o grupo interno da equipe (Luna_Atendimento) — necessario pro kill-switch
    // saber quem e o "grupo permitido" vs grupos de cliente.
    try {
      const internalGroup = await findGroupChat();
      log(`Grupo interno (${NOTIFY_GROUP_NAME}): ${internalGroup || 'NAO ENCONTRADO — todos grupos sao tratados como cliente'}`);
    } catch (e) { log(`findGroupChat erro: ${e.message}`); }

    // Rehydrate buffer persistido no PG (post-restart)
    try {
      await rehydrateLunaBuffer(async (aggMsg, cInfo, convInfo) => {
        await handleLunaV2(aggMsg, cInfo, convInfo);
      });
    } catch (e) { log('rehydrate buffer: ' + e.message); }

    // Restaura conversas ativas do banco e retoma fluxos pendentes
    const restored = await dbLoadActiveConversations();
    if (restored > 0) {
      conversations.forEach((conv, phone) => {
        if (conv.resolved) return;

        // Greeting pendente — envia agora
        if (!conv.greeted) {
          log(`Greeting pendente para ${conv.name} — enviando agora`);
          // sendGreeting legacy desativado — Luna LLM cuida de retomadas também
        }

        // Retoma escalation
        if (!conv.humanReplied) {
          const nextLevel = Math.max(conv.escalationLevel + 1, 0);
          const cappedLevel = Math.min(nextLevel, ESCALATION_LEVELS.length - 1);
          startEscalation(phone, conv.chatId, conv.name, cappedLevel);
          log(`Escalation retomada para ${conv.name} no nível ${cappedLevel}`);
        }
      });
    }
  });

  // Message ACK: atualiza status de entrega/leitura da msg.
  // whatsapp-web.js ack codes: 0=pending, 1=sent, 2=delivered, 3=read, 4=played (audio).
  // Armazena no metadata.ack pra UI mostrar ✓ (sent), ✓✓ (delivered), ✓✓ azul (read).
  client.on('message_ack', async (msg, ack) => {
    try {
      const waId = msg.id?._serialized || msg.id;
      if (!waId) return;
      const status = ack === 1 ? 'sent' : ack === 2 ? 'delivered' : ack === 3 ? 'read' : ack === 4 ? 'played' : null;
      if (!status) return;
      await query(
        `UPDATE whatsapp_messages
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('ack', $1, 'ack_status', $2)
         WHERE metadata->>'wa_msg_id' = $3`,
        [ack, status, waId]
      ).catch(() => {});
    } catch (e) { /* silencioso */ }
  });

  client.on('disconnected', (reason) => {
    log(`Desconectado: ${reason}`);
    isReady = false;
    broadcastFn?.({ type: 'whatsapp_disconnected' });

    // Notification: WhatsApp desconectado
    createNotification({
      type: 'erro_servico',
      title: 'WhatsApp desconectado',
      message: `WhatsApp desconectou: ${reason || 'motivo desconhecido'}`,
      severity: 'error',
      metadata: { service: 'whatsapp', reason },
    }).catch(() => {});
  });

  // Humano respondeu (via WhatsApp Web, celular)
  // IGNORA mensagens enviadas pelo próprio bot (Luna)
  const botMessages = new Set(); // IDs de mensagens que o bot enviou

  client.on('message_create', async (msg) => {
    if (!msg.fromMe || !msg.to) return;
    if (msg.to === 'status@broadcast' || msg.to.includes('@broadcast')) return;

    // Se é mensagem que o bot enviou, ignora
    if (botIsSending) return;

    // === GRUPOS: persiste outbound separado ===
    // Conversa individual segue abaixo com toda logica Luna. Grupo e mais simples:
    // upsert conv (is_group=true) + insert msg com sender='team'.
    const isGroupOut = String(msg.to).endsWith('@g.us');
    if (isGroupOut) {
      try {
        const phone = normalizePhone(msg.to);
        const chat = await msg.getChat().catch(() => null);
        const groupName = chat?.name || 'Grupo WhatsApp';
        await query(
          `INSERT INTO whatsapp_conversations (phone, chat_id, client_name, is_group, started_at, last_message_at)
           VALUES ($1, $2, $3, true, NOW(), NOW())
           ON CONFLICT (phone) DO UPDATE SET
             client_name = COALESCE(whatsapp_conversations.client_name, EXCLUDED.client_name),
             is_group = true,
             last_message_at = NOW()`,
          [phone, msg.to, groupName]
        ).catch(e => log('[group-out] upsert falhou: ' + e.message));
        const { rows } = await query(
          `SELECT id FROM whatsapp_conversations WHERE phone = $1 LIMIT 1`, [phone]
        ).catch(() => ({ rows: [] }));
        const convId = rows[0]?.id;
        if (convId) {
          const waId = msg.id?._serialized || msg.id || null;
          // Dedupe por wa_msg_id
          const dup = waId ? await query(
            `SELECT id FROM whatsapp_messages WHERE conversation_id = $1 AND metadata->>'wa_msg_id' = $2 LIMIT 1`,
            [convId, waId]
          ).catch(() => ({ rows: [] })) : { rows: [] };
          if (!dup.rows.length) {
            // Salva anexo se houver
            const attachMeta = msg.hasMedia ? await saveMsgAttachment(msg, convId) : null;
            await query(
              `INSERT INTO whatsapp_messages (conversation_id, sender, body, metadata)
               VALUES ($1, 'team', $2, $3)`,
              [convId, msg.body || '', JSON.stringify({
                is_group: true,
                group_name: groupName,
                wa_msg_id: waId,
                chat_id: msg.to,
                ...(attachMeta || {}),
              })]
            ).catch(e => log('[group-out] insert msg falhou: ' + e.message));
          }
        }
        broadcastFn?.({ type: 'conversation_updated', phone, isGroup: true });
        log(`[group-out] ${groupName}: ${(msg.body || '').slice(0, 60)}`);
      } catch (e) {
        log('[group-out] erro: ' + e.message);
      }
      return; // NAO prossegue no fluxo de individual
    }

    const phone = normalizePhone(msg.to);
    // Busca conv comparando contra TODOS os identificadores conhecidos.
    // WhatsApp manda msg.to em formatos diferentes dependendo do device que respondeu:
    //  - celular BR: 5511981030038@c.us  -> phone = 5511981030038
    //  - WA Web/LID: 126053079081028@lid -> phone = 126053079081028
    // Se a Map foi criada com uma chave e o humano respondeu via outro device,
    // o get direto falha. Precisa bater contra phone | chatId | realPhone | displayPhone.
    const _digits = (s) => String(s || '').replace(/\D/g, '');
    const phoneDigits = _digits(phone);
    let conv = conversations.get(phone);
    if (!conv) {
      for (const [k, c] of conversations) {
        const candidates = [c.phone, c.chatId, c.realPhone, c.displayPhone, k]
          .map(v => normalizePhone(String(v || '')))
          .filter(Boolean);
        const digitSet = new Set(candidates.map(_digits).filter(d => d.length >= 10));
        if (candidates.includes(phone) || digitSet.has(phoneDigits)) {
          conv = c;
          break;
        }
      }
    }

    // FIX (abr/2026+): quando conv nao esta em memoria (bot reiniciou, device
    // diferente, LID vs c.us), persistir a intervencao humana em AMBAS as tabelas:
    //   - luna_v2 (historico)
    //   - whatsapp_conversations (o que a UI le atraves de getPendingMessages
    //     — sem este UPDATE, a conv aparece eternamente como "aguardando")
    if (!conv) {
      try {
        // 1) grava em luna_v2 (historico)
        let lunaConvId = null;
        const ex = await query(
          `SELECT id FROM luna_v2.conversations WHERE phone = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
          [phone]
        ).catch(() => ({ rows: [] }));
        if (ex.rows[0]) {
          lunaConvId = ex.rows[0].id;
        } else {
          const ins = await query(
            `INSERT INTO luna_v2.conversations (phone, attendance_status, last_message_at, last_outbound_at, last_human_reply_at)
             VALUES ($1, 'open', NOW(), NOW(), NOW()) RETURNING id`,
            [phone]
          ).catch(() => ({ rows: [] }));
          lunaConvId = ins.rows[0]?.id || null;
        }
        if (lunaConvId) {
          await query(
            `INSERT INTO luna_v2.messages (conversation_id, direction, sender_type, content)
             VALUES ($1, 'outbound', 'human', $2)`,
            [lunaConvId, msg.body]
          ).catch(() => {});
          await query(
            `UPDATE luna_v2.conversations SET last_human_reply_at = NOW(), last_outbound_at = NOW(), last_message_at = NOW() WHERE id = $1`,
            [lunaConvId]
          ).catch(() => {});
        }

        // 2) marca whatsapp_conversations como respondida — match por qualquer identificador.
        //    Busca por phone, real_phone, chat_id (aceita prefixo) ou display_phone (digits).
        const upd = await query(
          `UPDATE whatsapp_conversations
           SET human_replied = true,
               human_replied_at = COALESCE(human_replied_at, NOW()),
               last_human_reply_at = NOW(),
               last_message_at = NOW()
           WHERE phone = $1
              OR real_phone = $1
              OR chat_id LIKE $1 || '@%'
              OR regexp_replace(COALESCE(display_phone,''), '\\D', '', 'g') = $1
              OR regexp_replace(COALESCE(real_phone,''),    '\\D', '', 'g') = $1
           RETURNING id, client_name`,
          [phone]
        ).catch(e => { log('fallback wc update: ' + e.message); return { rowCount: 0 }; });

        if (upd.rowCount > 0) {
          log(`[fallback] Humano respondeu pra ${phone} — ${upd.rowCount} conv(s) marcadas como respondidas no banco`);
        } else {
          log(`[fallback] Humano respondeu pra ${phone} — sem conv no banco tambem (so luna_v2)`);
        }
      } catch (e) { log('fallback humano sem conv: ' + e.message); }
      return;
    }
    if (conv.resolved) return;

    conv.messages.push({ body: msg.body, from: 'team', at: new Date().toISOString() });
    // Persiste o ID do WhatsApp (wa_msg_id) + anexo (se houver) em metadata.
    const attachOutMeta = msg.hasMedia ? await saveMsgAttachment(msg, conv.dbId || conv.phone) : null;
    dbSaveMessage(conv, 'team', msg.body, {
      wa_msg_id: msg.id?._serialized || msg.id || null,
      chat_id: msg.to,
      ...(attachOutMeta || {}),
    });
    markAsReplied(msg.to);
    // Watchdog hook: humano respondeu — marca luna_v2.conversations
    try {
      const _ph = normalizePhone(msg.to);
      await query(`UPDATE luna_v2.conversations SET last_human_reply_at = NOW(), last_outbound_at = NOW() WHERE phone = $1`, [_ph]);
    } catch (e) { log('watchdog hook human reply: ' + e.message); }
    log(`Humano respondeu para ${conv.name}`);

    // Agenda análise 2min depois
    if (conv.analysisTimer) clearTimeout(conv.analysisTimer);
    conv.analysisTimer = setTimeout(() => analyzeAndReport(phone), 2 * 60 * 1000);
  });

  // Mensagem recebida de cliente
  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    // Grupos: deixa entrar pro Atendimento MAS Luna nao responde (guard em handleIncoming).
    // Antes ignorava totalmente (@g.us). Agora surge no painel read-mostly + send manual.
    if (msg.from === 'status@broadcast') return; // ignora status/stories

    // Ignora reações (reactions) — não são mensagens reais
    if (msg.type === 'reaction' || msg.type === 'reaction_sent') return;

    // Ignora stickers e locations sem texto.
    // MAS: se tem mídia (PDF/imagem), deixa passar mesmo sem body — auto-ingest vai capturar
    if (msg.type === 'sticker') return;
    if (!msg.body?.trim() && !msg.hasMedia) return;

    // Detecta URL Gestta no corpo (gestta.com.br/.../download) — auto-baixa o doc fiscal
    try {
      const ingestModule = await import('./ingest.js');
      const gesttaUrl = ingestModule.extractGesttaUrl?.(msg.body);
      if (gesttaUrl && !msg.hasMedia) {
        log(`[GesttaURL] detectada em msg: ${gesttaUrl.slice(0, 80)}...`);
        const fetched = await ingestModule.fetchGesttaDoc(gesttaUrl);
        if (fetched.ok) {
          log(`[GesttaURL] baixado ${fetched.filename} (${fetched.buffer.length} bytes)`);
          // Reusa o pipeline de auto-ingest passando o buffer baixado
          // Cria um pseudo-msg pra reutilizar handleAutoIngest
          const pseudoMsg = { ...msg, body: msg.body, _gesttaBuffer: fetched.buffer, _gesttaFilename: fetched.filename, _gesttaMime: fetched.mime };
          // Chama handleIncoming normal — o auto-ingest abaixo vai usar o buffer Gestta no lugar de baixar mídia
          await handleIncoming(pseudoMsg);
          return;
        } else {
          log(`[GesttaURL] falha download: ${fetched.error}`);
        }
      }
    } catch (e) {
      log(`[GesttaURL] erro: ${e.message}`);
    }

    try {
      await handleIncoming(msg);
    } catch (err) {
      log(`ERRO handleIncoming: ${err.message}`);
    }
  });

  try { await client.initialize(); }
  catch (err) { log(`Erro inicialização: ${err.message}`); }
}

// ============================================
// MENSAGEM RECEBIDA
// ============================================

// =========================================
// LUNA V2 - Wrapper para OpenClaw
// =========================================

// ============================================
// ALERTA DELAYED — aguarda 60s apos ultima msg, agrupa contexto rico
// ============================================
const __pendingGroupAlerts = new Map();
const GROUP_ALERT_DELAY_MS = Number(process.env.GROUP_ALERT_DELAY_MS || 60_000);

function scheduleDelayedGroupAlert(ctx) {
  const { phone, realPhone, name, body, clientInfo, contact } = ctx;
  const existing = __pendingGroupAlerts.get(phone);
  if (existing) {
    clearTimeout(existing.timer);
    existing.msgs.push(body || '');
    existing.latestBody = body;
    existing.clientInfo = clientInfo || existing.clientInfo;
    existing.contact = contact || existing.contact;
    existing.timer = setTimeout(() => __fireGroupAlert(phone), GROUP_ALERT_DELAY_MS);
    log('[AlertGrupo] +1 msg acumulada p/ ' + phone + ' (timer resetado, aguarda ' + GROUP_ALERT_DELAY_MS/1000 + 's apos ultima msg)');
    return;
  }
  const entry = {
    msgs: [body || ''],
    latestBody: body,
    name, realPhone, phone, clientInfo, contact,
    timer: setTimeout(() => __fireGroupAlert(phone), GROUP_ALERT_DELAY_MS),
  };
  __pendingGroupAlerts.set(phone, entry);
  log('[AlertGrupo] agendado p/ ' + phone + ' em ' + GROUP_ALERT_DELAY_MS/1000 + 's (aguardando contexto)');
}

async function __fireGroupAlert(phone) {
  const entry = __pendingGroupAlerts.get(phone);
  if (!entry) return;
  __pendingGroupAlerts.delete(phone);
  try {
    const { realPhone, name, clientInfo, contact, msgs } = entry;
    const phoneKey = realPhone || phone;
    const last8 = String(phoneKey || '').replace(/\D/g, '').slice(-8);
    const { rows: convRows } = await query(
      "SELECT id, last_alert_at, classificacao, contexto, "
      + "EXTRACT(EPOCH FROM (NOW() - COALESCE(last_alert_at, NOW() - INTERVAL '10 years')))/3600 AS h_since_alert "
      + "FROM luna_v2.conversations "
      + "WHERE phone = $1 OR phone = $2 "
      + "OR (length($3) = 8 AND phone LIKE '%' || $3) "
      + "ORDER BY last_message_at DESC LIMIT 1",
      [phoneKey, phone, last8]
    );
    const conv = convRows[0];
    const hSince = conv?.last_alert_at ? parseFloat(conv.h_since_alert) : 99999;
    const isFirstContact = !conv?.last_alert_at;
    const isComeback = !isFirstContact && hSince >= 4;
    if (!isFirstContact && !isComeback) {
      log('[AlertGrupo] ' + phone + ' — dedup ativo (' + hSince.toFixed(1) + 'h), cancelando');
      return;
    }
    let ultimasMsgs = [];
    if (conv?.id) {
      try {
        const { rows: mrows } = await query(
          "SELECT direction, content, created_at FROM luna_v2.messages "
          + "WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 8",
          [conv.id]
        );
        ultimasMsgs = mrows.reverse();
      } catch {}
    }
    const isColaborador = clientInfo?.isColaborador === true;
    const isLead = !isColaborador && !clientInfo?.id && !clientInfo?.gesthub_id;
    const nomeCliente = isColaborador
      ? (clientInfo?.name || 'Colaborador interno')
      : (clientInfo?.razao_social || clientInfo?.legalName
        || clientInfo?.nome_fantasia || clientInfo?.trade_name
        || clientInfo?.name || name || contact?.pushname || 'Sem nome cadastrado');
    const cnpjLinha = clientInfo?.cnpj ? ('\nCNPJ: ' + clientInfo.cnpj) : '';
    const statusLinha = isColaborador
      ? ('\n🟢 *TIME INTERNO* — colaborador Átrio' + (clientInfo?.areas?.length ? ' (' + clientInfo.areas.join(', ') + ')' : ''))
      : (isLead
        ? '\n🟡 *LEAD NOVO* — nao cadastrado no Gesthub'
        : (clientInfo?.regime ? '\nRegime: ' + clientInfo.regime : ''));
    const contatoNome = clientInfo?.contato?.nome;
    const contatoFuncao = clientInfo?.contato?.funcao;
    const contatoLinha = contatoNome
      ? ('Contato: *' + contatoNome + '*' + (contatoFuncao ? ' (' + contatoFuncao + ')' : ''))
      : (name && name !== nomeCliente ? 'Contato: *' + name + '*' : null);
    const displayPhone = formatPhone(realPhone || phone);
    const horarioInfo = isHorarioComercial();
    const horarioTag = horarioInfo.open ? '' : ('\n⏰ _Fora do horario (' + horarioInfo.reason + ')_');
    const classif = conv?.classificacao;
    const classifLinha = classif ? ('\nClassificacao: *' + String(classif).toUpperCase() + '*') : '';
    // === INTENT SEMÂNTICO (demanda) ===
    // 1) Task recente vinculada (rotear_para_rodrigo criou) tem título descritivo
    // 2) Classificacao salva na conv
    // 3) Fallback: regex na 1ª msg inbound
    const msgsInbound = ultimasMsgs
      .filter(m => m.direction === 'inbound')
      .map(m => String(m.content || '')
        .replace(/---CONTEXTO---[\s\S]*?---FIM CONTEXTO---\s*/g, '')
        .replace(/^(⏰|🌙|🚫|⚠️|📅).*?(\n|$)/gm, '')
        .trim()
      )
      .filter(Boolean);

    let demandaIntent = null;
    // Passo 1: task recente criada pela Luna pra esse telefone
    try {
      const { rows: taskRows } = await query(
        "SELECT title, result FROM public.tasks "
        + "WHERE (result->>'phone' = $1 OR result->>'phone' = $2 "
        + "OR result->>'conversation_id' = $3) "
        + "AND created_at > NOW() - INTERVAL '10 minutes' "
        + "ORDER BY created_at DESC LIMIT 1",
        [phoneKey, phone, conv?.id || '']
      );
      if (taskRows[0]) {
        const t = String(taskRows[0].title || '').replace(/^\[[^\]]+\]\s*/, '').trim();
        // Pega só a parte antes dos ':' ou virgula (intent, não dados)
        const shortIntent = t.split(/[:,]/)[0].trim();
        if (shortIntent.length > 5 && shortIntent.length < 80) demandaIntent = shortIntent;
      }
    } catch {}

    // Passo 2: classificacao salva na conv
    if (!demandaIntent && conv?.classificacao) {
      demandaIntent = String(conv.classificacao).charAt(0).toUpperCase() + String(conv.classificacao).slice(1);
    }

    // Passo 3: intent detection em TODAS as msgs inbound (não só a primeira)
    // Prioridade: intent específico (NFS-e, IR, etc) > saudação genérica.
    // Analisa o texto combinado de TODAS as msgs + metadados da conversa.
    if (!demandaIntent && msgsInbound.length > 0) {
      const blob = msgsInbound.join(' ').toLowerCase();
      // Ordem de prioridade — mais específico primeiro
      if (/emitir\s+(nota|nfs|nfe|nf)|emiss[aã]o\s+de\s+(nota|nf)|quero\s+(uma\s+)?(nota|nfs)/.test(blob))
        demandaIntent = 'Emissão de NFS-e';
      else if (/imposto\s+de\s+renda|declara[çc][aã]o\s+(de\s+)?ir|irpf/.test(blob))
        demandaIntent = 'Imposto de Renda';
      else if (/n[aã]o\s+receb(i|emos)|imposto.*(n[aã]o|falta|atrasad)|das.*(n[aã]o|falta)/.test(blob))
        demandaIntent = 'Dúvida sobre imposto / recebimento';
      else if (/abertura|abrir\s+empresa|cnpj\s+novo|constitui[çc][aã]o/.test(blob))
        demandaIntent = 'Abertura de empresa';
      else if (/contrato.*(altera|mudanç)|altera[çc][aã]o\s+contratual|mudança\s+de\s+cnae|alterar\s+(s[oó]cio|endereço)/.test(blob))
        demandaIntent = 'Alteração contratual';
      else if (/folha|pr[oó]-labore|sal[aá]rio|funcion[aá]rio|admiss[aã]o|demiss[aã]o/.test(blob))
        demandaIntent = 'Folha de pagamento';
      else if (/boleto|cobran[çc]a|pagamento\s+(de|da)|honor[aá]rio/.test(blob))
        demandaIntent = 'Financeiro / cobrança';
      else if (/conciliac|extrato|bancari/.test(blob))
        demandaIntent = 'Conciliação bancária';
      // Saudação só cai aqui se for a ÚNICA coisa dita
      else if (msgsInbound.length === 1 && /^(oi+|ola|olá|bom\s+dia|boa\s+(tarde|noite)|hey|hi|opa|tudo\s+bem)[\s.!?]*$/.test(msgsInbound[0].toLowerCase()))
        demandaIntent = 'Contato inicial (ainda sem pedido claro)';
      else
        // Usa a msg mais substantiva (não saudação) ou a primeira
        demandaIntent = (msgsInbound.find(m => m.length > 15 && !/^(oi+|ola|olá|bom\s+dia)/i.test(m)) || msgsInbound[0]).substring(0, 80) + '…';
    }
    if (!demandaIntent) demandaIntent = 'A apurar';

    // Dados coletados: concatena as msgs seguintes à primeira (respostas do cliente aos pedidos de Luna)
    let dadosColetados = '';
    if (msgsInbound.length > 1) {
      dadosColetados = msgsInbound.slice(1).join(' | ');
      if (dadosColetados.length > 200) {
        const cut = dadosColetados.substring(0, 200);
        const lastSpace = cut.lastIndexOf(' ');
        dadosColetados = (lastSpace > 160 ? cut.substring(0, lastSpace) : cut) + '…';
      }
    }
    const ultimaRespostaLuna = ultimasMsgs.filter(m => m.direction === 'outbound').slice(-1)[0]?.content || '';
    const tag = isFirstContact ? '📩 *Novo contato*' : '🔁 *Retomada apos inatividade*';
    const alertMsg = [
      tag,
      '',
      'Cliente: *' + nomeCliente + '*' + cnpjLinha + statusLinha,
      ...(contatoLinha ? [contatoLinha] : []),
      'Telefone: ' + displayPhone,
      '',
      'Demanda: *' + demandaIntent + '*' + horarioTag,
      ...(dadosColetados ? ['Dados coletados: _' + dadosColetados + '_'] : []),
      ...(ultimaRespostaLuna ? ['', 'Luna já respondeu: _' + ultimaRespostaLuna.substring(0, 200) + '_'] : []),
      '',
      isLead ? '_Luna em triagem. Equipe: avaliar oportunidade._' : '_Luna conduzindo. Intervir apenas se necessário._',
    ].join('\n');
    await notifyTeamWhatsApp(alertMsg);
    if (conv?.id) {
      await query('UPDATE luna_v2.conversations SET last_alert_at = NOW() WHERE id = $1', [conv.id]).catch(() => {});
    }
    log('[AlertGrupo] ' + (isFirstContact ? 'novo' : 'retomada') + ' (delayed): ' + nomeCliente + ' — classif=' + (classif || 'sem-classif'));
  } catch (e) {
    log('[AlertGrupo] erro ao disparar: ' + e.message);
  }
}

async function handleLunaV2(msg, clientInfo, conversationInfo) {
  try {
    const result = await handleWhatsAppMessage(msg, clientInfo, conversationInfo);
    let replyText = '';

    switch (result.action) {
      case 'send_message':
        replyText = result.content;
        await botSend(msg.from, result.content);
        break;

      case 'delegate':
        if (result.ack) {
          await botSend(msg.from, result.ack);
        }
        // Chamar endpoint de delegacao
        try {
          const resp = await fetch('http://localhost:3010/api/luna/delegate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent_target: result.agent,
              task_type: result.task,
              conversation_id: conversationInfo.id,
              client_id: clientInfo.id,
              payload: result.payload
            })
          });
          const data = await resp.json();
          log(`[Luna v2] Task delegada: ${data.task_id} -> ${result.agent}`);
        } catch (err) {
          log(`[Luna v2] Erro ao delegar: ${err.message}`);
        }
        break;

      case 'coletar_dados':
        replyText = result.pergunta;
        await botSend(msg.from, result.pergunta);
        break;

      case 'escalate':
        log(`[Luna v2] Escalando para humano: ${result.reason}`);
        return { handled: false };

      case 'defer':
        log(`[Luna v2] Deferido 5min: ${result.reason}`);
        return { handled: true, deferred: true };

      case 'error':
        if (result.fallback) {
          return { handled: false };
        }
        replyText = result.message || 'Desculpe, tive um problema.';
        await botSend(msg.from, replyText);
        break;

      default:
        return { handled: false };
    }

    return { handled: true, reply: replyText, action: result.action };

  } catch (error) {
    console.error('[Luna v2] Erro:', error.message);
    return { handled: false };
  }
}

// Helper: busca info do cliente pelo telefone
async function upsertLunaClient(g) {
  // Espelha empresa do Gesthub em luna_v2.clients (chave: CNPJ). Retorna uuid local.
  if (!g) return null;
  const rawCnpj = g.document || g.cnpj || null;
  const cnpj = rawCnpj ? String(rawCnpj).replace(/\D/g, '') : null;
  // Gesthub real usa inglês: legalName, tradeName, taxRegime.
  const nomeLegal = g.legalName || g.razaoSocial || g.razao_social
                 || g.tradeName || g.nomeFantasia || g.nome_fantasia
                 || g.name || 'Cliente';
  const nomeFantasia = g.tradeName || g.nomeFantasia || g.nome_fantasia || null;
  const regime = g.taxRegime || g.regime || g.regimeTributario || g.regime_tributario || null;
  try {
    if (cnpj) {
      // Formato esperado 14 digitos ou XX.XXX.XXX/XXXX-XX; a coluna aceita varchar(18)
      const formatted = cnpj.length === 14
        ? `${cnpj.slice(0,2)}.${cnpj.slice(2,5)}.${cnpj.slice(5,8)}/${cnpj.slice(8,12)}-${cnpj.slice(12,14)}`
        : cnpj;
      const { rows } = await query(
        `INSERT INTO luna_v2.clients (cnpj, nome_legal, nome_fantasia, regime_tributario, sync_gesthub_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (cnpj) DO UPDATE
           SET nome_legal = EXCLUDED.nome_legal,
               nome_fantasia = COALESCE(EXCLUDED.nome_fantasia, luna_v2.clients.nome_fantasia),
               regime_tributario = COALESCE(EXCLUDED.regime_tributario, luna_v2.clients.regime_tributario),
               sync_gesthub_at = NOW()
         RETURNING id`,
        [formatted, nomeLegal, nomeFantasia, regime]
      );
      return rows[0]?.id || null;
    }
    // Sem CNPJ: tenta upsert pelo par (nome_legal, gesthub_id NULL) — menos confiavel, so para nao perder o cliente
    const { rows } = await query(
      `INSERT INTO luna_v2.clients (nome_legal, nome_fantasia, regime_tributario, sync_gesthub_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [nomeLegal, nomeFantasia, regime]
    );
    return rows[0]?.id || null;
  } catch (err) {
    log(`[Luna v2] upsertLunaClient erro: ${err.message}`);
    return null;
  }
}

async function getClientInfo(phone) {
  // 0) Colaborador interno — se o phone bate com algum colaborador Atrio,
  // trata como comunicacao interna (nao e LEAD NOVO)
  try {
    const team = await detectTeamMember(phone);
    if (team && team.nome) {
      return {
        isColaborador: true,
        name: team.nome,
        colaborador_nome: team.nome,
        areas: team.areas || [],
        source: 'colaborador',
      };
    }
  } catch (err) {
    log(`[Luna v2] detectTeamMember falhou: ${err.message}`);
  }
  // 1) Gesthub e o master: procura empresa cujo CONTATO da carteira tem esse numero
  try {
    const g = await findClientByPhone(phone);
    if (g) {
      const lunaUuid = await upsertLunaClient(g);
      // Gesthub usa inglês camelCase: legalName / tradeName / document / taxRegime / city / state.
      // Aceitamos pt snake/camel como fallback pra compatibilidade.
      const razaoSocial  = g.legalName || g.razaoSocial || g.razao_social || null;
      const nomeFantasia = g.tradeName || g.nomeFantasia || g.nome_fantasia || null;
      const cnpj         = g.document || g.cnpj || null;
      const regime       = g.taxRegime || g.regime || g.regimeTributario || g.regime_tributario || null;
      const municipio    = g.city || g.municipio || g.cidade || null;
      const tipoCliente  = g.type || g.tipo || null;  // ex: 'MEDICINA', 'ODONTO', 'GERAL' — usado pra decidir Dr./Drª
      return {
        id: lunaUuid,
        gesthub_id: g.id || null,
        name: razaoSocial || nomeFantasia || g.name || 'Cliente',
        trade_name: nomeFantasia,
        nome_fantasia: nomeFantasia,
        razao_social: razaoSocial,
        legalName: razaoSocial,          // espelho pro frontend que usa camelCase
        tradeName: nomeFantasia,
        cnpj,
        regime,
        municipio,
        tipo: tipoCliente,
        phone: g.phone || null,
        contato: g._contato || null,
        source: 'gesthub',
      };
    }
  } catch (err) {
    log(`[Luna v2] Gesthub findClientByPhone falhou: ${err.message}`);
  }
  // 2) Fallback: tabela local
  try {
    const result = await query(
      'SELECT id, name, trade_name, phone FROM clients WHERE phone = $1',
      [phone]
    );
    if (result.rows[0]) return { ...result.rows[0], source: 'local' };
  } catch (err) {
    log(`[Luna v2] Erro getClientInfo local: ${err.message}`);
  }
  return { id: null, name: null, trade_name: null, phone: null, source: 'unknown' };
}

// Helper: busca/cria conversa Luna v2
async function getConversationInfo(chatId, clientInfo) {
  try {
    const phone = chatId.replace('@c.us', '').replace('@lid', '').replace('@s.whatsapp.net', '');
    const clientId = clientInfo?.id || null;
    const result = await query(
      `SELECT id, phone, client_id, status, stage, contexto, classificacao, agente_atual, mensagens_count
       FROM luna_v2.conversations
       WHERE phone = $1 AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
      [phone]
    );
    if (result.rows[0]) {
      await query(
        `UPDATE luna_v2.conversations
         SET mensagens_count = mensagens_count + 1,
             last_message_at = NOW(),
             client_id = COALESCE(client_id, $2)
         WHERE id = $1`,
        [result.rows[0].id, clientId]
      );
      return { ...result.rows[0], client_id: result.rows[0].client_id || clientId };
    }
    const newConv = await query(
      `INSERT INTO luna_v2.conversations (phone, status, mensagens_count, client_id)
       VALUES ($1, 'active', 1, $2)
       RETURNING id, phone, status, mensagens_count, client_id`,
      [phone, clientId]
    );
    return newConv.rows[0] || { id: null };
  } catch (err) {
    log(`[Luna v2] Erro getConversationInfo: ${err.message}`);
    return { id: null };
  }
}


// Padroes que indicam que o CLIENTE resolveu a demanda sozinho (ou desistiu).
// Match conservador — so quando a mensagem carrega sinal CLARO de encerramento.
// Se casar, cancelamos escalation + marcamos conv resolved pra Luna parar de mandar msg.
const SELF_RESOLUTION_PATTERNS = [
  /\bvou (eu mesm[oa] )?(emitir|fazer|resolver|ver|cuidar|providenciar)\b/i,
  /\beu mesm[oa] (vou )?(emitir|fazer|resolver|ver|cuidar)\b/i,
  /\bj[aá] (resolv[ií]|consegu[ií]|fiz|emiti|vi)\b/i,
  /\bdeixa (pra l[aá]|comigo|quieto|assim)\b/i,
  /\besquec[ae]\b/i,
  /\bresolvido\b/i,
  /\btudo certo\b/i,
  /\bn[aã]o precis[ao] mais\b/i,
  /\bn[aã]o precisa (mais|n[aã]o)\b/i,
  /\btranquil[oa]s?,? (obrigad|valeu|vlw|tudo)/i,
  /\bj[aá] resolvi\b/i,
];

function detectSelfResolution(text) {
  if (!text || text.length < 3) return false;
  const clean = text.trim();
  if (clean.length > 300) return false; // muito longo provavelmente nao e sinal de encerramento
  return SELF_RESOLUTION_PATTERNS.some(p => p.test(clean));
}

async function handleIncoming(msg) {
  const from = msg.from;

  // Proteção extra: ignora broadcast, status, reações
  if (!from || from === 'status@broadcast' || from.includes('@broadcast')) return;
  if (msg.type === 'reaction' || msg.type === 'reaction_sent' || msg.type === 'sticker') return;

  const phone = normalizePhone(from);
  let body = msg.body || '';
  if (!body.trim() && !msg.hasMedia) return;

  const isGroup = String(from).endsWith('@g.us');

  // ========== GRUPOS ==========
  // Surgem no Atendimento pra visibilidade, MAS:
  //   - Luna NAO processa (nao responde)
  //   - Sem first-touch
  //   - Sem auto-resolution detection
  //   - Sem escalation
  //   - Sem auto-ingest de midia (seria barulho)
  //   - author (quem mandou) vira metadata da msg
  if (isGroup) {
    try {
      const chat = await msg.getChat().catch(() => null);
      const groupName = chat?.name || 'Grupo WhatsApp';
      const authorContact = msg.author ? await (async () => {
        try { return (await client.getContactById(msg.author)); } catch { return null; }
      })() : null;
      const authorName = authorContact?.pushname || authorContact?.name || msg.author?.replace('@c.us', '') || 'membro';

      // Upsert conversation (is_group=true)
      await query(
        `INSERT INTO whatsapp_conversations (phone, chat_id, client_name, is_group, started_at, last_message_at)
         VALUES ($1, $2, $3, true, NOW(), NOW())
         ON CONFLICT (phone) DO UPDATE SET
           client_name = COALESCE(whatsapp_conversations.client_name, EXCLUDED.client_name),
           is_group = true,
           last_message_at = NOW()`,
        [phone, from, groupName]
      ).catch(e => log('[group] upsert conv falhou: ' + e.message));

      // Persiste msg com author no metadata
      const { rows } = await query(
        `SELECT id FROM whatsapp_conversations WHERE phone = $1 LIMIT 1`, [phone]
      ).catch(() => ({ rows: [] }));
      const convId = rows[0]?.id;
      if (convId) {
        const waId = msg.id?._serialized || msg.id || null;
        // Dedupe por wa_msg_id (evita duplicacao em burst/retry do whatsapp-web.js)
        const dup = waId ? await query(
          `SELECT id FROM whatsapp_messages WHERE conversation_id = $1 AND metadata->>'wa_msg_id' = $2 LIMIT 1`,
          [convId, waId]
        ).catch(() => ({ rows: [] })) : { rows: [] };
        if (!dup.rows.length) {
          // Salva anexo do grupo (PDF, imagem, etc) se houver
          const attachMeta = msg.hasMedia ? await saveMsgAttachment(msg, convId) : null;
          await query(
            `INSERT INTO whatsapp_messages (conversation_id, sender, body, metadata)
             VALUES ($1, 'client', $2, $3)`,
            [convId, body, JSON.stringify({
              is_group: true,
              group_name: groupName,
              author: authorName,
              author_id: msg.author,
              wa_msg_id: waId,
              ...(attachMeta || {}),
            })]
          ).catch(e => log('[group] insert msg falhou: ' + e.message));
        }
      }
      broadcastFn?.({ type: 'conversation_updated', phone, isGroup: true });
      log(`[group] ${groupName}: ${authorName}: ${body.slice(0, 60)}`);
    } catch (e) {
      log('[group] erro processando: ' + e.message);
    }
    return; // NAO prossegue — sem Luna, sem first-touch, sem escalation
  }
  // ========== FIM GRUPOS ==========

  const contact = await msg.getContact().catch(() => null);
  const name = contact?.pushname || contact?.name || phone;
  // Pega número real — contact.id.user ou contact.number têm o número limpo
  const realPhone = contact?.id?.user || contact?.number || phone;

  // === TRANSCREVE AUDIO ===
  // Se for audio/ptt (voice note), baixa e transcreve via OpenAI Whisper.
  // Resultado vira o body da msg — seguimos o fluxo normal (Luna ve texto, UI mostra).
  // Guarda metadata pra UI renderizar icone 🎤 + duracao.
  let audioMeta = null;
  if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio') && !body.trim()) {
    try {
      log(`[audio] baixando de ${name}... (type=${msg.type})`);
      const media = await msg.downloadMedia();
      if (media?.data) {
        const audioBuffer = Buffer.from(media.data, 'base64');
        const { transcribeAudio } = await import('./transcription.js');
        const tr = await transcribeAudio(audioBuffer, media.mimetype || 'audio/ogg');
        if (tr?.text) {
          body = tr.text;
          audioMeta = {
            is_audio: true,
            transcribed: true,
            duration_sec: tr.duration,
            language: tr.language,
          };
          log(`[audio] ${name}: "${tr.text.slice(0, 80)}" (${tr.duration}s)`);
        } else {
          body = '[audio recebido — nao transcrito]';
          audioMeta = { is_audio: true, transcribed: false };
        }
      }
    } catch (e) {
      log(`[audio] erro transcrevendo: ${e.message}`);
      body = '[audio recebido — erro na transcricao]';
      audioMeta = { is_audio: true, transcribed: false, error: e.message };
    }
    // Coloca no objeto msg pra downstream pegar
    msg.body = body;
    // Marca metadata pra dbSaveMessage identificar que e audio transcrito
    msg._atrioAudioMeta = audioMeta;
  }

  log(`${name} (${phone}): ${body.substring(0, 80)}`);

  // Auto-resolucao: cliente sinalizou que ele mesmo vai resolver ou desistiu.
  // Cancela escalation + marca resolved pra Luna parar de enviar lembretes.
  if (detectSelfResolution(body)) {
    log(`[auto-resolve] ${name} (${phone}) sinalizou auto-resolucao: "${body.slice(0, 80)}"`);
    try {
      // Cancela timers de escalation na Map em memoria
      const existing = conversations.get(phone);
      if (existing) {
        existing.timers?.forEach(t => clearTimeout(t));
        existing.timers = [];
        existing.resolved = true;
        existing.resolvedAt = new Date().toISOString();
      }
      // Cancela first-touch timer se pendente
      try {
        const ft = await import('./luna-first-touch.js');
        ft.cancelLunaFirstTouch(phone, log);
        if (realPhone && realPhone !== phone) ft.cancelLunaFirstTouch(realPhone, log);
      } catch {}
      // Marca no banco — match amplo por qualquer identificador
      await query(
        `UPDATE whatsapp_conversations
         SET resolved = true,
             resolved_at = COALESCE(resolved_at, NOW()),
             resolution_reason = COALESCE(resolution_reason, 'cliente auto-resolveu'),
             last_message_at = NOW()
         WHERE phone = $1 OR real_phone = $1 OR chat_id LIKE $1 || '@%'
            OR regexp_replace(COALESCE(display_phone,''), '\\D', '', 'g') = $1`,
        [phone]
      ).catch(e => log('[auto-resolve] update falhou: ' + e.message));
      // Fecha tambem na luna_v2
      await query(
        `UPDATE luna_v2.conversations SET attendance_status = 'resolved'
         WHERE phone = $1 AND attendance_status = 'open'`,
        [phone]
      ).catch(() => {});
    } catch (e) { log('[auto-resolve] erro: ' + e.message); }
    // NAO retorna — cliente pode mandar mais uma msg depois, mas nao haverá nova escalation.
  }

    // ====== NOVO: Tentar Luna v2 primeiro ======
    try {
      // WhatsApp pode entregar chatId em formato LID (15 digitos, nao E164). Usa realPhone (numero limpo).
      const phoneForLookup = (realPhone && /^\d{10,13}$/.test(String(realPhone))) ? realPhone : phone;
      const clientInfo = await getClientInfo(phoneForLookup);
      log(`[lookup] phone=${phone} realPhone=${realPhone} usado=${phoneForLookup} gesthub=${clientInfo?.gesthub_id || 'nenhum'}`);
      const conversationInfo = await getConversationInfo(from, clientInfo);

      // Persiste vinculo phone -> gesthub_client_id na conversa (se nao estava setado).
      // Usado pelo painel direito do Atendimento pra mostrar dados do cliente.
      const ghId = clientInfo?.gesthub_id || clientInfo?.id;
      if (ghId && (phone || realPhone)) {
        try {
          await query(
            `UPDATE whatsapp_conversations
             SET gesthub_client_id = COALESCE(gesthub_client_id, $1)
             WHERE (phone = $2 OR real_phone = $2 OR phone = $3 OR real_phone = $3)
               AND (gesthub_client_id IS NULL OR gesthub_client_id = $1)`,
            [Number(ghId), phone, realPhone]
          );
        } catch (e) { log('[link-gesthub] falha: ' + e.message); }
      }

      // Se NAO linkou cliente, tenta identificar como COLABORADOR (membro da equipe Átrio)
      // via telefone. Match em colaboradores.ativo=true do Gesthub.
      // Marca contact_type='equipe' + contact_label com nome + areas + cargo.
      if (!ghId && !clientInfo?.is_team_member) {
        try {
          const { getColaboradores } = await import('./gesthub.js');
          const colabs = await getColaboradores().catch(() => []);
          const toDigits11 = (s) => {
            let d = String(s || '').replace(/\D/g, '');
            if (!d) return null;
            if ((d.length === 13 || d.length === 12) && d.startsWith('55')) d = d.slice(2);
            // Strip mobile "9" prefix (81997140391 -> 8197140391) pra casar com fixo (10 digits)
            if (d.length === 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3);
            return d;
          };
          const candidates = [phone, realPhone].map(toDigits11).filter(d => d && d.length >= 10);
          const match = (colabs || []).find(c => {
            if (!c.ativo) return false;
            const tel = toDigits11(c.telefone);
            return tel && candidates.includes(tel);
          });
          if (match) {
            const areas = match.areas || match.area || '';
            const cargo = match.cargo || '';
            const label = [match.nome, areas, cargo].filter(Boolean).join(' — ').slice(0, 200);
            await query(
              `UPDATE whatsapp_conversations
               SET contact_type = COALESCE(contact_type, 'equipe'),
                   contact_label = COALESCE(contact_label, $1)
               WHERE (phone = $2 OR real_phone = $2 OR phone = $3 OR real_phone = $3)
                 AND gesthub_client_id IS NULL
                 AND contact_type IS NULL`,
              [label, phone, realPhone]
            );
            log(`[auto-team] ${match.nome} (${match.telefone}) detectado como equipe`);
          }
        } catch (e) { log('[auto-team] falha: ' + e.message); }
      }

      // Auto-ingest de PDF/imagem — fire-and-forget, nao bloqueia Luna
      if (msg.hasMedia) {
        autoIngestWhatsAppMedia(msg, clientInfo, conversationInfo).catch(() => {});
      }

      // Alerta INTELIGENTE ao grupo: aguarda 60s após última msg, agrupa contexto
      // (conversa completa + classificação Luna), depois dispara alerta rico.
      // Reset do timer a cada nova msg no burst (debounce idêntico ao LLM buffer).
      // Dedup: só na 1ª entrada OU retomada 4h+ após último alerta.
      scheduleDelayedGroupAlert({
        phone, realPhone, name, body, clientInfo, contact,
      });

      // Buffer 10s: agrupa mensagens rapidas do mesmo contato
      scheduleLunaProcess(phone, msg,
        { ...(clientInfo||{}), pushname: name, realPhone, displayPhone: formatPhone(realPhone) },
        conversationInfo,
        async (aggMsg, cInfo, convInfo) => {
          const processedByLunaV2 = await handleLunaV2(aggMsg, cInfo, convInfo);
          if (processedByLunaV2?.handled) {
            try {
              let conv = conversations.get(phone);
              if (!conv) {
                conv = { name, chatId: from, realPhone, displayPhone: formatPhone(realPhone),
                  messages: [], receivedAt: new Date().toISOString(),
                  escalationLevel: -1, timers: [], greetingTimer: null, analysisTimer: null,
                  humanReplied: false, resolved: false, greeted: true };
                conversations.set(phone, conv);
                await dbSaveConversation(phone, conv);
              }
              conv.messages.push({ body: aggMsg.body, from: 'client', at: new Date().toISOString() });
              // Audio transcrito + anexos (PDF/imagem) viram metadata persistida
              const cliMeta = aggMsg._atrioAudioMeta ? { ...aggMsg._atrioAudioMeta } : {};
              if (aggMsg.hasMedia && !aggMsg._atrioAudioMeta) {
                const att = await saveMsgAttachment(aggMsg, conv.dbId || conv.phone);
                if (att) Object.assign(cliMeta, att);
              }
              await dbSaveMessage(conv, 'client', aggMsg.body, cliMeta);
              if (processedByLunaV2.reply) {
                conv.messages.push({ body: processedByLunaV2.reply, from: 'bot', at: new Date().toISOString() });
                await dbSaveMessage(conv, 'bot', processedByLunaV2.reply);
              }
              broadcastFn?.({ type: "conversation_updated", phone, conv });
            } catch (e) { log('[Buffer] persist erro: ' + e.message); }
          }
        });
      return; // nao prossegue no fluxo legado — buffer vai responder
    } catch (lunaErr) {
      log(`[Luna v2] Erro, usando legado: ${lunaErr.message}`);
    }
    // =============================================



  // Notifica dashboard
  broadcastFn?.({
    type: 'whatsapp_message',
    from: { phone, name },
    body: body.substring(0, 200),
    receivedAt: new Date().toISOString(),
  });

  // Notification: nova mensagem WhatsApp
  createNotification({
    type: 'whatsapp_message',
    title: 'Nova mensagem WhatsApp',
    message: `${name}: ${body.substring(0, 120)}`,
    severity: 'info',
    metadata: { phone, name, preview: body.substring(0, 200) },
  }).catch(() => {});

  // Análise de sentimento em background (só dashboard + Telegram se crítico)
  analyzeSentiment(body).then(analysis => {
    if (!analysis) return;
    log(`Sentimento ${name}: ${analysis.sentimento}, urgência: ${analysis.urgencia}`);
    broadcastFn?.({ type: 'whatsapp_analysis', phone, name, analysis });

    if (analysis.precisa_atencao_imediata || analysis.sentimento === 'irritado') {
      telegram.sendAlert(`🚨 *Atenção* — ${name}: ${analysis.sentimento} — _${analysis.resumo}_`);
    }
  }).catch(() => {});

  // === CONVERSA EXISTENTE ===
  if (conversations.has(phone)) {
    const conv = conversations.get(phone);
    conv.messages.push({ body, from: 'client', at: new Date().toISOString() });
    dbSaveMessage(conv, 'client', body);

    // Reseta greeting timer (espera cliente terminar de digitar) e reagenda
    // Greeting hardcoded desativado — Luna (LLM) já cumprimenta via prompt mestre.
    if (conv.greetingTimer) { clearTimeout(conv.greetingTimer); conv.greetingTimer = null; }
    conv.greeted = true;

    // Reseta timer de classificação/notificação (espera cliente parar de digitar)
    if (!conv.classified) {
      scheduleClassification(phone, from, name, conv);
    }

    // Se está coletando dados de NFS-e, acumula e processa com debounce (espera cliente parar de digitar)
    if (conv.nfseRequested && !conv.nfseTaskCreated) {
      handleNfseDataCollectionDebounced(from, phone, name, body, conv);
      return;
    }

    // Detecta URGENTE
    if (isUrgent(body)) {
      await handleUrgent(from, phone, name, body);
    }

    // Detecta solicitação de NFS-e
    // handleNfseRequest desativado — Luna (LLM) coleta via regra 21 do prompt mestre.
    if (isNfseRequest(body)) {
      conv.classified = true;
    }

    // Cliente insistiu após humano responder → reinicia monitoramento
    if (conv.humanReplied && !conv.resolved) {
      conv.humanReplied = false;
      log(`${name} insistiu — reiniciando escalation`);
      startEscalation(phone, from, name, 0);
    }
    return;
  }

  // === NOVA CONVERSA ===
  const conv = {
    name, chatId: from, realPhone, displayPhone: formatPhone(realPhone),
    messages: [{ body, from: 'client', at: new Date().toISOString() }],
    receivedAt: new Date().toISOString(),
    escalationLevel: -1,
    timers: [],
    greetingTimer: null,
    analysisTimer: null,
    humanReplied: false,
    resolved: false,
    greeted: false,
  };
  conversations.set(phone, conv);

  // Persistir no banco
  await dbSaveConversation(phone, conv);
  dbSaveMessage(conv, 'client', body);
  dbLogMetric('Luna', 'new_conversation', { phone, name });

  // Detecta NFS-e na primeira mensagem — só marca flags; Luna LLM faz a coleta
  if (isNfseRequest(body)) {
    conv.greeted = true;
    conv.classified = true;
  }

  // Detecta URGENTE na primeira mensagem
  if (isUrgent(body)) {
    conv.greeted = true;
    await handleUrgent(from, phone, name, body);
  }

  // Greeting hardcoded desativado — Luna LLM cumprimenta via prompt mestre (regra 2, 8, 10, 25)
  conv.greeted = true;

  // Notificação no chat da equipe: nova mensagem recebida
  chat({ from: 'Luna', text: `📩 Nova mensagem de *${name}*: "${body.substring(0, 60)}${body.length > 60 ? '...' : ''}"`, tag: 'whatsapp' });

  // Notifica dashboard imediatamente
  broadcastFn?.({ type: 'whatsapp_new_contact', phone, name, body: body.substring(0, 150) });

  // Aguarda 1 minuto para cliente terminar de digitar, depois classifica e notifica grupo
  scheduleClassification(phone, from, name, conv);

  // Inicia escalation (10min sem resposta → alertas crescentes)
  startEscalation(phone, from, name, 0);
  log(`Nova conversa — ${name} (${phone})`);
}

// ============================================
// CLASSIFICAÇÃO + NOTIFICAÇÃO (com delay de 1min)
// ============================================
const CLASSIFICATION_DELAY_MS = 60 * 1000; // 1 minuto

function scheduleClassification(phone, chatId, name, conv) {
  // Cancela timer anterior se existir
  if (conv.classificationTimer) {
    clearTimeout(conv.classificationTimer);
    conv.classificationTimer = null;
  }

  conv.classificationTimer = setTimeout(async () => {
    if (conv.classified || conv.resolved) return;
    conv.classified = true;

    // Pega todas as mensagens do cliente para classificar com contexto completo
    const allClientMsgs = conv.messages
      .filter(m => m.from === 'client')
      .map(m => m.body)
      .join('\n');

    try {
      const classification = await classifyDemand(allClientMsgs, name);
      if (!classification) return;

      conv.classification = classification.classificacao;
      conv.priority = classification.prioridade;
      conv.assignedTo = classification.atendente_sugerido;

      dbUpdateConversation(phone, {
        classification: classification.classificacao,
        priority: classification.prioridade,
        assigned_to: classification.atendente_sugerido,
      });
      dbLogMetric('Luna', 'demand_classified', { phone, name, ...classification });

      log(`Classificação ${name}: ${classification.classificacao} → ${classification.atendente_sugerido} (${classification.resumo})`);
      broadcastFn?.({ type: 'whatsapp_classification', phone, name, classification });

      // Guarda classificacao no conv para enriquecer alertas subsequentes
      conv.classification = classification;

      // Notificacao no chat: classificacao feita
      chat({ from: 'Luna', text: `🏷️ *${name}* classificado: *${classification.classificacao}* → ${classification.atendente_sugerido}${classification.resumo ? `. ${classification.resumo}` : ''}`, tag: classification.classificacao });

      // UMA mensagem no grupo com tudo
      const displayPhone = conv.displayPhone || phone;
      const lastMsg = conv.messages.filter(m => m.from === 'client').pop()?.body || '';
      const horarioInfo = isHorarioComercial();
      const horarioTag = horarioInfo.open ? '' : `\n⏰ _Fora do horário (${horarioInfo.reason})_`;
      const tipoTag = classification.classificacao !== 'geral' ? `\nTipo: *${classification.classificacao.toUpperCase()}* → *${classification.atendente_sugerido}*` : '';
      const resumoTag = classification.resumo ? `\nResumo: _${classification.resumo}_` : '';

      const alertUnico = `📩 *Novo contato*\n\nCliente: *${name}*\nTelefone: ${displayPhone}\nMensagem: _${lastMsg.substring(0, 150)}_${tipoTag}${resumoTag}${horarioTag}`;
      // Se config diz pra esperar o 10min para avisar (reduz ruido no grupo),
      // pulamos a notificacao imediata. Classificacao fica salva em conv.classification
      // e eh incluida no alerta de 10min quando dispara.
      // Removido: 'Novo contato' já foi emitido pelo IIFE em handleLunaV2 com dedup
      // Esta classification só atualiza o conv.classification em memória pra escalation usar.
      log(`[NovoContato] classification pronta — alerta já disparado anteriormente via dedup`);

      // Cria task e roteia (pula se já tem NFS-e em andamento ou se é fiscal com NFS-e ativo)
      if (!conv.nfseRequested && !conv.nfseTaskId && classification.classificacao !== 'geral') {
        await routeDemandToAgent(phone, name, chatId, allClientMsgs, conv, classification);
      }
    } catch (err) {
      log(`ERRO classificação ${name}: ${err.message}`);
      // Fallback — notifica grupo sem classificação
      const displayPhone = conv.displayPhone || phone;
      const lastMsg = conv.messages.filter(m => m.from === 'client').pop()?.body || '';
      // alertFallback removido — dedup já tratou no IIFE principal
      log(`[Classif-fallback] classification falhou, mas alerta inicial já foi emitido: ${err.message}`);
    }
  }, CLASSIFICATION_DELAY_MS);
}

// ============================================
// SAUDAÇÃO INICIAL
// ============================================
async function sendGreeting(chatId, name, conv) {
  const greeting = getGreeting();
  const horario = isHorarioComercial();

  const firstName = (name || '').split(' ')[0];

  let message;
  if (horario.open) {
    message = `${greeting}, ${firstName}! Sou a Luna, assistente virtual do Átrio Contabilidade 😊\nEstou aqui para te ajudar! Recebi sua mensagem e já estou encaminhando para a equipe. Em breve, um de nossos colaboradores dará continuidade ao seu atendimento.`;
  } else if (horario.isLunch) {
    message = `${greeting}, ${firstName}! Sou a Luna, assistente virtual do Átrio Contabilidade 😊\nRecebi sua mensagem. Nossa equipe está no intervalo de almoço e retorna às 13h.\n\nSe for algo urgente, responda *URGENTE* ou entre em contato pelo ${CONTACT_PHONE} 🔔`;
  } else {
    message = `${greeting}, ${firstName}! Sou a Luna, assistente virtual do Átrio Contabilidade 😊\nRecebi sua mensagem. No momento estamos fora do horário de atendimento, mas assim que a equipe retornar daremos continuidade ao seu atendimento.\n\nSe for algo urgente, responda *URGENTE* ou entre em contato pelo ${CONTACT_PHONE} 🔔`;
  }

  // Retry: WhatsApp pode estar reconectando quando o timer dispara
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await botSend(chatId, LUNA_HEADER + message);
      conv.outsideHours = !horario.open;
      dbUpdateConversation(normalizePhone(chatId), { greeted: true, outside_hours: conv.outsideHours });
      dbSaveMessage(conv, 'luna', message);
      dbLogMetric('Luna', 'greeting_sent', { name, outsideHours: conv.outsideHours });
      log(`Greeting enviado para ${name}${!horario.open ? ` (${horario.reason})` : ''}`);
      return;
    } catch (err) {
      if (attempt < 2 && (err.message.includes('não conectado') || err.message.includes('undefined'))) {
        log(`Greeting ${name}: tentativa ${attempt + 1} falhou (${err.message}), aguardando reconexão...`);
        await new Promise(r => setTimeout(r, 5000)); // espera 5s e tenta de novo
      } else {
        log(`ERRO greeting ${name}: ${err.message}`);
      }
    }
  }
}

// ============================================
// URGENTE
// ============================================
async function handleUrgent(chatId, phone, name, body) {
  const firstName = (name || '').split(' ')[0];
  log(`🚨 ${name} solicitou URGENTE`);

  const alertMsg = `🚨 *URGENTE — Cliente solicitou prioridade*\n\nCliente: *${name}* (${formatPhone(phone)})\nMensagem: _${body.substring(0, 150)}_`;
  await notifyAll(alertMsg);

  try {
    const horario = isHorarioComercial();
    let urgentReply;
    if (!horario.open) {
      const motivo = horario.reason === 'final de semana' ? 'final de semana'
        : horario.reason === 'feriado' ? 'feriado'
        : horario.reason === 'horário de almoço' ? 'horário de almoço'
        : 'fora do horário de expediente';
      urgentReply = `${firstName}, entendido! Recebemos sua solicitação de urgência. No momento estamos com atendimento limitado por ser ${motivo}, mas sua mensagem já foi sinalizada internamente com prioridade.\n\nPoderia nos detalhar brevemente o que está precisando? Assim que um colaborador estiver disponível, seu caso será o primeiro a ser atendido.\n\nSe for algo que não pode esperar, entre em contato diretamente pelo ${CONTACT_PHONE} 🔔`;
    } else {
      urgentReply = `${firstName}, entendido! Recebemos sua solicitação e um colaborador já está sendo acionado para atendê-lo com prioridade.\n\nPara agilizar, poderia nos detalhar brevemente o que está precisando? Assim conseguimos direcionar da melhor forma possível.\n\nSe preferir, entre em contato diretamente pelo ${CONTACT_PHONE} 🔔`;
    }
    await botSend(chatId, LUNA_HEADER + urgentReply);
    const conv = conversations.get(phone);
    if (conv) dbSaveMessage(conv, 'luna', urgentReply);
    dbLogMetric('Luna', 'urgent_detected', { phone, name });
  } catch (err) {
    log(`ERRO resposta urgente: ${err.message}`);
  }
}

// ============================================
// NFS-e — Solicitação de nota fiscal (coleta de dados)
// ============================================
const NFSE_COLLECTION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas

async function handleNfseRequest(chatId, phone, name, body, conv) {
  if (conv.nfseRequested) return;
  conv.nfseRequested = true;
  conv.nfseData = { step: 'tomador', mensagem_original: body, respostas: [body] };

  // Timeout: se após 2h os dados não foram coletados, notifica equipe e reseta
  conv.nfseCollectionTimer = setTimeout(async () => {
    if (conv.nfseTaskCreated || !conv.nfseRequested) return;
    log(`📄 NFS-e timeout — ${name} não completou dados em 2h`);
    conv.nfseRequested = false;
    conv.nfseData = null;
    const alertMsg = `⏰ *NFS-e timeout*\n\nCliente ${name} (${phone}) solicitou NFS-e há 2h mas não completou o envio dos dados.\nConversa resetada — se o cliente reenviar, Luna vai recomeçar a coleta.`;
    telegram.sendAlert(alertMsg.replace(/\*/g, ''));
    try { await sendAlertToGroup(alertMsg); } catch {}
  }, NFSE_COLLECTION_TIMEOUT_MS);

  log(`📄 ${name} solicitou NFS-e — verificando se dados já vieram na mensagem`);

  // Verifica se a mensagem JÁ contém os dados necessários (CPF/CNPJ + valor)
  const cpfCnpj = extractCpfCnpj(body);
  const valor = extractValor(body);
  const descricao = extractDescricao(body);

  if (cpfCnpj && valor && descricao) {
    // Dados completos na primeira mensagem — apresentar para confirmação
    conv.nfseData.awaitingConfirmation = true;
    const firstName = (name || '').split(' ')[0];

    const docLimpo = cpfCnpj[0].replace(/\D/g, '');
    const docTipo = docLimpo.length === 11 ? 'CPF' : 'CNPJ';
    const docFormatado = docLimpo.length === 11
      ? `${docLimpo.slice(0,3)}.${docLimpo.slice(3,6)}.${docLimpo.slice(6,9)}-${docLimpo.slice(9)}`
      : `${docLimpo.slice(0,2)}.${docLimpo.slice(2,5)}.${docLimpo.slice(5,8)}/${docLimpo.slice(8,12)}-${docLimpo.slice(12)}`;
    const valorStr = valor[0].replace(/[^\d.,]/g, '').replace(',', '.');
    const valorNum = parseFloat(valorStr) || 0;
    const valorFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valorNum);

    try {
      const confirmMsg = `${firstName}, entendi! Confirme os dados da nota:\n\n` +
        `📋 *Tomador (${docTipo}):* ${docFormatado}\n` +
        `💰 *Valor:* ${valorFmt}\n` +
        `📝 *Descrição:* ${descricao}\n` +
        `\nEstá correto? Posso seguir com a emissão? 😊`;
      await botSend(chatId, LUNA_HEADER + confirmMsg);
      dbSaveMessage(conv, 'luna', confirmMsg);
      log(`📄 NFS-e — dados completos na primeira mensagem, aguardando confirmação`);
    } catch (err) {
      log(`ERRO apresentar dados NFS-e: ${err.message}`);
    }
    return;
  }

  // Dados incompletos — pede o que falta
  const firstName = (name || '').split(' ')[0];
  const missing = [];
  if (!cpfCnpj) missing.push('*CPF ou CNPJ* do tomador');
  if (!valor) missing.push('*valor do serviço*');

  // Se tem algum dado, reconhece. Se não tem nenhum, pede tudo.
  let msg;
  if (missing.length < 2) {
    msg = `${firstName}, recebi parte dos dados! Ainda preciso do ${missing.join(' e ')} para prosseguir com a emissão 😊`;
  } else {
    msg = `${firstName}, para emitir a nota fiscal preciso de algumas informações sobre o *tomador* (para quem é a nota):\n\n1️⃣ *CPF ou CNPJ* do tomador\n2️⃣ *Valor do serviço*\n3️⃣ *Descrição do serviço prestado* (opcional)\n\nPode me enviar? 😊`;
  }

  try {
    await botSend(chatId, LUNA_HEADER + msg);
    dbSaveMessage(conv, 'luna', msg);
  } catch (err) {
    log(`ERRO coleta NFS-e: ${err.message}`);
  }
}

// Validação de CPF (mod 11)
function isValidCpf(cpf) {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false; // todos iguais
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits[i]) * (10 - i);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (parseInt(digits[9]) !== check) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(digits[i]) * (11 - i);
  check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  return parseInt(digits[10]) === check;
}

// Validação de CNPJ (mod 11)
function isValidCnpj(cnpj) {
  const digits = cnpj.replace(/\D/g, '');
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false; // todos iguais
  const weights1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  const weights2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(digits[i]) * weights1[i];
  let check = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  if (parseInt(digits[12]) !== check) return false;
  sum = 0;
  for (let i = 0; i < 13; i++) sum += parseInt(digits[i]) * weights2[i];
  check = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  return parseInt(digits[13]) === check;
}

// Extrai CPF/CNPJ de um texto (com validação de dígitos verificadores)
function extractCpfCnpj(text) {
  // Tenta CNPJ formatado
  const cnpjFmt = text.match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\\/\.\s]?\d{4}[\-\.\s]?\d{2}/);
  if (cnpjFmt && isValidCnpj(cnpjFmt[0])) return cnpjFmt;

  // Tenta CPF formatado
  const cpfFmt = text.match(/\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\-\.\s]?\d{2}/);
  if (cpfFmt && isValidCpf(cpfFmt[0])) return cpfFmt;

  // Tenta CNPJ sem formatação
  const cnpjRaw = text.match(/\b\d{14}\b/);
  if (cnpjRaw && isValidCnpj(cnpjRaw[0])) return cnpjRaw;

  // Tenta CPF sem formatação
  const cpfRaw = text.match(/\b\d{11}\b/);
  if (cpfRaw && isValidCpf(cpfRaw[0])) return cpfRaw;

  // Encontrou padrão numérico mas dígitos inválidos — retorna null (Luna vai pedir confirmação)
  const anyDoc = cnpjFmt || cpfFmt || cnpjRaw || cpfRaw;
  if (anyDoc) {
    // Marca como inválido para que a coleta peça confirmação
    return null; // documento encontrado mas inválido
  }

  return null;
}

// Extrai valor de um texto
function extractValor(text) {
  // 1. Formato monetário explícito: R$ 150, R$1.500,00
  const m1 = text.match(/[Rr]\$\s?[\d\.,]+/);
  if (m1) return m1;

  // 2. Formato brasileiro com centavos: 1.500,00 / 150,00
  const m2 = text.match(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b/);
  if (m2) return m2;

  // 3. Número + sufixo monetário (aceita typos comuns: "era" = "real", "reas" = "reais")
  const m3 = text.match(/\b(\d+(?:[.,]\d+)?)\s*(?:reais|real|rea[is]|era|mil)\b/i);
  if (m3) return m3;

  // 4. "valor de X" / "valor: X"
  const m4 = text.match(/\bvalor\s*(?:de|:|-|=)?\s*(\d+(?:[.,]\d+)?)\b/i);
  if (m4) return m4;

  // 5. Número solto (1-10 dígitos), mas NÃO se parece CPF (11 dígitos) ou CNPJ (14 dígitos)
  //    Procura em cada linha para evitar pegar CPF de outra linha
  const linhas = text.split('\n');
  for (const linha of linhas) {
    const limpa = linha.trim();
    // Pula linhas que são claramente CPF/CNPJ (11 ou 14 dígitos puros)
    if (/^\d{11}$/.test(limpa) || /^\d{14}$/.test(limpa)) continue;
    if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(limpa)) continue; // CPF formatado
    if (/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(limpa)) continue; // CNPJ formatado
    // Número solto nesta linha (1-10 dígitos)
    const m5 = limpa.match(/\b(\d{1,10})\b/);
    if (m5 && m5[1].length <= 10 && m5[1].length >= 1) {
      // Não captura se a linha inteira é um CPF/CNPJ
      const digits = limpa.replace(/\D/g, '');
      if (digits.length === 11 || digits.length === 14) continue;
      return m5;
    }
  }

  return null;
}

// Extrai descrição do serviço de um texto
function extractDescricao(text) {
  // Só match explícito quando há separador (: = -) — evita capturar "Serviços de impressão" como prefixo
  const explicita = text.match(/(?:descri[çc][aã]o|servi[çc]os?\s*prestados?)\s*[:=-]\s*(.+)/i)
    || text.match(/(?:servi[çc]o)\s*[:=-]\s*(.+)/i);
  let descricao = explicita?.[1]?.trim() || '';
  if (!descricao) {
    const linhas = text.split('\n').map(l => l.trim()).filter(l =>
      l.length > 3
      && !/^\d{11,14}$/.test(l)
      && !/^[Rr]\$/.test(l)
      && !/^\d+\s*(reais|real|mil)$/i.test(l)
      && !/^\d{5}-?\d{3}$/.test(l)
      && !/^\d+([.,]\d+)?$/.test(l)
      && !/(quero|preciso|emitir|gerar|nota\s*fiscal|nfs|urgente|oi|olá|bom dia|boa tarde|boa noite|por favor|pode|obrigad)/i.test(l)
    );
    if (linhas.length > 0) descricao = linhas[linhas.length - 1];
  }
  return descricao || null;
}

function extractCep(text) {
  // CEP brasileiro: 5 dígitos + hífen opcional + 3 dígitos (ex: 50030-230, 50030230)
  const match = text.match(/\b(\d{5})-?(\d{3})\b/);
  if (!match) return null;
  const cep = match[1] + match[2];
  if (cep === '00000000') return null;
  return cep;
}

// Debounce: espera cliente parar de digitar antes de processar (8 segundos)
const NFSE_DEBOUNCE_MS = 8000;

function handleNfseDataCollectionDebounced(chatId, phone, name, body, conv) {
  if (!conv.nfseData || conv.nfseTaskCreated) return false;

  // Acumula a mensagem imediatamente
  if (!conv.nfseData.respostas) conv.nfseData.respostas = [];
  conv.nfseData.respostas.push(body);
  log(`📄 NFS-e: acumulando msg de ${name} (${conv.nfseData.respostas.length} msgs). Aguardando ${NFSE_DEBOUNCE_MS / 1000}s...`);

  // Cancela timer anterior e cria novo (debounce)
  if (conv.nfseDebounceTimer) clearTimeout(conv.nfseDebounceTimer);
  conv.nfseDebounceTimer = setTimeout(async () => {
    conv.nfseDebounceTimer = null;
    try {
      await _processNfseDataCollection(chatId, phone, name, conv);
    } catch (err) {
      log(`ERRO processamento NFS-e debounced: ${err.message}`);
    }
  }, NFSE_DEBOUNCE_MS);

  return true; // Interceptou a mensagem
}

// Processa respostas do cliente durante coleta de NFS-e (chamado após debounce)
async function _processNfseDataCollection(chatId, phone, name, conv) {
  if (!conv.nfseData || conv.nfseTaskCreated) return false;

  const allText = conv.nfseData.respostas.join('\n');
  const firstName = (name || '').split(' ')[0];

  // Se cliente está confirmando dados já apresentados
  if (conv.nfseData.awaitingConfirmation) {
    const lastMsg = conv.nfseData.respostas[conv.nfseData.respostas.length - 1]?.toLowerCase().trim() || '';
    const isConfirm = /^(sim|s|ok|isso|correto|confirmo|pode|segue|seguir|manda|pode seguir|tá certo|ta certo|certo|yes|confirma|positivo|exato|isso mesmo|perfeito|bora|vai|manda ver)$/i.test(lastMsg)
      || /\b(sim|confirmo|correto|pode seguir|isso mesmo)\b/i.test(lastMsg);
    const isDeny = /^(não|nao|n|errado|incorreto|corrigir|alterar|mudar|trocar|refazer)$/i.test(lastMsg)
      || /\b(não|errado|incorreto|trocar|corrigir)\b/i.test(lastMsg);

    if (isConfirm) {
      conv.nfseTaskCreated = true;
      conv.nfseData.awaitingConfirmation = false;
      log(`📄 NFS-e: ${name} CONFIRMOU os dados. Criando task...`);

      try {
        const msg = `Perfeito, ${firstName}! Dados confirmados. Estou encaminhando para o setor fiscal providenciar a emissão.\n\nAssim que a nota estiver pronta, um de nossos colaboradores envia aqui para você 😊`;
        await botSend(chatId, LUNA_HEADER + msg);
        dbSaveMessage(conv, 'luna', msg);
      } catch (err) {
        log(`ERRO confirma NFS-e: ${err.message}`);
      }

      try {
        await createNfseTask(chatId, phone, name, conv);
      } catch (err) {
        log(`ERRO criar task NFS-e: ${err.message}`);
        conv.nfseRequested = false;
        conv.nfseTaskCreated = false;
        conv.nfseData = null;
        const alertMsg = `🚫 *Erro ao criar task NFS-e*\nCliente: ${name}\nErro: ${err.message}`;
        telegram.sendAlert(alertMsg.replace(/\*/g, ''));
        try { await sendAlertToGroup(alertMsg); } catch {}
      }
      return true;
    } else if (isDeny) {
      conv.nfseData.awaitingConfirmation = false;
      conv.nfseData.respostas = []; // Limpa para recomeçar
      conv.nfseData.askCount = 0;
      log(`📄 NFS-e: ${name} NEGOU os dados. Reiniciando coleta...`);

      try {
        const msg = `Sem problemas, ${firstName}! Por favor, me envie novamente os dados corretos:\n\n1️⃣ *CPF ou CNPJ* do tomador\n2️⃣ *Valor do serviço*\n3️⃣ *Descrição do serviço prestado*`;
        await botSend(chatId, LUNA_HEADER + msg);
        dbSaveMessage(conv, 'luna', msg);
      } catch (err) {
        log(`ERRO reiniciar coleta NFS-e: ${err.message}`);
      }
      return true;
    } else {
      // Mensagem ambígua — pedir confirmação clara
      try {
        const msg = `${firstName}, desculpe, não entendi. Você confirma os dados que enviei? Responda *sim* para confirmar ou *não* para corrigir 😊`;
        await botSend(chatId, LUNA_HEADER + msg);
        dbSaveMessage(conv, 'luna', msg);
      } catch (err) {
        log(`ERRO pedir confirmação NFS-e: ${err.message}`);
      }
      return true;
    }
  }

  const cpfCnpj = extractCpfCnpj(allText);
  const valor = extractValor(allText);
  const cep = extractCep(allText);
  const descricao = extractDescricao(allText);

  log(`📄 NFS-e extração: CPF/CNPJ=${cpfCnpj?.[0] || 'null'} | valor=${valor?.[0] || 'null'} | desc=${descricao || 'null'} | msgs=${conv.nfseData.respostas.length} | asks=${conv.nfseData.askCount || 0}`);

  // Se tem CPF/CNPJ + valor + descrição → apresentar para confirmação (NÃO criar task direto)
  if (cpfCnpj && valor && descricao) {
    conv.nfseData.awaitingConfirmation = true;

    const docLimpo = cpfCnpj[0].replace(/\D/g, '');
    const docTipo = docLimpo.length === 11 ? 'CPF' : 'CNPJ';
    const docFormatado = docLimpo.length === 11
      ? `${docLimpo.slice(0,3)}.${docLimpo.slice(3,6)}.${docLimpo.slice(6,9)}-${docLimpo.slice(9)}`
      : `${docLimpo.slice(0,2)}.${docLimpo.slice(2,5)}.${docLimpo.slice(5,8)}/${docLimpo.slice(8,12)}-${docLimpo.slice(12)}`;
    const valorStr = valor[0].replace(/[^\d.,]/g, '').replace(',', '.');
    const valorNum = parseFloat(valorStr) || 0;
    const valorFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valorNum);

    try {
      const msg = `${firstName}, entendi! Confirme os dados da nota:\n\n` +
        `📋 *Tomador (${docTipo}):* ${docFormatado}\n` +
        `💰 *Valor:* ${valorFmt}\n` +
        `📝 *Descrição:* ${descricao}\n` +
        `${cep ? `📍 *CEP:* ${cep}\n` : ''}` +
        `\nEstá correto? Posso seguir com a emissão? 😊`;
      await botSend(chatId, LUNA_HEADER + msg);
      dbSaveMessage(conv, 'luna', msg);
      log(`📄 NFS-e: dados apresentados para confirmação de ${name}`);
    } catch (err) {
      log(`ERRO apresentar dados NFS-e: ${err.message}`);
    }
    return true;
  }

  // Conta quantas vezes Luna já pediu dados faltantes
  if (!conv.nfseData.askCount) conv.nfseData.askCount = 0;

  // Após muitas tentativas (Luna já pediu 3+ vezes), cria task com o que tem e deixa fiscal resolver
  if (conv.nfseData.askCount >= 3) {
    conv.nfseTaskCreated = true;

    try {
      const msg = `${firstName}, obrigada pelas informações! Vou encaminhar para o setor fiscal e, caso precise de mais algum dado, entraremos em contato 😊`;
      await botSend(chatId, LUNA_HEADER + msg);
      dbSaveMessage(conv, 'luna', msg);
    } catch (err) {
      log(`ERRO confirma NFS-e parcial: ${err.message}`);
    }

    try {
      await createNfseTask(chatId, phone, name, conv);
    } catch (err) {
      log(`ERRO criar task NFS-e (parcial): ${err.message}`);
      conv.nfseRequested = false;
      conv.nfseTaskCreated = false;
      conv.nfseData = null;
      const alertMsg = `🚫 *Erro ao criar task NFS-e*\nCliente: ${name}\nErro: ${err.message}`;
      telegram.sendAlert(alertMsg.replace(/\*/g, ''));
      try { await sendAlertToGroup(alertMsg); } catch {}
    }
    return true;
  }

  // Verifica se há um documento com formato correto mas dígitos inválidos
  const hasDocPattern = allText.match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\\/\.\s]?\d{4}[\-\.\s]?\d{2}/)
    || allText.match(/\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\-\.\s]?\d{2}/)
    || allText.match(/\b\d{14}\b/) || allText.match(/\b\d{11}\b/);
  const docInvalid = hasDocPattern && !cpfCnpj;

  // Pede o que falta
  const missing = [];
  if (!cpfCnpj) {
    if (docInvalid) {
      missing.push('*CPF ou CNPJ válido* do tomador (o número informado parece estar incorreto — por favor, verifique os dígitos)');
    } else {
      missing.push('*CPF ou CNPJ* do tomador');
    }
  }
  if (!valor) missing.push('*valor do serviço*');

  conv.nfseData.askCount = (conv.nfseData.askCount || 0) + 1;
  log(`📄 NFS-e coleta: pedido #${conv.nfseData.askCount} — faltam: ${missing.join(', ')}`);

  try {
    const msg = `${firstName}, obrigada! Ainda preciso do ${missing.join(' e ')} para prosseguir com a emissão 😊`;
    await botSend(chatId, LUNA_HEADER + msg);
    dbSaveMessage(conv, 'luna', msg);
  } catch (err) {
    log(`ERRO coleta NFS-e: ${err.message}`);
  }

  return true;
}

async function createNfseTask(chatId, phone, name, conv) {
  try {
    // 1. Cruza telefone do solicitante com Gesthub → descobre a empresa emissora
    let prestadorInfo = null;
    const realPhone = conv.realPhone || phone;
    try {
      prestadorInfo = await findClientByPhone(realPhone);
      if (prestadorInfo) {
        log(`📄 Gesthub: ${name} → empresa ${prestadorInfo.legalName} (${prestadorInfo.document})`);
      } else {
        log(`📄 Gesthub: ${name} (${realPhone}) — empresa NÃO encontrada`);
      }
    } catch (err) {
      log(`ERRO buscar Gesthub: ${err.message}`);
    }

    // Se não encontrou empresa, alerta equipe interna (NUNCA perguntar ao cliente)
    if (!prestadorInfo) {
      const alertMsg = `⚠️ *Cadastro desatualizado*\n\nCliente ${name} solicitou NFS-e mas não foi possível identificar a empresa no Gesthub.\nTelefone: ${realPhone}\n\n_Equipe: atualize o cadastro no Gesthub com o telefone/WhatsApp deste cliente._`;
      telegram.sendAlert(alertMsg.replace(/\*/g, ''));
      try { await sendAlertToGroup(alertMsg); } catch {}
    }

    // 2. Monta task com dados enriquecidos
    const { rows: lunaRows } = await query(
      `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Luna'`
    );
    let { rows: fiscalRows } = await query(
      `SELECT tm.id FROM team_members tm WHERE tm.name IN ('Deyvison', 'Campelo') AND tm.status = 'available' ORDER BY tm.type ASC LIMIT 1`
    );

    // Fallback: se nenhum fiscal disponível, busca Campelo independente do status
    if (!fiscalRows.length) {
      const { rows: fallbackRows } = await query(
        `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Campelo' LIMIT 1`
      );
      fiscalRows = fallbackRows;
      if (fiscalRows.length) {
        log(`📄 NFS-e: nenhum fiscal disponível, usando Campelo como fallback`);
      }
    }

    // Se realmente nenhum membro fiscal existe, notifica equipe (NÃO envia ao cliente — já recebeu confirmação)
    if (!fiscalRows.length && !lunaRows.length) {
      const alertMsg = `🚫 *NFS-e sem responsável*\n\nCliente ${name} solicitou NFS-e mas nenhum membro fiscal (Campelo/Deyvison) foi encontrado no sistema.\nTask não pôde ser criada. Verificar seed do banco.`;
      telegram.sendAlert(alertMsg.replace(/\*/g, ''));
      try { await sendAlertToGroup(alertMsg); } catch {}
      return;
    }

    const dadosColetados = conv.nfseData.respostas?.join('\n') || '';
    const prestadorCnpj = prestadorInfo?.document?.replace(/\D/g, '') || '';
    const prestadorNome = prestadorInfo?.legalName || '';

    // Extrai campos estruturados para Campelo não precisar inferir via IA
    const allText = conv.nfseData.respostas?.join('\n') || '';
    const parsedCpfCnpj = extractCpfCnpj(allText);
    const parsedValor = extractValor(allText);
    const parsedCep = extractCep(allText);
    // Tenta extrair descrição (texto que não é número/documento)
    const descricaoMatch = allText.match(/(?:servi[çc]o|descri[çc][aã]o)\s*[:=-]?\s*(.+)/i);
    const parsedDescricao = descricaoMatch?.[1]?.trim() || '';

    const taskResult = await query(
      `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, result)
       VALUES ($1, $2, $3, $4, 'high', $5) RETURNING id`,
      [
        `[NFSE] Emitir nota fiscal — ${name}`,
        `Cliente ${name} (${phone}) solicitou emissão de NFS-e via WhatsApp.
${prestadorInfo ? `\nEMPRESA EMISSORA (do Gesthub): ${prestadorNome} — CNPJ: ${prestadorInfo.document}` : '\nEMPRESA EMISSORA: NÃO IDENTIFICADA — cadastro desatualizado'}
\nDados coletados pela Luna:\n${dadosColetados}\n\nMensagem original: "${conv.nfseData.mensagem_original?.substring(0, 300)}"`,
        fiscalRows[0]?.id || lunaRows[0]?.id,
        lunaRows[0]?.id,
        JSON.stringify({
          tipo: 'emissao_nfse',
          cliente_nome: name,
          cliente_phone: phone,
          cliente_chatId: chatId,
          prestador_cnpj: prestadorCnpj,
          prestador_nome: prestadorNome,
          // Campos estruturados para Campelo
          parsed_fields: {
            tomador_cpf_cnpj: parsedCpfCnpj?.[0]?.replace(/\D/g, '') || null,
            tomador_tipo_doc: parsedCpfCnpj?.[0] ? (parsedCpfCnpj[0].replace(/\D/g, '').length === 11 ? 'CPF' : 'CNPJ') : null,
            valor: parsedValor?.[0]?.replace(/[^\d.,]/g, '').replace(',', '.') || null,
            descricao: parsedDescricao || null,
            cep_tomador: parsedCep || null,
            prestador_cnpj: prestadorCnpj || null,
            prestador_nome: prestadorNome || null,
          },
          dados_coletados: conv.nfseData.respostas,
          mensagem_original: conv.nfseData.mensagem_original,
          solicitado_em: new Date().toISOString(),
        }),
      ]
    );

    const taskId = taskResult.rows[0].id;
    conv.nfseTaskId = taskId;
    // Clear the collection timeout since task was created successfully
    if (conv.nfseCollectionTimer) {
      clearTimeout(conv.nfseCollectionTimer);
      conv.nfseCollectionTimer = null;
    }
    dbUpdateConversation(phone, { classification: 'fiscal' });

    telegram.sendAlert(`📄 Task NFS-e #${taskId.substring(0, 8)} — ${name}${prestadorInfo ? ` (${prestadorNome})` : ' — empresa não identificada'}`);

    // Notificação no chat: task NFS-e criada
    chat({ from: 'Luna', text: `📄 NFS-e solicitada por *${name}*${prestadorInfo ? ` (${prestadorNome})` : ''}. Task criada → Campelo.`, tag: 'nfs-e' });

    if (onTaskCreatedFn) {
      setTimeout(() => onTaskCreatedFn(taskId), 500);
      log(`Task NFS-e disparada para processamento imediato: ${taskId}`);
    }

    dbLogMetric('Luna', 'nfse_requested', { phone, name, taskId, prestador: prestadorCnpj });
    log(`Task NFS-e criada: ${taskId} para ${name}${prestadorInfo ? ` → ${prestadorNome}` : ''}`);

  } catch (err) {
    log(`ERRO criar task NFS-e: ${err.message}`);
  }
}

// ============================================
// ROTEAMENTO DE DEMANDAS → AGENTES
// ============================================
// Agente IA executa, humano revisa/aprova e responde ao cliente
const DEMAND_ROUTING = {
  fiscal:      { agent: 'Campelo',  humans: ['Deyvison', 'Diego', 'Karla'], emoji: '📊', label: 'Fiscal' },
  financeiro:  { agent: 'Sneijder', humans: ['Diogo'],                      emoji: '💰', label: 'Financeiro' },
  societario:  { agent: 'Sofia',    humans: ['Deyvison'],                   emoji: '📜', label: 'Societário' },
  comercial:   { agent: null,       humans: ['Caio'],                       emoji: '🤝', label: 'Comercial' },
  atendimento: { agent: 'Luna',      humans: ['Quésia'],                     emoji: '📋', label: 'Atendimento' },
  pessoal:     { agent: null,       humans: ['Rafaela'],                    emoji: '👥', label: 'Pessoal/Folha' },
};

async function routeDemandToAgent(phone, name, chatId, body, conv, classification) {
  const tipo = classification.classificacao;
  const route = DEMAND_ROUTING[tipo];
  if (!route) return;

  // Evita task duplicada na mesma conversa
  if (conv.demandTaskCreated) return;

  // GUARD 1: Colaborador interno — Luna NAO abre task cliente-facing
  // (ex: Caio manda PDF, Luna nao deve tratar como cliente solicitando nota fiscal)
  let ehColaborador = conv.clientInfo?.isColaborador || conv.isColaborador;
  if (!ehColaborador) {
    try {
      const team = await detectTeamMember(phone) || (conv.realPhone && await detectTeamMember(conv.realPhone));
      if (team && team.nome) {
        ehColaborador = true;
        conv.isColaborador = true;
        log(`[routeDemand] Detectado colaborador interno: ${team.nome}`);
      }
    } catch {}
  }
  if (ehColaborador) {
    log(`[routeDemand] Pulado: ${name} eh colaborador interno, nao abre task de demanda`);
    return;
  }

  // GUARD 2: PDF de extrato bancario ja roteado pro Finance — nao duplicar em outro setor
  if (conv.bankStatementRouted) {
    log(`[routeDemand] Pulado: PDF de extrato ja roteado pro Finance, nao criar task ${tipo}`);
    return;
  }

  // GUARD 3: fiscal (NFS-e) precisa de intent EXPLICITO do cliente no texto.
  // Evita falso positivo quando cliente so manda PDF de extrato com palavras tipo "nota" no conteudo.
  if (tipo === 'fiscal') {
    const textoCliente = String(body || '').toLowerCase();
    const temIntentFiscalExplicito = /(emitir|gerar|preciso|fazer|quero|solicitar)\s+(uma\s+)?(nota|nfs|\bnf\b)/i.test(textoCliente)
      || /emiss[aã]o\s+de\s+(nota|nfs|\bnf\b)/i.test(textoCliente)
      || /\b(nfs-?e|nfe)\b.*\b(emitir|gerar|preciso|quero)\b/i.test(textoCliente);
    if (!temIntentFiscalExplicito) {
      log(`[routeDemand] Fiscal descartado: cliente nao pediu emissao explicitamente. Msg: "${textoCliente.slice(0, 150)}"`);
      try {
        const alertMsg = `🔍 *Classificacao fiscal descartada automaticamente*\n\nCliente: ${name}\nMotivo: LLM classificou como fiscal mas cliente NAO pediu emissao explicitamente (pode ter sido PDF de extrato com palavra "nota" no conteudo).\n\nMensagem cliente: "${textoCliente.slice(0, 200)}"\n\n_Equipe: revisar manualmente se realmente era pedido de nota._`;
        await sendAlertToGroup(alertMsg);
      } catch {}
      return;
    }
  }

  conv.demandTaskCreated = true;

  try {
    // Busca Luna como delegante
    const { rows: lunaRows } = await query(
      `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Luna'`
    );

    // Busca agente IA do setor (executa a tarefa)
    let agentId = null;
    if (route.agent) {
      const { rows } = await query(
        `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = $1 LIMIT 1`,
        [route.agent]
      );
      if (rows.length > 0) agentId = rows[0].id;
    }

    // Busca humano responsável (revisa/aprova e responde ao cliente)
    let humanId = null;
    for (const humanName of route.humans) {
      const { rows } = await query(
        `SELECT tm.id FROM team_members tm WHERE tm.name = $1 AND tm.type = 'human' AND tm.status = 'available' LIMIT 1`,
        [humanName]
      );
      if (rows.length > 0) { humanId = rows[0].id; break; }
    }

    // Task SEMPRE vai para o agente IA — humano apenas revisa/aprova
    if (!agentId) {
      log(`Roteamento ${tipo}: sem agente IA disponível para ${route.agent || 'setor'}. Notificando equipe.`);
      const alertMsg = `📋 *Demanda sem agente IA*\n\nCliente: ${name}\nTipo: ${tipo}\nResumo: ${classification.resumo}\n\n_Precisa de atendimento humano direto._`;
      notifyTeamWhatsApp(alertMsg).catch(() => {});
      telegram.sendAlert(alertMsg.replace(/\*/g, ''));
      return;
    }
    const assigneeId = agentId;
    const humanResponsavel = route.humans[0];

    const taskResult = await query(
      `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING id`,
      [
        `[${route.label.toUpperCase()}] ${classification.resumo} — ${name}`,
        `Cliente ${name} (${phone}) enviou solicitação via WhatsApp.\n\nClassificação: ${tipo}\nPrioridade: ${classification.prioridade}\nResponsável humano: ${humanResponsavel}\n\nMensagem original:\n"${body.substring(0, 500)}"`,
        assigneeId,
        lunaRows[0]?.id,
        classification.prioridade || 'medium',
        JSON.stringify({
          tipo: `demanda_${tipo}`,
          cliente_nome: name,
          cliente_phone: phone,
          cliente_chatId: chatId,
          agente_ia: route.agent,
          responsavel_humano: humanResponsavel,
          classificacao: classification,
          solicitado_em: new Date().toISOString(),
        }),
      ]
    );

    const taskId = taskResult.rows[0].id;
    conv.demandTaskId = taskId;

    // Notifica Telegram + chat inter-agentes
    telegram.sendAlert(`${route.emoji} Task #${taskId.substring(0, 8)} — ${route.label} — ${name} → ${route.agent} (IA) / ${humanResponsavel} (revisão)`);
    // Notificação no chat: demanda roteada
    chat({ from: 'Luna', text: `${route.emoji} Demanda de *${name}* roteada → *${route.agent}* (${route.label})`, tag: tipo });

    dbLogMetric('Luna', 'demand_routed', { phone, name, tipo, taskId, agent: route.agent, human: humanResponsavel });
    log(`Task criada: ${route.label} → ${route.agent} / revisa: ${humanResponsavel} (${taskId.substring(0, 8)}) para ${name}`);

  } catch (err) {
    log(`ERRO routeDemand: ${err.message}`);
  }
}

// ============================================
// ESCALATION
// ============================================
async function startEscalation(phone, chatId, name, fromLevel) {
  const conv = conversations.get(phone);
  if (!conv) return;

  conv.timers.forEach(t => clearTimeout(t));
  conv.timers = [];

  const { levels } = await getAlertConfig();
  for (let i = fromLevel; i < levels.length; i++) {
    const level = levels[i];
    if (!level.active) continue;
    const delay = level.minutes * 60 * 1000;
    log(`Escalation agendada: ${name} → nivel ${i} (${level.severity}) em ${level.minutes}min`);
    conv.timers.push(setTimeout(() => escalate(phone, chatId, name, i), delay));
  }
}

async function escalate(phone, chatId, name, levelIndex) {
  const conv = conversations.get(phone);
  if (!conv || conv.resolved) return;
  if (conv.humanReplied) return; // humano já respondeu, para escalation

  const cfg = await getAlertConfig();
  const level = cfg.levels[levelIndex] || cfg.levels[cfg.levels.length - 1];
  conv.escalationLevel = levelIndex;
  const lastMsg = conv.messages[conv.messages.length - 1]?.body || '';
  dbUpdateConversation(phone, { escalation_level: levelIndex });
  dbLogMetric('Luna', 'escalation', { phone, name, level: levelIndex, severity: level.severity });

  log(`${level.emoji} ${level.label} — ${name} (${phone})`);

  const horario = isHorarioComercial();

  // Mensagem ao cliente — somente em horario comercial
  if (level.client_message && horario.open) {
    try {
      const msg = renderClientMessage(level.client_message, name);
      await botSend(chatId, LUNA_HEADER + msg);
      dbSaveMessage(conv, 'luna', msg);
    } catch (err) {
      log(`ERRO follow-up nivel ${levelIndex}: ${err.message}`);
    }
  } else if (level.client_message && !horario.open) {
    log(`Escalation nivel ${levelIndex} para ${name} — fora do horario, nao envia ao cliente`);
  }

  // Enriquece alerta com classificacao (se conversa ja foi classificada)
  const classificacaoInfo = conv.classification
    ? `\nTipo: *${String(conv.classification.classificacao || '').toUpperCase()}* → *${conv.classification.atendente_sugerido || '-'}*` +
      (conv.classification.resumo ? `\nResumo: _${conv.classification.resumo}_` : '')
    : '';

  const foraHorario = !horario.open ? `\n⏰ _${horario.reason}_` : '';
  const urgencia = levelIndex >= 2 ? '\n\n⚠️ *ACAO IMEDIATA NECESSARIA*' : '';
  const alertMsg = `${level.emoji} *${level.label}*\n\nCliente: *${name}*\nTelefone: ${conv.displayPhone || phone}${classificacaoInfo}\nUltima msg: _${lastMsg.substring(0, 150)}_${foraHorario}${urgencia}`;

  // Telegram: SEMPRE
  telegram.sendAlert(alertMsg);

  // WhatsApp equipe: respeita config por nivel
  if (level.send_to_team && (horario.open || level.team_even_off_hours)) {
    await notifyTeamWhatsApp(alertMsg);
  }

  broadcastFn?.({
    type: 'whatsapp_escalation',
    phone, name,
    severity: level.severity,
    level: levelIndex,
    label: level.label,
  });
}

// ============================================
// ANÁLISE PÓS-ATENDIMENTO
// ============================================
async function analyzeAndReport(phone) {
  const conv = conversations.get(phone);
  if (!conv) return;

  try {
    const result = await analyzeConversation(conv.messages, conv.name);
    if (!result) return;

    conv.analysis = result;
    dbUpdateConversation(phone, { analysis: JSON.stringify(result) });
    dbLogMetric('Luna', 'conversation_analysis', { phone, name: conv.name, nps: result.nps_estimado, sentiment: result.sentimento_cliente, attended: result.demanda_atendida });
    log(`Análise ${conv.name}: atendida=${result.demanda_atendida}, NPS=${result.nps_estimado}, sentimento=${result.sentimento_cliente}`);

    broadcastFn?.({ type: 'whatsapp_conversation_analysis', phone, name: conv.name, analysis: result });

    if (!result.demanda_atendida) {
      const alertMsg = `⚠️ *Demanda não atendida*\n\nCliente: *${conv.name}* (${phone})\nPediu: _${result.demanda_original}_\nMotivo: _${result.motivo}_\nSentimento: ${result.sentimento_cliente}\nNPS: ${result.nps_estimado}/10`;
      await notifyAll(alertMsg);
    }

    if (result.nps_estimado <= 6) {
      telegram.sendAlert(`📊 *NPS Alerta — ${result.nps_estimado}/10*\n\nCliente: *${conv.name}*\nSentimento: ${result.sentimento_cliente}`);
    }

    registerNPS(result, phone, conv.name).catch(() => {});
    addAnalysis(result, conv.name, phone);

    // Auto-resolve SO quando:
    //  1. Luna analisou e disse "demanda_atendida + !precisa_followup", E
    //  2. HOUVE resposta (humano OU Luna) — ninguem respondeu = nao pode estar resolvido
    // Bug antigo: Luna marcava boas-vindas de parceiro como "atendida" mesmo sem resposta.
    const teveResposta = conv.humanReplied === true
      || (conv.messages || []).some(m => m.from === 'team' || m.from === 'bot' || m.from === 'luna');
    if (result.demanda_atendida && !result.precisa_followup && teveResposta) {
      resolveConversation(phone);
      // Marca a razao no banco pra ser rastreavel
      try {
        await query(
          `UPDATE whatsapp_conversations SET resolution_reason = COALESCE(resolution_reason, 'luna_analysis_demanda_atendida')
           WHERE phone = $1 AND resolution_reason IS NULL`,
          [phone]
        );
      } catch {}
    } else if (result.demanda_atendida && !teveResposta) {
      log(`[analyze] ${conv.name}: Luna disse 'atendida' mas ninguem respondeu — NAO auto-resolvendo`);
    }
  } catch (err) {
    log(`ERRO análise ${conv.name}: ${err.message}`);
  }
}

// ============================================
// NOTIFICAÇÕES
// ============================================
async function notifyAll(message) {
  telegram.sendAlert(message);
  await notifyTeamWhatsApp(message);
}

async function notifyTeamWhatsApp(message) {
  // Grupo
  if (NOTIFY_GROUP_ENABLED) {
    const gId = await findGroupChat();
    if (gId) {
      try { await botSend(gId, message); }
      catch (err) { log(`ERRO grupo: ${err.message}`); }
    }
  }

  // Individual
  for (const number of NOTIFY_NUMBERS) {
    try {
      await botSend(`${number}@c.us`, message);
      log(`Alerta enviado para ${number}`);
    } catch (err) {
      log(`ERRO notificar ${number}: ${err.message}`);
    }
  }
}

async function findGroupChat() {
  if (groupChatId) return groupChatId;
  try {
    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name === NOTIFY_GROUP_NAME);
    if (group) groupChatId = group.id._serialized;
    return groupChatId;
  } catch { return null; }
}

// ============================================================
// Redireciona resposta bloqueada pelo kill-switch pro grupo interno.
// Posta um aviso curto + cria/atualiza task na conversa pra alguem responder.
// Throttle: nao posta mais de 1x por minuto pra mesma conversa (evita flood).
// ============================================================
const _redirectThrottle = new Map(); // chatId -> lastSentMs
async function redirectToTeamGroup(clientChatId, suggestedText, opts = {}) {
  try {
    // Throttle 60s por chat
    const now = Date.now();
    const last = _redirectThrottle.get(clientChatId) || 0;
    if (now - last < 60_000) return;
    _redirectThrottle.set(clientChatId, now);

    // Busca contexto da conversa
    const phoneClean = String(clientChatId).split('@')[0].replace(/\D/g, '');
    const { rows } = await query(
      `SELECT id, client_name, display_phone, contact_label, contact_type, real_phone
         FROM whatsapp_conversations
        WHERE phone = $1 OR real_phone = $1
          OR phone = $2 OR real_phone = $2
        ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
      [phoneClean, phoneClean.replace(/^55/, '')]
    ).catch(() => ({ rows: [] }));
    const conv = rows[0] || {};
    const who = conv.contact_label || conv.client_name || conv.display_phone || phoneClean;

    const grupo = await findGroupChat();
    if (!grupo) return; // sem grupo configurado, nada a fazer

    const trimmed = String(suggestedText || '').trim().slice(0, 600);
    const aviso =
      `🤖 *Luna* (modo interno — kill-switch ativo)\n` +
      `Cliente: *${who}* (${phoneClean})\n` +
      `Resposta sugerida (NAO enviada):\n` +
      `> ${trimmed.split('\n').join('\n> ')}\n\n` +
      `Responder pelo painel: http://31.97.175.200:3010/atendimento` + (conv.id ? `?c=${conv.id}` : '');

    botIsSending = true;
    try {
      await client.sendMessage(grupo, aviso);
      await new Promise(r => setTimeout(r, 300));
    } finally {
      botIsSending = false;
    }
    log(`[redirect] aviso postado no grupo interno sobre ${who}`);
  } catch (e) {
    log(`[redirect] erro: ${e.message}`);
  }
}

// ============================================
// ENVIAR MENSAGEM (via dashboard/API)
// ============================================
export async function sendMessage(phone, message, opts = {}) {
  if (!isReady || !client) throw new Error('WhatsApp não conectado');
  let chatId;
  if (phone.includes('@')) {
    // Ja tem suffix — usa direto (chat_id canonico)
    chatId = phone;
  } else {
    // So digits — precisa decidir suffix. Grupo OU individual?
    // Checa no banco: se is_group, usa @g.us; senao @c.us.
    const cleanPhone = phone.replace(/\D/g, '');
    try {
      const { rows } = await query(
        `SELECT is_group, chat_id FROM whatsapp_conversations
         WHERE phone = $1 OR real_phone = $1 LIMIT 1`,
        [cleanPhone]
      );
      if (rows[0]?.chat_id?.includes('@')) {
        chatId = rows[0].chat_id;
      } else if (rows[0]?.is_group) {
        chatId = `${cleanPhone}@g.us`;
      } else {
        chatId = `${cleanPhone}@c.us`;
      }
    } catch {
      chatId = `${cleanPhone}@c.us`;
    }
  }
  const sent = await botSend(chatId, message, { manual: opts.manual === true });
  if (sent === null && !opts.manual) {
    throw new Error('Envio bloqueado: kill-switch agente→cliente ativo. Apenas envios manuais (do painel) podem comunicar com clientes externos.');
  }
  // markAsReplied so faz sentido em conversas individuais (nao grupo)
  if (chatId.endsWith('@c.us')) markAsReplied(phone);

  // Persiste explicitamente no DB pra envios manuais (humano via painel).
  // Antes dependiamos do message_create handler, mas ele e bloqueado quando
  // botIsSending=true causando race condition. Agora gravamos diretamente.
  if (opts.manual && sent) {
    try {
      const phoneClean = String(chatId).split('@')[0].replace(/\D/g, '');
      const { rows } = await query(
        `SELECT id FROM whatsapp_conversations
          WHERE phone = $1 OR real_phone = $1 OR chat_id = $2
          ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
        [phoneClean, chatId]
      );
      const convId = rows[0]?.id;
      if (convId) {
        const waMsgId = sent?.id?._serialized || sent?.id || null;
        // Dedupe por wa_msg_id (caso message_create tambem tenha gravado)
        const dup = waMsgId ? await query(
          `SELECT id FROM whatsapp_messages WHERE conversation_id = $1 AND metadata->>'wa_msg_id' = $2 LIMIT 1`,
          [convId, waMsgId]
        ).catch(() => ({ rows: [] })) : { rows: [] };
        if (!dup.rows.length) {
          await query(
            `INSERT INTO whatsapp_messages (conversation_id, sender, body, metadata)
             VALUES ($1, 'team', $2, $3::jsonb)`,
            [convId, message, JSON.stringify({ wa_msg_id: waMsgId, chat_id: chatId, manual: true, source: 'panel' })]
          );
          await query(`UPDATE whatsapp_conversations SET last_message_at = NOW(), human_replied = TRUE, last_human_reply_at = NOW() WHERE id = $1`, [convId]);
          broadcastFn?.({ type: 'conversation_updated', phone: phoneClean });
          broadcastFn?.({ type: 'message_added', conversation_id: convId });
        }
      }
    } catch (e) {
      log(`[manual-persist] falha: ${e.message}`);
    }
  }
  log(`Enviado para ${chatId}`);
}

// ============================================
// ENVIAR MIDIA (PDF, imagem, audio) via painel Atendimento
// ============================================
export async function sendMedia(phone, base64Data, filename, mimetype, caption = '', opts = {}) {
  if (!isReady || !client) throw new Error('WhatsApp não conectado');

  // Resolve chatId usando mesma logica do sendMessage (suporta grupo)
  let chatId;
  if (phone.includes('@')) {
    chatId = phone;
  } else {
    const cleanPhone = phone.replace(/\D/g, '');
    try {
      const { rows } = await query(
        `SELECT is_group, chat_id FROM whatsapp_conversations WHERE phone = $1 OR real_phone = $1 LIMIT 1`,
        [cleanPhone]
      );
      if (rows[0]?.chat_id?.includes('@')) chatId = rows[0].chat_id;
      else if (rows[0]?.is_group) chatId = `${cleanPhone}@g.us`;
      else chatId = `${cleanPhone}@c.us`;
    } catch { chatId = `${cleanPhone}@c.us`; }
  }

  const sent = await botSendMedia(chatId, base64Data, filename, mimetype, caption, { manual: opts.manual === true });
  if (sent === null && !opts.manual) {
    throw new Error('Envio bloqueado: kill-switch agente→cliente ativo.');
  }
  if (chatId.endsWith('@c.us')) markAsReplied(phone);

  // Persiste explicitamente pra mídia manual (mesmo motivo do sendMessage)
  if (opts.manual && sent) {
    try {
      const phoneClean = String(chatId).split('@')[0].replace(/\D/g, '');
      const { rows } = await query(
        `SELECT id FROM whatsapp_conversations
          WHERE phone = $1 OR real_phone = $1 OR chat_id = $2
          ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
        [phoneClean, chatId]
      );
      const convId = rows[0]?.id;
      if (convId) {
        const waMsgId = sent?.id?._serialized || sent?.id || null;
        const dup = waMsgId ? await query(
          `SELECT id FROM whatsapp_messages WHERE conversation_id = $1 AND metadata->>'wa_msg_id' = $2 LIMIT 1`,
          [convId, waMsgId]
        ).catch(() => ({ rows: [] })) : { rows: [] };
        if (!dup.rows.length) {
          await query(
            `INSERT INTO whatsapp_messages (conversation_id, sender, body, metadata)
             VALUES ($1, 'team', $2, $3::jsonb)`,
            [convId, caption || filename, JSON.stringify({
              wa_msg_id: waMsgId, chat_id: chatId, manual: true, source: 'panel',
              attachment: { filename, mime_type: mimetype, type: mimetype.startsWith('image/') ? 'image' : mimetype.startsWith('video/') ? 'video' : mimetype.startsWith('audio/') ? 'audio' : 'file' }
            })]
          );
          await query(`UPDATE whatsapp_conversations SET last_message_at = NOW(), human_replied = TRUE, last_human_reply_at = NOW() WHERE id = $1`, [convId]);
          broadcastFn?.({ type: 'conversation_updated', phone: phoneClean });
          broadcastFn?.({ type: 'message_added', conversation_id: convId });
        }
      }
    } catch (e) {
      log(`[manual-persist-media] falha: ${e.message}`);
    }
  }
  log(`Enviada midia ${filename} (${mimetype}) para ${chatId}`);
}

// ============================================
// APAGAR MENSAGEM (para todos, via WhatsApp — janela limitada pelo WhatsApp)
// ============================================
// Recebe o wa_msg_id (ex: "true_5581999999@c.us_AB12CD34") e o chat_id.
// Usa whatsapp-web.js: busca a msg no chat e chama msg.delete(true).
// Retorna { ok: true } OU { ok: false, error: string }.
export async function deleteMessageForEveryone(waMsgId, chatId) {
  if (!isReady || !client) throw new Error('WhatsApp não conectado');
  if (!waMsgId) throw new Error('wa_msg_id ausente');

  // Deriva chat_id do proprio wa_msg_id se nao veio explicito
  // Formato: "true_<chatId>_<hash>"  ou  "false_<chatId>_<hash>"
  let resolvedChatId = chatId;
  if (!resolvedChatId && typeof waMsgId === 'string') {
    const parts = waMsgId.split('_');
    if (parts.length >= 3) resolvedChatId = parts[1];
  }
  if (!resolvedChatId) throw new Error('chat_id nao pode ser derivado do wa_msg_id');

  const chat = await client.getChatById(resolvedChatId);
  if (!chat) throw new Error('Chat nao encontrado');

  // Pega as ultimas 100 mensagens do chat procurando a nossa
  const msgs = await chat.fetchMessages({ limit: 100 });
  const target = msgs.find(m => (m.id?._serialized || m.id) === waMsgId);
  if (!target) throw new Error('Mensagem nao encontrada no chat (pode ter sido apagada ou estar muito antiga)');

  await target.delete(true); // true = delete for everyone
  log(`Mensagem apagada para todos: ${waMsgId}`);
  return { ok: true };
}

// ============================================
// ENVIAR NFS-e NO GRUPO (PDF + caption)
// ============================================
export async function sendNfseToGroup({ pdfBase64, clienteNome, tomadorNome, tomadorDoc, valor, numeroNfse, taskId }) {
  if (!isReady || !client) {
    log('WhatsApp não conectado — NFS-e não enviada ao grupo');
    return false;
  }

  const gid = await findGroupChat();
  if (!gid) {
    log('Grupo não encontrado — NFS-e não enviada');
    return false;
  }

  const valorFmt = typeof valor === 'number' ? `R$ ${valor.toFixed(2).replace('.', ',')}` : `R$ ${valor}`;
  const caption = `📄 *NFS-e emitida*\n\nCliente: *${clienteNome}*\nTomador: ${tomadorNome} (${tomadorDoc})\nValor: ${valorFmt}${numeroNfse ? `\nNº: ${numeroNfse}` : ''}${taskId ? `\nTask: #${taskId.substring(0, 8)}` : ''}`;

  try {
    if (pdfBase64) {
      await botSendMedia(gid, pdfBase64, `nfse-${numeroNfse || Date.now()}.pdf`, 'application/pdf', caption);
      log(`NFS-e PDF enviado no grupo — ${clienteNome}`);
    } else {
      await botSend(gid, caption);
      log(`NFS-e notificação enviada no grupo (sem PDF) — ${clienteNome}`);
    }
    return true;
  } catch (err) {
    log(`ERRO enviar NFS-e no grupo: ${err.message}`);
    return false;
  }
}

// ============================================
// ALERTA GENÉRICO NO GRUPO (erros, bloqueios, avisos)
// ============================================
export async function sendAlertToGroup(message) {
  if (!isReady || !client) {
    log('WhatsApp não conectado — alerta não enviado ao grupo');
    return false;
  }
  const gid = await findGroupChat();
  if (!gid) {
    log('Grupo não encontrado — alerta não enviado');
    return false;
  }
  try {
    await botSend(gid, message);
    log('Alerta enviado ao grupo');
    return true;
  } catch (err) {
    log(`ERRO enviar alerta no grupo: ${err.message}`);
    return false;
  }
}

// ============================================
// CLEANUP
// ============================================
export async function destroy() {
  conversations.forEach(conv => {
    conv.timers.forEach(t => clearTimeout(t));
    if (conv.greetingTimer) clearTimeout(conv.greetingTimer);
    if (conv.analysisTimer) clearTimeout(conv.analysisTimer);
  });
  conversations.clear();
  if (client) { await client.destroy(); client = null; isReady = false; qrCodeData = null; }
}

// ============================================
// AUTO-HEALING — monitora Chromium/Puppeteer e reinicia automaticamente
// Detecta 3 sintomas:
//  1) isReady=false por >3min sem QR ativo (conexao travada)
//  2) Processo browser subjacente morto (pid nao existe)
//  3) Muitos processos defunct ("zumbis") indicando crash parcial
// ============================================
let _healStartedAt = null;
let _lastDisconnectReportedAt = 0;

async function checkChromiumHealth() {
  const status = { connected: isReady, hasQR: !!qrCodeData };

  // Sintoma 1: cliente nem inicializado ha muito tempo
  if (!client) {
    status.reason = 'client-null';
    status.needsHeal = true;
    return status;
  }

  // Sintoma 2: browser pid morreu
  try {
    const browserPid = client.pupBrowser?.process()?.pid;
    if (browserPid) {
      try {
        process.kill(browserPid, 0); // signal 0 = check if alive
        status.browserPid = browserPid;
      } catch (e) {
        status.reason = 'browser-pid-dead:' + browserPid;
        status.needsHeal = true;
        return status;
      }
    }
  } catch (e) { /* pupBrowser indisponivel = client nao totalmente pronto, ignora */ }

  // Sintoma 3: zumbis demais (threshold: 8+)
  try {
    const { execSync } = await import('child_process');
    const zombieCount = parseInt(execSync("ps aux | awk '$8 ~ /Z/' | wc -l").toString().trim(), 10) || 0;
    status.zombies = zombieCount;
    if (zombieCount >= 8) {
      status.reason = 'too-many-zombies:' + zombieCount;
      status.needsHeal = true;
      return status;
    }
  } catch (e) { /* no-op */ }

  // Sintoma 4: disconnected por mais de 3min sem QR em tela
  if (!isReady && !qrCodeData) {
    if (!_lastDisconnectReportedAt) _lastDisconnectReportedAt = Date.now();
    const disconnectedFor = Date.now() - _lastDisconnectReportedAt;
    if (disconnectedFor > 3 * 60 * 1000) {
      status.reason = 'stuck-no-qr:' + Math.round(disconnectedFor / 1000) + 's';
      status.needsHeal = true;
      return status;
    }
  } else {
    _lastDisconnectReportedAt = 0;
  }

  return status;
}

async function healChromium(reason) {
  // Cooldown: nao cura 2x em menos de 2min
  if (_healStartedAt && (Date.now() - _healStartedAt) < 2 * 60 * 1000) {
    log('[auto-heal] em cooldown, pulando');
    return false;
  }
  _healStartedAt = Date.now();
  log('[auto-heal] acionado: ' + reason);
  try {
    if (client) {
      try { await client.destroy(); } catch (e) { log('[auto-heal] destroy falhou: ' + e.message); }
    }
    client = null;
    isReady = false;
    qrCodeData = null;
    _lastDisconnectReportedAt = 0;

    // Aguarda 3s pra sistema limpar processos
    await new Promise(r => setTimeout(r, 3000));

    // Reinicia (NaO apaga sessao — mantem login)
    await initialize();
    log('[auto-heal] initialize() chamado');
    return true;
  } catch (e) {
    log('[auto-heal] ERRO: ' + e.message);
    return false;
  }
}

export function startHealthcheck(intervalMs = 90 * 1000) {
  log('[auto-heal] healthcheck iniciado (interval ' + (intervalMs/1000) + 's)');
  setInterval(async () => {
    try {
      const status = await checkChromiumHealth();
      if (status.needsHeal) {
        await healChromium(status.reason);
      }
    } catch (e) {
      log('[auto-heal] check falhou: ' + e.message);
    }
  }, intervalMs);
}

export async function getHealthStatus() {
  return await checkChromiumHealth();
}


// ============================================
// AUTO-INGEST DE MIDIA (PDF / IMAGEM)
// Chamado pelo handler do WhatsApp quando msg.hasMedia.
// Baixa o arquivo, despacha para o pipeline de ingest e cria memoria vinculada ao cliente.
// A memoria entra como 'draft' — requer aprovacao via UI /docs.
// ============================================
// Faz upload de extrato pro Atrio Finance (banking-system) e retorna { ok, uploadId, transactions }
async function uploadExtratoToFinance({ buffer, filename, clienteId, ano, mes }) {
  if (!buffer || !clienteId) return { ok: false, error: 'dados insuficientes pra upload' };
  const FINANCE_URL = process.env.ATRIO_FINANCE_URL || process.env.BANKING_URL || 'http://atrio-banking-system-1:3000';
  try {
    // Node 20+ tem FormData nativo; File/Blob tambem
    const form = new FormData();
    const blob = new Blob([buffer], { type: 'application/pdf' });
    form.append('file', blob, filename || `extrato-${Date.now()}.pdf`);
    form.append('cliente_id', String(clienteId));
    form.append('ano', String(ano));
    form.append('mes', String(mes));

    const resp = await fetch(`${FINANCE_URL}/api/uploads`, { method: 'POST', body: form });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: data?.detail || `HTTP ${resp.status}` };
    return {
      ok: true,
      uploadId: data?.data?.id,
      transactions: data?.data?.transacoes_count || data?.data?.num_transactions || 0,
      periodo: data?.data ? `${data.data.periodo_inicio || ''} a ${data.data.periodo_fim || ''}` : null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function autoIngestWhatsAppMedia(msg, clientInfo, conversationInfo) {
  // Pseudo-msg de URL Gestta: usa buffer pre-baixado em vez de hasMedia
  let media, buffer, mime, filename;
  if (msg?._gesttaBuffer) {
    buffer = msg._gesttaBuffer;
    mime = msg._gesttaMime || 'application/pdf';
    filename = msg._gesttaFilename || `gestta_${Date.now()}.pdf`;
    log(`[AutoIngest] usando buffer Gestta pre-baixado: ${filename}`);
  } else {
    if (!msg?.hasMedia) return null;
    try {
      media = await msg.downloadMedia();
      if (!media || !media.data) return null;
    } catch (e) { log(`[AutoIngest] downloadMedia falhou: ${e.message}`); return null; }
    mime = media.mimetype || '';
    filename = media.filename || `whatsapp_${Date.now()}`;
  }
  try {
    const fnameLower = filename.toLowerCase();
    // Tipos aceitos: PDF, imagem, OFX (extratos bancarios), CSV (extratos Nubank etc)
    const isPdf = mime === 'application/pdf' || fnameLower.endsWith('.pdf');
    const isImage = mime.startsWith('image/');
    const isOfx = fnameLower.endsWith('.ofx') || fnameLower.endsWith('.qfx') || mime === 'application/x-ofx';
    const isCsv = fnameLower.endsWith('.csv') || mime === 'text/csv';
    if (!isPdf && !isImage && !isOfx && !isCsv) {
      log(`[AutoIngest] ignorando mime nao suportado: ${mime} (${filename})`);
      return null;
    }

    if (!buffer) buffer = Buffer.from(media.data, 'base64');

    // Fast-path pra OFX/CSV: assume extrato bancario e vai direto pro Atrio Finance /auto
    if (isOfx || isCsv) {
      log(`[AutoIngest] ${filename} (${isOfx ? 'OFX' : 'CSV'}) -> Atrio Finance /auto`);
      try {
        const FINANCE_URL = process.env.ATRIO_FINANCE_URL || 'http://atrio-banking-system-1:3000';
        const form = new FormData();
        const blob = new Blob([buffer], { type: isOfx ? 'application/x-ofx' : 'text/csv' });
        form.append('file', blob, filename);
        const resp = await fetch(`${FINANCE_URL}/api/uploads/auto`, { method: 'POST', body: form });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data?.ok) {
          const uploadId = data?.data?.id;
          const numTx = data?.data?.transacoes_count || data?.data?.num_transactions || 0;
          log(`[AutoIngest] ${filename} -> upload #${uploadId} (${numTx} transacoes)`);
          try {
            chat({ from: 'Sneijder', text: `💾 ${isOfx ? 'OFX' : 'CSV'} de ${clientInfo?.name || 'cliente'} (${filename}) carregado no Atrio Finance — upload #${uploadId}, ${numTx} transações.`, tag: 'atrio-finance' });
          } catch {}
          return { ok: true, doc_type: 'extrato', upload_id: uploadId, transacoes: numTx, type: isOfx ? 'ofx' : 'csv' };
        }
        // Falhou: log detalhado + task manual pro Sneijder
        const errMsg = typeof data?.detail === 'object' ? JSON.stringify(data.detail) : (data?.detail || `HTTP ${resp.status}`);
        log(`[AutoIngest] ${filename} upload /auto falhou: ${errMsg}`);
        try {
          chat({ from: 'Luna', text: `⚠️ ${isOfx ? 'OFX' : 'CSV'} de ${clientInfo?.name || 'cliente'} (${filename}) chegou mas nao identifiquei a conta. Sneijder: cadastrar conta bancaria ou fazer upload manual.`, tag: 'atrio-finance' });
        } catch {}
        // Cria task manual
        try {
          const { rows: tmRows } = await query(
            `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Sneijder' LIMIT 1`
          );
          if (tmRows[0]?.id) {
            await query(
              `INSERT INTO tasks (title, description, client_id, assigned_to, priority, status, result, created_at)
               VALUES ($1, $2, $3, $4, 'medium', 'pending', $5::jsonb, NOW())`,
              [
                `[EXTRATO] ${filename} — conta nao cadastrada`,
                `Arquivo ${isOfx ? 'OFX' : 'CSV'} recebido via WhatsApp de ${clientInfo?.name || msg.from}.\nFilename: ${filename}\nErro auto-detect: ${errMsg}\n\nAção: cadastrar conta bancaria no Atrio Finance e fazer upload manual.`,
                clientInfo?.id || null,
                tmRows[0].id,
                JSON.stringify({ origem: 'whatsapp_auto_route', file_type: isOfx ? 'ofx' : 'csv', filename, error: errMsg }),
              ]
            );
          }
        } catch (e) { log('[AutoIngest] task manual falhou: ' + e.message); }
        return { ok: false, error: errMsg, type: isOfx ? 'ofx' : 'csv' };
      } catch (e) {
        log(`[AutoIngest] ${filename} upload /auto excecao: ${e.message}`);
        return { ok: false, error: e.message };
      }
    }

    // Busca o agent_id da Luna para marcar a origem
    let lunaAgentId = null;
    try {
      const { rows } = await query(`SELECT id FROM agents WHERE name='Luna' LIMIT 1`);
      lunaAgentId = rows[0]?.id || null;
    } catch {}

    const meta = {
      filename,
      client_id: clientInfo?.id ? String(clientInfo.id) : null,
      agent_id: lunaAgentId,
      title: msg.body?.trim() || filename,
      msg_body: msg.body || '',  // pra classificador de doc fiscal usar texto da msg
      tags: ['whatsapp', isPdf ? 'pdf' : 'imagem'],
      source_channel: 'whatsapp',    // gate: whatsapp SEMPRE vai pra draft
      forceDraft: true,              // reforco: midia de cliente exige revisao humana
      metadata: {
        whatsapp_msg_id: msg.id?._serialized || msg.id,
        conversation_id: conversationInfo?.id || null,
        client_phone: msg.from,
        received_at: new Date().toISOString(),
      },
    };

    const result = await ingestFile(buffer, mime, meta);
    logEvent({
      actor_type: 'agent', actor_id: lunaAgentId, actor_name: 'Luna',
      event_type: 'memory.ingest.whatsapp', action: 'auto',
      entity_type: 'memory',
      entity_id: result.memory_id || (result.memory_ids && result.memory_ids[0]) || null,
      payload: { filename, mime, client_id: clientInfo?.id, phone: msg.from, ok: result.ok, doc_type: result.doc_type, chunks: result.chunks },
      source: 'whatsapp',
      severity: result.ok ? 'info' : 'warn',
    });
    log(`[AutoIngest] ${filename} → ${result.ok ? 'ok' : 'fail'} (${result.type}${result.ok ? (result.memory_id ? ', mem='+result.memory_id.slice(0,8) : (result.memory_ids?.length ? ', chunks='+result.memory_ids.length : '')) : ': '+result.error})`);

    // Notifica equipe no chat interno (NAO responde o cliente — regra feedback_nfse_notificacao)
    // Mensagem varia conforme destino real do PDF:
    //   1. Extrato roteado com sucesso pro Finance → info
    //   2. Extrato detectado MAS Finance rejeitou (sem conta/cliente) → delega task pro Sneijder
    //   3. Doc normal pro RAG → pendente aprovacao
    if (typeof chat === "function") {
      const who = clientInfo?.name || clientInfo?.legalName || 'Cliente';
      try {
        if (result.ok && result.routed === 'banking') {
          // Sucesso no Finance
          const bancoTxt = result.banco ? ` (${result.banco.toUpperCase()})` : '';
          const txt = result.imported != null
            ? `✅ Extrato${bancoTxt} importado: ${result.imported} transações${result.skipped ? `, ${result.skipped} duplicadas ignoradas` : ''}${result.contaCriada ? ' — conta criada automaticamente' : ''}`
            : `✅ Extrato${bancoTxt} enviado ao Atrio Finance`;
          chat({ from: 'Luna', text: `📎 ${who} enviou ${filename}\n${txt}`, tag: 'ingest' });
        } else if (!result.ok && result.skipped_memory) {
          // Extrato detectado mas precisa intervenção — cria task pro Sneijder
          const banco = result.classification?.bankHint || 'banco';
          const clienteInfo = result.cliente_id ? `cliente #${result.cliente_id}` : '(cliente nao identificado)';
          try {
            await query(
              `INSERT INTO tasks (title, description, client_id, assigned_to, priority, status, result, created_at)
               VALUES ($1, $2, $3, $4, 'high', 'pending', $5::jsonb, NOW())`,
              [
                `Extrato ${banco.toUpperCase()} precisa ação — ${who}`,
                `Extrato PDF recebido via WhatsApp nao pode ser importado automaticamente.\n\n` +
                `Arquivo: ${filename}\n` +
                `Cliente: ${clienteInfo}\n` +
                `Motivo: ${result.error || 'sem detalhes'}\n\n` +
                `Ação: abrir Atrio Finance > Extratos e importar manualmente ou cadastrar conta primeiro.`,
                result.cliente_id || null,
                'a0000001-0000-0000-0000-000000000003',  // Sneijder
                JSON.stringify({
                  source: 'whatsapp_auto_ingest',
                  filename,
                  phone: msg.from,
                  classification: result.classification,
                  file_path: result.file_path,
                }),
              ]
            );
            chat({
              from: 'Luna',
              text: `📎 ${who} enviou extrato ${banco.toUpperCase()} (${filename})\n⚠️ Nao importei automaticamente: ${result.error}\n→ Criei task pro *Sneijder* processar em Finance`,
              tag: 'ingest'
            });
          } catch (e) {
            log('[auto-ingest] falha ao criar task Sneijder: ' + e.message);
            chat({
              from: 'Luna',
              text: `📎 ${who} enviou extrato ${banco.toUpperCase()} (${filename})\n⚠️ Nao consegui importar nem criar task: ${e.message}`,
              tag: 'ingest'
            });
          }
        } else if (result.ok && result.type === 'image') {
          // Imagem vai pra RAG como sempre
          const preview = `${result.doc_type || 'imagem'}: ${result.summary?.slice(0, 160) || ''}`;
          chat({ from: 'Luna', text: `📎 ${who} enviou imagem: ${filename}\n${preview}\n(Pendente de aprovação na aba Documentos)`, tag: 'ingest' });
        } else if (result.ok && result.memory_ids) {
          // PDF comum foi pra RAG
          const preview = `PDF ${result.pages || '?'}p, ${result.chunks || result.memory_ids?.length || 0} chunks — ${result.preview?.slice(0, 160) || ''}`;
          chat({ from: 'Luna', text: `📎 ${who} enviou PDF: ${filename}\n${preview}\n(Pendente de aprovação na aba Documentos)`, tag: 'ingest' });
        } else if (!result.ok) {
          chat({ from: 'Luna', text: `📎 ${who} enviou ${filename}\n⚠️ Erro na ingestão: ${result.error || 'desconhecido'}`, tag: 'ingest' });
        }
      } catch {}
    }

    // IDENTIFICAÇÃO DO CLIENTE REAL: se o PDF tem CNPJ/CPF, usa pra achar cliente certo no Gesthub
    // (ex: Kamille envia PDF do Instituto Maria Joana — cliente real é o instituto, não Kamille)
    let realClientId = clientInfo?.id || null;
    let realClientName = clientInfo?.name || clientInfo?.legalName || null;
    if (result.ok && result.structured) {
      const docCnpj = String(result.structured.cnpj || '').replace(/\D/g, '');
      const docCpf = String(result.structured.cpf || '').replace(/\D/g, '');
      const docToSearch = docCnpj.length === 14 ? docCnpj : (docCpf.length === 11 ? docCpf : null);
      if (docToSearch) {
        try {
          const gh = await import('./gesthub.js');
          const clients = await gh.getClients();
          const hit = clients.find(c => (c.document || '').replace(/\D/g, '') === docToSearch);
          if (hit) {
            realClientId = hit.id;
            realClientName = hit.legalName || hit.tradeName || result.structured.razao_social || realClientName;
            log(`[AutoRoute] PDF do cliente ${realClientName} (${docToSearch}) — enviado via contato ${clientInfo?.name || msg.from}`);
          }
        } catch (e) { log('[AutoRoute] gesthub lookup falhou: ' + e.message); }
      }
    }

    // ORQUESTRAÇÃO: rotear documento ao agente correto via task
    // Mapeia doc_type → agente responsável. Documentos sem match ficam em /docs aguardando humano.
    if (result.ok && result.doc_type && realClientId) {
      const DOC_TYPE_TO_AGENT = {
        extrato:      { agent: 'Sneijder', action: 'Upload no Atrio Finance + conciliação' },
        comprovante:  { agent: 'Sneijder', action: 'Registrar no Atrio Finance (contas a pagar/receber)' },
        boleto:       { agent: 'Sneijder', action: 'Lançar em contas a pagar no Atrio Finance' },
        nota_fiscal:  { agent: 'Campelo', action: 'Conferir emissão/classificação fiscal' },
        contrato:     { agent: 'Saldanha', action: 'Analisar cláusulas e arquivar' },
      };
      const route = DOC_TYPE_TO_AGENT[result.doc_type];
      if (route) {
        // Se extrato, tenta upload direto pro Atrio Finance antes da task
        let uploadInfo = null;
        if (result.doc_type === 'extrato') {
          const structured = result.structured || {};
          const periodFinal = String(structured.periodo_final || structured.periodo_inicial || '').slice(0, 10);
          const mm = periodFinal.match(/^(\d{4})-(\d{2})/);
          const ano = mm ? parseInt(mm[1], 10) : new Date().getFullYear();
          const mes = mm ? parseInt(mm[2], 10) : new Date().getMonth() + 1;
          uploadInfo = await uploadExtratoToFinance({
            buffer, filename, clienteId: realClientId, ano, mes,
          });
          if (uploadInfo.ok) {
            log(`[AutoRoute] extrato → Atrio Finance upload #${uploadInfo.uploadId} (${uploadInfo.transactions} transacoes)`);
            chat({ from: 'Sneijder', text: `💾 Extrato de ${realClientName} carregado no Atrio Finance — upload #${uploadInfo.uploadId}, ${uploadInfo.transactions} transações. Conciliação disponível.`, tag: 'atrio-finance' });
          } else {
            log(`[AutoRoute] upload Atrio Finance falhou: ${uploadInfo.error}`);
          }
        }
        try {
          const { rows: tmRows } = await query(
            `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = $1 LIMIT 1`,
            [route.agent]
          );
          const assignedId = tmRows[0]?.id;
          if (assignedId) {
            const title = `[${String(result.doc_type).toUpperCase()}] ${realClientName || 'Cliente'} — ${route.action}`;
            const contatoLinha = (clientInfo?.name && clientInfo.name !== realClientName)
              ? `Enviado por: ${clientInfo.name} (${msg.from})\nCliente real (do documento): ${realClientName}\n\n`
              : `Cliente: ${realClientName || '—'} (${msg.from})\n\n`;
            const desc = contatoLinha
              + `Tipo detectado: ${result.doc_type}\n`
              + `Arquivo: ${filename}\n`
              + (result.structured?.banco ? `Banco: ${result.structured.banco}\n` : '')
              + (result.structured?.valor ? `Valor: R$ ${result.structured.valor}\n` : '')
              + (result.summary ? `\nResumo:\n${result.summary.slice(0, 400)}\n` : '')
              + (uploadInfo && uploadInfo.ok
                  ? `\n✅ Upload automatico no Atrio Finance: #${uploadInfo.uploadId} (${uploadInfo.transactions} transacoes). Ação: conciliar.`
                  : (uploadInfo && uploadInfo.error
                    ? `\n⚠️ Upload automatico FALHOU: ${uploadInfo.error}. Ação: subir manualmente.`
                    : `\nAção solicitada: ${route.action}`));
            const { rows: taskRows } = await query(
              `INSERT INTO tasks (title, description, client_id, assigned_to, priority, status, result, created_at)
               VALUES ($1, $2, $3, $4, 'medium', 'pending', $5::jsonb, NOW())
               RETURNING id`,
              [
                title.slice(0, 255),
                desc,
                realClientId,
                assignedId,
                JSON.stringify({
                  doc_type: result.doc_type,
                  memory_id: result.memory_id || null,
                  filename,
                  phone: msg.from,
                  structured: result.structured || {},
                  origem: 'whatsapp_auto_route',
                }),
              ]
            );
            log(`[AutoRoute] ${result.doc_type} → ${route.agent} (task ${taskRows[0]?.id?.slice(0,8)})`);
            const quemMandou = (clientInfo?.name && clientInfo.name !== realClientName)
              ? `${clientInfo.name} (doc é de ${realClientName})`
              : realClientName;
            chat({
              from: 'Luna',
              text: `🔀 Roteado: ${result.doc_type} de ${quemMandou} → *${route.agent}*.\n${route.action}`,
              tag: 'ingest'
            });
          }
        } catch (e) { log('[AutoRoute] falhou: ' + e.message); }
      } else {
        log(`[AutoRoute] doc_type=${result.doc_type} sem rota definida — fica em /docs pra triagem humana`);
      }
    }

    return result;
  } catch (err) {
    log(`[AutoIngest] ERRO: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
