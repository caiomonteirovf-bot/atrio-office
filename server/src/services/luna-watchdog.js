// Luna Watchdog — vigia de atendimento WhatsApp.
// 3 comportamentos ativos:
//  1) Mensagem fora do horario / feriado: responde cordial + pede assunto
//  2) Mensagem in-hours sem resposta humana > SLA: calma o cliente + alerta equipe
//  3) Conversa aberta > 24h sem fechamento: avisa equipe (nao o cliente)
//
// Chave: Luna NAO resolve, apenas garante que nada se perde.

import { query } from '../db/pool.js';
import { sendMessage as sendWhatsAppMessage } from './whatsapp.js';

// --- CONFIG ---
const SLA_SECS   = parseInt(process.env.SLA_TOLERANCE_SECONDS || '600', 10); // padrao 10min
const TICK_MS    = parseInt(process.env.WATCHDOG_TICK_MS      || '15000', 10); // 15s
const BH_START   = parseInt(process.env.BUSINESS_HOUR_START   || '8', 10);
const BH_END     = parseInt(process.env.BUSINESS_HOUR_END     || '18', 10);
// dow: 1=seg ... 5=sex (nao inclui sab/dom)
const BH_DAYS    = (process.env.BUSINESS_DAYS || '1,2,3,4,5').split(',').map(x=>parseInt(x,10));
const STALE_CONV_HOURS = parseInt(process.env.STALE_CONV_HOURS || '24', 10);

// Dedupe por conversa: nao manda 2x a mesma mensagem pra mesma inbound
const _lastActionByConv = new Map();

function hojeStr(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function isHoliday(date = new Date()) {
  try {
    const { rows } = await query('SELECT name FROM public.holidays WHERE date = $1::date LIMIT 1', [hojeStr(date)]);
    return rows[0]?.name || null;
  } catch { return null; }
}

function isBusinessHour(date = new Date()) {
  const dow = date.getDay() === 0 ? 7 : date.getDay(); // Dom=7
  if (!BH_DAYS.includes(dow)) return false;
  const h = date.getHours();
  return h >= BH_START && h < BH_END;
}

async function fetchTemplate(key) {
  const { rows } = await query('SELECT body FROM public.luna_templates WHERE key = $1', [key]);
  return rows[0]?.body || '';
}

function primeiroNome(nome) {
  if (!nome) return '';
  const first = String(nome).trim().split(/\s+/)[0];
  return first ? ' ' + first : '';
}

function renderTemplate(body, vars) {
  return body
    .replace(/\{nome\}/g, vars.nome || '')
    .replace(/\{feriado\}/g, vars.feriado || '');
}

// Responsavel interno do cliente (para alerta de equipe)
async function fetchResponsavelInterno(clientId) {
  if (!clientId) return null;
  try {
    const { rows } = await query(
      `SELECT analyst, office_owner FROM datalake.cliente_360 WHERE gesthub_id = $1 LIMIT 1`,
      [clientId]
    );
    return rows[0]?.analyst || rows[0]?.office_owner || null;
  } catch { return null; }
}

// Formata telefone BR: 558199387529 → +55 (81) 99938-7529
function formatPhoneBR(phone) {
  if (!phone) return '(sem telefone)';
  const digits = String(phone).replace(/\D/g, '');
  // 55 + DDD(2) + numero(8 ou 9)
  if (digits.length === 13) return `+${digits.slice(0,2)} (${digits.slice(2,4)}) ${digits.slice(4,9)}-${digits.slice(9)}`;
  if (digits.length === 12) return `+${digits.slice(0,2)} (${digits.slice(2,4)}) ${digits.slice(4,8)}-${digits.slice(8)}`;
  if (digits.length === 11) return `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`;
  return phone;
}

// Constrói mensagem natural a partir do tipo + meta
function buildNaturalMessage(titulo, meta) {
  const tipo = meta.tipo || meta.type || 'alerta';
  const phone = meta.phone ? formatPhoneBR(meta.phone) : null;
  const responsavel = meta.responsavel ? ` Responsável: ${meta.responsavel}.` : '';

  if (tipo === 'stale_review') {
    return `Uma conversa no WhatsApp está aberta há mais de 24h sem retorno. Alguém pode confirmar se o atendimento foi concluído e fechar?${responsavel}`;
  }
  if (tipo === 'sla_alert' && meta.idade_segundos) {
    const min = Math.floor(meta.idade_segundos / 60);
    return `Cliente ${phone || 'WhatsApp'} aguarda resposta humana há ${min} minutos.${responsavel} Passou do SLA — verifique e responda.`;
  }
  // fallback: titulo limpo sem prefixo [tipo]
  return titulo.replace(/^\[[^\]]+\]\s*/, '');
}

