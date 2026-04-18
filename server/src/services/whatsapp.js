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
import { createNotification } from './notifications.js';
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

async function dbSaveMessage(conv, sender, body, metadata = {}) {
  if (!conv.dbId) return;
  try {
    await query(`INSERT INTO whatsapp_messages (conversation_id, sender, body, metadata) VALUES ($1, $2, $3, $4)`,
      [conv.dbId, sender, body, JSON.stringify(metadata)]);
    await query(`UPDATE whatsapp_conversations SET last_message_at = NOW() WHERE id = $1`, [conv.dbId]);
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
const CLIENT_MESSAGES = {
  0: (name) => {
    const firstName = (name || '').split(' ')[0];
    return `${firstName}, agradecemos a paciência! Notamos que você ainda está aguardando. Nossa equipe está empenhada em finalizar os atendimentos atuais para te responder com a atenção que você merece.\n\nSe preferir, pode deixar os detalhes da sua solicitação descritos abaixo. Isso ajuda muito a nossa equipe a te dar um retorno mais assertivo e rápido assim que assumirmos seu chat! 😊`;
  },
  1: (name) => {
    const firstName = (name || '').split(' ')[0];
    return `${firstName}, agradecemos a espera! Estamos com um volume elevado de atendimentos hoje. Sua solicitação é prioridade e um colaborador entrará em contato em breve. 💙`;
  },
  2: (name) => {
    const firstName = (name || '').split(' ')[0];
    const horario = isHorarioComercial();
    if (!horario.open) {
      return `${firstName}, nosso time encerrou o expediente, mas sua mensagem está salva e será a primeira a ser respondida amanhã às 8h.\n\nSe for algo extremamente urgente, entre em contato pelo ${CONTACT_PHONE} 🔔`;
    }
    return `${firstName}, sabemos que a espera está longa. Sua solicitação é prioridade e estimamos que um colaborador assuma seu atendimento nos próximos minutos.\n\nSe for algo extremamente urgente, entre em contato pelo ${CONTACT_PHONE} 🔔`;
  },
  3: (name) => {
    const firstName = (name || '').split(' ')[0];
    return `${firstName}, sua solicitação está sendo tratada internamente e um responsável entrará em contato com você. Agradecemos a compreensão. 🙏`;
  },
  4: null, // 6h: só equipe
  5: null, // 12h: só equipe
  6: null, // 24h: só equipe
};

const NOTIFY_NUMBERS = ['5581997166091'];
const CONTACT_PHONE = '(81) 9971-66091';

// Grupo — desabilitado em fase de testes
const NOTIFY_GROUP_ENABLED = true;
const NOTIFY_GROUP_NAME = 'Luna_Atendimento';
let groupChatId = null;

const FERIADOS_FIXOS = ['01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'];

const LUNA_HEADER = '✨ *Luna — Assistente Virtual* | Átrio Contabilidade\n\n';
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

function isHorarioComercial() {
  const n = now();
  const day = n.getDay();
  const hour = n.getHours();
  const mmdd = `${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;

  const isWeekend = day === 0 || day === 6;
  const isHoliday = FERIADOS_FIXOS.includes(mmdd);
  const isLunch = hour >= 12 && hour < 13;
  const open = !isWeekend && !isHoliday && hour >= 8 && hour < 18 && !isLunch;

  const reason = isWeekend ? 'final de semana' : isHoliday ? 'feriado' : isLunch ? 'horário de almoço' : (hour < 8 || hour >= 18) ? 'fora do horário' : null;
  return { open, isLunch, reason };
}

// ============================================
// Buffer de inbound — agrupa mensagens do mesmo contato em 10s
// antes de enviar pra Luna (evita respostas duplicadas)
// ============================================
const __lunaInboundBuffer = new Map();
const LUNA_DEBOUNCE_MS = Number(process.env.LUNA_DEBOUNCE_MS || 2500);

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
  // Flush rapido (1.5s) pra mensagens que parecem completas: terminam com pontuacao
  // final ou sao saudacoes curtas isoladas (oi/ola/bom dia/etc)
  const body = (msg.body || '').trim();
  const looksComplete = /[.!?]$/.test(body) || /^(oi|ola|olá|bom dia|boa tarde|boa noite|hey|hi|e ai|eai)[.!?\s]*$/i.test(body);
  const waitMs = looksComplete ? 1500 : LUNA_DEBOUNCE_MS;
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
  __lunaInboundBuffer.delete(phone);
  const combinedBody = entry.msgs.filter(Boolean).join('\n');
  const msg = entry.latestMsg;
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
        log('[Handoff] ' + phone + ' — humano inativo ha ' + Math.round(minutesSinceHuman) + 'min, Luna retoma + alerta');
        try {
          await query(`INSERT INTO public.tasks (title, status, result, created_at)
                       VALUES ($1, 'pending', $2::jsonb, now())`,
            ['[ALERTA] Atendimento humano em inercia — ' + phone,
             JSON.stringify({ type: 'handoff_inertia', conversation_id: r.id, phone, minutos_sem_resposta: Math.round(minutesSinceHuman) })]);
        } catch (_) {}
      }
      if (humanOwns && lastOutShort) {
        log('[Handoff] ' + phone + ' — resposta humana vaga, Luna retoma + alerta');
        try {
          await query(`INSERT INTO public.tasks (title, status, result, created_at)
                       VALUES ($1, 'pending', $2::jsonb, now())`,
            ['[ALERTA] Resposta humana vaga — ' + phone,
             JSON.stringify({ type: 'handoff_vague', conversation_id: r.id, phone, ultima_resposta: r.last_outbound_body })]);
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

async function botSend(chatId, text) {
  if (!client) throw new Error('WhatsApp não conectado');

  // NUNCA enviar para status/broadcast/stories
  if (!chatId || chatId === 'status@broadcast' || chatId.includes('@broadcast')) {
    log(`BLOQUEADO: tentativa de enviar para ${chatId}`);
    return null;
  }

  botIsSending = true;
  try {
    const sent = await client.sendMessage(chatId, text);
    // Espera o message_create processar antes de liberar
    await new Promise(r => setTimeout(r, 500));
    return sent;
  } finally {
    botIsSending = false;
  }
}

async function botSendMedia(chatId, base64Data, filename, mimetype, caption) {
  if (!client) throw new Error('WhatsApp não conectado');
  if (!chatId || chatId === 'status@broadcast' || chatId.includes('@broadcast')) {
    log(`BLOQUEADO: tentativa de enviar mídia para ${chatId}`);
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

export function markAsReplied(rawPhone) {
  const phone = normalizePhone(rawPhone);
  const conv = conversations.get(phone);
  if (conv && !conv.resolved) {
    conv.humanReplied = true;
    conv.humanRepliedAt = new Date().toISOString();
    dbUpdateConversation(phone, { human_replied: true, human_replied_at: conv.humanRepliedAt });
    dbLogMetric('Luna', 'human_replied', { phone, name: conv.name });
    log(`${conv.name} (${phone}) — humano respondeu`);
    return true;
  }
  return false;
}

export function resolveConversation(rawPhone) {
  const phone = normalizePhone(rawPhone);
  const conv = conversations.get(phone);
  if (conv) {
    conv.timers.forEach(t => clearTimeout(t));
    conv.timers = [];
    if (conv.greetingTimer) clearTimeout(conv.greetingTimer);
    conv.resolved = true;
    dbResolveConversation(phone);
    dbLogMetric('Luna', 'conversation_resolved', { phone, name: conv.name, escalationLevel: conv.escalationLevel });
    log(`${conv.name} (${phone}) — conversa resolvida`);
    return true;
  }
  return false;
}

// ============================================
// INICIALIZAÇÃO
// ============================================
export async function initialize() {
  if (client) return;
  log('Inicializando...');

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
          sendGreeting(conv.chatId, conv.name, conv).catch(() => {});
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

    const phone = normalizePhone(msg.to);
    const conv = conversations.get(phone);
    if (!conv || conv.resolved) return;

    conv.messages.push({ body: msg.body, from: 'team', at: new Date().toISOString() });
    dbSaveMessage(conv, 'team', msg.body);
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
    if (msg.from?.includes('@g.us')) return; // ignora grupos
    if (msg.from === 'status@broadcast') return; // ignora status/stories

    // Ignora reações (reactions) — não são mensagens reais
    if (msg.type === 'reaction' || msg.type === 'reaction_sent') return;

    // Ignora stickers e locations sem texto.
    // MAS: se tem mídia (PDF/imagem), deixa passar mesmo sem body — auto-ingest vai capturar
    if (msg.type === 'sticker') return;
    if (!msg.body?.trim() && !msg.hasMedia) return;

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
  const cnpj = g.cnpj ? String(g.cnpj).replace(/\D/g, '') : null;
  const nomeLegal = g.razao_social || g.nome_fantasia || g.name || 'Cliente';
  const nomeFantasia = g.nome_fantasia || null;
  const regime = g.regime || g.regime_tributario || null;
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
  // 1) Gesthub e o master: procura empresa cujo CONTATO da carteira tem esse numero
  try {
    const g = await findClientByPhone(phone);
    if (g) {
      const lunaUuid = await upsertLunaClient(g);
      return {
        id: lunaUuid,
        gesthub_id: g.id || null,
        name: g.nome_fantasia || g.razao_social || g.name || 'Cliente',
        trade_name: g.nome_fantasia || g.trade_name || null,
        nome_fantasia: g.nome_fantasia || null,
        razao_social: g.razao_social || null,
        cnpj: g.cnpj || null,
        regime: g.regime || g.regime_tributario || null,
        municipio: g.municipio || g.cidade || null,
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
  return { id: null, name: 'Cliente', trade_name: null, phone: null, source: 'unknown' };
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


async function handleIncoming(msg) {
  const from = msg.from;

  // Proteção extra: ignora broadcast, status, reações
  if (!from || from === 'status@broadcast' || from.includes('@broadcast')) return;
  if (msg.type === 'reaction' || msg.type === 'reaction_sent' || msg.type === 'sticker') return;

  const phone = normalizePhone(from);
  const body = msg.body || '';
  if (!body.trim() && !msg.hasMedia) return;

  const contact = await msg.getContact().catch(() => null);
  const name = contact?.pushname || contact?.name || phone;
  // Pega número real — contact.id.user ou contact.number têm o número limpo
  const realPhone = contact?.id?.user || contact?.number || phone;

  log(`${name} (${phone}): ${body.substring(0, 80)}`);

    // ====== NOVO: Tentar Luna v2 primeiro ======
    try {
      const clientInfo = await getClientInfo(phone);
      const conversationInfo = await getConversationInfo(from, clientInfo);

      // Auto-ingest de PDF/imagem — fire-and-forget, nao bloqueia Luna
      if (msg.hasMedia) {
        autoIngestWhatsAppMedia(msg, clientInfo, conversationInfo).catch(() => {});
      }

      // Alerta o grupo quando ha novo contato SEM intervencao humana pendente.
      // Dispara UMA vez por conversa (primeira entrada) OU se cliente volta apos inatividade > 2h.
      // Fire-and-forget — nao bloqueia o fluxo de resposta.
      (async () => {
        try {
          const { rows: msgCounts } = await query(
            `SELECT COUNT(*) AS n,
                    MAX(created_at) FILTER (WHERE direction = 'inbound' AND created_at < NOW() - INTERVAL '2 hours') AS last_before
               FROM luna_v2.messages
              WHERE conversation_id = $1`,
            [conversationInfo.id]
          );
          const totalMsgs = parseInt(msgCounts[0]?.n || 0, 10);
          const isFirstContact = totalMsgs <= 1;          // conta so a mensagem atual
          const isComeback = msgCounts[0]?.last_before != null;
          if (!isFirstContact && !isComeback) return;

          const displayPhone = formatPhone(realPhone || phone);
          const horarioInfo = isHorarioComercial();
          const horarioTag = horarioInfo.open ? '' : `\n⏰ _Fora do horario (${horarioInfo.reason})_`;
          const tag = isFirstContact ? '📩 *Novo contato*' : '🔁 *Retomada apos inatividade*';
          const alertMsg = `${tag}\n\nCliente: *${clientInfo?.legalName || clientInfo?.name || name}*\nTelefone: ${displayPhone}\nMensagem: _${String(body || '').substring(0, 180)}_${horarioTag}\n\n_Luna processando — intervir se necessario._`;
          await notifyTeamWhatsApp(alertMsg);
          log(`[AlertGrupo] ${isFirstContact ? 'novo contato' : 'retomada'}: ${displayPhone}`);
        } catch (e) {
          log(`[AlertGrupo] erro: ${e.message}`);
        }
      })();

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
              await dbSaveMessage(conv, 'client', aggMsg.body);
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
    if (conv.greetingTimer) {
      clearTimeout(conv.greetingTimer);
      conv.greetingTimer = null;
    }
    if (!conv.greeted) {
      conv.greetingTimer = setTimeout(async () => {
        if (conv.greeted || conv.resolved) return;
        conv.greeted = true;
        await sendGreeting(conv.chatId, conv.name, conv);
      }, GREETING_DELAY_MS);
    }

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
    if (isNfseRequest(body)) {
      conv.classified = true; // já sabemos que é fiscal, evita classificação duplicada
      await handleNfseRequest(from, phone, name, body, conv);
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

  // Detecta NFS-e na primeira mensagem — pula greeting (a coleta de dados já é o greeting)
  if (isNfseRequest(body)) {
    conv.greeted = true;
    conv.classified = true; // não precisa classificar, já sabemos que é fiscal
    handleNfseRequest(from, phone, name, body, conv).catch(() => {});
  }

  // Detecta URGENTE na primeira mensagem
  if (isUrgent(body)) {
    conv.greeted = true;
    await handleUrgent(from, phone, name, body);
  }

  // Greeting com delay de 10s
  if (!conv.greeted) {
    conv.greetingTimer = setTimeout(async () => {
      if (conv.greeted || conv.resolved) return;
      conv.greeted = true;
      await sendGreeting(from, name, conv);
    }, GREETING_DELAY_MS);
  }

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
      const _cfg = await getAlertConfig();
      if (_cfg.meta.first_contact_alert_delayed !== 'true') {
        notifyTeamWhatsApp(alertUnico).catch(() => {});
      } else {
        log(`[NovoContato] ${name} — alerta adiado para 10min (config)`);
      }

      // Cria task e roteia (pula se já tem NFS-e em andamento ou se é fiscal com NFS-e ativo)
      if (!conv.nfseRequested && !conv.nfseTaskId && classification.classificacao !== 'geral') {
        await routeDemandToAgent(phone, name, chatId, allClientMsgs, conv, classification);
      }
    } catch (err) {
      log(`ERRO classificação ${name}: ${err.message}`);
      // Fallback — notifica grupo sem classificação
      const displayPhone = conv.displayPhone || phone;
      const lastMsg = conv.messages.filter(m => m.from === 'client').pop()?.body || '';
      const alertFallback = `📩 *Novo contato*\n\nCliente: *${name}*\nTelefone: ${displayPhone}\nMensagem: _${lastMsg.substring(0, 150)}_`;
      notifyTeamWhatsApp(alertFallback).catch(() => {});
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

    if (result.demanda_atendida && !result.precisa_followup) {
      resolveConversation(phone);
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

// ============================================
// ENVIAR MENSAGEM (via dashboard/API)
// ============================================
export async function sendMessage(phone, message) {
  if (!isReady || !client) throw new Error('WhatsApp não conectado');
  const chatId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
  await botSend(chatId, message);
  markAsReplied(phone);
  log(`Enviado para ${phone}`);
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
// AUTO-INGEST DE MIDIA (PDF / IMAGEM)
// Chamado pelo handler do WhatsApp quando msg.hasMedia.
// Baixa o arquivo, despacha para o pipeline de ingest e cria memoria vinculada ao cliente.
// A memoria entra como 'draft' — requer aprovacao via UI /docs.
// ============================================
export async function autoIngestWhatsAppMedia(msg, clientInfo, conversationInfo) {
  if (!msg?.hasMedia) return null;
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    const mime = media.mimetype || '';
    // Apenas PDF e imagens — ignora audio (por ora), video, docs nao suportados
    const isPdf = mime === 'application/pdf';
    const isImage = mime.startsWith('image/');
    if (!isPdf && !isImage) {
      log(`[AutoIngest] ignorando mime nao suportado: ${mime}`);
      return null;
    }

    const buffer = Buffer.from(media.data, 'base64');
    const filename = media.filename || (isPdf ? `whatsapp_${Date.now()}.pdf` : `whatsapp_${Date.now()}.jpg`);

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
      tags: ['whatsapp', isPdf ? 'pdf' : 'imagem'],
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
    if (result.ok && typeof chat === "function") {
      const preview = result.type === 'image'
        ? `${result.doc_type || 'imagem'}: ${result.summary?.slice(0, 160) || ''}`
        : `PDF ${result.pages}p, ${result.chunks} chunks — ${result.preview?.slice(0, 160) || ''}`;
      try {
        chat({
          from: 'Luna',
          text: `📎 ${clientInfo?.name || 'Cliente'} enviou ${isPdf ? 'PDF' : 'imagem'}: ${filename}\n${preview}\n(Pendente de aprovacao na aba Documentos)`,
          tag: 'ingest'
        });
      } catch {}
    }

    return result;
  } catch (err) {
    log(`[AutoIngest] ERRO: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
