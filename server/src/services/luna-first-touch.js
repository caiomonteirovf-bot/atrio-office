/**
 * Luna First-Touch Scheduler
 * ---------------------------
 * Comportamento novo (abril/2026):
 *  - Quando cliente escreve no WhatsApp, Luna NÃO responde imediato
 *  - Apenas alerta no grupo interno (isso já rola via AlertGrupo)
 *  - Timer de 5min: se humano respondeu via WhatsApp Web → cancela
 *    Se 5min estourou sem resposta humana → Luna envia saudação + triagem mínima
 *  - Exceção: intenção clara de NFS-e → Luna responde imediato (coleta CNPJ+valor+descrição)
 */

const WAIT_MS = 5 * 60 * 1000; // 5 minutos

// Map<phone, timer>
const pendingTimers = new Map();

export function hasPendingFirstTouch(phone) {
  return pendingTimers.has(phone);
}

/**
 * Agenda a primeira resposta da Luna para daqui a 5min.
 * Se já existir um timer para o mesmo phone, não cria outro (evita spam).
 */
export function scheduleLunaFirstTouch({ phone, conversationId, clientInfo, message, sendFn, log }) {
  if (pendingTimers.has(phone)) {
    log?.(`[first-touch] já agendado para ${phone} — ignorando novo`);
    return;
  }

  const firstName = (clientInfo?.contato?.nome || clientInfo?.name || clientInfo?.legalName || '').split(' ')[0] || '';

  const timer = setTimeout(async () => {
    pendingTimers.delete(phone);
    try {
      // Verifica se humano respondeu no intervalo (via WhatsApp Web)
      const { query } = await import('../db/pool.js');
      let humanReplied = false;
      try {
        const r = await query(
          `SELECT human_replied FROM whatsapp_conversations WHERE phone = $1 OR real_phone = $1 ORDER BY last_message_at DESC LIMIT 1`,
          [phone]
        );
        humanReplied = r.rows[0]?.human_replied === true;
      } catch {}

      if (humanReplied) {
        log?.(`[first-touch] ${phone} — humano respondeu no intervalo, Luna não entra`);
        return;
      }

      // 5min se passaram sem humano responder → Luna se identifica e pede triagem
      const hour = new Date().getHours();
      const saudacao = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
      const nome = firstName ? `${saudacao}, ${firstName}` : saudacao;
      const texto =
        `${nome}. Aqui é a Luna, assistente virtual da Átrio.\n\n` +
        `A equipe está com um pouco mais de volume agora. Pra adiantar, me conta em uma frase qual é o assunto?\n\n` +
        `Se for emissão de NFS-e, já pode me passar o CNPJ do tomador, o valor e a descrição do serviço.`;

      await sendFn(phone, texto);
      log?.(`[first-touch] ${phone} — Luna triagem enviada após 5min sem humano`);

      // Marca que Luna já fez o primeiro toque pra essa conversa
      try {
        await query(
          `UPDATE whatsapp_conversations SET greeted = true WHERE phone = $1 OR real_phone = $1`,
          [phone]
        );
      } catch {}
    } catch (e) {
      log?.(`[first-touch] erro no disparo: ${e.message}`);
    }
  }, WAIT_MS);

  pendingTimers.set(phone, timer);
  log?.(`[first-touch] agendado para ${phone} (${firstName || 'sem nome'}) — Luna triagem em 5min se humano não responder`);
}

/**
 * Cancela o timer pendente — chamado quando humano responde via WhatsApp Web
 * ou quando a conversa é marcada como resolvida.
 */
export function cancelLunaFirstTouch(phone, log) {
  const t = pendingTimers.get(phone);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(phone);
    log?.(`[first-touch] cancelado para ${phone} (humano assumiu)`);
    return true;
  }
  return false;
}

export function listPending() {
  return Array.from(pendingTimers.keys());
}