// Constrói título amigável (sem JSON, sem phone cru)
function buildFriendlyTitle(titulo, meta) {
  if (!meta || !meta.phone) return titulo;
  // substitui telefone cru no título por formato amigável
  const formatted = formatPhoneBR(meta.phone);
  return titulo.replace(meta.phone, formatted);
}

async function enviarPraEquipe(texto, meta = {}) {
  try {
    // Cria como NOTIFICATION (nao como task) — essas sao para humano revisar,
    // nao para orchestrator processar. Se fosse task 'pending' sem assigned_to,
    // ficava orfa no Mission Control e enchia a fila.
    const titulo = buildFriendlyTitle(texto, meta);
    const mensagem = buildNaturalMessage(texto, meta);
    await query(
      `INSERT INTO public.notifications (type, title, message, severity, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
      [
        meta.tipo || 'sla_alert',
        titulo,
        mensagem,
        meta.severity || 'warning',
        JSON.stringify({ ...meta, fonte: 'luna-watchdog' }),  // raw meta vai pra metadata
      ]
    );
  } catch (e) { console.error('[watchdog] alert falhou:', e.message); }
}

async function sendLuna(phone, texto, convId, acao) {
  try {
    await sendWhatsAppMessage(phone, texto);
    await query(
      `UPDATE luna_v2.conversations SET luna_ack_at = NOW(), luna_silence_nudge_at = NOW() WHERE id = $1`,
      [convId]
    );
    await query(
      `INSERT INTO luna_v2.messages (conversation_id, direction, sender_type, agent_id, content, created_at)
       VALUES ($1, 'outbound', 'agent', 'luna-watchdog', $2, NOW())`,
      [convId, texto]
    );
    _lastActionByConv.set(convId, { acao, at: Date.now() });
    console.log(`[watchdog] Luna -> ${phone}: ${acao}`);
  } catch (e) { console.error('[watchdog] sendLuna erro:', e.message); }
}

// Ja rodou essa acao pra essa inbound recente?
function jaAgiu(convId, last_inbound_at, acao) {
  const last = _lastActionByConv.get(convId);
  if (!last) return false;
  if (last.acao !== acao) return false;
  const inbTs = new Date(last_inbound_at).getTime();
  return last.at > inbTs;
}

// --- TICK PRINCIPAL ---
async function tick() {
  const now = new Date();
  const horaComercial = isBusinessHour(now);
  const feriado = await isHoliday(now);

  // Busca conversas com inbound pendente (sem resposta humana apos o inbound)
  const { rows: convs } = await query(`
    SELECT c.id, c.phone, c.client_id, c.last_inbound_at, c.last_human_reply_at,
           c.luna_ack_at, c.luna_silence_nudge_at, c.attendance_status,
           c.mensagens_count, c.started_at
    FROM luna_v2.conversations c
    WHERE c.attendance_status = 'open'
      AND c.last_inbound_at IS NOT NULL
      AND c.last_inbound_at > NOW() - INTERVAL '7 days'
      AND (c.last_human_reply_at IS NULL OR c.last_human_reply_at < c.last_inbound_at)
      AND (c.last_outbound_at IS NULL OR c.last_outbound_at < c.last_inbound_at - INTERVAL '2 seconds')
    ORDER BY c.last_inbound_at ASC
    LIMIT 50
  `);

  for (const c of convs) {
    const inbAt = new Date(c.last_inbound_at).getTime();
    const ageSec = (now.getTime() - inbAt) / 1000;
    if (ageSec < SLA_SECS) continue;

    // Busca nome do cliente se conhecido
    let nome = '';
    if (c.client_id) {
      try {
        const { rows } = await query(
          `SELECT nome_fantasia, razao_social FROM datalake.cliente_360 WHERE gesthub_id = $1 LIMIT 1`,
          [c.client_id]
        );
        nome = primeiroNome(rows[0]?.nome_fantasia || rows[0]?.razao_social);
      } catch {}
    }

    // --- Caso A: feriado ---
    if (feriado) {
      if (jaAgiu(c.id, c.last_inbound_at, 'holiday')) continue;
      if (c.luna_ack_at && new Date(c.luna_ack_at).getTime() > inbAt) continue;
      const tpl = await fetchTemplate('holiday');
      const texto = renderTemplate(tpl, { nome, feriado });
      await sendLuna(c.phone, texto, c.id, 'holiday');
      continue;
    }

    // --- Caso B: fora do horario ---
    if (!horaComercial) {
      if (jaAgiu(c.id, c.last_inbound_at, 'off_hours')) continue;
      if (c.luna_ack_at && new Date(c.luna_ack_at).getTime() > inbAt) continue;
      const tpl = await fetchTemplate('off_hours');
      const texto = renderTemplate(tpl, { nome });
      await sendLuna(c.phone, texto, c.id, 'off_hours');
      continue;
    }

    // --- Caso C: in-hours, silencio > SLA ---
    if (jaAgiu(c.id, c.last_inbound_at, 'silence_inhours')) continue;
    if (c.luna_silence_nudge_at && new Date(c.luna_silence_nudge_at).getTime() > inbAt) continue;

    const tpl = await fetchTemplate('silence_inhours');
    const texto = renderTemplate(tpl, { nome });
    await sendLuna(c.phone, texto, c.id, 'silence_inhours');

    // Alerta equipe
    const responsavel = await fetchResponsavelInterno(c.client_id);
    const tituloAlerta = `[Atendimento] ${nome || c.phone}: sem resposta humana ha ${Math.floor(ageSec)}s`;
    await enviarPraEquipe(tituloAlerta, {
      conversation_id: c.id, phone: c.phone, client_id: c.client_id,
      responsavel, idade_segundos: Math.floor(ageSec),
    });
  }

  // --- Varredura de conversas abertas muito antigas (24h) ---
  try {
    const { rows: staleConvs } = await query(`
      SELECT id, phone, client_id, last_message_at
      FROM luna_v2.conversations
      WHERE attendance_status = 'open'
        AND last_message_at < NOW() - INTERVAL '${STALE_CONV_HOURS} hours'
        AND last_message_at > NOW() - INTERVAL '7 days'
      LIMIT 20
    `);
    for (const s of staleConvs) {
      const key = `stale:${s.id}`;
      const last = _lastActionByConv.get(key);
      if (last && (now.getTime() - last.at) < 12 * 3600 * 1000) continue; // 1x a cada 12h
      const resp = await fetchResponsavelInterno(s.client_id);
      await enviarPraEquipe(
        `[Atendimento aberto ${STALE_CONV_HOURS}h+] ${s.phone}: confirmar se foi resolvido`,
        { conversation_id: s.id, responsavel: resp, tipo: 'stale_review' }
      );
      _lastActionByConv.set(key, { acao: 'stale', at: now.getTime() });
    }
  } catch (e) { console.error('[watchdog] stale scan:', e.message); }
}

// --- FERIADOS: refresh diario ---
async function refreshHolidays() {
  const ano = new Date().getFullYear();
  try {
    const resp = await fetch(`https://brasilapi.com.br/api/feriados/v1/${ano}`);
    if (!resp.ok) return;
    const dados = await resp.json();
    for (const f of dados) {
      await query(
        `INSERT INTO public.holidays (date, name, type) VALUES ($1, $2, 'national')
         ON CONFLICT (date) DO UPDATE SET name = EXCLUDED.name`,
        [f.date, f.name]
      );
    }
    console.log(`[watchdog] ${dados.length} feriados nacionais ${ano} sincronizados`);
  } catch (e) { console.error('[watchdog] feriados:', e.message); }
}

// --- BOOT ---
let _interval = null;
export function startWatchdog() {
  if (_interval) return;
  console.log(`[watchdog] iniciado — SLA=${SLA_SECS}s tick=${TICK_MS}ms horario=${BH_START}h-${BH_END}h dias=${BH_DAYS}`);
  refreshHolidays();
  setInterval(refreshHolidays, 24 * 3600 * 1000);
  _interval = setInterval(() => tick().catch(e => console.error('[watchdog] tick:', e.message)), TICK_MS);
  // Roda o primeiro tick rapido (3s) pra teste ficar fluido
  setTimeout(() => tick().catch(()=>{}), 3000);
}

export default { startWatchdog };
