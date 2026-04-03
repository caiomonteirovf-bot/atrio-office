import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import * as telegram from './telegram.js';

let client = null;
let qrCodeData = null;
let isReady = false;
let broadcastFn = null;

// Escalation progressiva
const ESCALATION_LEVELS = [
  { minutes: 10, severity: 'normal', emoji: '🟡', label: 'Sem resposta — 10min' },
  { minutes: 30, severity: 'atencao', emoji: '🟠', label: 'Atenção — 30min sem retorno' },
  { minutes: 60, severity: 'critico', emoji: '🔴', label: 'CRÍTICO — 1h sem retorno' },
  { minutes: 120, severity: 'urgente', emoji: '🚨', label: 'URGENTE — 2h sem retorno' },
];

const NOTIFY_NUMBERS = ['5581997166091'];
const NOTIFY_GROUP_NAME = 'Chat WeGo (Equipe)';
let groupChatId = null;

// Conversas ativas
const conversations = new Map();

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
      const level = ESCALATION_LEVELS[conv.escalationLevel] || ESCALATION_LEVELS[0];
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

export function markAsReplied(phone) {
  const n = phone.replace(/\D/g, '');
  const conv = conversations.get(n);
  if (conv) {
    conv.humanReplied = true;
    conv.humanRepliedAt = new Date().toISOString();
    console.log(`[WhatsApp] ${n} — humano respondeu. Monitorando resolução.`);
    return true;
  }
  return false;
}

export function resolveConversation(phone) {
  const n = phone.replace(/\D/g, '');
  const conv = conversations.get(n);
  if (conv) {
    conv.timers.forEach(t => clearTimeout(t));
    conv.timers = [];
    conv.resolved = true;
    console.log(`[WhatsApp] ${n} — conversa resolvida`);
    return true;
  }
  return false;
}

function getGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

// ============================================
// INICIALIZAÇÃO
// ============================================
export async function initialize() {
  if (client) return;
  console.log('[WhatsApp] Inicializando...');

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', async (qr) => {
    console.log('[WhatsApp] QR Code gerado');
    qrCodeData = await qrcode.toDataURL(qr);
    broadcastFn?.({ type: 'whatsapp_qr', hasQR: true });
  });

  client.on('ready', () => {
    console.log('[WhatsApp] Conectado!', client.info?.wid?.user);
    isReady = true;
    qrCodeData = null;
    broadcastFn?.({ type: 'whatsapp_ready', phone: client.info?.wid?.user });
  });

  client.on('disconnected', (reason) => {
    console.log('[WhatsApp] Desconectado:', reason);
    isReady = false;
    broadcastFn?.({ type: 'whatsapp_disconnected' });
  });

  // Humano respondeu via WhatsApp Web/celular
  client.on('message_create', (msg) => {
    if (msg.fromMe && msg.to) {
      markAsReplied(msg.to.replace('@c.us', ''));
    }
  });

  // Mensagem recebida de cliente
  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    if (msg.from.includes('@g.us')) return;
    await handleIncoming(msg);
  });

  try { await client.initialize(); }
  catch (err) { console.error('[WhatsApp] Erro:', err.message); }
}

// ============================================
// MENSAGEM RECEBIDA
// ============================================
async function handleIncoming(msg) {
  const from = msg.from;
  const phone = from.replace('@c.us', '');
  const body = msg.body;
  const contact = await msg.getContact();
  const name = contact.pushname || contact.name || phone;

  console.log(`[WhatsApp] ${name} (${phone}): ${body.substring(0, 80)}`);

  broadcastFn?.({
    type: 'whatsapp_message',
    from: { phone, name },
    body: body.substring(0, 200),
    receivedAt: new Date().toISOString(),
  });

  // Conversa existente
  if (conversations.has(phone)) {
    const conv = conversations.get(phone);
    conv.messages.push({ body, from: 'client', at: new Date().toISOString() });

    // Cliente mandou de novo após humano responder → não foi resolvido
    if (conv.humanReplied && !conv.resolved) {
      conv.humanReplied = false;
      console.log(`[WhatsApp] ${name} insistiu — reiniciando escalation`);
      startEscalation(phone, from, name, 0);
    }
    return;
  }

  // Nova conversa
  conversations.set(phone, {
    name, chatId: from,
    messages: [{ body, from: 'client', at: new Date().toISOString() }],
    receivedAt: new Date().toISOString(),
    escalationLevel: -1,
    timers: [],
    humanReplied: false,
    resolved: false,
  });

  startEscalation(phone, from, name, 0);
  console.log(`[WhatsApp] Nova conversa — ${name} (${phone}) — monitoramento ativo`);
}

