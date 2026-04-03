import TelegramBot from 'node-telegram-bot-api';
import { chatWithAgent } from './claude.js';
import { executeToolCall } from '../tools/registry.js';
import { query } from '../db/pool.js';
import * as whatsapp from './whatsapp.js';

let bot = null;
let authorizedUsers = new Set(); // chat IDs autorizados

const LUNA_AGENT_ID = 'a0000001-0000-0000-0000-000000000004';
const RODRIGO_AGENT_ID = 'a0000001-0000-0000-0000-000000000001';

// Mapa de agentes por comando
const AGENT_MAP = {
  luna: LUNA_AGENT_ID,
  rodrigo: RODRIGO_AGENT_ID,
  campelo: 'a0000001-0000-0000-0000-000000000002',
  sneijder: 'a0000001-0000-0000-0000-000000000003',
  sofia: 'a0000001-0000-0000-0000-000000000005',
};

export function getBot() { return bot; }

export async function initialize(token) {
  if (!token) {
    console.log('[Telegram] Sem token — bot desativado');
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  console.log('[Telegram] Bot inicializado');

  // /start — autoriza e apresenta
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    authorizedUsers.add(chatId);
    await bot.sendMessage(chatId,
      `👋 Olá! Sou a *Luna*, assistente do Átrio Office.\n\n` +
      `Comandos disponíveis:\n` +
      `/luna [mensagem] — Falar com Luna\n` +
      `/rodrigo [mensagem] — Falar com Rodrigo\n` +
      `/campelo [mensagem] — Falar com Campelo\n` +
      `/sneijder [mensagem] — Falar com Sneijder\n` +
      `/sofia [mensagem] — Falar com Sofia\n` +
      `/status — Status da equipe e WhatsApp\n` +
      `/pendentes — Mensagens WhatsApp pendentes\n` +
      `/enviar [telefone] [mensagem] — Enviar WhatsApp\n`,
      { parse_mode: 'Markdown' }
    );
  });

  // /status — status geral
  bot.onText(/\/status/, async (msg) => {
    const wsStatus = whatsapp.getStatus();
    const { rows: tasks } = await query(
      `SELECT status, COUNT(*) as c FROM tasks GROUP BY status`
    );
    const taskStr = tasks.map(t => `${t.status}: ${t.c}`).join(', ');

    await bot.sendMessage(msg.chat.id,
      `📊 *Status Átrio Office*\n\n` +
      `WhatsApp: ${wsStatus.connected ? '✅ Conectado' : '❌ Desconectado'}\n` +
      `Conversas ativas: ${wsStatus.activeConversations}\n` +
      `Tasks: ${taskStr || 'nenhuma'}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /pendentes — mensagens WhatsApp sem resposta
  bot.onText(/\/pendentes/, async (msg) => {
    const pending = whatsapp.getPendingMessages();
    if (pending.length === 0) {
      await bot.sendMessage(msg.chat.id, '✅ Nenhuma mensagem pendente.');
      return;
    }

    let text = `⏳ *${pending.length} mensagem(ns) pendente(s):*\n\n`;
    pending.forEach(p => {
      text += `${p.severity === 'critico' || p.severity === 'urgente' ? '🔴' : '🟡'} *${p.name}* (${p.phone})\n`;
      text += `_${p.lastMessage.substring(0, 80)}_\n`;
      text += `Há ${timeSince(p.receivedAt)} — ${p.humanReplied ? 'Respondido, mas insistiu' : 'Sem resposta'}\n\n`;
    });

    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  });

  // /enviar [telefone] [mensagem] — enviar WhatsApp pelo bot
  bot.onText(/\/enviar\s+(\S+)\s+(.+)/, async (msg, match) => {
    const phone = match[1];
    const text = match[2];
    try {
      await whatsapp.sendMessage(phone, text);
      await bot.sendMessage(msg.chat.id, `✅ Mensagem enviada para ${phone}`);
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Erro: ${err.message}`);
    }
  });

  // Comandos de agentes: /luna, /rodrigo, /campelo, /sneijder, /sofia
  Object.entries(AGENT_MAP).forEach(([name, agentId]) => {
    const regex = new RegExp(`\\/${name}\\s+(.+)`, 's');
    bot.onText(regex, async (msg, match) => {
      const userMessage = match[1];
      const chatId = msg.chat.id;

      await bot.sendChatAction(chatId, 'typing');

      try {
        const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [agentId]);
        if (!agents.length) {
          await bot.sendMessage(chatId, `❌ Agente ${name} não encontrado`);
          return;
        }

        const response = await chatWithAgent(agents[0], [
          { role: 'user', content: userMessage },
        ], executeToolCall);

        if (response.success && response.text) {
          // Telegram tem limite de 4096 chars
          const text = response.text.substring(0, 4000);
          await bot.sendMessage(chatId, `*${agents[0].name}:*\n\n${text}`, { parse_mode: 'Markdown' }).catch(() =>
            bot.sendMessage(chatId, `${agents[0].name}:\n\n${text}`)
          );
        } else {
          await bot.sendMessage(chatId, `❌ Erro: ${response.error || 'Sem resposta'}`);
        }
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Erro: ${err.message}`);
      }
    });
  });

  // Mensagem livre (sem comando) — fala com Luna por padrão
  bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/')) return; // ignora comandos
    const chatId = msg.chat.id;

    await bot.sendChatAction(chatId, 'typing');

    try {
      const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [LUNA_AGENT_ID]);
      if (!agents.length) return;

      const response = await chatWithAgent(agents[0], [
        { role: 'user', content: msg.text },
      ], executeToolCall);

      if (response.success && response.text) {
        await bot.sendMessage(chatId, `*Luna:*\n\n${response.text.substring(0, 4000)}`, { parse_mode: 'Markdown' }).catch(() =>
          bot.sendMessage(chatId, `Luna:\n\n${response.text.substring(0, 4000)}`)
        );
      }
    } catch (err) {
      await bot.sendMessage(chatId, `❌ ${err.message}`);
    }
  });
}

// Enviar alerta no Telegram (usado pelo WhatsApp escalation)
export async function sendAlert(message) {
  if (!bot) return;
  for (const chatId of authorizedUsers) {
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch {}
  }
}

function timeSince(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'agora';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
