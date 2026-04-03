import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chatWithAgent } from './claude.js';
import { executeToolCall } from '../tools/registry.js';
import { query } from '../db/pool.js';
import * as whatsapp from './whatsapp.js';
import { generateDailyReport } from './daily-report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let bot = null;

// Persiste chat IDs autorizados em arquivo para sobreviver restarts
const AUTH_FILE = path.join(__dirname, '../../telegram-users.json');
let authorizedUsers = new Set();

function loadAuthorizedUsers() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      authorizedUsers = new Set(data);
      console.log(`[Telegram] ${authorizedUsers.size} usuário(s) autorizados carregados`);
    }
  } catch {}
}

function saveAuthorizedUsers() {
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify([...authorizedUsers]));
  } catch {}
}

const AGENT_MAP = {
  luna: 'a0000001-0000-0000-0000-000000000004',
  rodrigo: 'a0000001-0000-0000-0000-000000000001',
  campelo: 'a0000001-0000-0000-0000-000000000002',
  sneijder: 'a0000001-0000-0000-0000-000000000003',
  sofia: 'a0000001-0000-0000-0000-000000000005',
};

export async function initialize(token) {
  if (!token) {
    console.log('[Telegram] Sem token — bot desativado');
    return;
  }

  loadAuthorizedUsers();
  bot = new TelegramBot(token, { polling: true });
  console.log('[Telegram] Bot inicializado');

  // /start
  bot.onText(/\/start/, async (msg) => {
    authorizedUsers.add(msg.chat.id);
    saveAuthorizedUsers();
    await bot.sendMessage(msg.chat.id,
      `👋 Olá! Sou a assistente do escritório.\n\n` +
      `*Comandos:*\n` +
      `/luna [msg] — Falar com Luna\n` +
      `/rodrigo [msg] — Falar com Rodrigo\n` +
      `/campelo [msg] — Falar com Campelo\n` +
      `/sneijder [msg] — Falar com Sneijder\n` +
      `/sofia [msg] — Falar com Sofia\n` +
      `/status — Status geral\n` +
      `/pendentes — WhatsApp pendentes\n` +
      `/relatorio — Gerar relatório\n` +
      `/enviar [tel] [msg] — Enviar WhatsApp`,
      { parse_mode: 'Markdown' }
    );
  });

  // /status
  bot.onText(/\/status/, async (msg) => {
    try {
      const wsStatus = whatsapp.getStatus();
      const { rows: tasks } = await query('SELECT status, COUNT(*) as c FROM tasks GROUP BY status');
      const taskStr = tasks.map(t => `${t.status}: ${t.c}`).join(', ') || 'nenhuma';
      await bot.sendMessage(msg.chat.id,
        `📊 *Status*\n\nWhatsApp: ${wsStatus.connected ? '✅ Conectado' : '❌ Off'}\nConversas: ${wsStatus.activeConversations}\nTasks: ${taskStr}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
  });

  // /relatorio
  bot.onText(/\/relatorio/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '📋 Gerando...');
    try {
      const report = await generateDailyReport();
      if (!report) await bot.sendMessage(msg.chat.id, '❌ Sem dados para relatório');
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
  });

  // /pendentes
  bot.onText(/\/pendentes/, async (msg) => {
    const pending = whatsapp.getPendingMessages();
    if (!pending.length) {
      await bot.sendMessage(msg.chat.id, '✅ Nenhuma mensagem pendente.');
      return;
    }
    let text = `⏳ *${pending.length} pendente(s):*\n\n`;
    pending.forEach(p => {
      const icon = ['critico','urgente'].includes(p.severity) ? '🔴' : '🟡';
      text += `${icon} *${p.name}* (${p.phone})\n_${p.lastMessage.substring(0, 80)}_\nHá ${timeSince(p.receivedAt)}${p.humanReplied ? ' (respondido, insistiu)' : ''}\n\n`;
    });
    await safeSend(msg.chat.id, text);
  });

  // /enviar [tel] [msg]
  bot.onText(/\/enviar\s+(\S+)\s+(.+)/s, async (msg, match) => {
    try {
      await whatsapp.sendMessage(match[1], match[2]);
      await bot.sendMessage(msg.chat.id, `✅ Enviado para ${match[1]}`);
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
  });

  // Comandos de agentes
  Object.entries(AGENT_MAP).forEach(([name, agentId]) => {
    bot.onText(new RegExp(`\\/${name}\\s+(.+)`, 's'), async (msg, match) => {
      await bot.sendChatAction(msg.chat.id, 'typing');
      try {
        const { rows } = await query('SELECT * FROM agents WHERE id = $1', [agentId]);
        if (!rows.length) return await bot.sendMessage(msg.chat.id, `❌ Agente não encontrado`);
        const response = await chatWithAgent(rows[0], [{ role: 'user', content: match[1] }], executeToolCall);
        if (response.success && response.text) {
          await safeSend(msg.chat.id, `*${rows[0].name}:*\n\n${response.text.substring(0, 4000)}`);
        } else {
          await bot.sendMessage(msg.chat.id, `❌ ${response.error || 'Sem resposta'}`);
        }
      } catch (err) {
        await bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
      }
    });
  });

  // Mensagem livre → Luna
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const { rows } = await query('SELECT * FROM agents WHERE id = $1', [AGENT_MAP.luna]);
      if (!rows.length) return;
      const response = await chatWithAgent(rows[0], [{ role: 'user', content: msg.text }], executeToolCall);
      if (response.success && response.text) {
        await safeSend(msg.chat.id, `*Luna:*\n\n${response.text.substring(0, 4000)}`);
      }
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
  });
}

// Envia com Markdown, fallback para texto puro se falhar
async function safeSend(chatId, text) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch {
    await bot.sendMessage(chatId, text.replace(/[*_`]/g, '')).catch(() => {});
  }
}

// Alerta para TODOS os usuários autorizados
export async function sendAlert(message) {
  if (!bot || !authorizedUsers.size) return;
  for (const chatId of authorizedUsers) {
    await safeSend(chatId, message);
  }
}

function timeSince(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
