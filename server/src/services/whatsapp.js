import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import * as telegram from './telegram.js';
import { analyzeSentiment, analyzeConversation, registerNPS } from './luna-analyzer.js';
import { addAnalysis } from './daily-report.js';

// ============================================
// ESTADO
// ============================================
let client = null;
let qrCodeData = null;
let isReady = false;
let broadcastFn = null;

const conversations = new Map();
let botIsSending = false; // Flag: true enquanto o bot está enviando mensagem

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

// Mensagens da Luna ao cliente por nível (null = não envia)
const CLIENT_MESSAGES = {
  0: null, // 10min: só notifica equipe
  1: (name) => `${name}, nossos atendentes estão finalizando outros atendimentos no momento. Já já alguém da equipe vai te atender, tá? Obrigada pela paciência! 🙏`,
  2: (name) => `${name}, peço desculpas pela demora! Estamos com um volume alto de atendimentos hoje. Sua solicitação é prioridade e um atendente entrará em contato em breve. 💙`,
  3: null, // 2h: só equipe
  4: (name) => `${name}, pedimos sinceras desculpas. Sua solicitação está sendo tratada internamente e um responsável entrará em contato com você. Agradecemos a compreensão. 🙏`,
  5: null, // 12h: só equipe
  6: (name) => `${name}, sabemos que está aguardando e lamentamos a demora. Sua solicitação é prioridade máxima. Um responsável entrará em contato hoje. Se preferir, ligue para ${CONTACT_PHONE}. 🔔`,
};

const NOTIFY_NUMBERS = ['5581997166091'];
const CONTACT_PHONE = '(81) 9971-66091';

// Grupo — desabilitado em fase de testes
const NOTIFY_GROUP_ENABLED = true;
const NOTIFY_GROUP_NAME = 'Luna_Atendimento';
let groupChatId = null;

const FERIADOS_FIXOS = ['01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'];

const GREETING_DELAY_MS = 30 * 1000; // 30 segundos
const URGENTE_KEYWORDS = ['urgente', 'urgência', 'urgencia', 'emergencia', 'emergência'];

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

