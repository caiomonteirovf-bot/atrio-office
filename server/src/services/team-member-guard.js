/**
 * Team Member Detection
 * ---------------------
 * Detecta se um número de telefone pertence a um colaborador da Átrio
 * (Gesthub /colaboradores). Se for, Luna trata como COMUNICAÇÃO INTERNA
 * e não como atendimento de cliente.
 *
 * Diferença de comportamento:
 *  - Cliente externo:  buffer → LLM → resposta → alertas → escalation
 *  - Colaborador:      log interno + tag "interno" no chat da equipe
 *                      Luna NÃO responde, NÃO cria task, NÃO agenda
 *                      first-touch nem escalation
 */
import * as gesthub from './gesthub.js';

let _cache = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5min

function normalizeDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function loadTeam() {
  const now = Date.now();
  if (_cache && (now - _cachedAt) < CACHE_TTL_MS) return _cache;
  try {
    const list = await gesthub.getColaboradores();
    _cache = (list || [])
      .filter(c => c && (c.telefone || c.phone))
      .map(c => ({
        nome: c.nome || c.name || '',
        phoneDigits: normalizeDigits(c.telefone || c.phone),
        areas: c.areas || c.area || [],
      }))
      .filter(c => c.phoneDigits.length >= 10);
    _cachedAt = now;
  } catch (e) {
    console.error('[team-guard] loadTeam falhou:', e.message);
    if (!_cache) _cache = [];
  }
  return _cache;
}

/**
 * Retorna o colaborador se o phone bater com algum da Átrio, senão null.
 * Compara pelos últimos 8 dígitos pra resistir a variações de DDI/DDD/LID.
 */
export async function detectTeamMember(phone) {
  if (!phone) return null;
  const digits = normalizeDigits(phone);
  if (digits.length < 8) return null;
  const tail = digits.slice(-8);
  const team = await loadTeam();
  return team.find(m => m.phoneDigits.slice(-8) === tail) || null;
}

export function invalidateTeamCache() {
  _cache = null;
  _cachedAt = 0;
}