// ============================================
// ESCALATION PROGRESSIVA
// ============================================
function startEscalation(phone, chatId, name, fromLevel) {
  const conv = conversations.get(phone);
  if (!conv) return;

  // Limpa timers anteriores
  conv.timers.forEach(t => clearTimeout(t));
  conv.timers = [];

  for (let i = fromLevel; i < ESCALATION_LEVELS.length; i++) {
    const level = ESCALATION_LEVELS[i];
    const delay = level.minutes * 60 * 1000;

    conv.timers.push(setTimeout(async () => {
      await escalate(phone, chatId, name, i);
    }, delay));
  }
}

async function escalate(phone, chatId, name, levelIndex) {
  const conv = conversations.get(phone);
  if (!conv || conv.resolved) return;

  // Se humano respondeu e cliente não insistiu, pula
  if (conv.humanReplied && levelIndex > 0) return;

  const level = ESCALATION_LEVELS[levelIndex];
  conv.escalationLevel = levelIndex;
  const lastMsg = conv.messages[conv.messages.length - 1]?.body || '';

  console.log(`[WhatsApp] ${level.emoji} ${level.label} — ${name} (${phone})`);

  // Nível 0: Luna responde ao cliente (só se humano não respondeu)
  if (levelIndex === 0 && !conv.humanReplied) {
    try {
      const greeting = getGreeting();
      await client.sendMessage(chatId,
        `${greeting}! Aqui é a Luna, assistente do Átrio Contabilidade. Já estou direcionando sua mensagem para um de nossos atendentes. Enquanto isso, posso te ajudar em algo? 😊`
      );
    } catch (err) {
      console.error('[WhatsApp] Erro ao responder:', err.message);
    }
  }

  // Notifica equipe (todos os níveis)
  const statusHumano = conv.humanReplied ? 'Respondeu, mas cliente insistiu' : 'Nenhuma resposta';
  const urgencia = levelIndex >= 2 ? '\n\n⚠️ *AÇÃO IMEDIATA NECESSÁRIA*' : '';

  const alertMsg = `${level.emoji} *${level.label}*\n\nCliente: *${name}*\nTelefone: ${phone}\nÚltima msg: _${lastMsg.substring(0, 150)}_\nAtendente: ${statusHumano}${urgencia}`;

  await notifyTeam(alertMsg);
  telegram.sendAlert(alertMsg); // Notifica também no Telegram

  broadcastFn?.({
    type: 'whatsapp_escalation',
    phone, name,
    severity: level.severity,
    level: levelIndex,
    label: level.label,
  });
}

// ============================================
// NOTIFICAR EQUIPE
// ============================================
async function findGroupChat() {
  if (groupChatId) return groupChatId;
  try {
    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name === NOTIFY_GROUP_NAME);
    if (group) {
      groupChatId = group.id._serialized;
      console.log(`[WhatsApp] Grupo "${NOTIFY_GROUP_NAME}" encontrado`);
    }
    return groupChatId;
  } catch { return null; }
}

async function notifyTeam(message) {
  // Grupo — desabilitado durante fase de testes
  // const gId = await findGroupChat();
  // if (gId) {
  //   try { await client.sendMessage(gId, message); }
  //   catch (err) { console.error('[WhatsApp] Erro grupo:', err.message); }
  // }

  // Individual
  for (const number of NOTIFY_NUMBERS) {
    try { await client.sendMessage(`${number}@c.us`, message); }
    catch (err) { console.error(`[WhatsApp] Erro ${number}:`, err.message); }
  }
}

// ============================================
// ENVIAR MENSAGEM (via dashboard)
// ============================================
export async function sendMessage(phone, message) {
  if (!isReady || !client) throw new Error('WhatsApp não conectado');
  const chatId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
  await client.sendMessage(chatId, message);
  markAsReplied(phone.replace(/\D/g, ''));
  console.log(`[WhatsApp] Enviado para ${phone}`);
}

export async function destroy() {
  conversations.forEach(conv => conv.timers.forEach(t => clearTimeout(t)));
  conversations.clear();
  if (client) { await client.destroy(); client = null; isReady = false; qrCodeData = null; }
}