function log(msg) {
  const time = now().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[WhatsApp ${time}] ${msg}`);
}

// ============================================
// API PÚBLICA
// ============================================
export function setBroadcast(fn) { broadcastFn = fn; }

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

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', async (qr) => {
    log('QR Code gerado');
    qrCodeData = await qrcode.toDataURL(qr);
    broadcastFn?.({ type: 'whatsapp_qr', hasQR: true });
  });

  client.on('ready', () => {
    log(`Conectado! ${client.info?.wid?.user}`);
    isReady = true;
    qrCodeData = null;
    broadcastFn?.({ type: 'whatsapp_ready', phone: client.info?.wid?.user });
  });

  client.on('disconnected', (reason) => {
    log(`Desconectado: ${reason}`);
    isReady = false;
    broadcastFn?.({ type: 'whatsapp_disconnected' });
  });

  // Humano respondeu (via WhatsApp Web, celular)
  // IGNORA mensagens enviadas pelo próprio bot (Luna)
  const botMessages = new Set(); // IDs de mensagens que o bot enviou

  client.on('message_create', async (msg) => {
    if (!msg.fromMe || !msg.to) return;

    // Se é mensagem que o bot enviou, ignora
    if (botIsSending) return;

    const phone = normalizePhone(msg.to);
    const conv = conversations.get(phone);
    if (!conv || conv.resolved) return;

    conv.messages.push({ body: msg.body, from: 'team', at: new Date().toISOString() });
    markAsReplied(msg.to);
    log(`Humano respondeu para ${conv.name}`);

    // Agenda análise 2min depois
    if (conv.analysisTimer) clearTimeout(conv.analysisTimer);
    conv.analysisTimer = setTimeout(() => analyzeAndReport(phone), 2 * 60 * 1000);
  });

  // Mensagem recebida de cliente
  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    if (msg.from?.includes('@g.us')) return; // ignora grupos
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
async function handleIncoming(msg) {
  const from = msg.from;
  const phone = normalizePhone(from);
  const body = msg.body;
  if (!body?.trim()) return;

  const contact = await msg.getContact().catch(() => null);
  const name = contact?.pushname || contact?.name || phone;
  // Pega número real — contact.id.user ou contact.number têm o número limpo
  const realPhone = contact?.id?.user || contact?.number || phone;

  log(`${name} (${phone}): ${body.substring(0, 80)}`);

  // Notifica dashboard
  broadcastFn?.({
    type: 'whatsapp_message',
    from: { phone, name },
    body: body.substring(0, 200),
    receivedAt: new Date().toISOString(),
  });

  // Análise de sentimento em background
  analyzeSentiment(body).then(analysis => {
    if (!analysis) return;
    log(`Sentimento ${name}: ${analysis.sentimento}, urgência: ${analysis.urgencia}`);
    broadcastFn?.({ type: 'whatsapp_analysis', phone, name, analysis });

    if (analysis.precisa_atencao_imediata || analysis.sentimento === 'irritado') {
      const alertMsg = `🚨 *ATENÇÃO IMEDIATA*\n\nCliente: *${name}* (${phone})\nSentimento: ${analysis.sentimento}\nUrgência: ${analysis.urgencia}\n_${analysis.resumo}_`;
      notifyAll(alertMsg);
    }
  }).catch(() => {});

  // === CONVERSA EXISTENTE ===
  if (conversations.has(phone)) {
    const conv = conversations.get(phone);
    conv.messages.push({ body, from: 'client', at: new Date().toISOString() });

    // Reseta greeting timer (espera cliente terminar de digitar)
    if (conv.greetingTimer) {
      clearTimeout(conv.greetingTimer);
      conv.greetingTimer = null;
    }

    // Detecta URGENTE
    if (isUrgent(body)) {
      await handleUrgent(from, phone, name, body);
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

  // Detecta URGENTE na primeira mensagem
  if (isUrgent(body)) {
    conv.greeted = true; // pula greeting padrão
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

  // Notifica grupo IMEDIATAMENTE
  const firstMsg = body.substring(0, 150);
  const displayPhone = formatPhone(realPhone);
  const alertImediato = `📩 *Novo contato!*\n\nCliente: *${name}*\nTelefone: ${displayPhone}\nMensagem: _${firstMsg}_\n\nVamos lá equipe! 💪`;
  notifyTeamWhatsApp(alertImediato).catch(() => {});

  broadcastFn?.({ type: 'whatsapp_new_contact', phone, name, body: firstMsg });

  // Inicia escalation (10min sem resposta → alertas crescentes)
  startEscalation(phone, from, name, 0);
  log(`Nova conversa — ${name} (${phone})`);
}

// ============================================
// SAUDAÇÃO INICIAL
// ============================================
async function sendGreeting(chatId, name, conv) {
  const greeting = getGreeting();
  const horario = isHorarioComercial();

  let message;
  if (horario.open) {
    message = `${greeting}! Sua mensagem foi recebida, logo um atendente entrará em contato 😊`;
  } else if (horario.isLunch) {
    message = `${greeting}! Sua mensagem foi recebida. Nossa equipe está no intervalo de almoço e retorna às 13h.\n\nSe for algo urgente, responda *URGENTE* que acionaremos um atendente, ou ligue diretamente para ${CONTACT_PHONE} 🔔`;
  } else {
    message = `${greeting}! Sua mensagem foi recebida. No momento estamos com atendimento reduzido, mas retornaremos assim que possível.\n\nSe for algo urgente, responda *URGENTE* que acionaremos um atendente, ou ligue diretamente para ${CONTACT_PHONE} 🔔`;
  }

  try {
    await botSend(chatId, message);
    conv.outsideHours = !horario.open;
    log(`Greeting enviado para ${name}${!horario.open ? ` (${horario.reason})` : ''}`);
  } catch (err) {
    log(`ERRO greeting ${name}: ${err.message}`);
  }
}

// ============================================
// URGENTE
// ============================================
async function handleUrgent(chatId, phone, name, body) {
  log(`🚨 ${name} solicitou URGENTE`);

  const alertMsg = `🚨 *URGENTE — Cliente solicitou prioridade*\n\nCliente: *${name}* (${phone})\nMensagem: _${body.substring(0, 150)}_`;
  await notifyAll(alertMsg);

  try {
    await botSend(chatId,
      `Entendido! Estamos acionando um atendente para te atender com prioridade. Você também pode ligar diretamente para ${CONTACT_PHONE} 🔔`
    );
  } catch (err) {
    log(`ERRO resposta urgente: ${err.message}`);
  }
}

// ============================================
// ESCALATION
// ============================================
function startEscalation(phone, chatId, name, fromLevel) {
  const conv = conversations.get(phone);
  if (!conv) return;

  conv.timers.forEach(t => clearTimeout(t));
  conv.timers = [];

  for (let i = fromLevel; i < ESCALATION_LEVELS.length; i++) {
    const level = ESCALATION_LEVELS[i];
    const delay = level.minutes * 60 * 1000;

    log(`Escalation agendada: ${name} → nível ${i} (${level.severity}) em ${level.minutes}min`);
    conv.timers.push(setTimeout(() => escalate(phone, chatId, name, i), delay));
  }
}

async function escalate(phone, chatId, name, levelIndex) {
  const conv = conversations.get(phone);
  if (!conv || conv.resolved) return;
  if (conv.humanReplied) return; // humano já respondeu, para escalation

  const level = ESCALATION_LEVELS[levelIndex];
  conv.escalationLevel = levelIndex;
  const lastMsg = conv.messages[conv.messages.length - 1]?.body || '';

  log(`${level.emoji} ${level.label} — ${name} (${phone})`);

  // Mensagem ao cliente (se configurada para este nível)
  const clientMsgFn = CLIENT_MESSAGES[levelIndex];
  if (clientMsgFn) {
    try {
      await botSend(chatId, clientMsgFn(name));
    } catch (err) {
      log(`ERRO follow-up nível ${levelIndex}: ${err.message}`);
    }
  }

  // SEMPRE notifica equipe via Telegram (independente do horário)
  // WhatsApp da equipe só em horário comercial
  const horario = isHorarioComercial();
  const foraHorario = !horario.open ? `\n⏰ _${horario.reason}_` : '';
  const urgencia = levelIndex >= 2 ? '\n\n⚠️ *AÇÃO IMEDIATA NECESSÁRIA*' : '';
  const alertMsg = `${level.emoji} *${level.label}*\n\nCliente: *${name}*\nTelefone: ${conv.displayPhone || phone}\nÚltima msg: _${lastMsg.substring(0, 150)}_${foraHorario}${urgencia}`;

  // Telegram: SEMPRE
  telegram.sendAlert(alertMsg);

  // WhatsApp equipe: só em horário comercial ou nível crítico+
  if (horario.open || levelIndex >= 2) {
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
